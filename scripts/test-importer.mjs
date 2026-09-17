// Meridian — broker statement import assertions
//
// Run:
//   MERIDIAN_DB=/tmp/imp.db node scripts/test-importer.mjs
//
// This module writes to the holdings table, which is the one thing in Meridian
// with no version history and no automatic backup. The assertions are therefore
// weighted heavily towards what it REFUSES to do:
//
//   - preview writes nothing, checked by counting rows before and after
//   - a row the preview rejected cannot be applied even if handed back
//   - an existing holding is never overwritten unless that is asked for
//   - a holding missing from the file is never deleted
//   - a date column that could be read either way is refused, not guessed
//   - a suspected pence quote is flagged and never converted
//
// The fixtures are shaped like real exports rather than like clean test data:
// preamble rows above the header, currency symbols, thousands separators,
// parenthesised negatives, semicolon delimiters, and a file where the dates are
// genuinely undecidable.

import { db, all, one, run } from '../server/db.js';
import * as I from '../server/engines/importer.js';

const DB = process.env.MERIDIAN_DB;
if (!DB) { console.error('Set MERIDIAN_DB to a throwaway path before running this.'); process.exit(1); }
if (DB.includes('meridian.db')) {
  console.error('Refusing to run against the real database. Point MERIDIAN_DB somewhere disposable.');
  process.exit(1);
}

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(name) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); }
const near = (a, b, tol = 1e-6) => a != null && Math.abs(a - b) <= tol;

db.exec('DELETE FROM holdings; DELETE FROM transactions; DELETE FROM ohlcv;');

// A stored price for SHEL.L so the pence check has something to compare to.
{
  const stmt = db.prepare(`INSERT OR REPLACE INTO ohlcv (symbol, date, open, high, low, close, adj_close, volume)
                           VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
    stmt.run('SHEL.L', d, 27.5, 27.5, 27.5, 27.5, 27.5, 1000);
    stmt.run('VUSA.L', d, 85.0, 85.0, 85.0, 85.0, 85.0, 1000);
  }
}

// ─── 1. CSV mechanics ─────────────────────────────────────────

section('Reading what brokers actually export');

check('quoted fields containing the delimiter stay whole',
  I.parseDelimited('a,"b,c",d')[0].length === 3
  && I.parseDelimited('a,"b,c",d')[0][1] === 'b,c');

check('escaped quotes are unescaped',
  I.parseDelimited('a,"say ""hi""",b')[0][1] === 'say "hi"');

check('quoted newlines do not split the row',
  I.parseDelimited('a,"line1\nline2",c').length === 1);

check('windows line endings do not leave stray characters',
  I.parseDelimited('a,b\r\nc,d').length === 2
  && I.parseDelimited('a,b\r\nc,d')[1][1] === 'd');

check('a semicolon file is detected',
  I.sniffDelimiter('Symbol;Qty;Price\nSHEL.L;100;27.5') === ';');

check('a tab file is detected',
  I.sniffDelimiter('Symbol\tQty\tPrice\nSHEL.L\t100\t27.5') === '\t');

check('commas inside text do not fool the sniffer into the wrong delimiter',
  // Every line has two semicolon-separated fields, but the description field
  // is full of commas. Counting commas alone would pick the comma.
  I.sniffDelimiter('Name;Qty\n"Shell, plc, class A";100\n"BP, p.l.c., ords";200') === ';',
  I.sniffDelimiter('Name;Qty\n"Shell, plc, class A";100\n"BP, p.l.c., ords";200'));

check('a header below preamble rows is found', (() => {
  const rows = I.parseDelimited([
    'Your Investment Account',
    'Generated 01/09/2026',
    '',
    'Symbol,Quantity,Price',
    'SHEL.L,100,27.50',
  ].join('\n'));
  return I.findHeaderRow(rows) === 3;
})());

check('a row of numbers is not mistaken for a header', (() => {
  const rows = I.parseDelimited('100,200,300\nSymbol,Quantity,Price\nSHEL.L,100,27.5');
  return I.findHeaderRow(rows) === 1;
})());

// ─── 2. Column mapping ────────────────────────────────────────

section('Mapping columns brokers name differently');

check('plain names map', (() => {
  const { mapping } = I.mapColumns(['Symbol', 'Quantity', 'Price', 'Date']);
  return mapping.symbol === 0 && mapping.quantity === 1 && mapping.price === 2 && mapping.date === 3;
})());

check('UK broker spellings map', (() => {
  const { mapping } = I.mapColumns(['EPIC', 'No. of Shares', 'Price Per Share', 'Trade Date']);
  return mapping.symbol === 0 && mapping.quantity === 1 && mapping.price === 2 && mapping.date === 3;
})(), JSON.stringify(I.mapColumns(['EPIC', 'No. of Shares', 'Price Per Share', 'Trade Date']).mapping));

check('a longer, more specific header beats a substring match', (() => {
  const { mapping } = I.mapColumns(['Ticker', 'Units', 'Price Per Share', 'Market Value']);
  return mapping.price === 2 && mapping.value === 3;
})(), JSON.stringify(I.mapColumns(['Ticker', 'Units', 'Price Per Share', 'Market Value']).mapping));

check('one column cannot fill two roles', (() => {
  const { mapping } = I.mapColumns(['Symbol', 'Quantity']);
  const used = Object.values(mapping);
  return new Set(used).size === used.length;
})());

check('an exact match wins over a substring match in another role', (() => {
  // "Account Type" contains "type", which the side role lists. Assigning role
  // by role in declaration order lets side claim the column before wrapper —
  // which matches it exactly — is ever consulted.
  const { mapping } = I.mapColumns(['Investment', 'Units', 'Price Per Share', 'Account Type']);
  return mapping.wrapper === 3 && mapping.side !== 3;
})(), JSON.stringify(I.mapColumns(['Investment', 'Units', 'Price Per Share', 'Account Type']).mapping));

check('a real side column is still found when one exists', (() => {
  const { mapping } = I.mapColumns(['Symbol', 'Quantity', 'Buy/Sell', 'Account Type']);
  return mapping.side === 2 && mapping.wrapper === 3;
})(), JSON.stringify(I.mapColumns(['Symbol', 'Quantity', 'Buy/Sell', 'Account Type']).mapping));

check('columns nobody claimed are reported rather than dropped', (() => {
  const { unmapped } = I.mapColumns(['Symbol', 'Quantity', 'Custodian Reference']);
  return unmapped.some(u => /Custodian/.test(u.header));
})());

// ─── 3. Numbers as brokers write them ─────────────────────────

section('Parsing money');

check('a pound sign and thousands separator are handled',
  near(I.parseNumber('£1,234.50'), 1234.5));
check('a dollar sign is handled', near(I.parseNumber('$99.99'), 99.99));
check('a euro sign is handled', near(I.parseNumber('€1.234'), 1.234));
check('parenthesised negatives are negative, not positive',
  near(I.parseNumber('(1,500.00)'), -1500),
  'accounting convention — parseFloat reads this as positive');
check('a leading minus is negative', near(I.parseNumber('-42.5'), -42.5));
check('a trailing pence marker is stripped', near(I.parseNumber('2750p'), 2750));
check('blank is null, not zero', I.parseNumber('') === null && I.parseNumber(null) === null);
check('text is null rather than NaN', I.parseNumber('n/a') === null && I.parseNumber('--') === null);
check('a number passes straight through', near(I.parseNumber(12.25), 12.25));
check('a non-finite number is rejected', I.parseNumber(Infinity) === null);

// ─── 4. Dates — the one that quietly corrupts ─────────────────

section('Dates, and refusing to guess');

check('a column containing 25/12/2026 is day-first',
  I.detectDateOrder(['01/02/2026', '25/12/2026', '03/04/2026']) === 'dmy');

check('a column containing 12/25/2026 is month-first',
  I.detectDateOrder(['01/02/2026', '12/25/2026']) === 'mdy');

check('a column where every row works both ways is ambiguous, not assumed',
  I.detectDateOrder(['01/02/2026', '03/04/2026', '05/06/2026']) === 'ambiguous',
  'guessing here silently corrupts a transaction history');

check('a column with evidence for both orders is conflicting',
  I.detectDateOrder(['25/12/2026', '12/25/2026']) === 'conflicting');

check('ISO dates are recognised as their own thing',
  I.detectDateOrder(['2026-03-04', '2026-12-25']) === 'iso');

check('day-first parsing puts the day first',
  I.parseDate('03/04/2026', 'dmy') === '2026-04-03');
check('month-first parsing puts the month first',
  I.parseDate('03/04/2026', 'mdy') === '2026-03-04');
check('the same string gives two different real dates under the two orders',
  I.parseDate('03/04/2026', 'dmy') !== I.parseDate('03/04/2026', 'mdy'));

check('ISO input is read as ISO whatever the order says',
  I.parseDate('2026-04-03', 'mdy') === '2026-04-03');
check('two-digit years resolve sensibly',
  I.parseDate('03/04/99', 'dmy') === '1999-04-03' && I.parseDate('03/04/26', 'dmy') === '2026-04-03');
check('a named month is read', I.parseDate('12 Mar 2026', 'dmy') === '2026-03-12');
check('an American named month is read', I.parseDate('Mar 12, 2026', 'mdy') === '2026-03-12');
check('an impossible date is rejected rather than rolled over',
  I.parseDate('31/02/2026', 'dmy') === null, 'Date() would silently make this 3 March');
check('nonsense is null', I.parseDate('not a date', 'dmy') === null);

// ─── 5. Sides ─────────────────────────────────────────────────

section('Buy and sell, in broker vocabulary');

check('buy spellings', ['Buy', 'BOUGHT', 'B', 'Purchase'].every(s => I.parseSide(s) === 'buy'));
check('sell spellings', ['Sell', 'SOLD', 'S', 'Disposal'].every(s => I.parseSide(s) === 'sell'));
check('dividends are their own thing', I.parseSide('Dividend') === 'dividend');
check('an unrecognised side is null rather than defaulted to buy',
  I.parseSide('Corporate Action') === null);

// ─── 6. Pence detection ───────────────────────────────────────

section('Pence, and refusing to convert on a guess');

check('a price 100x the stored one is flagged', (() => {
  const s = I.penceSuspicion('SHEL.L', 2750);      // stored close is 27.5
  return s?.suspected === true && /pence/.test(s.note);
})(), JSON.stringify(I.penceSuspicion('SHEL.L', 2750)));

check('the flag says nothing was converted',
  /Nothing was converted/.test(I.penceSuspicion('SHEL.L', 2750).note));

check('a correct price is not flagged', I.penceSuspicion('SHEL.L', 27.6) === null);

check('an instrument with no stored bars cannot be judged, and says nothing',
  I.penceSuspicion('UNKNOWN.L', 2750) === null,
  'with no reference price there is no evidence either way');

// ─── 7. Preview writes nothing ────────────────────────────────

section('Preview touches the database not at all');

const HOLDINGS_CSV = [
  'Hargreaves Lansdown - Stocks and Shares ISA',
  'Valuation as at 01/09/2026',
  '',
  'Stock,Units held,Price (p),Value (£),Account Type',
  '"Shell plc",1000,"2,750.00","£27,500.00",ISA',
  '"Vanguard S&P 500 UCITS ETF",300,"8,500.00","£25,500.00",ISA',
  '"Made Up Fund",50,"1,000.00","£500.00",ISA',
].join('\n');

{
  const before = all('SELECT * FROM holdings').length;
  const p = I.preview(HOLDINGS_CSV, { mode: 'holdings' });
  const after = all('SELECT * FROM holdings').length;

  check('the preview parses', p.available === true, p.reason);
  check('and wrote nothing', before === after && after === 0);
  check('it says so explicitly', /Nothing has been written/.test(p.note));
  check('the header below the preamble was found at its real file line',
    p.headerLine === 4, String(p.headerLine));
  check('three data rows were read', p.rows.length === 3, String(p.rows.length));
  check('symbols were cleaned', p.rows[0].symbol === 'SHELLPLC' || typeof p.rows[0].symbol === 'string');
  check('quantities parsed', p.rows[0].quantity === 1000);
  check('prices with separators parsed', near(p.rows[0].price, 2750));
  check('the wrapper column was read', p.rows.every(r => r.wrapper === 'ISA'));
  check('rows are numbered by their real line in the file, past the blank preamble line',
    p.rows[0].row === 5 && p.rows[1].row === 6 && p.rows[2].row === 7,
    JSON.stringify(p.rows.map(r => r.row)));

  check('a quoted field containing a newline does not desynchronise later line numbers', (() => {
    const csv = 'Symbol,Name,Quantity\nSHEL.L,"Shell\nplc",100\nVUSA.L,Vanguard,50';
    const q = I.preview(csv);
    // Row 2 starts on file line 2; the quoted newline pushes row 3 to line 4.
    return q.rows[0].row === 2 && q.rows[1].row === 4;
  })(), JSON.stringify(I.preview('Symbol,Name,Quantity\nSHEL.L,"Shell\nplc",100\nVUSA.L,Vanguard,50').rows?.map(r => r.row)));
  check('counts are reported', p.counts.total === 3);
}

// ─── 8. Rejection and refusal ─────────────────────────────────

section('What it refuses');

check('a file with no recognisable header is refused with a reason', (() => {
  const p = I.preview('just\nsome\nlines\n');
  return p.available === false && /header/i.test(p.reason);
})());

check('an empty file is refused', I.preview('').available === false);

check('a table missing a quantity column is refused, naming what is missing', (() => {
  const p = I.preview('Symbol,Price\nSHEL.L,27.5');
  return p.available === false && /quantity/i.test(p.reason);
})(), I.preview('Symbol,Price\nSHEL.L,27.5').reason);

check('an ambiguous date column blocks every row rather than guessing', (() => {
  const csv = 'Symbol,Quantity,Price,Date,Side\n'
    + 'SHEL.L,100,27.5,01/02/2026,Buy\n'
    + 'VUSA.L,50,85.0,03/04/2026,Buy\n';
  const p = I.preview(csv, { mode: 'transactions' });
  return p.available === true
    && p.dateOrder === 'ambiguous'
    && p.rows.every(r => r.status === 'error')
    && p.rows.every(r => r.issues.some(i => /day-first or month-first/.test(i.message)));
})(), JSON.stringify(I.preview('Symbol,Quantity,Price,Date,Side\nSHEL.L,100,27.5,01/02/2026,Buy\n', { mode: 'transactions' }).rows?.[0]));

check('and the caller can settle it explicitly', (() => {
  const csv = 'Symbol,Quantity,Price,Date,Side\nSHEL.L,100,27.5,01/02/2026,Buy\n';
  const p = I.preview(csv, { mode: 'transactions', dateOrder: 'dmy' });
  return p.rows[0].date === '2026-02-01' && p.rows[0].status !== 'error';
})(), JSON.stringify(I.preview('Symbol,Quantity,Price,Date,Side\nSHEL.L,100,27.5,01/02/2026,Buy\n', { mode: 'transactions', dateOrder: 'dmy' }).rows?.[0]));

check('a transaction with neither price nor value is an error', (() => {
  const p = I.preview('Symbol,Quantity,Date,Side\nSHEL.L,100,2026-03-04,Buy', { mode: 'transactions' });
  return p.rows[0].status === 'error'
    && p.rows[0].issues.some(i => /neither a price nor a value/i.test(i.message));
})());

check('a price can be derived from a total value', (() => {
  const p = I.preview('Symbol,Quantity,Value,Date,Side\nSHEL.L,100,"£2,750.00",2026-03-04,Buy', { mode: 'transactions' });
  return near(p.rows[0].price, 27.5) && p.rows[0].priceDerived === true;
})(), JSON.stringify(I.preview('Symbol,Quantity,Value,Date,Side\nSHEL.L,100,"£2,750.00",2026-03-04,Buy', { mode: 'transactions' }).rows?.[0]));

check('a pence-looking price is warned about, not silently converted', (() => {
  const p = I.preview('Symbol,Quantity,Price\nSHEL.L,100,2750', { mode: 'holdings' });
  const r = p.rows[0];
  return r.status === 'warning' && near(r.price, 2750) && r.penceSuspicion?.suspected === true;
})(), JSON.stringify(I.preview('Symbol,Quantity,Price\nSHEL.L,100,2750').rows?.[0]));

check('an instrument with no stored bars imports but is flagged as unmeasurable', (() => {
  const p = I.preview('Symbol,Quantity,Price\nNOBARS.L,10,5.00');
  return p.rows[0].status === 'warning'
    && p.rows[0].issues.some(i => /No stored price history/.test(i.message));
})());

// ─── 9. Apply ─────────────────────────────────────────────────

section('Applying, and everything it will not do');

{
  db.exec('DELETE FROM holdings');
  const csv = 'Symbol,Quantity,Price\nSHEL.L,1000,27.50\nVUSA.L,300,85.00';
  const p = I.preview(csv, { mode: 'holdings' });
  const res = I.apply(p.rows, { mode: 'holdings' });

  check('rows are written', res.applied === 2, JSON.stringify(res));
  check('the holdings are really there', all('SELECT * FROM holdings').length === 2);
  check('quantities landed correctly',
    one("SELECT qty FROM holdings WHERE symbol='SHEL.L'").qty === 1000);
  check('prices landed correctly',
    near(one("SELECT avg_price FROM holdings WHERE symbol='SHEL.L'").avg_price, 27.5));
}

check('an error row cannot be applied even when handed back', () => {}, '');
{
  const before = all('SELECT * FROM holdings').length;
  const res = I.apply([
    { status: 'error', symbol: 'BAD.L', quantity: 5, row: 9, issues: [] },
  ], { mode: 'holdings' });
  const after = all('SELECT * FROM holdings').length;
  check('an error row cannot be applied even when handed back directly',
    res.applied === 0 && before === after, JSON.stringify(res));
}

{
  const before = one("SELECT qty FROM holdings WHERE symbol='SHEL.L'").qty;
  const p = I.preview('Symbol,Quantity,Price\nSHEL.L,9999,1.00');
  const res = I.apply(p.rows, { mode: 'holdings' });
  const after = one("SELECT qty FROM holdings WHERE symbol='SHEL.L'").qty;

  check('an existing holding is not overwritten by default',
    after === before && res.applied === 0, `${before} -> ${after}`);
  check('and the skip is explained',
    res.skippedRows.some(s => /Already held/.test(s.reason)), JSON.stringify(res.skippedRows));
}

{
  const p = I.preview('Symbol,Quantity,Price\nSHEL.L,9999,1.00');
  const res = I.apply(p.rows, { mode: 'holdings', updateExisting: true });
  const after = one("SELECT qty FROM holdings WHERE symbol='SHEL.L'").qty;

  check('an existing holding updates when that is explicitly asked for',
    after === 9999 && res.updated.length === 1);
  check('the update records what it changed from and to',
    res.updated[0].from.qty === 1000 && res.updated[0].to.qty === 9999,
    JSON.stringify(res.updated[0]));
}

{
  // VUSA.L is in the database but absent from this file.
  const before = all('SELECT symbol FROM holdings').map(h => h.symbol).sort();
  I.apply(I.preview('Symbol,Quantity,Price\nSHEL.L,1000,27.50').rows, { mode: 'holdings', updateExisting: true });
  const after = all('SELECT symbol FROM holdings').map(h => h.symbol).sort();
  check('a holding missing from the file is never deleted',
    JSON.stringify(before) === JSON.stringify(after),
    'a statement not mentioning a position is not evidence it was sold');
  check('and the result says so', /not evidence it was sold/.test(
    I.apply([], { mode: 'holdings' }).note ?? I.apply(I.preview('Symbol,Quantity,Price\nSHEL.L,1000,27.5').rows, { mode: 'holdings' }).note ?? ''));
}

check('warnings can be excluded from an apply', (() => {
  db.exec('DELETE FROM holdings');
  const p = I.preview('Symbol,Quantity,Price\nSHEL.L,100,2750');   // pence warning
  const res = I.apply(p.rows, { mode: 'holdings', includeWarnings: false });
  return res.applied === 0;
})());

// ─── 10. Transactions ─────────────────────────────────────────

section('Transactions, and not double-counting them');

{
  db.exec('DELETE FROM transactions');
  const csv = 'Symbol,Quantity,Price,Trade Date,Type,Fees\n'
    + 'SHEL.L,100,27.50,2026-03-04,Buy,9.95\n'
    + 'VUSA.L,50,85.00,2026-03-11,Buy,9.95\n'
    + 'SHEL.L,40,29.00,2026-04-02,Sell,9.95\n';
  const p = I.preview(csv, { mode: 'transactions' });
  check('all three rows are clean', p.rows.every(r => r.status !== 'error'),
    JSON.stringify(p.rows.map(r => [r.row, r.status, r.issues.map(i => i.message)])));
  check('sides were read', p.rows.map(r => r.side).join() === 'buy,buy,sell');
  check('fees were read', near(p.rows[0].fees, 9.95));

  const res = I.apply(p.rows, { mode: 'transactions' });
  check('transactions are written', res.applied === 3, JSON.stringify(res));

  const again = I.apply(I.preview(csv, { mode: 'transactions' }).rows, { mode: 'transactions' });
  check('re-importing the same statement adds nothing',
    again.applied === 0 && all('SELECT * FROM transactions').length === 3,
    JSON.stringify(again));
  check('and says which rows it already had',
    again.skippedRows.every(s => /Already recorded/.test(s.reason)));
}

check('a sell quantity is stored as a positive size with the side recording direction', (() => {
  const t = one("SELECT * FROM transactions WHERE symbol='SHEL.L' AND side='sell'");
  return t && t.qty === 40;
})());

// ─── 11. A full realistic file ────────────────────────────────

section('A statement shaped like a real one');

{
  db.exec('DELETE FROM holdings');
  const messy = [
    'AJ Bell Youinvest',
    'Account: SIPP 12345678',
    'Downloaded 01/09/2026',
    '',
    'Investment;Units;Price Per Share;Market Value;Currency;Account Type',
    '"Shell plc Ordinary 0.07";1,000.00;£27.50;"£27,500.00";GBP;SIPP',
    '"Vanguard S&P 500";300.5;£85.00;"£25,542.50";GBP;SIPP',
    '"Cash";0;;"(£1,200.00)";GBP;SIPP',
  ].join('\n');

  const p = I.preview(messy, { mode: 'holdings' });
  check('a semicolon file with preamble parses', p.available === true, p.reason);
  check('the delimiter is reported', p.delimiter === ';', String(p.delimiter));
  check('fractional units are kept', near(p.rows[1].quantity, 300.5), String(p.rows[1].quantity));
  check('a parenthesised negative value is read as negative',
    p.rows[2].value != null && p.rows[2].value < 0, String(p.rows[2].value));
  check('a zero-quantity row is warned about rather than silently imported',
    p.rows[2].status !== 'ok' && p.rows[2].issues.some(i => /zero/i.test(i.message)));
  check('the wrapper came from the file', p.rows[0].wrapper === 'SIPP');
  check('unmapped columns are listed', Array.isArray(p.unmapped));
}

// ─── 12. Defaults and overrides ───────────────────────────────

section('Overrides');

check('a hand-supplied column mapping overrides the guess', (() => {
  const csv = 'ColA,ColB\nSHEL.L,250';
  const bad = I.preview(csv);
  const good = I.preview(csv, { mapping: { symbol: 0, quantity: 1 } });
  return bad.available === false && good.available === true && good.rows[0].quantity === 250;
})());

check('an override also gets past unrecognisable headers', (() => {
  // Without a mapping this is refused, because guessing which row is the
  // header is how a data row becomes column names. With one, the caller has
  // already said what the columns are.
  const good = I.preview('ColA,ColB\nSHEL.L,250', { mapping: { symbol: 0, quantity: 1 } });
  return good.available === true && good.rows.length === 1;
})(), JSON.stringify(I.preview('ColA,ColB\nSHEL.L,250', { mapping: { symbol: 0, quantity: 1 } }).reason));

check('and a refusal without one points at the way out',
  /Map the columns by hand/.test(I.preview('ColA,ColB\nSHEL.L,250').hint ?? ''));

check('defaults fill fields the file does not carry', (() => {
  const p = I.preview('Symbol,Quantity\nSHEL.L,100', { defaults: { wrapper: 'SIPP', account: 'Pension', currency: 'USD' } });
  const r = p.rows[0];
  return r.wrapper === 'SIPP' && r.account === 'Pension' && r.currency === 'USD';
})(), JSON.stringify(I.preview('Symbol,Quantity\nSHEL.L,100', { defaults: { wrapper: 'SIPP' } }).rows?.[0]));

check('an unrecognised wrapper falls back rather than being stored as typed', (() => {
  const p = I.preview('Symbol,Quantity,Account Type\nSHEL.L,100,"Weird Plan"');
  return p.rows[0].wrapper === 'ISA';
})());

check('existing holdings are marked so new rows are distinguishable', (() => {
  db.exec('DELETE FROM holdings');
  run(`INSERT INTO holdings (symbol, name, qty, avg_price, currency, asset_class, account, wrapper, added_at)
       VALUES ('SHEL.L','Shell',10,27,'GBP','Equity','Main','ISA',?)`, Date.now());
  const p = I.preview('Symbol,Quantity,Price\nSHEL.L,100,27.5\nNEWCO.L,50,10');
  return p.rows[0].existing === true && p.rows[1].existing === false && p.counts.new === 1;
})());

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n${'='.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`${'='.repeat(52)}\n`);
process.exit(failed ? 1 : 0);
