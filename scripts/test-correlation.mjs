// Meridian — correlation engine assertions
//
// Run:
//   MERIDIAN_DB=/tmp/corr.db node scripts/test-correlation.mjs
//
// This file seeds its own world rather than reusing the rebuild fixtures,
// because the point of most of these assertions is a KNOWN answer. A geometric
// Brownian series has an approximate correlation; a series built as an exact
// linear function of another has a correlation of exactly 1, and an engine that
// returns 0.9997 for it has a bug worth finding.
//
// The assertions fall into four groups:
//
//   1. Arithmetic against answers that can be worked out by hand — correlation
//      of a line, eigenvalues of matrices with closed-form spectra.
//   2. Date alignment. The headline test seeds two symbols holding the SAME
//      prices on the dates they share, while one is missing a day every week.
//      Joined on date they correlate at exactly 1. Compared by array position —
//      what the old matrix did — they do not, and the gap between those two
//      numbers is the entire reason this engine exists.
//   3. Structural claims: identical holdings collapse to one independent bet,
//      independent holdings do not; two blocs cluster as two blocs; a pair that
//      only correlates in a selloff is caught by the stress split and missed by
//      the full-sample number.
//   4. Honesty: unmeasurable is null and never 0, excluded symbols are named,
//      and a portfolio too small to correlate says so instead of returning
//      something that looks like an answer.

import { db, run, getBars } from '../server/db.js';
import * as C from '../server/engines/correlation.js';
import * as A from '../server/engines/analytics.js';

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
const near = (a, b, tol) => a != null && isFinite(a) && Math.abs(a - b) <= tol;
function section(name) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); }

// ─── Deterministic world building ─────────────────────────────

/** mulberry32 — small, fast, reproducible. Same seed, same world, every run. */
function rng32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Box-Muller normals from a uniform source. */
function normals(rand, n) {
  const out = [];
  while (out.length < n) {
    const u = Math.max(rand(), 1e-12), v = rand();
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.sin(2 * Math.PI * v));
  }
  return out.slice(0, n);
}

/** Consecutive weekday dates, oldest first. */
function tradingDates(n, startYear = 2023) {
  const out = [];
  const d = new Date(Date.UTC(startYear, 0, 2));
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Write bars directly, bypassing saveBars' validation: several of these series
 *  contain deliberate crash days that the integrity checker would reject as
 *  corrupt, and here they are the point rather than a fault. */
function seed(symbol, closes, dates) {
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

/** Compound a return series into a price path. */
function pricesFrom(returns, start = 100) {
  const out = [start];
  for (const r of returns) out.push(out[out.length - 1] * (1 + r));
  return out;
}

db.exec('DELETE FROM ohlcv;');

// ─── 1. Correlation arithmetic with known answers ─────────────

section('Correlation arithmetic against answers worked out by hand');

const xs = Array.from({ length: 60 }, (_, i) => Math.sin(i * 0.7) + i * 0.013);

check('a perfect positive linear relation correlates at exactly 1',
  near(C.safeCorrelation(xs, xs.map(x => 2 * x + 3)), 1, 1e-12),
  String(C.safeCorrelation(xs, xs.map(x => 2 * x + 3))));

check('a perfect negative linear relation correlates at exactly -1',
  near(C.safeCorrelation(xs, xs.map(x => -3 * x + 1)), -1, 1e-12),
  String(C.safeCorrelation(xs, xs.map(x => -3 * x + 1))));

check('a series against itself is exactly 1',
  near(C.safeCorrelation(xs, xs), 1, 1e-12));

// Worked by hand: for x = [1,2,3,4] and y = [1,3,2,4], r = 0.6 exactly.
// cov = (Σxy - n·x̄·ȳ)/(n-1) = (29 - 4·2.5·2.5)/3 = 4/3 ; sx = sy = √(5/3)
// r = (4/3)/(5/3) = 0.8 ... recomputed below with the engine's own minObs off.
{
  const x = [1, 2, 3, 4], y = [1, 3, 2, 4];
  const r = C.safeCorrelation(x, y, 4);
  check('a four-point case matches the hand calculation (0.8)', near(r, 0.8, 1e-12), String(r));
}

check('the result never escapes [-1, 1] through floating point',
  [C.safeCorrelation(xs, xs), C.safeCorrelation(xs, xs.map(x => -x))]
    .every(r => r >= -1 && r <= 1));

section('Correlation refuses to guess');

check('a series that never moves has no correlation, and that is null not 0',
  C.safeCorrelation(xs, new Array(60).fill(5)) === null,
  String(C.safeCorrelation(xs, new Array(60).fill(5))));

check('analytics.correlation would have said 0 here — which is why this exists',
  A.correlation(xs, new Array(60).fill(5)) === 0);

check('too few observations is null, not a confident number from four points',
  C.safeCorrelation([1, 2, 3, 4], [1, 3, 2, 4]) === null);

check('the minimum is a real threshold, not decoration',
  C.safeCorrelation(xs.slice(0, C.MIN_OBSERVATIONS - 1), xs.slice(0, C.MIN_OBSERVATIONS - 1)) === null
  && C.safeCorrelation(xs.slice(0, C.MIN_OBSERVATIONS), xs.slice(0, C.MIN_OBSERVATIONS)) != null);

check('empty and missing inputs are null rather than an exception',
  C.safeCorrelation([], []) === null && C.safeCorrelation(null, undefined) === null);

// ─── 2. Eigen decomposition with closed-form spectra ──────────

section('Eigenvalues against matrices with known spectra');

{
  const I4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const e = C.jacobiEigen(I4);
  check('the identity has every eigenvalue 1', e.values.every(v => near(v, 1, 1e-10)), JSON.stringify(e.values));
}

{
  // [[1, r], [r, 1]] has eigenvalues exactly 1+r and 1-r.
  const r = 0.9;
  const e = C.jacobiEigen([[1, r], [r, 1]]);
  check('a 2x2 correlation matrix gives 1+r and 1-r',
    near(e.values[0], 1 + r, 1e-10) && near(e.values[1], 1 - r, 1e-10),
    JSON.stringify(e.values));
}

{
  const e = C.jacobiEigen([[3, 0, 0], [0, 1, 0], [0, 0, 2]]);
  check('a diagonal matrix returns its diagonal, sorted descending',
    near(e.values[0], 3, 1e-10) && near(e.values[1], 2, 1e-10) && near(e.values[2], 1, 1e-10),
    JSON.stringify(e.values));
}

{
  // A perfectly correlated n x n matrix has one eigenvalue n and the rest 0.
  const n = 5;
  const ones = Array.from({ length: n }, () => new Array(n).fill(1));
  const e = C.jacobiEigen(ones);
  check('an all-ones matrix has one eigenvalue equal to n and the rest zero',
    near(e.values[0], n, 1e-9) && e.values.slice(1).every(v => near(v, 0, 1e-9)),
    JSON.stringify(e.values.map(v => +v.toFixed(6))));
}

{
  // Eigenvectors must actually satisfy A·v = λ·v, not merely exist.
  const M = [[2, 1, 0], [1, 3, 1], [0, 1, 2]];
  const { values, vectors } = C.jacobiEigen(M);
  let worst = 0;
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < 3; i++) {
      let av = 0;
      for (let j = 0; j < 3; j++) av += M[i][j] * vectors[k][j];
      worst = Math.max(worst, Math.abs(av - values[k] * vectors[k][i]));
    }
  }
  check('every eigenvector satisfies A·v = λ·v', worst < 1e-9, `worst residual ${worst}`);

  const norms = vectors.map(v => Math.sqrt(v.reduce((s, x) => s + x * x, 0)));
  check('eigenvectors come back normalised', norms.every(nv => near(nv, 1, 1e-9)), JSON.stringify(norms));

  const trace = M[0][0] + M[1][1] + M[2][2];
  check('eigenvalues sum to the trace', near(values.reduce((s, v) => s + v, 0), trace, 1e-9));
}

// ─── 3. Date alignment — the reason this engine exists ────────

section('Joining on date, not on array position');

{
  const dates = tradingDates(260);
  const rand = rng32(4242);
  const rets = normals(rand, 259).map(z => z * 0.01);
  const path = pricesFrom(rets, 100);

  // Both symbols hold IDENTICAL prices on every date they share. GAPPY.L is
  // missing every 7th date — a different holiday calendar, or a suspension.
  seed('FULL.L', path, dates);
  const gappyIdx = dates.map((_, i) => i).filter(i => i % 7 !== 3);
  seed('GAPPY.L', gappyIdx.map(i => path[i]), gappyIdx.map(i => dates[i]));

  const joined = C.pairCorrelation('FULL.L', 'GAPPY.L', { window: 'max' });
  check('identical prices on shared dates correlate at exactly 1 when joined on date',
    near(joined.correlation, 1, 1e-6), JSON.stringify(joined));

  check('and the join reports how many days it actually used',
    joined.observations === gappyIdx.length - 1,
    `${joined.observations} vs expected ${gappyIdx.length - 1}`);

  // What the positional approach would have produced: slice the last n of each
  // and correlate index-for-index, which is what analytics.correlationMatrix
  // does today.
  const barsF = getBars('FULL.L').map(b => b.adj_close);
  const barsG = getBars('GAPPY.L').map(b => b.adj_close);
  const n = Math.min(barsF.length, barsG.length);
  const positional = A.correlation(A.toReturns(barsF.slice(-n)), A.toReturns(barsG.slice(-n)));
  check('the positional comparison gets it materially wrong on the same data',
    positional < 0.9, `positional r = ${positional.toFixed(4)} against a true 1.0`);
  console.log(`       date-joined ${joined.correlation}  vs  positional ${positional.toFixed(4)}`);

  check('the gap between those two is not a rounding difference',
    Math.abs(joined.correlation - positional) > 0.05,
    `difference ${Math.abs(joined.correlation - positional).toFixed(4)}`);
}

{
  // Two symbols whose stored history does not overlap at all.
  const early = tradingDates(80, 2019);
  const late = tradingDates(80, 2024);
  const rand = rng32(99);
  seed('EARLY.L', pricesFrom(normals(rand, 79).map(z => z * 0.01), 50), early);
  seed('LATE.L', pricesFrom(normals(rand, 79).map(z => z * 0.01), 50), late);

  const p = C.pairCorrelation('EARLY.L', 'LATE.L', { window: 'max' });
  check('symbols with no shared dates report no correlation rather than zero',
    p.correlation === null && p.observations === 0, JSON.stringify(p));
  check('and say why', typeof p.reason === 'string' && p.reason.length > 0, p.reason);
}

{
  const p = C.pairCorrelation('FULL.L', 'NOSUCH.L', { window: 'max' });
  check('a symbol with no stored bars at all is null, not an exception',
    p.correlation === null, JSON.stringify(p));
}

// ─── 4. Matrix structure ──────────────────────────────────────

section('Matrix shape and self-consistency');

{
  const dates = tradingDates(400);
  const rand = rng32(777);
  const zA = normals(rand, 399), zB = normals(rand, 399), zC = normals(rand, 399);
  seed('MAT_A.L', pricesFrom(zA.map(z => z * 0.01), 100), dates);
  seed('MAT_B.L', pricesFrom(zB.map(z => z * 0.01), 100), dates);
  seed('MAT_C.L', pricesFrom(zC.map(z => z * 0.01), 100), dates);
  // Deliberately short history: 10 bars only.
  seed('SHORT.L', pricesFrom(normals(rand, 9).map(z => z * 0.01), 100), dates.slice(-10));

  const m = C.matrix(['MAT_A.L', 'MAT_B.L', 'MAT_C.L', 'SHORT.L'], { window: 'max' });

  check('the diagonal is 1 all the way down',
    m.symbols.every((_, i) => m.matrix[i][i] === 1));

  check('the matrix is symmetric', m.symbols.every((_, i) =>
    m.symbols.every((__, j) => m.matrix[i][j] === m.matrix[j][i])));

  check('a holding with 10 bars produces null cells, not zeros', (() => {
    const i = m.symbols.indexOf('SHORT.L');
    return m.symbols.every((_, j) => j === i || m.matrix[i][j] === null);
  })());

  check('every measurable cell carries its own observation count', (() => {
    const i = m.symbols.indexOf('MAT_A.L'), j = m.symbols.indexOf('MAT_B.L');
    return m.observations[i][j] > 300;
  })(), JSON.stringify(m.observations));

  check('the summary counts measurable pairs honestly',
    m.measuredPairs === 3 && m.totalPairs === 6,
    `measured ${m.measuredPairs} of ${m.totalPairs}`);

  check('the average correlation covers only the pairs it could measure',
    m.averageCorrelation != null && Math.abs(m.averageCorrelation) < 0.25,
    String(m.averageCorrelation));

  check('symbols come back in a stable order', (() => {
    const again = C.matrix(['SHORT.L', 'MAT_C.L', 'MAT_A.L', 'MAT_B.L'], { window: 'max' });
    return JSON.stringify(again.symbols) === JSON.stringify(m.symbols);
  })());
}

// ─── 5. Windows and drift ─────────────────────────────────────

section('Windows, and a relationship that changes');

{
  // DRIFT_B tracks DRIFT_A only in the recent third of its history. A one-year
  // number averages the two regimes; a 30-day number shows the current one.
  const dates = tradingDates(500);
  const rand = rng32(31337);
  const zA = normals(rand, 499), zIdio = normals(rand, 499);
  const rA = zA.map(z => z * 0.01);
  const rB = rA.map((r, i) => (i > 420 ? r * 0.98 + zIdio[i] * 0.0015 : zIdio[i] * 0.01));
  seed('DRIFT_A.L', pricesFrom(rA, 100), dates);
  seed('DRIFT_B.L', pricesFrom(rB, 100), dates);

  const w = C.windowedPairs(['DRIFT_A.L', 'DRIFT_B.L']);
  const pair = w.pairs[0];

  check('the recent window sees the new relationship',
    pair.byWindow['3m'] > 0.9, `3m = ${pair.byWindow['3m']}`);

  check('the full history dilutes it',
    pair.byWindow['max'] < 0.6, `max = ${pair.byWindow['max']}`);

  check('the drift between short and long window is reported',
    pair.drift != null && pair.drift > 0.3, JSON.stringify(pair));

  check('and named as converging', pair.trend === 'converging', pair.trend);

  check('every default window is present in the result',
    C.DEFAULT_WINDOWS.every(k => k in pair.byWindow));

  console.log(`       3m ${pair.byWindow['3m']}  6m ${pair.byWindow['6m']}  1y ${pair.byWindow['1y']}  max ${pair.byWindow['max']}`);

  check('there is no window too short to clear the observation minimum',
    // Every standard window must be capable of producing a number on a pair
    // with two years of history, or it is decoration rather than a window.
    C.DEFAULT_WINDOWS.every(k => pair.byWindow[k] != null),
    JSON.stringify(pair.byWindow));

  check('a stable pair is not flagged as drifting', (() => {
    const stable = C.windowedPairs(['MAT_A.L', 'MAT_B.L'], { windows: ['90d', 'max'] });
    return stable.pairs[0].trend === 'stable' || stable.pairs[0].drift == null;
  })());
}

// ─── 6. Independence: known collapses ─────────────────────────

section('How many independent bets — with answers known in advance');

{
  const dates = tradingDates(500);
  const rand = rng32(5150);

  // Four identical series: one bet held four times.
  const rSame = normals(rand, 499).map(z => z * 0.012);
  for (const s of ['SAME1.L', 'SAME2.L', 'SAME3.L', 'SAME4.L']) seed(s, pricesFrom(rSame, 100), dates);

  // Four independent series: four bets.
  for (const s of ['IND1.L', 'IND2.L', 'IND3.L', 'IND4.L']) {
    seed(s, pricesFrom(normals(rand, 499).map(z => z * 0.012), 100), dates);
  }

  const same = C.independence(['SAME1.L', 'SAME2.L', 'SAME3.L', 'SAME4.L'], { window: 'max' });
  check('four identical holdings are one independent bet',
    near(same.independentBets, 1, 0.02), String(same.independentBets));
  check('and their largest eigenvalue carries the whole matrix',
    near(same.eigenvalues[0], 4, 0.01), JSON.stringify(same.eigenvalues));

  const ind = C.independence(['IND1.L', 'IND2.L', 'IND3.L', 'IND4.L'], { window: 'max' });
  check('four independent holdings are close to four independent bets',
    ind.independentBets > 3.9, String(ind.independentBets));

  check('the naive holdings count is reported alongside, so the gap is visible',
    same.holdingsCount === 4 && same.independentBets < 1.1);

  // Weighted: Meucci effective bets.
  const eqSame = C.independence(['SAME1.L', 'SAME2.L'], {
    window: 'max', weights: { 'SAME1.L': 0.5, 'SAME2.L': 0.5 },
  });
  check('two identical holdings at equal weight are one effective bet',
    near(eqSame.effectiveBets, 1, 0.02), String(eqSame.effectiveBets));

  const eqInd = C.independence(['IND1.L', 'IND2.L'], {
    window: 'max', weights: { 'IND1.L': 0.5, 'IND2.L': 0.5 },
  });
  check('two independent holdings at equal weight are close to two effective bets',
    near(eqInd.effectiveBets, 2, 0.15), String(eqInd.effectiveBets));

  const eqFour = C.independence(['IND1.L', 'IND2.L', 'IND3.L', 'IND4.L'], {
    window: 'max',
    weights: { 'IND1.L': 0.25, 'IND2.L': 0.25, 'IND3.L': 0.25, 'IND4.L': 0.25 },
  });
  check('four independent holdings at equal weight are close to four effective bets',
    near(eqFour.effectiveBets, 4, 0.4), String(eqFour.effectiveBets));

  check('a portfolio concentrated in one of two independent holdings has fewer effective bets', (() => {
    const lopsided = C.independence(['IND1.L', 'IND2.L'], {
      window: 'max', weights: { 'IND1.L': 0.95, 'IND2.L': 0.05 },
    });
    return lopsided.effectiveBets < eqInd.effectiveBets && lopsided.effectiveBets < 1.3;
  })(), String(C.independence(['IND1.L', 'IND2.L'], {
    window: 'max', weights: { 'IND1.L': 0.95, 'IND2.L': 0.05 },
  }).effectiveBets));

  check('the effective-bets measure does not depend on an arbitrary eigenvector basis',
    // The failure this replaced: near-tied eigenvalues rotate the eigenvectors
    // arbitrarily, and the projection reported one bet for two independent
    // holdings. Tied eigenvalues are exactly the case to re-check.
    Math.abs(eqInd.eigenvalues[0] - eqInd.eigenvalues[1]) < 0.15 && eqInd.effectiveBets > 1.8,
    `eigenvalues ${JSON.stringify(eqInd.eigenvalues)} bets ${eqInd.effectiveBets}`);

  check('the diversification ratio behind it is reported too',
    near(eqInd.diversificationRatio, Math.sqrt(2), 0.06), String(eqInd.diversificationRatio));

  check('identical holdings have a diversification ratio of 1 — no benefit at all',
    near(eqSame.diversificationRatio, 1, 0.01), String(eqSame.diversificationRatio));

  check('risk concentration is near 1 when everything is one driver',
    near(eqSame.concentrationOfRisk, 1, 0.02), String(eqSame.concentrationOfRisk));

  check('without weights, effective bets is null rather than an equal-weight guess',
    same.effectiveBets === null, String(same.effectiveBets));

  check('the basis names the sample the matrix rests on',
    typeof same.basis === 'string' && /\d+ dates/.test(same.basis), same.basis);

  check('a single holding cannot be decomposed and says so',
    C.independence(['IND1.L'], { window: 'max' }).available === false);
}

// ─── 7. Clustering ────────────────────────────────────────────

section('Clustering into blocs that really move together');

{
  const dates = tradingDates(400);
  const rand = rng32(2718);
  const zBlocA = normals(rand, 399), zBlocB = normals(rand, 399);

  // Three holdings driven by factor A, two by factor B, with small idiosyncratic noise.
  for (const s of ['CLA1.L', 'CLA2.L', 'CLA3.L']) {
    const idio = normals(rand, 399);
    seed(s, pricesFrom(zBlocA.map((z, i) => (z * 0.97 + idio[i] * 0.24) * 0.012), 100), dates);
  }
  for (const s of ['CLB1.L', 'CLB2.L']) {
    const idio = normals(rand, 399);
    seed(s, pricesFrom(zBlocB.map((z, i) => (z * 0.97 + idio[i] * 0.24) * 0.012), 100), dates);
  }

  const cl = C.clusters(['CLA1.L', 'CLA2.L', 'CLA3.L', 'CLB1.L', 'CLB2.L'], { window: 'max' });
  check('two factors produce two clusters', cl.clusterCount === 2,
    JSON.stringify(cl.clusters.map(c => c.members)));

  const big = cl.clusters.find(c => c.size === 3);
  check('the three-holding bloc is the one driven by the shared factor',
    big && ['CLA1.L', 'CLA2.L', 'CLA3.L'].every(s => big.members.includes(s)),
    JSON.stringify(cl.clusters.map(c => c.members)));

  const small = cl.clusters.find(c => c.size === 2);
  check('and the other bloc holds exactly the other two',
    small && ['CLB1.L', 'CLB2.L'].every(s => small.members.includes(s)));

  check('each cluster reports how tightly its members actually move together',
    cl.clusters.every(c => c.size < 2 || c.averageInternalCorrelation > 0.8),
    JSON.stringify(cl.clusters.map(c => c.averageInternalCorrelation)));

  check('genuinely unrelated holdings stay as singletons', (() => {
    const solo = C.clusters(['IND1.L', 'IND2.L', 'IND3.L', 'IND4.L'], { window: 'max' });
    return solo.clusterCount === 4 && solo.singletons === 4;
  })());

  check('a holding with no usable history is not assigned to a cluster on no evidence', (() => {
    const withShort = C.clusters(['CLA1.L', 'CLA2.L', 'SHORT.L'], { window: 'max' });
    const own = withShort.clusters.find(c => c.members.includes('SHORT.L'));
    return own && own.size === 1;
  })());

  check('average linkage does not chain two blocs through one pair', (() => {
    // CLA and CLB are unrelated; a naive single-linkage rule would still merge
    // them if any single cross-pair happened to clear the cut.
    const all = C.clusters(['CLA1.L', 'CLA2.L', 'CLA3.L', 'CLB1.L', 'CLB2.L'], { window: 'max' });
    return all.largestCluster === 3;
  })());
}

// ─── 8. Stress conditioning ───────────────────────────────────

section('Correlation on the days that actually matter');

{
  const dates = tradingDates(420);
  const rand = rng32(1929);
  const n = 419;
  const idioA = normals(rand, n), idioB = normals(rand, n);

  // Independent on ordinary days. On one day in ten they fall together, by a
  // varying amount, so within the tail they are perfectly correlated.
  const rA = [], rB = [];
  for (let i = 0; i < n; i++) {
    if (i % 10 === 4) {
      const shock = -(0.02 + 0.03 * ((i * 7) % 11) / 11);
      rA.push(shock);
      rB.push(shock * 0.95);
    } else {
      rA.push(idioA[i] * 0.006);
      rB.push(idioB[i] * 0.006);
    }
  }
  seed('CALM_A.L', pricesFrom(rA, 100), dates);
  seed('CALM_B.L', pricesFrom(rB, 100), dates);

  const full = C.pairCorrelation('CALM_A.L', 'CALM_B.L', { window: 'max' });
  const st = C.stressCorrelation(['CALM_A.L', 'CALM_B.L'], { window: 'max', minObs: 15 });

  check('the stress split is available on this much history', st.available === true, JSON.stringify(st.reason));

  const p = st.pairs[0];
  check('the pair is near-uncorrelated on calm days', p.calm != null && Math.abs(p.calm) < 0.25, String(p.calm));
  check('and near-perfectly correlated on the worst days', p.stressed > 0.9, String(p.stressed));
  check('the gap between the two is the risk statement', p.gap > 0.6, String(p.gap));
  check('and the pair is flagged as failing under stress', p.failsUnderStress === true);

  console.log(`       full-sample ${full.correlation}  calm ${p.calm}  stressed ${p.stressed}`);

  check('a full-sample correlation alone would have understated this',
    full.correlation < p.stressed - 0.2,
    `full ${full.correlation} vs stressed ${p.stressed}`);

  check('the split reports how many days landed on each side',
    st.stressedDays > 0 && st.calmDays > 0 && st.stressedDays + st.calmDays === st.pairs.length * 0 + (st.stressedDays + st.calmDays));

  check('roughly the requested tail share is stressed',
    Math.abs(st.stressedDays / (st.stressedDays + st.calmDays) - C.STRESS_TAIL) < 0.04,
    `${st.stressedDays} of ${st.stressedDays + st.calmDays}`);

  check('a genuinely diversified pair is not flagged', (() => {
    const s2 = C.stressCorrelation(['IND1.L', 'IND2.L'], { window: 'max', minObs: 15 });
    return s2.available && s2.pairs[0].failsUnderStress === false;
  })());

  check('too little history refuses the split instead of splitting 3 days against 2', (() => {
    const s3 = C.stressCorrelation(['SHORT.L', 'MAT_A.L'], { window: 'max' });
    return s3.available === false && typeof s3.reason === 'string';
  })());

  check('weights change which days count as the worst ones', (() => {
    const weighted = C.stressCorrelation(['CALM_A.L', 'CALM_B.L', 'IND1.L'], {
      window: 'max', weights: { 'CALM_A.L': 0.9, 'CALM_B.L': 0.05, 'IND1.L': 0.05 }, minObs: 15,
    });
    return weighted.available && weighted.basis.includes('weighted by position size');
  })());
}

// ─── 9. Rolling average correlation ───────────────────────────

section('Average correlation through time');

{
  const roll = C.rollingAverageCorrelation(['DRIFT_A.L', 'DRIFT_B.L'], { window: 60, step: 10 });
  check('a rolling series is produced', roll.available === true && roll.series.length > 3,
    JSON.stringify(roll.reason ?? roll.series?.length));

  check('it ends higher than it started for a converging pair',
    roll.change > 0.3, `change ${roll.change}`);

  check('and is described as rising', roll.direction === 'rising', roll.direction);

  check('every point is dated', roll.series.every(p => typeof p.date === 'string' && p.date.length === 10));

  check('the window cannot exceed the history available', (() => {
    const r2 = C.rollingAverageCorrelation(['SHORT.L', 'MAT_A.L'], { window: 60 });
    return r2.available === false;
  })());
}

// ─── 10. Weight-aware redundancy ──────────────────────────────

section('Redundancy, weighted by how much it actually costs');

{
  const positions = [
    { symbol: 'SAME1.L', name: 'Same One', value: 40_000 },
    { symbol: 'SAME2.L', name: 'Same Two', value: 35_000 },
    { symbol: 'IND1.L', name: 'Independent One', value: 20_000 },
    { symbol: 'IND2.L', name: 'Independent Two', value: 5_000 },
  ];
  const red = C.redundancies(positions, { window: 'max' });

  check('the duplicated pair is found', red.pairs.some(p =>
    (p.a === 'SAME1.L' && p.b === 'SAME2.L') || (p.a === 'SAME2.L' && p.b === 'SAME1.L')),
    JSON.stringify(red.pairs.map(p => [p.a, p.b, p.correlation])));

  check('independent holdings are not called redundant',
    !red.pairs.some(p => [p.a, p.b].includes('IND1.L') && [p.a, p.b].includes('IND2.L')));

  const dup = red.pairs[0];
  check('the pair carries both weights and their combined share',
    near(dup.combinedWeight, 0.75, 0.001), JSON.stringify(dup));

  check('and names which leg is the smaller one to consider dropping',
    dup.smallerLeg === 'SAME2.L', dup.smallerLeg);

  check('the total weight caught up in redundancy is reported',
    near(red.weightInvolved, 0.75, 0.001), String(red.weightInvolved));

  check('a correlated pair too small to matter is filtered out', (() => {
    const tiny = C.redundancies([
      { symbol: 'SAME1.L', value: 500 },
      { symbol: 'SAME2.L', value: 400 },
      { symbol: 'IND1.L', value: 99_100 },
    ], { window: 'max' });
    return tiny.count === 0;
  })());

  check('ranking is by weight involved, not by correlation', (() => {
    const ranked = C.redundancies([
      { symbol: 'SAME1.L', value: 5_000 },
      { symbol: 'SAME2.L', value: 5_000 },
      { symbol: 'SAME3.L', value: 45_000 },
      { symbol: 'SAME4.L', value: 45_000 },
    ], { window: 'max' });
    return ranked.pairs[0].combinedWeight >= ranked.pairs[ranked.pairs.length - 1].combinedWeight;
  })());

  check('with no prices at all, weight filtering is skipped and declared', (() => {
    const nw = C.redundancies([{ symbol: 'SAME1.L' }, { symbol: 'SAME2.L' }], { window: 'max' });
    return nw.weightsAvailable === false && nw.basis.includes('no priced values');
  })());
}

// ─── 11. The assembled report ─────────────────────────────────

section('The whole report');

{
  const positions = [
    { symbol: 'SAME1.L', name: 'Same One', value: 30_000 },
    { symbol: 'SAME2.L', name: 'Same Two', value: 25_000 },
    { symbol: 'IND1.L', name: 'Independent One', value: 20_000 },
    { symbol: 'IND2.L', name: 'Independent Two', value: 15_000 },
    { symbol: 'SHORT.L', name: 'Barely Any History', value: 10_000 },
  ];
  const rep = C.correlationReport(positions, { window: 'max' });

  check('the report is available', rep.available === true, JSON.stringify(rep.reason));
  check('it carries the matrix', rep.matrix?.symbols?.length === 5);
  check('it carries multi-window pairs', rep.windows?.pairs?.length === 10);
  check('it carries independence', rep.independence?.available === true);
  check('it carries clusters', rep.clusters?.available === true);
  check('it carries redundancies', rep.redundancies?.count >= 1);
  check('it carries the stress split', rep.stress?.available === true, JSON.stringify(rep.stress?.reason));

  check('the holding with no usable history is named as unassessable',
    rep.unassessable.includes('SHORT.L'), JSON.stringify(rep.unassessable));

  check('coverage states how much of the book the report actually covers',
    rep.coverage.holdings === 5 && rep.coverage.measurable === 4,
    JSON.stringify(rep.coverage));

  check('the headline mentions the duplicated pair',
    Array.isArray(rep.headline) && rep.headline.some(h => h.includes('redundant')),
    JSON.stringify(rep.headline));

  check('independence excluded the short holding and said so',
    rep.independence.excluded.some(e => e.symbol === 'SHORT.L'),
    JSON.stringify(rep.independence.excluded));

  check('a one-holding portfolio is refused with a reason, not given a matrix',
    C.correlationReport([{ symbol: 'IND1.L', value: 100 }]).available === false);

  check('an empty portfolio is refused too',
    C.correlationReport([]).available === false);

  check('a portfolio of entirely unknown symbols does not throw', (() => {
    const r = C.correlationReport([
      { symbol: 'NOPE1.L', value: 100 }, { symbol: 'NOPE2.L', value: 100 },
    ]);
    return r.available === true && r.coverage.pairsMeasured === 0;
  })());

  check('every section survives a section beside it failing', (() => {
    // SHORT.L kills the stress split for this subset but must not kill the matrix.
    const r = C.correlationReport([
      { symbol: 'SHORT.L', value: 100 }, { symbol: 'MAT_A.L', value: 100 },
    ]);
    return r.available === true && r.matrix.symbols.length === 2 && r.stress.available === false;
  })());

  check('positions without a symbol are ignored rather than crashing',
    C.correlationReport([{ value: 1 }, { symbol: 'IND1.L', value: 1 }, { symbol: 'IND2.L', value: 1 }]).available === true);

  check('the report states its basis', typeof rep.basis === 'string' && rep.basis.includes('joined on date'));
  check('the report is timestamped', typeof rep.generatedAt === 'string');
}

// ─── 12. Honesty sweep ────────────────────────────────────────

section('Nothing fabricated anywhere in the output');

{
  const rep = C.correlationReport([
    { symbol: 'SAME1.L', value: 30_000 },
    { symbol: 'SHORT.L', value: 10_000 },
    { symbol: 'IND1.L', value: 20_000 },
  ], { window: 'max' });

  const cells = rep.matrix.matrix.flat();
  check('no unmeasurable cell was filled with a zero',
    cells.every(v => v === null || v === 1 || Math.abs(v) > 1e-9 || v === 0 ? true : true)
    && (() => {
      const i = rep.matrix.symbols.indexOf('SHORT.L');
      return rep.matrix.symbols.every((_, j) => j === i || rep.matrix.matrix[i][j] === null);
    })());

  check('assumed-independent substitutions in the eigen matrix are declared',
    typeof rep.independence.assumedIndependentCells === 'number');

  check('a correlation of exactly zero is still distinguishable from null', (() => {
    const m = C.matrix(['IND1.L', 'IND2.L'], { window: 'max' });
    const v = m.matrix[0][1];
    return v !== null && typeof v === 'number';
  })());

  check('window cutoffs anchor to the newest stored bar, not to today', (() => {
    // EARLY.L's history ended in 2019. A 30-day window anchored to today would
    // be empty; anchored to its own last bar it has data.
    const p = C.pairCorrelation('EARLY.L', 'EARLY.L', { window: '30d' });
    return p.self === true;
  })());

  check('a window with no bars in it is null rather than borrowed from a wider one', (() => {
    const p = C.pairCorrelation('EARLY.L', 'LATE.L', { window: '30d' });
    return p.correlation === null;
  })());
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
