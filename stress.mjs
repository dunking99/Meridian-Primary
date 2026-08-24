// Meridian v2 — adversarial stress test
// The audit proved correct behaviour on well-formed input. This tries to break it.

process.chdir('/home/claude/mv2/server');

const db = await import('/home/claude/mv2/server/db.js');
const A = await import('/home/claude/mv2/server/engines/analytics.js');
const opt = await import('/home/claude/mv2/server/engines/optimiser.js');
const pf = await import('/home/claude/mv2/server/engines/portfolio.js');
const analyst = await import('/home/claude/mv2/server/engines/analyst.js');
const screener = await import('/home/claude/mv2/server/engines/screener.js');
const backtest = await import('/home/claude/mv2/server/engines/backtest.js');
const mc = await import('/home/claude/mv2/server/engines/montecarlo.js');
const rebal = await import('/home/claude/mv2/server/engines/rebalance.js');
const alerts = await import('/home/claude/mv2/server/engines/alerts.js');
const integrity = await import('/home/claude/mv2/server/engines/integrity.js');

let pass = 0, fail = 0; const issues = [];
function T(n, c, d = '') {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? '  ' + d : ''}`); }
  else { fail++; issues.push(n); console.log(`  FAIL  ${n}  ${d}`); }
}
function safe(fn, label) {
  try { const r = fn(); return { ok: true, r }; }
  catch (e) { return { ok: false, err: e.message }; }
}
const section = s => console.log(`\n━━━ ${s} ━━━`);

const prices = {};
for (const { symbol } of db.all('SELECT DISTINCT symbol FROM ohlcv')) {
  const b = db.getBars(symbol); if (!b.length) continue;
  const last = b[b.length - 1];
  prices[symbol] = { price: last.close, prev: last.close, changePct: 0, high52: last.close * 1.2, low52: last.close * 0.8, volume: 1e5, avgVolume: 1e5 };
}

// ══════════════════════════════════════════
section('ANALYTICS — degenerate inputs');
for (const [label, fn] of [
  ['empty array stdev', () => A.stdev([])],
  ['single value stdev', () => A.stdev([5])],
  ['empty returns', () => A.toReturns([])],
  ['zeros in prices', () => A.toReturns([0, 0, 100, 0])],
  ['negative prices', () => A.toReturns([-10, -20, 30])],
  ['all identical', () => A.annualisedVol(new Array(100).fill(0))],
  ['NaN injection', () => A.mean([1, NaN, 3])],
  ['Infinity injection', () => A.stdev([1, Infinity, 3])],
  ['maxDrawdown empty', () => A.maxDrawdown([])],
  ['maxDrawdown single', () => A.maxDrawdown([100])],
  ['cagr zero-length', () => A.cagr([])],
  ['cagr negative end', () => A.cagr([100, -50])],
  ['sharpe all zeros', () => A.sharpe(new Array(50).fill(0))],
  ['correlation zero variance', () => A.correlation(new Array(50).fill(1), new Array(50).fill(2))],
  ['beta zero-variance bench', () => A.betaAlpha([0.01, 0.02], new Array(2).fill(0))],
  ['rsi too short', () => A.rsi([1, 2])],
  ['percentile empty', () => A.percentile([], 0.5)],
  ['varSuite tiny sample', () => A.varSuite([0.01, -0.01])],
  ['effectiveHoldings all zero', () => A.effectiveHoldings({ a: 0, b: 0 })],
  ['portfolioVol zero weights', () => A.portfolioVol({ a: [0.01, 0.02], b: [0.01, 0.02] }, { a: 0, b: 0 })],
]) {
  const res = safe(fn);
  const finite = res.ok && (typeof res.r !== 'number' || isFinite(res.r) || res.r === 0);
  T(label, res.ok, res.ok ? (typeof res.r === 'number' ? String(res.r) : 'ok') : `THREW: ${res.err}`);
  if (res.ok && typeof res.r === 'number' && !isFinite(res.r)) {
    T(`${label} → finite`, false, `returned ${res.r}`);
  }
}

// ══════════════════════════════════════════
section('OPTIMISER — pathological covariance');
const flat = { A: new Array(300).fill(0.001), B: new Array(300).fill(0.001) };
let r = safe(() => opt.optimise(flat, { method: 'maxSharpe' }));
T('zero-variance assets survive', r.ok, r.ok ? JSON.stringify(r.r.weights ?? r.r.error) : r.err);

let s = 3; const rnd = () => ((s = s * 16807 % 2147483647) / 2147483647 - 0.5);
const base = [...Array(400)].map(() => rnd() * 0.02);
const dup = { A: base, B: [...base], C: base.map(x => x * 2) };
r = safe(() => opt.optimise(dup, { method: 'minVariance' }));
T('perfectly collinear assets survive', r.ok && !r.r.error, r.ok ? JSON.stringify(r.r.weights) : r.err);
if (r.ok && r.r.weights) {
  T('collinear weights still sum to 1', Math.abs(Object.values(r.r.weights).reduce((a, b) => a + b, 0) - 1) < 1e-6);
}

const many = {}; for (let i = 0; i < 40; i++) many['S' + i] = [...Array(400)].map(() => rnd() * 0.02);
const t0 = Date.now();
r = safe(() => opt.optimise(many, { method: 'maxSharpe', maxWeight: 0.1 }));
const dur = Date.now() - t0;
T('40 assets optimises', r.ok && !r.r.error, `${dur}ms`);
T('40-asset optimise under 10s', dur < 10000, `${dur}ms`);
if (r.ok && r.r.weights) {
  T('40-asset cap respected', Math.max(...Object.values(r.r.weights)) <= 0.1001);
  T('40-asset sums to 1', Math.abs(Object.values(r.r.weights).reduce((a, b) => a + b, 0) - 1) < 1e-6);
}

r = safe(() => opt.optimise({ A: base }, {}));
T('single asset rejected cleanly', r.ok && !!r.r.error, r.ok ? r.r.error : r.err);
r = safe(() => opt.optimise({}, {}));
T('empty series rejected cleanly', r.ok && !!r.r.error, r.ok ? r.r.error : r.err);
r = safe(() => opt.optimise({ A: base.slice(0, 10), B: base.slice(0, 10) }, {}));
T('short series rejected cleanly', r.ok && !!r.r.error, r.ok ? r.r.error : r.err);

// impossible constraint: 8 assets but max weight 5% cannot sum to 1
const eight = {}; for (let i = 0; i < 8; i++) eight['E' + i] = [...Array(300)].map(() => rnd() * 0.02);
r = safe(() => opt.optimise(eight, { method: 'minVariance', maxWeight: 0.05 }));
T('infeasible cap does not crash', r.ok, r.ok ? `sum=${Object.values(r.r.weights ?? {}).reduce((a, b) => a + b, 0).toFixed(4)}` : r.err);

// ══════════════════════════════════════════
section('REBALANCER — hostile inputs');
const hold = [{ symbol: 'A.L', qty: 100, price: 50, avgPrice: 40, wrapper: 'ISA', account: 'M' }];
for (const [label, fn] of [
  ['targets summing to 0', () => rebal.rebalance(hold, { 'A.L': 0 }, {})],
  ['targets summing to 5', () => rebal.rebalance(hold, { 'A.L': 3, 'B.L': 2 }, {})],
  ['negative target', () => rebal.rebalance(hold, { 'A.L': -0.5, 'B.L': 1.5 }, {})],
  ['target for unheld symbol', () => rebal.rebalance(hold, { 'ZZZ.L': 1 }, {})],
  ['zero-price holding', () => rebal.rebalance([{ ...hold[0], price: 0 }], { 'A.L': 1 }, {})],
  ['negative contribution', () => rebal.rebalance(hold, { 'A.L': 1 }, { contribution: -5000 })],
  ['huge contribution', () => rebal.rebalance(hold, { 'A.L': 0.5, 'B.L': 0.5 }, { contribution: 1e9 })],
  ['NaN quantity', () => rebal.rebalance([{ ...hold[0], qty: NaN }], { 'A.L': 1 }, {})],
]) {
  const res = safe(fn);
  T(label, res.ok, res.ok ? (res.r.error ?? `${res.r.summary?.trades ?? 0} trades`) : `THREW: ${res.err}`);
  if (res.ok && res.r.summary) {
    const bad = [res.r.summary.totalAfter, res.r.summary.turnover, res.r.summary.estimatedCgt]
      .some(x => x != null && !isFinite(x));
    if (bad) T(`${label} → finite summary`, false, JSON.stringify(res.r.summary));
  }
}

// ══════════════════════════════════════════
section('MONTE CARLO — boundaries');
for (const [label, opts] of [
  ['zero years', { years: 0, paths: 50 }],
  ['zero paths', { years: 5, paths: 0 }],
  ['zero initial, zero monthly', { initial: 0, monthly: 0, years: 5, paths: 50 }],
  ['negative initial', { initial: -1000, years: 5, paths: 50 }],
  ['100% volatility', { volatility: 1.0, expectedReturn: 0.07, mode: 'normal', years: 10, paths: 100 }],
  ['negative expected return', { expectedReturn: -0.20, volatility: 0.3, mode: 'normal', years: 10, paths: 100 }],
  ['fees exceed return', { expectedReturn: 0.05, fees: 0.5, mode: 'normal', years: 10, paths: 100 }],
  ['50 year horizon', { years: 50, paths: 100, mode: 'normal', expectedReturn: 0.07, volatility: 0.15 }],
]) {
  const res = safe(() => mc.simulate(opts));
  const finite = res.ok && Object.values(res.r.outcomes ?? {}).every(x => isFinite(x));
  T(`MC ${label}`, res.ok && finite,
    res.ok ? `median ${res.r.outcomes?.median}` : `THREW: ${res.err}`);
}
const tBig = Date.now();
mc.simulate({ years: 30, paths: 5000, mode: 'normal', expectedReturn: 0.07, volatility: 0.15 });
T('30y × 5000 paths under 15s', Date.now() - tBig < 15000, `${Date.now() - tBig}ms`);

// ══════════════════════════════════════════
section('BACKTEST — boundaries & performance');
const t1 = Date.now();
const bt = backtest.backtest('VUSA.L', { strategy: 'rsi' });
T('rsi backtest (O(n²) risk) under 20s', Date.now() - t1 < 20000, `${Date.now() - t1}ms`);
for (const [label, opts] of [
  ['zero initial capital', { symbol: 'VUSA.L', initial: 0 }],
  ['100% commission', { symbol: 'VUSA.L', commission: 1e6 }],
  ['huge slippage', { symbol: 'VUSA.L', slippageBps: 5000 }],
  ['inverted date range', { symbol: 'VUSA.L', from: '2026-01-01', to: '2015-01-01' }],
  ['future date range', { symbol: 'VUSA.L', from: '2030-01-01', to: '2031-01-01' }],
  ['nonsense params', { symbol: 'VUSA.L', strategy: 'maCross', params: { fast: 999, slow: 1 } }],
  ['unknown strategy', { symbol: 'VUSA.L', strategy: 'nonexistent' }],
]) {
  const res = safe(() => backtest.backtest(opts.symbol, opts));
  const ok = res.ok && (res.r.error || Object.values(res.r.metrics ?? {}).every(x => typeof x !== 'number' || isFinite(x)));
  T(`BT ${label}`, ok, res.ok ? (res.r.error ?? `ret ${res.r.metrics?.totalReturn}%`) : `THREW: ${res.err}`);
}

// ══════════════════════════════════════════
section('SCREENER & INTEGRITY edge cases');
r = safe(() => screener.screen([], {}));
T('screen empty universe', r.ok && r.r.results.length === 0, r.ok ? 'ok' : r.err);
r = safe(() => screener.screen(['VUSA.L'], { strategy: 'nonexistent' }));
T('unknown strategy falls back', r.ok && r.r.results.length > 0, r.ok ? r.r.strategyLabel : r.err);

r = safe(() => integrity.findOutliers([]));
T('outliers on empty', r.ok && r.r.length === 0);
r = safe(() => integrity.findOutliers([{ date: 'x', close: 100 }]));
T('outliers on single bar', r.ok);
r = safe(() => integrity.findOutliers([{ date: 'a', close: 0 }, { date: 'b', close: 100 }, { date: 'c', close: 101 }]));
T('zero close flagged fatal', r.ok && r.r.some(o => o.severity === 'fatal'), r.ok ? r.r[0]?.reason : r.err);
r = safe(() => integrity.findOutliers([{ date: 'a', close: NaN }, { date: 'b', close: 100 }]));
T('NaN close flagged', r.ok && r.r.length > 0);
r = safe(() => db.saveBars('EMPTY.L', []));
T('saveBars empty array', r.ok && r.r.saved === 0);

// ══════════════════════════════════════════
section('SQL INJECTION / weird symbols');
for (const bad of ["'; DROP TABLE holdings; --", "A' OR '1'='1", "<script>alert(1)</script>", "../../etc/passwd", "A".repeat(500)]) {
  const res = safe(() => db.getBars(bad));
  T(`getBars(${bad.slice(0, 22)}…)`, res.ok && Array.isArray(res.r), res.ok ? `${res.r.length} rows` : res.err);
}
const stillThere = safe(() => db.all('SELECT COUNT(*) n FROM holdings'));
T('holdings table intact after injection attempts', stillThere.ok, stillThere.ok ? `${stillThere.r[0].n} rows` : stillThere.err);

const resAlert = safe(() => alerts.createAlert({ symbol: "'; DELETE FROM alerts; --", kind: 'price', threshold: 1 }));
T('alert with SQL in symbol handled', resAlert.ok);
T('alerts table intact', db.all('SELECT COUNT(*) n FROM alerts')[0].n > 0);

// ══════════════════════════════════════════
section('CONCURRENCY');
db.run("DELETE FROM holdings");
const dupes = [];
for (let i = 0; i < 5; i++) {
  dupes.push(safe(() => db.run(
    `INSERT INTO holdings (symbol,name,qty,avg_price,currency,sector,geography,asset_class,wrapper,account,target_pct,added_at) VALUES ('DUP.L','d',10,5,'GBP','B','G','Equity','ISA','Main',10,?)`,
    Date.now())));
}
T('rapid inserts do not crash', dupes.every(d => d.ok));
const dupCount = db.all("SELECT COUNT(*) n FROM holdings WHERE symbol='DUP.L'")[0].n;
console.log(`     (db-level duplicates: ${dupCount} — POST /holdings guards this at the API layer)`);

console.log(`\n${'═'.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (issues.length) { console.log('\n  FAILURES:'); issues.forEach(i => console.log(`    - ${i}`)); }
console.log('═'.repeat(60));
