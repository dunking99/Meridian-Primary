// Meridian — return attribution assertions
//
// Run:
//   MERIDIAN_DB=/tmp/attr.db node scripts/test-attribution.mjs
//
// Attribution is unusually testable, because a correct decomposition satisfies
// exact identities rather than merely looking sensible:
//
//   - every holding's contribution sums to the portfolio's compounded return,
//     not approximately but to floating-point tolerance. This is what Cariño
//     linking is for, and a naive sum of daily w x r fails it by a margin that
//     grows with volatility. The test below measures both so the difference is
//     visible rather than asserted.
//   - contribution = baseline + allocation + selection, per holding.
//   - allocation effects sum to zero across groups.
//   - selection effects sum to zero within every group.
//   - a one-holding portfolio has all of the return in that holding, and zero
//     allocation and zero selection, because there is nothing to be relatively
//     good or bad against.
//
// Those hold whatever the prices happen to be, so the world here is built from
// deliberately different-shaped series rather than tuned to a known answer,
// with one exception: the two-holding case where the arithmetic is small enough
// to check by hand.

import { db, run } from '../server/db.js';
import * as AT from '../server/engines/attribution.js';

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
const near = (a, b, tol = 1e-6) => a != null && isFinite(a) && Math.abs(a - b) <= tol;
function section(name) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); }

// ─── World ────────────────────────────────────────────────────

function rng32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normals(rand, n) {
  const out = [];
  while (out.length < n) {
    const u = Math.max(rand(), 1e-12), v = rand();
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.sin(2 * Math.PI * v));
  }
  return out.slice(0, n);
}
function tradingDates(n, startYear = 2024) {
  const out = [];
  const d = new Date(Date.UTC(startYear, 0, 2));
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function seedBars(symbol, closes, dates) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ohlcv (symbol, date, open, high, low, close, adj_close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (let i = 0; i < closes.length; i++) {
      const c = +closes[i].toFixed(6);
      stmt.run(symbol, dates[i], c, c, c, c, c, 1_000_000);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function pricesFrom(returns, start = 100) {
  const out = [start];
  for (const r of returns) out.push(out[out.length - 1] * (1 + r));
  return out;
}
function addHolding({ symbol, qty, avg = 1, sector = null, geography = null, currency = 'GBP' }) {
  run(`INSERT INTO holdings (symbol, name, qty, avg_price, currency, sector, geography, asset_class, account, wrapper, added_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      symbol, symbol, qty, avg, currency, sector, geography, 'Equity', 'Main', 'ISA', Date.now());
}

db.exec('DELETE FROM ohlcv; DELETE FROM holdings; DELETE FROM cash;');

const N = 260;
const dates = tradingDates(N);
const rand = rng32(8642);

// Four holdings across two sectors, with deliberately different shapes so the
// effects are not all trivially equal.
const series = {
  'TECHA.L': pricesFrom(normals(rand, N - 1).map(z => 0.0006 + z * 0.014), 100),  // strong, volatile
  'TECHB.L': pricesFrom(normals(rand, N - 1).map(z => 0.0001 + z * 0.010), 100),  // mild
  'ENRGA.L': pricesFrom(normals(rand, N - 1).map(z => -0.0004 + z * 0.012), 100), // drifting down
  'ENRGB.L': pricesFrom(normals(rand, N - 1).map(z => 0.0002 + z * 0.008), 100),  // quiet
};
for (const [s, closes] of Object.entries(series)) seedBars(s, closes, dates);
seedBars('^FTSE', pricesFrom(normals(rand, N - 1).map(z => 0.0002 + z * 0.007), 7000), dates);

addHolding({ symbol: 'TECHA.L', qty: 300, sector: 'Technology' });
addHolding({ symbol: 'TECHB.L', qty: 200, sector: 'Technology' });
addHolding({ symbol: 'ENRGA.L', qty: 250, sector: 'Energy' });
addHolding({ symbol: 'ENRGB.L', qty: 400, sector: 'Energy' });

const prices = Object.fromEntries(Object.entries(series).map(([s, c]) =>
  [s, { price: c[c.length - 1], currency: 'GBP', changePct: 0 }]));

// ─── 1. Cariño linking ────────────────────────────────────────

section('Cariño linking, against its own definition');

check('the factor at zero return is 1, not a division by zero',
  AT.carinoFactor(0) === 1);
check('and stays 1 through the unstable neighbourhood of zero',
  AT.carinoFactor(1e-12) === 1 && AT.carinoFactor(-1e-12) === 1);
check('a 10% return gives ln(1.1)/0.1',
  near(AT.carinoFactor(0.1), Math.log(1.1) / 0.1, 1e-12), String(AT.carinoFactor(0.1)));
check('a negative return is handled',
  near(AT.carinoFactor(-0.2), Math.log(0.8) / -0.2, 1e-12));
check('a total loss does not produce -Infinity',
  isFinite(AT.carinoFactor(-1)) && isFinite(AT.carinoFactor(-1.5)));
check('a non-finite input does not propagate',
  AT.carinoFactor(NaN) === 1 && AT.carinoFactor(Infinity) === 1);

// ─── 2. The value series ──────────────────────────────────────

section('Reconstructed value history');

const vs = AT.valueSeries(prices, { lookback: 750 });
check('a series is produced', vs.available === true, vs.reason);
check('it covers every seeded holding', vs.symbols.length === 4, JSON.stringify(vs.symbols));
check('it spans the seeded dates', vs.days > 250, String(vs.days));
check('every row carries a positive total', vs.rows.every(r => r.total > 0));
check('a portfolio with no stored bars refuses rather than returning zeros', (() => {
  const r = AT.valueSeries({}, { lookback: 10 });
  return r.available === false && typeof r.reason === 'string';
})());

// ─── 3. The identities ────────────────────────────────────────

section('Identities a correct decomposition must satisfy');

const labels = { 'TECHA.L': 'Technology', 'TECHB.L': 'Technology', 'ENRGA.L': 'Energy', 'ENRGB.L': 'Energy' };
const dec = AT.decompose(vs, { groupOf: s => labels[s] });

check('the decomposition is available', dec.available === true, dec.reason);

const sumContrib = dec.holdings.reduce((s, h) => s + h.contribution, 0);
check('contributions sum to the compounded total return, exactly',
  Math.abs(sumContrib - dec.totalReturn) < 1e-9,
  `sum ${sumContrib.toFixed(10)} vs total ${dec.totalReturn.toFixed(10)}`);

check('the engine reports that it reconciles', dec.reconciles === true);

// Show what the naive version would have done, so the linking is visibly
// doing work rather than being decoration.
{
  const rows = vs.rows;
  let naive = 0;
  for (let t = 1; t < rows.length; t++) {
    for (const s of vs.symbols) {
      const vPrev = rows[t - 1].bySymbol[s];
      if (!(vPrev > 0)) continue;
      naive += (vPrev / rows[t - 1].total) * (rows[t].bySymbol[s] / vPrev - 1);
    }
  }
  const linkedErr = Math.abs(sumContrib - dec.totalReturn);
  const naiveErr = Math.abs(naive - dec.totalReturn);
  check('an unlinked sum would not have reconciled',
    naiveErr > 1e-4 && naiveErr > linkedErr * 100,
    `unlinked off by ${naiveErr.toFixed(6)}, linked off by ${linkedErr.toExponential(2)}`);
  console.log(`       total ${(dec.totalReturn * 100).toFixed(3)}%  linked ${(sumContrib * 100).toFixed(3)}%  unlinked ${(naive * 100).toFixed(3)}%`);
}

check('each holding splits into baseline + allocation + selection',
  dec.holdings.every(h => Math.abs(h.contribution - (h.baseline + h.allocation + h.selection)) < 1e-7),
  JSON.stringify(dec.holdings.map(h => +(h.contribution - (h.baseline + h.allocation + h.selection)).toExponential(1))));

const groups = AT.byGroup(dec);
check('grouping is available', groups.available === true);

check('allocation effects sum to zero across groups',
  Math.abs(groups.allocationSum) < 1e-7, String(groups.allocationSum));

check('selection effects sum to zero across groups too',
  Math.abs(groups.selectionSum) < 1e-7, String(groups.selectionSum));

check('selection sums to zero within each individual group', (() => {
  const byGroup = {};
  for (const h of dec.holdings) byGroup[h.group] = (byGroup[h.group] ?? 0) + h.selection;
  return Object.values(byGroup).every(v => Math.abs(v) < 1e-7);
})(), JSON.stringify((() => {
  const byGroup = {};
  for (const h of dec.holdings) byGroup[h.group] = (byGroup[h.group] ?? 0) + h.selection;
  return byGroup;
})()));

check('group-level selection is structurally zero, so it is never worth displaying',
  // A group return IS the weighted average of its members, so nothing inside
  // can beat it on net. A UI column showing this sum would read 0.00% for
  // every group forever. The engine exposes the spread instead, and this
  // assertion exists so that the zero is understood rather than rediscovered.
  groups.groups.every(g => Math.abs(g.selection) < 1e-9),
  JSON.stringify(groups.groups.map(g => [g.group, g.selection])));

check('the selection spread is what carries the content, and it is not zero',
  groups.groups.filter(g => g.holdingCount > 1).every(g => g.selectionSpread > 0),
  JSON.stringify(groups.groups.map(g => [g.group, g.holdingCount, g.selectionSpread])));

check('the spread is half the absolute selection, not double-counted', (() => {
  const g = groups.groups.find(x => x.holdingCount > 1);
  const members = dec.holdings.filter(h => h.group === g.group);
  const absSum = members.reduce((s, h) => s + Math.abs(h.selection), 0);
  return near(g.selectionSpread, absSum / 2, 1e-7);
})());

check('a single-holding group has no spread to report', (() => {
  const solo = AT.byGroup(AT.decompose(vs, { groupOf: s => s }));
  return solo.groups.every(g => g.holdingCount === 1 && Math.abs(g.selectionSpread) < 1e-9);
})());

check('the grouping basis explains why the sum is not shown',
  /sums to zero by construction/.test(groups.basis), groups.basis);

check('group contributions sum to the total return',
  near(groups.groups.reduce((s, g) => s + g.contribution, 0), dec.totalReturn, 1e-7));

check('baselines sum to the total return as well',
  near(dec.holdings.reduce((s, h) => s + h.baseline, 0), dec.totalReturn, 1e-7),
  'the baseline is every holding earning the portfolio average, which is the portfolio');

check('average weights sum to 1',
  near(dec.holdings.reduce((s, h) => s + h.averageWeight, 0), 1, 1e-4),
  String(dec.holdings.reduce((s, h) => s + h.averageWeight, 0)));

// ─── 4. Degenerate cases where the answer is obvious ──────────

section('Cases where the answer is known without arithmetic');

check('one holding takes the whole return and has no relative effects', (() => {
  db.exec("DELETE FROM holdings WHERE symbol != 'TECHA.L'");
  const v = AT.valueSeries(prices, { lookback: 750 });
  const d = AT.decompose(v, { groupOf: () => 'Only' });
  const h = d.holdings[0];
  const ok = near(h.contribution, d.totalReturn, 1e-9)
    && Math.abs(h.allocation) < 1e-9
    && Math.abs(h.selection) < 1e-9;
  return ok;
})(), 'with nothing to be relatively better than, allocation and selection must be exactly zero');

check('two holdings in the same group have zero allocation between them', (() => {
  db.exec('DELETE FROM holdings');
  addHolding({ symbol: 'TECHA.L', qty: 300, sector: 'Technology' });
  addHolding({ symbol: 'TECHB.L', qty: 200, sector: 'Technology' });
  const v = AT.valueSeries(prices, { lookback: 750 });
  const d = AT.decompose(v, { groupOf: () => 'Technology' });
  return d.holdings.every(h => Math.abs(h.allocation) < 1e-9);
})(), 'one group cannot outperform the portfolio when it IS the portfolio');

check('and their selection effects are equal and opposite', (() => {
  const v = AT.valueSeries(prices, { lookback: 750 });
  const d = AT.decompose(v, { groupOf: () => 'Technology' });
  return Math.abs(d.holdings[0].selection + d.holdings[1].selection) < 1e-9;
})());

check('the better performer of the two has the positive selection effect', (() => {
  const v = AT.valueSeries(prices, { lookback: 750 });
  const d = AT.decompose(v, { groupOf: () => 'Technology' });
  const first = v.rows[0].bySymbol, last = v.rows[v.rows.length - 1].bySymbol;
  const retOf = s => last[s] / first[s] - 1;
  const best = retOf('TECHA.L') > retOf('TECHB.L') ? 'TECHA.L' : 'TECHB.L';
  return d.holdings.find(h => h.symbol === best).selection > 0;
})());

// Restore the full book for the rest of the file.
db.exec('DELETE FROM holdings');
addHolding({ symbol: 'TECHA.L', qty: 300, sector: 'Technology' });
addHolding({ symbol: 'TECHB.L', qty: 200, sector: 'Technology' });
addHolding({ symbol: 'ENRGA.L', qty: 250, sector: 'Energy' });
addHolding({ symbol: 'ENRGB.L', qty: 400, sector: 'Energy' });

// ─── 5. Benchmark comparison ──────────────────────────────────

section('Against a real index');

const dec2 = AT.decompose(AT.valueSeries(prices, { lookback: 750 }), { groupOf: s => labels[s] });
const bench = AT.versusBenchmark(dec2, '^FTSE');

check('the benchmark comparison is available', bench.available === true, bench.reason);
check('excess is portfolio minus benchmark',
  near(bench.excess, bench.portfolioReturn - bench.benchmarkReturn, 1e-9));

check('the benchmark return is a fraction, not a percentage',
  Math.abs(bench.benchmarkReturn) < 3,
  `${bench.benchmarkReturn} — if this is ~100x the portfolio figure, percent and fraction were mixed`);

check('an unknown benchmark is refused rather than assumed flat',
  AT.versusBenchmark(dec2, 'NOSUCH.L').available === false);

check('the comparison states that the sector effects are not benchmark-relative',
  /portfolio-relative/.test(bench.basis) && /no free source/.test(bench.basis), bench.basis);

// ─── 6. The assembled report ──────────────────────────────────

section('The whole report');

const rep = AT.attributionReport(prices, { lookback: 750, grouping: 'sector', benchmark: '^FTSE' });

check('the report is available', rep.available === true, rep.reason);
check('it reconciles', rep.reconciles === true);
check('holdings carry display names', rep.holdings.every(h => typeof h.name === 'string'));
check('groups are present', rep.groups.length === 2, JSON.stringify(rep.groups.map(g => g.group)));
check('winners are positive contributors', rep.winners.every(w => w.contribution > 0));
check('losers are negative contributors', rep.losers.every(l => l.contribution < 0));
check('losers are ordered worst first',
  rep.losers.every((l, i) => i === 0 || rep.losers[i - 1].contribution <= l.contribution));

check('grouping by something else works', (() => {
  const g = AT.attributionReport(prices, { lookback: 750, grouping: 'wrapper' });
  return g.available && g.groups.length === 1 && g.groups[0].group === 'ISA';
})());

check('an unknown grouping falls back rather than crashing',
  AT.attributionReport(prices, { lookback: 750, grouping: 'nonsense' }).available === true);

check('holdings with no label land in a named bucket rather than vanishing', (() => {
  // valuePortfolio already substitutes "Unclassified" for a null sector, so
  // the engine's own Unlabelled fallback does not fire here. What matters is
  // the property, not which of the two labels is used: every holding is still
  // in some group, and the groups still add up. A decomposition that quietly
  // drops a holding stops summing to the total, and nothing on screen shows it.
  db.exec("UPDATE holdings SET sector = NULL WHERE symbol = 'ENRGB.L'");
  const r = AT.attributionReport(prices, { lookback: 750, grouping: 'sector' });
  const allBucketed = r.holdings.every(h => typeof h.group === 'string' && h.group.length > 0);
  const noneLost = r.holdings.length === 4
    && r.groups.reduce((s, g) => s + g.holdingCount, 0) === 4;
  const stillSums = Math.abs(r.groups.reduce((s, g) => s + g.contribution, 0) - r.totalReturn) < 1e-7;
  db.exec("UPDATE holdings SET sector = 'Energy' WHERE symbol = 'ENRGB.L'");
  return allBucketed && noneLost && stillSums;
})());

check('a field that really is empty falls into the engine\'s own bucket', (() => {
  // geography is left null on every seeded holding and has no upstream
  // substitute, so this exercises the fallback that sector does not reach.
  const r = AT.attributionReport(prices, { lookback: 750, grouping: 'geography' });
  return r.available
    && r.groups.every(g => typeof g.group === 'string' && g.group.length > 0)
    && Math.abs(r.groups.reduce((s, g) => s + g.contribution, 0) - r.totalReturn) < 1e-7;
})(), JSON.stringify(AT.attributionReport(prices, { lookback: 750, grouping: 'geography' }).groups?.map(g => g.group)));

check('the caveat about not being benchmark-relative is carried',
  /not benchmark-relative/.test(rep.caveat), rep.caveat);

check('the basis names the fixed-weight assumption',
  /fixed-weight/i.test(rep.basis) && /Trades inside the period/.test(rep.basis), rep.basis);

check('an empty portfolio refuses rather than reporting a zero return', (() => {
  db.exec('DELETE FROM holdings');
  const r = AT.attributionReport({}, { lookback: 750 });
  return r.available === false && typeof r.reason === 'string';
})());

// Restore again.
addHolding({ symbol: 'TECHA.L', qty: 300, sector: 'Technology' });
addHolding({ symbol: 'TECHB.L', qty: 200, sector: 'Technology' });
addHolding({ symbol: 'ENRGA.L', qty: 250, sector: 'Energy' });
addHolding({ symbol: 'ENRGB.L', qty: 400, sector: 'Energy' });

// ─── 7. Commentary ────────────────────────────────────────────

section('Commentary over the reconciled figures');

const rep2 = AT.attributionReport(prices, { lookback: 750, grouping: 'sector', benchmark: '^FTSE' });
const facts = AT.commentaryFacts(rep2);

check('facts are assembled', typeof facts === 'string' && facts.length > 100);
check('they state the period', facts.includes(rep2.from) && facts.includes(rep2.to));
check('they state the total return', facts.includes((rep2.totalReturn * 100).toFixed(2)));
check('they name contributors with their average weights', /average weight/.test(facts));
check('they explain what allocation and selection mean', /Allocation effect means/.test(facts));
check('they carry the portfolio-relative caveat', /not against an index/.test(facts));

const prompt = AT.commentaryPrompt(rep2);
check('the prompt permits concluding that nothing happened',
  /Nothing much drove this period/.test(prompt) && /correct and expected/.test(prompt));
check('the prompt forbids inventing figures',
  /Do not estimate, extrapolate/.test(prompt));
check('the prompt forbids advice and predictions',
  /Do not give advice, make predictions/.test(prompt));
check('the prompt tells the model to separate size from movement',
  /mattered because it was large/.test(prompt));

{
  // Injected model, so this runs with no key and no network.
  let seen = null;
  const fake = async (p) => { seen = p; return 'Technology did the work this period.'; };
  const out = await AT.explain(rep2, { aiFn: fake });
  check('explain returns the model text', out.available === true && out.text.length > 0, JSON.stringify(out));
  check('the model was handed the assembled figures, not the raw report',
    seen.includes('Total portfolio return') && !seen.includes('"holdings"'));
  check('the result says what it was written from', /reconciled attribution figures/.test(out.basis));
}

{
  const blank = await AT.explain(rep2, { aiFn: async () => '   ' });
  check('an empty model response is reported as absent, not rendered as prose',
    blank.available === false, JSON.stringify(blank));
}

{
  const boom = await AT.explain(rep2, { aiFn: async () => { throw new Error('rate limited'); } });
  check('a model failure degrades to a stated reason rather than throwing',
    boom.available === false && /rate limited/.test(boom.reason), JSON.stringify(boom));
}

{
  const noKey = await AT.explain(rep2, { hasKey: false });
  check('with no API key it says so rather than returning a canned sentence',
    noKey.available === false && /No Gemini API key/.test(noKey.reason), JSON.stringify(noKey));
}

{
  const nothing = await AT.explain({ available: false, reason: 'nothing to do' }, { aiFn: async () => 'x' });
  check('an unavailable report is not sent to the model at all',
    nothing.available === false);
}

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n${'='.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`${'='.repeat(52)}\n`);
process.exit(failed ? 1 : 0);
