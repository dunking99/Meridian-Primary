// Meridian — rebuild pipeline test harness
//
// Run: MERIDIAN_DB=/tmp/rebuild-test.db node scripts/test-rebuild.mjs
//
// Why this exists as a committed script rather than a throwaway: the rebuild
// pipeline makes buy and sell recommendations about real money from a chain of
// six engines, and "it ran without throwing" is not evidence that any of them
// reached the right answer. The only way to know a stage works is to hand it
// data whose correct answer is known in advance and check it finds it.
//
// So this builds a synthetic portfolio with deliberate, known faults:
//
//   CORE.L  a sound, cheap fund                      -> should survive
//   TWIN.L  built to be ~0.98 correlated with CORE.L
//           and four times the cost                  -> should be caught as a
//                                                       duplicate and dropped
//                                                       in favour of CORE.L
//   DIVR.L  an independent series                    -> should survive as a
//                                                       genuine diversifier
//   JUNK.L  negative drift, high vol, deep drawdown  -> should fail the
//                                                       conviction bar and be
//                                                       proposed for sale
//   NEWG.L  strong, cheap, not currently held        -> should be discovered
//                                                       and proposed as a buy
//
// Every series is generated from a seeded PRNG, so a failure here is
// reproducible rather than a one-off draw. Bars are written through the real
// saveBars() validation path, not inserted directly, so the data is subject to
// the same integrity checks live data is.

import { randomBytes } from 'crypto';

const DB = process.env.MERIDIAN_DB;
if (!DB) {
  console.error('Set MERIDIAN_DB to a throwaway path before running this.');
  process.exit(1);
}
if (DB.includes('meridian.db')) {
  console.error('Refusing to run against the real database. Point MERIDIAN_DB somewhere disposable.');
  process.exit(1);
}

const { db, run, saveBars, all } = await import('../server/db.js');
const rebuild = await import('../server/engines/rebuild/index.js');
const exposure = await import('../server/engines/rebuild/exposure.js');
const construct = await import('../server/engines/rebuild/construct.js');
const { assembleUniverse } = await import('../server/engines/rebuild/universe.js');

// ─── Assertions ───────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

// ─── Deterministic synthetic series ───────────────────────────

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so the driving shocks are genuinely normal rather than uniform
 *  noise that would give every series the wrong tail behaviour. */
function normals(rng, n) {
  const out = [];
  while (out.length < n) {
    const u1 = Math.max(rng(), 1e-12), u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(r * Math.cos(2 * Math.PI * u2));
    out.push(r * Math.sin(2 * Math.PI * u2));
  }
  return out.slice(0, n);
}

function tradingDates(n) {
  const out = [];
  const d = new Date('2026-09-01T00:00:00Z');
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out.reverse();
}

/** Geometric Brownian motion from a supplied shock series, so two assets can
 *  be given a known correlation by sharing shocks. */
function gbm(shocks, { start = 100, drift = 0.08, vol = 0.15 }) {
  const dt = 1 / 252;
  const closes = [start];
  for (const z of shocks) {
    const prev = closes[closes.length - 1];
    closes.push(prev * Math.exp((drift - 0.5 * vol * vol) * dt + vol * Math.sqrt(dt) * z));
  }
  return closes.slice(1);
}

function seedSeries(symbol, closes, dates) {
  const bars = closes.map((c, i) => ({
    date: dates[i],
    open: +(c * 0.999).toFixed(4),
    high: +(c * 1.006).toFixed(4),
    low: +(c * 0.994).toFixed(4),
    close: +c.toFixed(4),
    adjClose: +c.toFixed(4),
    volume: 1_000_000,
  }));
  const res = saveBars(symbol, bars);
  if (res.saved < bars.length * 0.95) {
    throw new Error(`${symbol}: only ${res.saved}/${bars.length} bars survived validation`);
  }
  return closes[closes.length - 1];
}

// ─── Build the world ──────────────────────────────────────────

section('Seeding synthetic world');

db.exec('DELETE FROM ohlcv; DELETE FROM holdings; DELETE FROM cash; DELETE FROM watchlist; DELETE FROM instrument_composition; DELETE FROM rebuild_runs; DELETE FROM settings;');

const N = 1000;
const dates = tradingDates(N);
const rng = mulberry32(20260912);

const zCore = normals(rng, N);
const zIdio = normals(rng, N);
const zDivr = normals(rng, N);
const zJunk = normals(rng, N);
const zNew = normals(rng, N);

// rho = 0.98 : z_twin = rho*z_core + sqrt(1-rho^2)*z_idio
const RHO = 0.98;
const zTwin = zCore.map((z, i) => RHO * z + Math.sqrt(1 - RHO * RHO) * zIdio[i]);

const lastPrice = {};
lastPrice['CORE.L'] = seedSeries('CORE.L', gbm(zCore, { start: 100, drift: 0.10, vol: 0.15 }), dates);
lastPrice['TWIN.L'] = seedSeries('TWIN.L', gbm(zTwin, { start: 100, drift: 0.095, vol: 0.155 }), dates);
lastPrice['DIVR.L'] = seedSeries('DIVR.L', gbm(zDivr, { start: 100, drift: 0.07, vol: 0.13 }), dates);
lastPrice['JUNK.L'] = seedSeries('JUNK.L', gbm(zJunk, { start: 100, drift: -0.12, vol: 0.42 }), dates);
lastPrice['NEWG.L'] = seedSeries('NEWG.L', gbm(zNew, { start: 100, drift: 0.13, vol: 0.16 }), dates);

console.log(`  seeded 5 symbols x ${N} bars (${dates[0]} to ${dates[dates.length - 1]})`);

// Holdings: CORE and TWIN are the deliberate duplicate pair.
const holdings = [
  { symbol: 'CORE.L', qty: 200, avg: 90, sector: 'Global Equity' },
  { symbol: 'TWIN.L', qty: 180, avg: 95, sector: 'Global Equity' },
  { symbol: 'DIVR.L', qty: 150, avg: 88, sector: 'Diversified' },
  { symbol: 'JUNK.L', qty: 300, avg: 120, sector: 'Speculative' },
];
for (const h of holdings) {
  run(`INSERT INTO holdings (symbol, name, qty, avg_price, currency, sector, geography, asset_class, account, wrapper, added_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      h.symbol, `${h.symbol} Fund`, h.qty, h.avg, 'GBP', h.sector, 'Global', 'Equity', 'Main', 'ISA', Date.now());
}
run(`INSERT INTO cash (account, wrapper, currency, amount, updated_at) VALUES (?,?,?,?,?)`,
    'Main', 'ISA', 'GBP', 7000, Date.now());
run(`INSERT INTO watchlist (symbol, tier, added_at) VALUES (?,?,?)`, 'NEWG.L', 1, Date.now());

// Compositions. CORE and TWIN deliberately share eight of ten names at similar
// weights — the composition half of the duplicate evidence. DIVR shares none.
const megacaps = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];
exposure.saveComposition({
  symbol: 'CORE.L', name: 'CORE Global Index', category: 'ETF', expenseRatio: 0.07,
  holdings: [...megacaps.map((s, i) => ({ symbol: s, name: `${s} Corp`, weight: 0.06 - i * 0.004 })),
             { symbol: 'XXX', name: 'XXX Corp', weight: 0.015 }, { symbol: 'YYY', name: 'YYY Corp', weight: 0.012 }],
  sectors: { technology: 0.31, financial_services: 0.14, healthcare: 0.12, consumer_cyclical: 0.11, industrials: 0.09 },
  asOf: '2026-09-01',
});
exposure.saveComposition({
  symbol: 'TWIN.L', name: 'TWIN World Index', category: 'Fund', expenseRatio: 0.28,
  holdings: [...megacaps.map((s, i) => ({ symbol: s, name: `${s} Corporation`, weight: 0.055 - i * 0.004 })),
             { symbol: 'ZZZ', name: 'ZZZ Inc', weight: 0.014 }, { symbol: 'WWW', name: 'WWW Inc', weight: 0.011 }],
  sectors: { technology: 0.29, financial_services: 0.15, healthcare: 0.12, consumer_cyclical: 0.10, industrials: 0.10 },
  asOf: '2026-09-01',
});
exposure.saveComposition({
  symbol: 'DIVR.L', name: 'DIVR Alternative', category: 'ETF', expenseRatio: 0.19,
  holdings: [{ symbol: 'QQQ1', name: 'Alpha Mining', weight: 0.08 }, { symbol: 'QQQ2', name: 'Beta Energy', weight: 0.07 },
             { symbol: 'QQQ3', name: 'Gamma Utilities', weight: 0.06 }],
  sectors: { energy: 0.34, utilities: 0.28, basic_materials: 0.22, industrials: 0.16 },
  asOf: '2026-09-01',
});
exposure.saveComposition({
  symbol: 'NEWG.L', name: 'NEWG Growth', category: 'ETF', expenseRatio: 0.12,
  holdings: [{ symbol: 'NG1', name: 'Newco One', weight: 0.09 }, { symbol: 'NG2', name: 'Newco Two', weight: 0.08 }],
  sectors: { technology: 0.44, communication_services: 0.21, consumer_cyclical: 0.20, healthcare: 0.15 },
  asOf: '2026-09-01',
});
console.log('  seeded compositions for 4 symbols (JUNK.L deliberately left without one)');

const prices = Object.fromEntries(Object.entries(lastPrice).map(([s, p]) => [s, {
  price: p, currency: 'GBP', changePct: 0,
}]));

// SEED_ONLY builds the synthetic world and stops, so the same fixtures can
// back a dev server for frontend work without the destructive edge-case
// section below tearing them down again.
if (process.env.SEED_ONLY === '1') {
  console.log('\nSEED_ONLY set — world seeded, stopping before assertions.');
  process.exit(0);
}

// ─── Stage A: exposure teardown ───────────────────────────────

section('Stage A — exposure teardown');

const pair = exposure.pairOverlap('CORE.L', 'TWIN.L', {
  compositions: exposure.listCompositions(['CORE.L', 'TWIN.L']),
});
console.log(`  CORE.L/TWIN.L: verdict=${pair.verdict} score=${pair.score}`);
console.log(`    ${pair.basis.join(' | ')}`);
check('duplicate pair is caught', pair.verdict === 'duplicate', `got "${pair.verdict}"`);
check('correlation evidence is present and high',
  pair.evidence.correlation?.available && pair.evidence.correlation.correlation > 0.95,
  `corr=${pair.evidence.correlation?.correlation}`);
check('composition overlap is measured and substantial',
  pair.evidence.holdings && pair.evidence.holdings.atLeast > 0.30,
  `overlap=${pair.evidence.holdings?.atLeast}`);
check('overlap is reported as a floor, not a point estimate',
  pair.evidence.holdings?.truncated === true);

const unrelated = exposure.pairOverlap('CORE.L', 'DIVR.L', {
  compositions: exposure.listCompositions(['CORE.L', 'DIVR.L']),
});
console.log(`  CORE.L/DIVR.L: verdict=${unrelated.verdict} score=${unrelated.score}`);
check('genuinely different pair is not flagged as duplicate',
  unrelated.verdict === 'distinct' || unrelated.verdict === 'related',
  `got "${unrelated.verdict}"`);

const noData = exposure.pairOverlap('CORE.L', 'ABSENT.L', { compositions: {} });
check('a pair with no data reports cannot-assess, never "distinct"',
  noData.verdict === 'cannot-assess', `got "${noData.verdict}"`);

// ─── Universe ─────────────────────────────────────────────────

section('Stage C — universe');

const scan = assembleUniverse({ holdingsSymbols: holdings.map(h => h.symbol) });
const scanned = scan.candidates.map(c => c.symbol);
console.log(`  ${scan.counts.candidates} candidates, ${scan.counts.skipped} skipped`);

check('all four holdings are candidates',
  ['CORE.L', 'TWIN.L', 'DIVR.L', 'JUNK.L'].every(s => scanned.includes(s)));
check('the watchlist candidate is discovered', scanned.includes('NEWG.L'));
check('indices are never proposed as investable', !scanned.includes('^GSPC') && !scanned.includes('^FTSE'));
check('FX pairs are never proposed as investable', !scanned.includes('GBPUSD=X'));
check('futures are never proposed as investable', !scanned.includes('GC=F') && !scanned.includes('CL=F'));
check('yields are never proposed as investable', !scanned.includes('^TNX'));

// ─── Full pipeline ────────────────────────────────────────────

section('Full pipeline');

const report = rebuild.runRebuild(prices, { save: false });
console.log(`  ok=${report.ok} elapsed=${report.elapsedMs}ms`);
check('pipeline produced a report', report.ok === true, report.error ?? '');

if (!report.ok) {
  console.log('\nPipeline failed — remaining checks skipped.');
  summarise();
  process.exit(1);
}

const dil = report.stages.diligence;
const byCandidate = Object.fromEntries(dil.candidates.map(c => [c.symbol, c]));
console.log('  conviction by candidate:');
for (const c of dil.candidates.sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0))) {
  console.log(`    ${c.symbol.padEnd(9)} conviction=${c.conviction == null ? 'n/a' : c.conviction.toFixed(3)}` +
              ` evidence=${c.evidence == null ? 'n/a' : (c.evidence * 100).toFixed(0) + '%'} -> ${c.verdict}`);
}

section('Stages E-G — diligence verdicts');

check('the junk holding fails the conviction bar',
  byCandidate['JUNK.L']?.verdict === 'excluded',
  `verdict=${byCandidate['JUNK.L']?.verdict} conviction=${byCandidate['JUNK.L']?.conviction}`);
check('the junk holding scores below the sound one',
  (byCandidate['JUNK.L']?.conviction ?? 1) < (byCandidate['CORE.L']?.conviction ?? 0),
  `JUNK=${byCandidate['JUNK.L']?.conviction} CORE=${byCandidate['CORE.L']?.conviction}`);
check('the strong unheld candidate passes',
  byCandidate['NEWG.L']?.verdict === 'included',
  `verdict=${byCandidate['NEWG.L']?.verdict} conviction=${byCandidate['NEWG.L']?.conviction}`);
check('every exclusion carries a reason',
  dil.candidates.filter(c => c.verdict === 'excluded').every(c => !!c.reason));
check('an unmeasurable component is reported missing, not defaulted',
  byCandidate['JUNK.L']?.components?.cost?.available === false &&
  byCandidate['JUNK.L']?.components?.cost?.reason != null,
  'JUNK.L has no stored expense ratio and should say so');
check('evidence share is reported for every scored candidate',
  dil.candidates.filter(c => c.conviction != null).every(c => typeof c.evidence === 'number'));

section('Redundancy resolution');

const red = report.stages.redundancy;
const droppedSymbols = red.dropped.map(d => d.symbol);
console.log(`  survivors: ${red.survivors.join(', ')}`);
console.log(`  dropped:   ${droppedSymbols.join(', ') || '(none)'}`);
for (const d of red.dropped) console.log(`    ${d.symbol}: ${d.reason}`);

check('exactly one of the duplicate pair survives',
  (red.survivors.includes('CORE.L') ? 1 : 0) + (red.survivors.includes('TWIN.L') ? 1 : 0) === 1,
  `survivors=${red.survivors.join(',')}`);
check('the cheaper duplicate is the one kept',
  red.survivors.includes('CORE.L') && droppedSymbols.includes('TWIN.L'),
  'CORE.L costs 0.07% vs TWIN.L at 0.28%');
check('the dropped duplicate says what it was dropped for',
  red.dropped.find(d => d.symbol === 'TWIN.L')?.droppedFor === 'CORE.L');
check('the genuine diversifier is not collapsed away', red.survivors.includes('DIVR.L'));

section('Stage H — construction');

const built = report.stages.construction;
const tw = built.targetWeights;
const sumW = Object.values(tw).reduce((a, b) => a + b, 0);
console.log('  target weights:');
for (const [s, w] of Object.entries(tw).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${s.padEnd(9)} ${(w * 100).toFixed(2)}%`);
}

check('weights never exceed 1', sumW <= 1 + 1e-6, `sum=${sumW}`);
check('any shortfall against 1 is declared as uninvested, not renormalised away',
  Math.abs((built.constraints.investedShare ?? sumW) - sumW) < 1e-6 &&
  Math.abs((built.constraints.investedShare ?? 0) + (built.constraints.uninvestedShare ?? 0) - 1) < 1e-6,
  `invested=${built.constraints.investedShare} uninvested=${built.constraints.uninvestedShare}`);
check('no weight is negative', Object.values(tw).every(w => w >= 0));
check('position cap is respected',
  Object.values(tw).every(w => w <= report.mandate.maxPositionPct / 100 + 1e-6),
  `max=${Math.max(...Object.values(tw))}`);
check('minimum position size is respected',
  Object.values(tw).filter(w => w > 0).every(w => w >= report.mandate.minPositionPct / 100 - 1e-6),
  `min=${Math.min(...Object.values(tw).filter(w => w > 0))}`);
check('position count is within the mandate',
  Object.values(tw).filter(w => w > 0).length <= report.mandate.maxPositions);
check('the dropped duplicate gets no weight', !(tw['TWIN.L'] > 0));
check('the junk holding gets no weight', !(tw['JUNK.L'] > 0));
check('expected returns are conviction-tilted, not raw historical means',
  built.expectedReturns?.note?.includes('conviction') || built.expectedReturns?.maxTiltPct != null);
check('conviction tilt is capped at the mandate value',
  built.expectedReturns.maxTiltPct <= report.mandate.convictionTiltPct + 1e-9,
  `tilt=${built.expectedReturns.maxTiltPct} cap=${report.mandate.convictionTiltPct}`);

section('Trade list');

const actions = built.actions;
const byAction = Object.fromEntries(actions.map(a => [a.symbol, a]));
for (const a of actions) {
  console.log(`    ${a.action.padEnd(5)} ${a.symbol.padEnd(9)} ${a.currentWeightPct.toFixed(1)}% -> ${a.targetWeightPct.toFixed(1)}%  (${a.deltaValue >= 0 ? '+' : ''}${a.deltaValue.toFixed(0)})`);
}

check('the junk holding is proposed for sale', byAction['JUNK.L']?.action === 'SELL');
check('the duplicate is proposed for sale', byAction['TWIN.L']?.action === 'SELL');
check('the new candidate is proposed for purchase', byAction['NEWG.L']?.action === 'BUY');
check('a sale is a full exit, not a partial', byAction['JUNK.L']?.targetWeightPct === 0);
check('turnover is reported', typeof built.summary.turnoverPct === 'number');
check('units are only stated where a price is known',
  actions.every(a => (a.units == null) === (a.priceKnown === false)));
check('cash after equals whatever the target weights did not claim',
  Math.abs(built.summary.cashAfter - (report.portfolio.total - built.summary.investedAfter)) < 1,
  `cashAfter=${built.summary.cashAfter} investedAfter=${built.summary.investedAfter}`);
check('cash held is at least the mandate buffer',
  built.summary.cashAfter >= report.portfolio.total * report.mandate.cashBufferPct / 100 - 1,
  `cashAfter=${built.summary.cashAfter}`);

section('Risk and stress comparison');

const risk = built.risk;
if (risk.current.available && risk.proposed.available) {
  console.log(`  vol:            ${risk.current.annualVolPct}% -> ${risk.proposed.annualVolPct}%`);
  console.log(`  diversification: ${risk.current.diversificationRatio} -> ${risk.proposed.diversificationRatio}`);
  console.log(`  effective holdings: ${risk.current.effectiveHoldings} -> ${risk.proposed.effectiveHoldings}`);
}
check('risk is computed for both current and proposed',
  risk.current.available && risk.proposed.available);
check('the change between them is reported', risk.changes != null);
check('removing a duplicate and a junk holding does not reduce diversification',
  risk.proposed.diversificationRatio >= risk.current.diversificationRatio - 0.05,
  `${risk.current.diversificationRatio} -> ${risk.proposed.diversificationRatio}`);
check('stress scenarios ran for both portfolios',
  report.stress?.current?.results?.length > 0 && report.stress?.proposed?.results?.length > 0);

section('Honesty properties');

check('data gaps are collected and surfaced', Array.isArray(report.dataGaps));
// A report that contradicts itself is worse than one that says nothing: a
// symbol cannot both be sized into the proposal and be reported as absent
// from it for want of history.
check('nothing in the proposal is also reported as missing from it',
  (built.withoutHistory ?? []).every(s => !(tw[s] > 0)),
  `withoutHistory=${JSON.stringify(built.withoutHistory)} weighted=${JSON.stringify(Object.keys(tw))}`);
check('the gap list does not name holdings that were actually sized',
  !report.dataGaps.some(g => g.stage === 'construction' &&
    /absent from the proposal/.test(g.issue) &&
    Object.keys(tw).some(s => g.issue.includes(s))),
  JSON.stringify(report.dataGaps.filter(g => g.stage === 'construction')));
check('the missing news gate is declared, not silently passed',
  report.dataGaps.some(g => g.issue.toLowerCase().includes('news')),
  'no news is stored in this synthetic world, and the report should say so');
check('the mandate is echoed with the report', report.mandate?.riskLevel === 'high');
check('no tax field appears anywhere in the report',
  !/\b(cgt|capitalGains|taxable|taxDue)\b/i.test(JSON.stringify(report)),
  'this pipeline must not model tax');

// ─── Edge cases ───────────────────────────────────────────────

section('Edge cases');

// A portfolio where nothing can be assessed at all.
db.exec('DELETE FROM ohlcv WHERE symbol IN (\'DIVR.L\',\'NEWG.L\',\'CORE.L\',\'TWIN.L\',\'JUNK.L\')');
const starved = rebuild.runRebuild(prices, { save: false });
check('a portfolio with no usable history fails loudly rather than inventing weights',
  starved.ok === false || Object.keys(starved.stages?.construction?.targetWeights ?? {}).length === 0,
  `ok=${starved.ok}`);
check('the failure explains itself',
  !!(starved.error || starved.stages?.construction?.error),
  starved.error ?? starved.stages?.construction?.error ?? 'no error message');

// Restore, then test a single-holding portfolio.
seedSeries('CORE.L', gbm(zCore, { start: 100, drift: 0.10, vol: 0.15 }), dates);
db.exec("DELETE FROM holdings WHERE symbol != 'CORE.L'");
db.exec("DELETE FROM watchlist");
const single = rebuild.runRebuild({ 'CORE.L': prices['CORE.L'] }, { save: false });
check('a one-holding portfolio does not crash',
  single && typeof single.ok === 'boolean');
check('a one-holding portfolio explains why it cannot be optimised',
  single.ok === false || !!single.stages?.construction?.error || Object.keys(single.stages?.construction?.targetWeights ?? {}).length > 0);

// An impossible mandate must be reported, not silently satisfied.
const { resolveMandate } = await import('../server/engines/rebuild/mandate.js');
const impossible = resolveMandate({
  riskLevel: 'high', horizon: 'long',
  overrides: { maxPositionPct: 10, maxPositions: 4, cashBufferPct: 0 },
});
check('an unsatisfiable constraint set is detected',
  impossible.conflicts.length > 0,
  `conflicts=${JSON.stringify(impossible.conflicts)}`);
console.log(`    ${impossible.conflicts[0] ?? ''}`);

// Constraint enforcement in isolation, with a deliberately concentrated input.
const capped = construct.applyConstraints(
  { A: 0.70, B: 0.20, C: 0.06, D: 0.04 },
  {
    mandate: { maxPositionPct: 30, maxSectorPct: 50, minPositionPct: 5, maxPositions: 8 },
    sectors: {
      A: { distribution: { Tech: 1 } }, B: { distribution: { Tech: 1 } },
      C: { distribution: { Energy: 1 } }, D: { distribution: { Energy: 1 } },
    },
  });
const cw = capped.weights;
console.log(`    capped: ${Object.entries(cw).map(([k, v]) => `${k}=${(v * 100).toFixed(1)}%`).join(' ')}` +
            ` (invested ${(capped.investedShare * 100).toFixed(1)}%, uninvested ${(capped.uninvestedShare * 100).toFixed(1)}%)`);
check('a concentrated input is brought under the position cap',
  Object.values(cw).every(w => w <= 0.30 + 1e-6),
  JSON.stringify(cw));
check('the sector cap is enforced across members',
  (cw.A ?? 0) + (cw.B ?? 0) <= 0.50 + 1e-6,
  `Tech=${((cw.A ?? 0) + (cw.B ?? 0)).toFixed(4)}`);
check('an infeasible cap set leaves the remainder uninvested rather than breaching',
  capped.uninvestedShare > 0 &&
  Math.abs(capped.investedShare + capped.uninvestedShare - 1) < 1e-6,
  `invested=${capped.investedShare} uninvested=${capped.uninvestedShare}`);
check('the uninvested remainder is explained to the user',
  capped.adjustments.some(a => a.rule === 'feasibility'),
  JSON.stringify(capped.adjustments.map(a => a.rule)));
check('the rescaling mechanism is disclosed', !!capped.note);

// Proportional sector attribution: a broad fund that is only part technology
// must not be capped as though it were a pure technology fund.
const mixed = construct.applyConstraints(
  { BROAD: 0.5, PURETECH: 0.5 },
  {
    mandate: { maxPositionPct: 60, maxSectorPct: 50, minPositionPct: 1, maxPositions: 8 },
    sectors: {
      BROAD: { distribution: { Tech: 0.3, Health: 0.4, Energy: 0.3 } },
      PURETECH: { distribution: { Tech: 1 } },
    },
  });
const mw = mixed.weights;
const techExposure = (mw.BROAD ?? 0) * 0.3 + (mw.PURETECH ?? 0) * 1;
console.log(`    mixed: BROAD=${((mw.BROAD ?? 0) * 100).toFixed(1)}% PURETECH=${((mw.PURETECH ?? 0) * 100).toFixed(1)}%` +
            ` -> tech exposure ${(techExposure * 100).toFixed(1)}%`);
check('sector cap is applied to real proportional exposure',
  techExposure <= 0.50 + 1e-6, `tech=${(techExposure * 100).toFixed(2)}%`);
check('the diversified fund takes less of the cut than the concentrated one',
  (mw.BROAD ?? 0) > (mw.PURETECH ?? 0),
  `BROAD=${mw.BROAD} PURETECH=${mw.PURETECH}`);

// ─── Summary ──────────────────────────────────────────────────

function summarise() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  console.log(`${'='.repeat(60)}\n`);
}

summarise();
process.exit(failed ? 1 : 0);
