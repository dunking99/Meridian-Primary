// Meridian v2 — broker statement import
//
// Every engine in this app is only as good as the holdings behind it, and
// until now those were typed in by hand. This parses what a broker actually
// exports.
//
// ─── The rule this module is built around ─────────────────────
//
// meridian.db holds the user's real positions and has no version history and
// no automatic backup. An importer is the single most dangerous thing that can
// be pointed at it: one bad column mapping and a portfolio is silently wrong
// in a way that every downstream number inherits and nothing flags.
//
// So nothing here writes on the first call. `preview()` parses, maps, validates
// and reports exactly what WOULD happen, row by row, and touches nothing.
// `apply()` is a separate call that takes the preview's own output back, so the
// thing being written is the thing that was shown. Rows the preview marked bad
// cannot be applied at all, and no path in this file deletes or overwrites an
// existing holding — an import can only add, or be told explicitly to update a
// named position.
//
// ─── Three ways a statement import goes silently wrong ────────
//
// 1. DATES. "03/04/2026" is 3 April to a British broker and 4 March to an
//    American one, and both are plausible. Guessing corrupts a transaction
//    history in a way that looks entirely normal. This module infers the order
//    from the whole column — if any row has a first component above 12, the
//    order is settled for every row — and where a column is genuinely
//    ambiguous it says so and refuses rather than picking one.
//
// 2. PENCE. UK brokers quote many LSE lines in pence, so a price of "1,234.50"
//    may be £1,234.50 or £12.345. That is a 100x error, the same class of
//    corruption the integrity module already guards bars against. Nothing here
//    converts silently: a suspected pence quote is flagged for the reader to
//    resolve.
//
// 3. TICKERS. A broker's symbol is not always Yahoo's. An unrecognised ticker
//    is reported as unmatched rather than mapped to whatever looks closest,
//    because a position quietly attached to the wrong instrument prices,
//    charts and correlates as that instrument.

import { all, one, run, getBars } from '../db.js';

/** Column roles the mapper tries to fill. */
export const ROLES = [
  'symbol', 'name', 'quantity', 'price', 'date', 'side',
  'fees', 'currency', 'account', 'wrapper', 'value',
];

/**
 * Header spellings seen across UK and US retail brokers, lower-cased and
 * stripped of punctuation before matching. Ordered most specific first within
 * each role, because "price" appears inside "price per share" and the longer
 * phrase is the better signal.
 */
const HEADER_PATTERNS = {
  symbol: ['symbol', 'ticker', 'epic', 'sedol', 'isin', 'instrument', 'stock', 'security', 'investment', 'code'],
  name: ['name', 'description', 'instrumentname', 'securityname', 'holding', 'companyname'],
  quantity: ['quantity', 'qty', 'units', 'shares', 'noofshares', 'numberofshares', 'unitsheld', 'holdingqty'],
  price: ['pricepershare', 'unitprice', 'pricepaid', 'avgprice', 'averageprice', 'bookcost perunit', 'price', 'cost'],
  date: ['tradedate', 'date', 'settlementdate', 'transactiondate', 'dealdate', 'valuedate'],
  side: ['side', 'type', 'transactiontype', 'buysell', 'direction', 'action', 'tradetype'],
  fees: ['fees', 'commission', 'charges', 'fee', 'stampduty', 'cost'],
  currency: ['currency', 'ccy', 'curr'],
  account: ['account', 'accountname', 'accountnumber', 'portfolio'],
  wrapper: ['wrapper', 'accounttype', 'producttype', 'plantype'],
  value: ['value', 'marketvalue', 'totalvalue', 'consideration', 'amount', 'bookcost'],
};

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ─── CSV parsing ──────────────────────────────────────────────

/**
 * Split CSV text into rows, honouring quotes and embedded newlines.
 * Written rather than pulled in, because the whole project has four runtime
 * dependencies and a correct-enough CSV reader is eighty lines.
 */
export function parseDelimited(text, delimiter = ',', { withLines = false } = {}) {
  const rows = [];
  const lines = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Line numbers are tracked through parsing rather than derived from the row
  // index afterwards. Blank lines and preamble get filtered out downstream, and
  // a quoted field can itself contain newlines, so an index into the row array
  // is not the line the reader will find in their own file. Telling someone to
  // check "row 47" and meaning a different row than their spreadsheet shows is
  // worse than not numbering the rows at all.
  let line = 1, rowStart = 1;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\n') {
      row.push(field); rows.push(row); lines.push(rowStart);
      row = []; field = ''; line++; rowStart = line;
      continue;
    }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); lines.push(rowStart); }

  const trimmed = rows.map(r => r.map(f => f.trim()));
  return withLines ? trimmed.map((cells, i) => ({ cells, line: lines[i] })) : trimmed;
}

/**
 * Guess the delimiter by which candidate yields the most consistent column
 * count across the first several lines. Counting occurrences alone picks the
 * wrong one whenever a text field is full of commas.
 */
export function sniffDelimiter(text) {
  const candidates = [',', ';', '\t', '|'];
  const sample = String(text ?? '').split('\n').filter(l => l.trim()).slice(0, 12);
  if (!sample.length) return ',';

  let best = ',', bestScore = -1;
  for (const d of candidates) {
    const counts = sample.map(l => parseDelimited(l, d)[0]?.length ?? 1);
    const max = Math.max(...counts);
    if (max < 2) continue;
    const consistent = counts.filter(c => c === max).length;
    // Reward consistency first, then width — a delimiter that splits every
    // line into the same number of columns is almost certainly the real one.
    const score = consistent * 100 + max;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/**
 * Find the header row.
 *
 * Broker exports routinely open with account names, disclaimers and blank
 * lines before the table starts, so row 0 is often not the header. The header
 * is taken to be the first row that both looks like labels and matches at
 * least two known roles.
 */
export function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const r = rows[i];
    if (!r || r.length < 2) continue;
    const filled = r.filter(c => c && c.length).length;
    if (filled < 2) continue;

    let matched = 0;
    for (const cell of r) {
      const n = norm(cell);
      if (!n) continue;
      if (Object.values(HEADER_PATTERNS).some(pats => pats.some(p => n === norm(p) || n.includes(norm(p))))) matched++;
    }
    // Labels are rarely numeric; a row of numbers is data, not a header.
    const numeric = r.filter(c => c && /^[-(£$€\s]*[\d.,]+\)?$/.test(c)).length;
    if (matched >= 2 && numeric <= filled / 2) return i;
  }
  return -1;
}

/** Map header cells to roles. Each role takes at most one column. */
export function mapColumns(header) {
  // Every (role, column) pair is scored, then assigned best-first across the
  // whole grid rather than role by role in declaration order. Greedy per-role
  // assignment gets "Account Type" wrong: the side role lists "type", matches
  // it as a substring, and claims the column before the wrapper role — which
  // matches "accounttype" exactly — ever gets to look at it. Scoring globally
  // lets the exact match win wherever it sits in the list.
  const candidates = [];
  for (const role of ROLES) {
    const pats = HEADER_PATTERNS[role] ?? [];
    header.forEach((cell, i) => {
      const n = norm(cell);
      if (!n) return;
      for (const p of pats) {
        const np = norm(p);
        if (!np) continue;
        // An exact match always beats any substring match; among substrings,
        // the longer pattern is the stronger signal.
        const score = n === np ? np.length + 1000 : n.includes(np) ? np.length : -1;
        if (score > 0) candidates.push({ role, index: i, score });
      }
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);

  const mapping = {};
  const usedCols = new Set(), usedRoles = new Set();
  for (const c of candidates) {
    if (usedRoles.has(c.role) || usedCols.has(c.index)) continue;
    mapping[c.role] = c.index;
    usedRoles.add(c.role);
    usedCols.add(c.index);
  }

  const unmapped = [];
  header.forEach((cell, i) => { if (!usedCols.has(i) && cell) unmapped.push({ index: i, header: cell }); });
  return { mapping, unmapped };
}

// ─── Value parsing ────────────────────────────────────────────

/**
 * A number as brokers write them: currency symbols, thousands separators,
 * and negatives in parentheses, which is an accounting convention a plain
 * parseFloat reads as a positive number.
 */
export function parseNumber(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[£$€,\s]/g, '');
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  // A trailing 'p' is the pence marker; the caller decides what to do about it.
  s = s.replace(/p$/i, '');
  if (!/^\d*\.?\d+$/.test(s)) return null;

  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Work out whether a column of dates is day-first or month-first, across the
 * whole column rather than row by row.
 *
 * Returns 'dmy', 'mdy', 'iso' or 'ambiguous'. Ambiguous is a real answer: if
 * every row could be read either way, no amount of staring at one value
 * settles it, and picking one silently is how a transaction history ends up
 * quietly wrong.
 */
export function detectDateOrder(values) {
  let sawIso = 0, sawDayFirst = 0, sawMonthFirst = 0, sawSlashed = 0;

  for (const v of values) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) { sawIso++; continue; }
    const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
    if (!m) continue;
    sawSlashed++;
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) sawDayFirst++;
    else if (b > 12 && a <= 12) sawMonthFirst++;
  }

  if (sawIso && !sawSlashed) return 'iso';
  if (!sawSlashed) return sawIso ? 'iso' : 'ambiguous';
  if (sawDayFirst && !sawMonthFirst) return 'dmy';
  if (sawMonthFirst && !sawDayFirst) return 'mdy';
  if (sawDayFirst && sawMonthFirst) return 'conflicting';
  return 'ambiguous';
}

/** Parse one date given a settled order. Returns ISO yyyy-mm-dd or null. */
export function parseDate(raw, order) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return validDate(+y, +m, +d);
  }

  const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (!m) {
    // "12 Mar 2026" and "Mar 12, 2026"
    const named = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/)
      || s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})/);
    if (named) {
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const isDayFirst = /^\d/.test(named[1]);
      const day = +(isDayFirst ? named[1] : named[2]);
      const mon = months.indexOf(String(isDayFirst ? named[2] : named[1]).slice(0, 3).toLowerCase()) + 1;
      if (mon > 0) return validDate(+named[3], mon, day);
    }
    return null;
  }

  let [, p1, p2, y] = m;
  let year = +y;
  if (year < 100) year += year < 70 ? 2000 : 1900;
  const day = order === 'mdy' ? +p2 : +p1;
  const mon = order === 'mdy' ? +p1 : +p2;
  return validDate(year, mon, day);
}

function validDate(y, m, d) {
  if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;   // 31 Feb etc
  return dt.toISOString().slice(0, 10);
}

/** Normalise a broker's word for buy/sell. */
export function parseSide(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^(b|buy|bought|purchase|debit|deposit|subscription)/.test(s)) return 'buy';
  if (/^(s|sell|sold|sale|disposal|credit|withdrawal|redemption)/.test(s)) return 'sell';
  if (/div/.test(s)) return 'dividend';
  return null;
}

/**
 * Does this look like a pence quote?
 *
 * Deliberately conservative and advisory only. The check compares the parsed
 * price against the instrument's own stored bars, which is the only evidence
 * that actually settles it — a bare number cannot be told apart from its own
 * 100x, and nothing here converts on a guess.
 */
export function penceSuspicion(symbol, price) {
  if (!(price > 0)) return null;
  const bars = getBars(symbol);
  if (!bars?.length) return null;
  const last = bars[bars.length - 1];
  const ref = last?.adj_close ?? last?.close;
  if (!(ref > 0)) return null;

  const ratio = price / ref;
  if (ratio > 50 && ratio < 200) {
    return {
      suspected: true,
      storedPrice: +ref.toFixed(4),
      ratio: +ratio.toFixed(1),
      note: `Imported price is about ${Math.round(ratio)}x the last stored price for ${symbol}. `
        + 'That is the shape of a pence quote against a pounds one. Nothing was converted.',
    };
  }
  if (ratio < 0.02 && ratio > 0.005) {
    return {
      suspected: true,
      storedPrice: +ref.toFixed(4),
      ratio: +ratio.toFixed(4),
      note: `Imported price is about 1/${Math.round(1 / ratio)} of the last stored price for ${symbol}. `
        + 'Nothing was converted.',
    };
  }
  return null;
}

// ─── Preview ──────────────────────────────────────────────────

const KNOWN_WRAPPERS = ['ISA', 'SIPP', 'GIA', 'LISA', 'JISA', 'CTF'];

function cleanSymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return null;
  // Strip a broker's trailing exchange note: "SHEL (LSE)" -> "SHEL"
  return s.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, '');
}

/**
 * Parse a statement and report exactly what an import would do.
 * Writes nothing, ever.
 *
 * @param {string} text  raw file contents
 * @param {object} opts  mode: 'holdings' | 'transactions', plus overrides
 */
export function preview(text, { mode = 'holdings', mapping: override = null, dateOrder = null, defaults = {} } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) {
    return { available: false, reason: 'The file is empty.' };
  }

  const delimiter = sniffDelimiter(raw);
  const withLines = parseDelimited(raw, delimiter, { withLines: true })
    .filter(r => r.cells.some(c => c && c.length));
  const rows = withLines.map(r => r.cells);
  if (rows.length < 2) {
    return { available: false, reason: 'Nothing that looks like a table — fewer than two non-empty rows.', delimiter };
  }

  let headerIdx = findHeaderRow(rows);
  if (headerIdx < 0) {
    // A caller who supplied a mapping has already said what the columns are,
    // so unrecognisable labels are no longer a reason to refuse — that is the
    // whole point of being able to map by hand. Without one, refusing is right:
    // guessing which row is the header is how a data row becomes column names.
    if (override && Object.keys(override).length) {
      headerIdx = 0;
    } else {
      return {
        available: false,
        reason: 'No header row found. The first 25 rows contained nothing recognisable as column labels.',
        delimiter,
        header: rows[0] ?? [],
        sample: rows.slice(0, 5),
        hint: 'Map the columns by hand and preview again.',
      };
    }
  }

  const header = rows[headerIdx];
  const headerLine = withLines[headerIdx].line;
  const { mapping: auto, unmapped } = mapColumns(header);
  const mapping = { ...auto, ...(override ?? {}) };
  const bodyWithLines = withLines.slice(headerIdx + 1).filter(r => r.cells.some(c => c && c.length));
  const body = bodyWithLines.map(r => r.cells);

  const required = mode === 'transactions'
    ? ['symbol', 'quantity', 'date']
    : ['symbol', 'quantity'];
  const missing = required.filter(r => mapping[r] == null);
  if (missing.length) {
    return {
      available: false,
      reason: `Could not find a column for: ${missing.join(', ')}.`,
      delimiter, headerLine, header,
      mapping, unmapped,
      hint: 'Map the columns by hand and preview again.',
    };
  }

  // Settle the date order across the whole column before reading any row.
  const dateCol = mapping.date;
  const order = dateOrder
    ?? (dateCol != null ? detectDateOrder(body.map(r => r[dateCol])) : 'iso');

  const cell = (r, role) => (mapping[role] == null ? null : r[mapping[role]]);
  const parsed = [];
  let ok = 0, warned = 0, failed = 0;

  for (let i = 0; i < body.length; i++) {
    const r = body[i];
    const issues = [];
    const symbol = cleanSymbol(cell(r, 'symbol'));
    const qty = parseNumber(cell(r, 'quantity'));
    const price = parseNumber(cell(r, 'price'));
    const fees = parseNumber(cell(r, 'fees')) ?? 0;
    const value = parseNumber(cell(r, 'value'));
    const sideRaw = cell(r, 'side');
    const side = parseSide(sideRaw);
    const dateRaw = cell(r, 'date');

    let date = null;
    if (dateCol != null) {
      if (order === 'ambiguous' || order === 'conflicting') {
        issues.push({
          level: 'error',
          message: order === 'conflicting'
            ? 'Dates in this file are internally inconsistent — some rows read as day-first and others as month-first. Choose the order explicitly.'
            : 'Every date in this file could be read day-first or month-first, and nothing in the column settles it. Choose the order explicitly.',
        });
      } else {
        date = parseDate(dateRaw, order);
        if (dateRaw && !date) issues.push({ level: 'error', message: `Could not read "${dateRaw}" as a date.` });
      }
    }

    if (!symbol) issues.push({ level: 'error', message: 'No symbol.' });
    if (qty == null) issues.push({ level: 'error', message: 'No quantity.' });
    else if (qty === 0) issues.push({ level: 'warning', message: 'Quantity is zero.' });

    if (mode === 'transactions') {
      if (!date) issues.push({ level: 'error', message: 'Transactions need a date.' });
      if (!side) {
        issues.push({
          level: sideRaw ? 'error' : 'warning',
          message: sideRaw ? `Could not read "${sideRaw}" as buy or sell.` : 'No buy/sell column — assuming buy.',
        });
      }
      if (price == null && value == null) {
        issues.push({ level: 'error', message: 'Neither a price nor a value, so there is nothing to record.' });
      }
    }

    // Price can be derived from value/qty when the broker gives only a total.
    let unitPrice = price;
    let priceDerived = false;
    if (unitPrice == null && value != null && qty) {
      unitPrice = Math.abs(value / qty);
      priceDerived = true;
    }

    const pence = symbol && unitPrice != null ? penceSuspicion(symbol, unitPrice) : null;
    if (pence?.suspected) issues.push({ level: 'warning', message: pence.note });

    // An instrument nobody has ever priced is not necessarily wrong, but it is
    // worth saying, because it will not chart or correlate until it is synced.
    if (symbol && !getBars(symbol)?.length) {
      issues.push({ level: 'warning', message: `No stored price history for ${symbol}. It will import, but nothing can be measured against it until a sync fetches its bars.` });
    }

    const level = issues.some(x => x.level === 'error') ? 'error'
      : issues.length ? 'warning' : 'ok';
    if (level === 'error') failed++; else if (level === 'warning') warned++; else ok++;

    const wrapperRaw = String(cell(r, 'wrapper') ?? defaults.wrapper ?? '').trim().toUpperCase();
    parsed.push({
      // The real line number in the user's own file, so "check row 47" means
      // what their spreadsheet shows.
      row: bodyWithLines[i].line,
      status: level,
      issues,
      symbol,
      name: cell(r, 'name') || null,
      quantity: qty,
      price: unitPrice == null ? null : +unitPrice.toFixed(6),
      priceDerived,
      fees,
      value,
      date,
      side: side ?? (mode === 'transactions' ? 'buy' : null),
      currency: (cell(r, 'currency') || defaults.currency || 'GBP').toUpperCase().slice(0, 3),
      account: cell(r, 'account') || defaults.account || 'Main',
      wrapper: KNOWN_WRAPPERS.includes(wrapperRaw) ? wrapperRaw : (defaults.wrapper ?? 'ISA'),
      penceSuspicion: pence,
    });
  }

  // What already exists, so the reader knows which rows are new.
  const existingSymbols = new Set(all('SELECT symbol FROM holdings').map(h => h.symbol));
  for (const p of parsed) {
    p.existing = !!(p.symbol && existingSymbols.has(p.symbol));
  }

  return {
    available: true,
    mode,
    delimiter: delimiter === '\t' ? 'tab' : delimiter,
    headerLine,
    header,
    mapping,
    unmapped,
    dateOrder: order,
    rows: parsed,
    counts: { total: parsed.length, ok, warned, failed, new: parsed.filter(p => !p.existing && p.status !== 'error').length },
    // Said plainly and up front, because the whole design rests on it.
    note: 'Nothing has been written. Review the rows, then apply.',
  };
}

// ─── Apply ────────────────────────────────────────────────────

/**
 * Write a previously previewed set of rows.
 *
 * Takes the preview's own rows back rather than re-parsing, so what is written
 * is what was shown. Rows the preview rejected are refused here too, whatever
 * the caller passes.
 *
 * Never deletes. `updateExisting` is opt-in and only ever adjusts a position
 * the file names; a holding absent from the file is left exactly as it was,
 * because "this statement did not mention it" is not evidence that it was sold.
 */
export function apply(rows, { mode = 'holdings', updateExisting = false, includeWarnings = true } = {}) {
  const candidates = (rows ?? []).filter(r =>
    r && r.status !== 'error' && (includeWarnings || r.status === 'ok') && r.symbol && r.quantity != null);

  if (!candidates.length) {
    return { applied: 0, skipped: (rows ?? []).length, added: [], updated: [], skippedRows: [], reason: 'No rows were eligible to apply.' };
  }

  const added = [], updated = [], skippedRows = [];

  if (mode === 'transactions') {
    for (const r of candidates) {
      // A transaction already recorded on the same day, instrument, side and
      // size is the same transaction. Re-importing an overlapping statement is
      // routine and must not double-count.
      const dup = one(
        `SELECT id FROM transactions WHERE symbol = ? AND date = ? AND side = ? AND qty = ?`,
        r.symbol, r.date, r.side ?? 'buy', Math.abs(r.quantity));
      if (dup) { skippedRows.push({ row: r.row, symbol: r.symbol, reason: 'Already recorded.' }); continue; }

      run(`INSERT INTO transactions (symbol, date, side, qty, price, fees, currency, account, wrapper, note)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        r.symbol, r.date, r.side ?? 'buy', Math.abs(r.quantity), r.price ?? 0,
        r.fees ?? 0, r.currency ?? 'GBP', r.account ?? 'Main', r.wrapper ?? 'ISA',
        'Imported from statement');
      added.push({ row: r.row, symbol: r.symbol, date: r.date, qty: Math.abs(r.quantity) });
    }
    return { applied: added.length, added, updated, skippedRows, mode };
  }

  for (const r of candidates) {
    const existing = one('SELECT * FROM holdings WHERE symbol = ?', r.symbol);
    if (existing) {
      if (!updateExisting) {
        skippedRows.push({ row: r.row, symbol: r.symbol, reason: 'Already held; updating existing positions was not requested.' });
        continue;
      }
      run(`UPDATE holdings SET qty = ?, avg_price = COALESCE(?, avg_price), currency = ?, account = ?, wrapper = ?
           WHERE symbol = ?`,
        r.quantity, r.price, r.currency ?? existing.currency,
        r.account ?? existing.account, r.wrapper ?? existing.wrapper, r.symbol);
      updated.push({
        row: r.row, symbol: r.symbol,
        from: { qty: existing.qty, avgPrice: existing.avg_price },
        to: { qty: r.quantity, avgPrice: r.price ?? existing.avg_price },
      });
      continue;
    }

    run(`INSERT INTO holdings (symbol, name, qty, avg_price, currency, sector, geography, asset_class, account, wrapper, added_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      r.symbol, r.name ?? r.symbol, r.quantity, r.price ?? 0, r.currency ?? 'GBP',
      null, null, 'Equity', r.account ?? 'Main', r.wrapper ?? 'ISA', Date.now());
    added.push({ row: r.row, symbol: r.symbol, qty: r.quantity });
  }

  return {
    applied: added.length + updated.length,
    added, updated, skippedRows, mode,
    note: 'Holdings absent from the file were left untouched — a statement not mentioning a position is not evidence it was sold.',
  };
}
