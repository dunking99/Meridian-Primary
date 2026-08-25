// Meridian — SEC EDGAR.
//
// Free, unlimited, structured, and filed under legal obligation, which makes
// it the highest-quality source wired into this app. It was being used for one
// thing: listing the dates of Form 4 filings.
//
// Two additions here.
//
// Company facts. EDGAR publishes every XBRL fact a registrant has ever filed
// at a single JSON endpoint — revenue, net income, assets, equity, cash flow
// and share count, quarterly and annually, going back years, straight from the
// filed documents. That is reported fundamental history rather than a vendor's
// summary of it, and it makes fundamental *change* visible: margin trend,
// revenue growth, and share count drift, which is the one that matters most
// and shows up nowhere on a price chart.
//
// Real Form 4 parsing. syncInsiders previously stored a row per filing with
// filer, role, shares, price and value all set to NULL — the columns existed
// and were never populated, so the insider table rendered as a grid of blanks.
// The filings themselves are XML at a predictable URL and carry all of it.
//
// SEC requires a descriptive User-Agent with contact details; requests without
// one are throttled or refused.

import https from 'https';
import { run, all, one, getSetting, setSetting } from '../db.js';

const UA = () => getSetting('edgarUserAgent', 'Meridian Personal Dashboard (contact@example.com)');

function get(hostname, path, { json = true } = {}) {
  return new Promise(resolve => {
    const req = https.get({
      hostname, path,
      headers: { 'User-Agent': UA(), 'Accept': json ? 'application/json' : '*/*' },
    }, res => {
      // EDGAR redirects some archive paths; follow one hop rather than
      // returning null and reporting a document as unavailable.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const next = loc.startsWith('http') ? new URL(loc) : { hostname, pathname: loc };
        res.resume();
        return resolve(get(next.hostname ?? hostname, next.pathname + (next.search ?? ''), { json }));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const body = Buffer.concat(c).toString();
        if (!json) return resolve(body);
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

const getJson = path => get('data.sec.gov', path);

// ─── Ticker → CIK ─────────────────────────────────────────────

let tickerMap = null;

async function loadTickerMap() {
  if (tickerMap) return tickerMap;
  // The map is ~10k entries and changes rarely; caching it in settings avoids
  // re-downloading it on every restart.
  const cached = getSetting('edgar_ticker_map', null);
  if (cached && typeof cached === 'object' && Object.keys(cached).length > 100) {
    tickerMap = cached;
    return tickerMap;
  }
  const data = await get('www.sec.gov', '/files/company_tickers.json');
  if (!data) return null;
  tickerMap = {};
  for (const v of Object.values(data)) tickerMap[v.ticker] = String(v.cik_str).padStart(10, '0');
  setSetting('edgar_ticker_map', tickerMap);
  return tickerMap;
}

/** CIK for a ticker, or null when it is not a US registrant. */
export async function cikFor(ticker) {
  const map = await loadTickerMap();
  return map?.[String(ticker).toUpperCase()] ?? null;
}

// ─── Filings ──────────────────────────────────────────────────

/** Recent filings of a given type. Pass type=null for all forms. */
export async function fetchFilings(ticker, { type = '4', limit = 25 } = {}) {
  const cik = await cikFor(ticker);
  if (!cik) return { ticker, error: 'Not a US-listed ticker in the SEC index.' };

  const data = await getJson(`/submissions/CIK${cik}.json`);
  const recent = data?.filings?.recent;
  if (!recent) return { ticker, error: 'No filings returned.' };

  const out = [];
  for (let i = 0; i < recent.form.length && out.length < limit; i++) {
    if (type && recent.form[i] !== type) continue;
    const accNoDash = recent.accessionNumber[i].replace(/-/g, '');
    out.push({
      form: recent.form[i],
      date: recent.filingDate[i],
      reportDate: recent.reportDate?.[i] || null,
      accession: recent.accessionNumber[i],
      primaryDoc: recent.primaryDocument[i],
      description: recent.primaryDocDescription?.[i] || null,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accNoDash}/${recent.primaryDocument[i]}`,
      dir: `/Archives/edgar/data/${Number(cik)}/${accNoDash}`,
    });
  }
  return { ticker, cik, company: data.name, filings: out };
}

// ─── Form 4: actual transactions ──────────────────────────────

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
};

// Form 4 wraps most numbers as <field><value>N</value></field>, but some
// filers emit a bare value. Handle both rather than returning null on the
// variant, which is how these columns ended up empty.
const tagValue = (xml, name) => {
  const block = tag(xml, name);
  if (block == null) return null;
  const inner = /<value>([\s\S]*?)<\/value>/.exec(block);
  return (inner ? inner[1] : block).trim();
};

const num = v => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse one Form 4 XML document into its non-derivative transactions.
 *
 * Deliberately regex-based: the schema is shallow and stable, and adding an
 * XML parser dependency for it is not worth the weight. Anything unparseable
 * yields no transactions rather than a row of nulls.
 */
export function parseForm4(xml) {
  if (!xml || !xml.includes('ownershipDocument')) return null;

  const owner = tag(xml, 'reportingOwner') ?? '';
  const filer = tag(owner, 'rptOwnerName');
  const rel = tag(owner, 'reportingOwnerRelationship') ?? '';
  const roles = [
    tag(rel, 'isDirector') === '1' && 'Director',
    tag(rel, 'isOfficer') === '1' && (tag(rel, 'officerTitle') || 'Officer'),
    tag(rel, 'isTenPercentOwner') === '1' && '10% owner',
  ].filter(Boolean);

  const transactions = [];
  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? [];
  for (const b of blocks) {
    const shares = num(tagValue(b, 'transactionShares'));
    const price = num(tagValue(b, 'transactionPricePerShare'));
    const code = tagValue(b, 'transactionCode');
    const ad = tagValue(b, 'transactionAcquiredDisposedCode');
    if (shares == null) continue;

    transactions.push({
      date: tagValue(b, 'transactionDate'),
      // P and S are open-market purchases and sales — the ones that carry
      // signal. A, F, M and G are awards, tax withholding, option exercises
      // and gifts, which are compensation mechanics rather than a view.
      code,
      kind: code === 'P' ? 'Buy' : code === 'S' ? 'Sell'
          : code === 'A' ? 'Award' : code === 'M' ? 'Option exercise'
          : code === 'F' ? 'Tax withholding' : code === 'G' ? 'Gift' : (code ?? 'Other'),
      openMarket: code === 'P' || code === 'S',
      direction: ad === 'A' ? 'acquired' : ad === 'D' ? 'disposed' : null,
      shares, price,
      value: price != null ? shares * price : null,
      sharesAfter: num(tagValue(b, 'sharesOwnedFollowingTransaction')),
    });
  }

  return { filer, role: roles.join(', ') || null, transactions };
}

/**
 * Fetch and store real Form 4 transaction detail for a ticker.
 *
 * One extra request per filing, so it is bounded and only fetches filings not
 * already stored.
 */
export async function syncInsiders(ticker, { limit = 15 } = {}) {
  const res = await fetchFilings(ticker, { type: '4', limit });
  if (res.error) return res;

  let added = 0, parsed = 0;
  const failed = [];

  for (const f of res.filings) {
    if (one('SELECT id FROM insiders WHERE accession = ?', f.accession)) continue;

    // The primary document is XML for Form 4; older ones point at an HTML
    // rendering whose XML sibling lives in the same directory.
    const doc = f.primaryDoc?.endsWith('.xml')
      ? await get('www.sec.gov', `${f.dir}/${f.primaryDoc}`, { json: false })
      : await get('www.sec.gov', `${f.dir}/${f.primaryDoc.replace(/\.html?$/, '.xml')}`, { json: false });

    const p = doc ? parseForm4(doc) : null;
    if (!p || !p.transactions.length) {
      failed.push(f.accession);
      continue;
    }
    parsed++;

    for (const t of p.transactions) {
      try {
        run(`INSERT INTO insiders (symbol, accession, filer, role, date, tx_type, shares, price, value, url, fetched_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            ticker.toUpperCase(),
            // The accession is unique per filing, but a filing can carry
            // several transactions — suffixed so each keeps its own row.
            `${f.accession}#${added}`,
            p.filer, p.role, t.date || f.date,
            `${t.kind}${t.openMarket ? '' : ' (non-market)'}`,
            t.shares, t.price, t.value, f.url, Date.now());
        added++;
      } catch { /* already stored */ }
    }
    await new Promise(r => setTimeout(r, 120));   // SEC asks for <10 req/sec
  }

  return { ticker, company: res.company, added, parsed, failed, filings: res.filings.length };
}

export function getInsiders(symbol, limit = 40) {
  return all('SELECT * FROM insiders WHERE symbol = ? ORDER BY date DESC LIMIT ?',
             String(symbol).toUpperCase(), limit);
}

/**
 * Net open-market insider activity over a window.
 *
 * The count of Form 4s tells you nothing — most are awards and tax
 * withholding. What matters is whether insiders bought or sold with their own
 * money, and for how much.
 */
export function insiderSummary(symbol, { days = 180 } = {}) {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const rows = all(
    `SELECT * FROM insiders WHERE symbol = ? AND date >= ? AND value IS NOT NULL`,
    String(symbol).toUpperCase(), since);

  const market = rows.filter(r => /^(Buy|Sell)$/.test(r.tx_type));
  if (!market.length) {
    return {
      symbol, days, available: false,
      reason: rows.length
        ? `${rows.length} filings in the window, none of them open-market purchases or sales.`
        : 'No stored Form 4 transactions in this window.',
    };
  }

  const bought = market.filter(r => r.tx_type === 'Buy');
  const sold = market.filter(r => r.tx_type === 'Sell');
  const sum = xs => xs.reduce((a, r) => a + (r.value ?? 0), 0);
  const buyValue = sum(bought), sellValue = sum(sold);

  return {
    symbol, days, available: true,
    buys: bought.length, sells: sold.length,
    buyValue, sellValue, net: buyValue - sellValue,
    distinctInsiders: new Set(market.map(r => r.filer)).size,
    source: 'SEC EDGAR Form 4',
  };
}

// ─── Company facts (XBRL) ─────────────────────────────────────

// Concepts worth tracking, with the us-gaap tags they may appear under. Filers
// are inconsistent about which tag they use for the same line, so each concept
// lists its aliases in preference order.
const CONCEPTS = {
  revenue: {
    label: 'Revenue',
    tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues',
           'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
  },
  netIncome:  { label: 'Net income',        tags: ['NetIncomeLoss'] },
  grossProfit:{ label: 'Gross profit',      tags: ['GrossProfit'] },
  opIncome:   { label: 'Operating income',  tags: ['OperatingIncomeLoss'] },
  assets:     { label: 'Total assets',      tags: ['Assets'] },
  liabilities:{ label: 'Total liabilities', tags: ['Liabilities'] },
  equity:     { label: 'Shareholders equity',
                tags: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
  cashFromOps:{ label: 'Cash from operations',
                tags: ['NetCashProvidedByUsedInOperatingActivities'] },
  eps:        { label: 'Diluted EPS',       tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'] },
  shares:     { label: 'Diluted shares',
                tags: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'] },
};

/** Annual (FY) series for one concept, most recent last, deduped by fiscal year. */
function annualSeries(facts, tags) {
  for (const t of tags) {
    const units = facts?.facts?.['us-gaap']?.[t]?.units;
    if (!units) continue;
    const key = Object.keys(units)[0];          // USD, USD/shares or shares
    const rows = (units[key] ?? []).filter(r => r.form === '10-K' && r.fp === 'FY' && r.fy);

    // A fiscal year appears in several filings as prior-period comparatives.
    // The latest-filed version is the restated one and the one to keep.
    const byYear = new Map();
    for (const r of rows) {
      const prev = byYear.get(r.fy);
      if (!prev || (r.filed > prev.filed)) byYear.set(r.fy, r);
    }
    const series = [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([fy, r]) => ({ fy, end: r.end, value: r.val, filed: r.filed }));
    if (series.length) return { tag: t, unit: key, series };
  }
  return null;
}

/**
 * Reported annual fundamentals for a US registrant, from its own filings.
 *
 * Returns the concepts that were actually found, and names the ones that were
 * not, so a missing line reads as "this filer does not report it under a tag
 * we recognise" rather than as a blank.
 */
export async function fetchCompanyFacts(ticker, { years = 10 } = {}) {
  const cik = await cikFor(ticker);
  if (!cik) return { ticker, error: 'Not a US-listed ticker in the SEC index.' };

  const facts = await getJson(`/api/xbrl/companyfacts/CIK${cik}.json`);
  if (!facts) return { ticker, cik, error: 'EDGAR returned no company facts.' };

  const concepts = {};
  const missing = [];
  for (const [id, def] of Object.entries(CONCEPTS)) {
    const found = annualSeries(facts, def.tags);
    if (!found) { missing.push(def.label); continue; }
    concepts[id] = { label: def.label, ...found, series: found.series.slice(-years) };
  }

  return {
    ticker, cik, company: facts.entityName ?? null,
    concepts, missing,
    source: 'SEC EDGAR XBRL company facts (as filed)',
  };
}

/**
 * Derived fundamental trends — the part that needs history rather than a
 * snapshot, and the reason to pull this at all.
 */
export function deriveTrends(factsResult) {
  const c = factsResult?.concepts;
  if (!c) return { available: false };

  const last = s => s?.series?.[s.series.length - 1]?.value ?? null;
  const first = s => s?.series?.[0]?.value ?? null;

  // Elapsed fiscal years, not the number of data points. A filer with a gap in
  // its reported history would otherwise have its growth rate overstated —
  // four points spanning eight years is not a four-year CAGR.
  const yearsSpanned = s => {
    const ser = s?.series;
    if (!ser || ser.length < 2) return 0;
    return (ser[ser.length - 1].fy ?? 0) - (ser[0].fy ?? 0);
  };

  const cagr = (s) => {
    const a = first(s), b = last(s), n = yearsSpanned(s);
    if (a == null || b == null || n < 1 || a <= 0 || b <= 0) return null;
    return Math.pow(b / a, 1 / n) - 1;
  };

  const plural = n => `${n} year${n === 1 ? "" : "s"}`;

  const marginSeries = (numer, denom) => {
    if (!c[numer] || !c[denom]) return null;
    const d = new Map(c[denom].series.map(r => [r.fy, r.value]));
    return c[numer].series
      .filter(r => d.get(r.fy))
      .map(r => ({ fy: r.fy, value: r.value / d.get(r.fy) }));
  };

  const shareChange = (() => {
    const s = c.shares;
    if (!s || s.series.length < 2) return null;
    const a = first(s), b = last(s), n = yearsSpanned(s);
    if (!a || !b || n < 1) return null;
    return {
      changePct: b / a - 1,
      years: n,
      // Dilution is invisible on a price chart and is the single most useful
      // thing in this dataset for a long-term holder.
      note: b > a
        ? `Share count grew ${(((b / a) - 1) * 100).toFixed(1)}% over ${plural(n)} — per-share results are diluted.`
        : `Share count shrank ${((1 - b / a) * 100).toFixed(1)}% over ${plural(n)} — buybacks flatter per-share results.`,
    };
  })();

  return {
    available: true,
    revenueCagr: cagr(c.revenue),
    netIncomeCagr: cagr(c.netIncome),
    epsCagr: cagr(c.eps),
    grossMargin: marginSeries('grossProfit', 'revenue'),
    operatingMargin: marginSeries('opIncome', 'revenue'),
    netMargin: marginSeries('netIncome', 'revenue'),
    shareChange,
    years: yearsSpanned(c.revenue ?? c.netIncome),
  };
}

/** Full-text filing search across EDGAR. */
export async function searchFilings(query, { forms = '8-K,10-K,10-Q', limit = 20 } = {}) {
  const data = await get('efts.sec.gov',
    `/LATEST/search-index?q=${encodeURIComponent(`"${query}"`)}&forms=${encodeURIComponent(forms)}`);
  if (!data) return { query, results: [], note: 'EDGAR full-text search unavailable.' };
  return {
    query,
    results: (data.hits?.hits ?? []).slice(0, limit).map(h => ({
      id: h._id,
      form: h._source?.file_type ?? null,
      date: h._source?.file_date ?? null,
      company: h._source?.display_names?.[0] ?? null,
    })),
  };
}
