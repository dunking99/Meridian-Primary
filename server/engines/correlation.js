// Meridian v2 — correlation engine
//
// What this answers that a single correlation number does not:
//
//   1. Do these holdings move together *on the days that matter*? Correlation
//      measured across all days is dominated by ordinary days. Diversification
//      failing is a tail event — everything falling at once — so the number
//      worth knowing is correlation conditioned on the worst days, compared
//      against the calm ones. A pair at 0.30 normally and 0.85 in a selloff is
//      not a diversified pair; a full-sample correlation reports 0.35 and says
//      nothing about that.
//
//   2. Is it changing? A correlation quoted over all stored history is an
//      average across regimes. The same pair measured over 30 days and over a
//      year answers a different question: has the relationship moved recently.
//
//   3. How many independent things do I actually own? Counting holdings, or
//      counting them by weight (inverse Herfindahl), treats two 0.98-correlated
//      funds as two holdings. They are one bet held twice. The eigenvalue
//      decomposition of the correlation matrix gives the honest count.
//
//   4. Which holdings form blocs? A matrix of numbers does not tell you that
//      six of your eleven holdings are one cluster. Clustering does.
//
// Alignment, and why there are two kinds:
//
//   Every correlation here is joined on DATE, never by array position. Two
//   listings with different holiday calendars, or a symbol with a gap in its
//   stored history, do not line up index-for-index, and correlating them
//   positionally silently compares different days. That produces a number that
//   looks exactly like a measurement and is not one.
//
//   - PAIRWISE (used for the matrix): each pair is joined on its own
//     overlapping dates. Maximises the evidence behind each cell, and one
//     short-history holding does not destroy every other pair. The cost is
//     that different cells rest on different samples, so the matrix is not
//     guaranteed to be a coherent (positive semi-definite) matrix.
//   - COMPLETE-CASE (used for eigenvalues and anything matrix-wide): the
//     intersection of dates where *every* included symbol has a return. Gives
//     one coherent matrix at the cost of sample size, and names the symbols it
//     had to exclude rather than dropping them quietly.
//
//   Both are reported. Neither is silently substituted for the other.
//
// Nulls: a correlation that cannot be computed — too little overlap, or a
// series that never moved and therefore has no variance to correlate — is
// null, and null renders as "not measurable". It is never 0, which is a claim
// that two things are independent, and is a different and much stronger
// statement than "we could not tell".

import { getBars } from '../db.js';
import * as A from './analytics.js';

// ─── Tunables ─────────────────────────────────────────────────

/** Minimum aligned return observations before a correlation is reported at
 *  all. Below this the estimate's standard error is so wide that the number
 *  misleads more than it informs: at n=10 a sample correlation of 0.5 has a
 *  95% interval spanning roughly -0.15 to 0.85. */
export const MIN_OBSERVATIONS = 30;

/**
 * Conventional windows, in calendar days of stored history. "max" is every bar
 * held. Short and long windows are compared to detect drift.
 *
 * There is deliberately no one-month window. Thirty calendar days is about
 * twenty-two trading days, which is below MIN_OBSERVATIONS, so such a window
 * could only ever return null — and if the minimum were lowered to admit it,
 * the number it produced would be noise: at n=22 the 95% interval around a
 * sample correlation of 0.5 runs from roughly 0.10 to 0.76, which is not a
 * measurement of anything. Three months is the shortest window this engine
 * will state a correlation over.
 */
export const WINDOWS = {
  '3m': 90,
  '6m': 180,
  '1y': 365,
  'max': null,
};

/** Default window set, shortest first — the order drift comparison relies on. */
export const DEFAULT_WINDOWS = ['3m', '6m', '1y', 'max'];

/** Share of days treated as the stressed tail when conditioning. 0.10 = the
 *  worst 10% of days for the reference series. Low enough to be genuinely a
 *  tail, high enough that a year of history still leaves ~25 observations. */
export const STRESS_TAIL = 0.10;

/** Correlation at or above this, between two holdings that together carry
 *  material weight, is called redundancy: you are paying two management fees
 *  for one exposure. */
export const REDUNDANT_CORR = 0.90;
/** Below this, a pair is doing genuine diversification work. */
export const DIVERSIFYING_CORR = 0.30;
/** Combined portfolio weight below which a correlated pair is not worth
 *  raising — two 0.4% positions at 0.99 correlation change nothing. */
export const MATERIAL_PAIR_WEIGHT = 0.05;

/** Distance threshold for cutting the clustering tree. Distance is
 *  1 - correlation, so 0.35 groups holdings correlated at 0.65 or above. */
export const CLUSTER_CUT = 0.35;

// ─── Bar access and date joining ──────────────────────────────

const closeOf = bar => {
  const c = bar.adj_close ?? bar.close;
  return typeof c === 'number' && isFinite(c) && c > 0 ? c : null;
};

/** Date-keyed close map for one symbol, oldest first, invalid bars dropped. */
function closeMap(symbol, fromDate = null) {
  const bars = getBars(symbol);
  if (!Array.isArray(bars) || !bars.length) return null;
  const m = new Map();
  for (const b of bars) {
    if (!b?.date) continue;
    if (fromDate && b.date < fromDate) continue;
    const c = closeOf(b);
    if (c != null) m.set(b.date, c);
  }
  return m.size ? m : null;
}

/** ISO date cutoff for a window expressed in calendar days, relative to the
 *  most recent date actually present in the data rather than to today — so a
 *  stale database gives a short window of real bars rather than an empty one. */
function windowCutoff(days, latestDate) {
  if (days == null || !latestDate) return null;
  const d = new Date(`${latestDate}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** The newest date held for any of these symbols. Anchors every window. */
export function latestDateFor(symbols) {
  let latest = null;
  for (const s of symbols) {
    const bars = getBars(s);
    if (!Array.isArray(bars) || !bars.length) continue;
    const last = bars[bars.length - 1]?.date;
    if (last && (latest == null || last > latest)) latest = last;
  }
  return latest;
}

/**
 * Two symbols' returns over their overlapping dates.
 * Returns aligned arrays of equal length plus the dates they came from, or
 * null when the two share no usable history at all.
 */
export function pairReturns(symA, symB, { window = null, latest = null } = {}) {
  const anchor = latest ?? latestDateFor([symA, symB]);
  const cutoff = windowCutoff(WINDOWS[window] ?? (typeof window === 'number' ? window : null), anchor);

  const mapA = closeMap(symA, cutoff);
  const mapB = closeMap(symB, cutoff);
  if (!mapA || !mapB) return null;

  // Intersect on date, oldest first. Sorting the smaller map's keys and
  // probing the larger keeps this O(n log n) rather than O(n*m).
  const [small, large] = mapA.size <= mapB.size ? [mapA, mapB] : [mapB, mapA];
  const dates = [...small.keys()].filter(d => large.has(d)).sort();
  if (dates.length < 2) return null;

  const pa = dates.map(d => mapA.get(d));
  const pb = dates.map(d => mapB.get(d));

  // Returns are computed only between consecutive *joined* dates. A gap in
  // the overlap (one side missing a week) yields a multi-day return on both
  // sides, which is the honest comparison: the same elapsed period for each.
  const ra = [], rb = [], rdates = [];
  for (let i = 1; i < dates.length; i++) {
    ra.push(pa[i] / pa[i - 1] - 1);
    rb.push(pb[i] / pb[i - 1] - 1);
    rdates.push(dates[i]);
  }
  return { a: ra, b: rb, dates: rdates, from: rdates[0], to: rdates[rdates.length - 1] };
}

/**
 * Complete-case alignment across many symbols: the dates on which every
 * included symbol has a usable close.
 *
 * Symbols with too little overlap are excluded and named. This is deliberately
 * not silent — dropping the one holding whose history is short changes what
 * the resulting matrix is a statement about, and the caller has to be able to
 * say so.
 */
export function alignedReturns(symbols, { window = null, latest = null, minObs = MIN_OBSERVATIONS } = {}) {
  const uniq = [...new Set(symbols)].filter(Boolean);
  const anchor = latest ?? latestDateFor(uniq);
  const cutoff = windowCutoff(WINDOWS[window] ?? (typeof window === 'number' ? window : null), anchor);

  const maps = new Map();
  const missing = [];
  for (const s of uniq) {
    const m = closeMap(s, cutoff);
    if (m) maps.set(s, m); else missing.push({ symbol: s, reason: 'no stored bars in window' });
  }
  if (!maps.size) {
    return { symbols: [], dates: [], returns: {}, excluded: missing, observations: 0 };
  }

  // Start from the shortest series and keep only dates present in all.
  const ordered = [...maps.entries()].sort((x, y) => x[1].size - y[1].size);
  let dates = [...ordered[0][1].keys()];
  for (let i = 1; i < ordered.length; i++) {
    const m = ordered[i][1];
    dates = dates.filter(d => m.has(d));
  }
  dates.sort();

  // If the intersection is too thin, the culprit is usually one short series.
  // Drop the shortest contributors one at a time until the remaining set has
  // enough common dates, naming each exclusion.
  const kept = new Set(maps.keys());
  const excluded = [...missing];
  while (kept.size > 1 && dates.length < minObs + 1) {
    const shortest = [...kept]
      .map(s => ({ s, n: maps.get(s).size }))
      .sort((x, y) => x.n - y.n)[0];
    kept.delete(shortest.s);
    excluded.push({
      symbol: shortest.s,
      reason: `only ${shortest.n} stored bars — too short for a common window with the rest`,
    });
    dates = [...maps.get([...kept][0]).keys()];
    for (const s of kept) { const m = maps.get(s); dates = dates.filter(d => m.has(d)); }
    dates.sort();
  }

  const keptList = [...kept].sort();
  if (dates.length < 2) {
    return { symbols: keptList, dates: [], returns: {}, excluded, observations: 0 };
  }

  const returns = {};
  for (const s of keptList) {
    const m = maps.get(s);
    const r = [];
    for (let i = 1; i < dates.length; i++) r.push(m.get(dates[i]) / m.get(dates[i - 1]) - 1);
    returns[s] = r;
  }
  const rdates = dates.slice(1);
  return {
    symbols: keptList,
    dates: rdates,
    returns,
    excluded,
    observations: rdates.length,
    from: rdates[0] ?? null,
    to: rdates[rdates.length - 1] ?? null,
  };
}

// ─── Correlation with honest failure ──────────────────────────

/**
 * Pearson correlation that refuses to guess.
 * Returns null — not 0 — when either series never moves (no variance to
 * correlate) or there are too few points. analytics.correlation() returns 0 in
 * those cases, which reads as "independent" rather than "unknown".
 */
export function safeCorrelation(a, b, minObs = MIN_OBSERVATIONS) {
  const n = Math.min(a?.length ?? 0, b?.length ?? 0);
  if (n < minObs) return null;
  const x = a.slice(0, n), y = b.slice(0, n);
  const sx = A.stdev(x), sy = A.stdev(y);
  if (!sx || !sy || !isFinite(sx) || !isFinite(sy)) return null;
  const r = A.covariance(x, y) / (sx * sy);
  if (!isFinite(r)) return null;
  // Floating point can push a mathematically-exact ±1 a hair outside the range.
  return Math.max(-1, Math.min(1, r));
}

/** One pair, fully described: the number, what it rests on, and when. */
export function pairCorrelation(symA, symB, { window = null, latest = null, minObs = MIN_OBSERVATIONS } = {}) {
  if (symA === symB) {
    return { a: symA, b: symB, correlation: 1, observations: null, window, self: true };
  }
  const joined = pairReturns(symA, symB, { window, latest });
  if (!joined) {
    return { a: symA, b: symB, correlation: null, observations: 0, window, reason: 'no overlapping stored history' };
  }
  const r = safeCorrelation(joined.a, joined.b, minObs);
  if (r == null) {
    return {
      a: symA, b: symB, correlation: null, observations: joined.a.length, window,
      reason: joined.a.length < minObs
        ? `only ${joined.a.length} overlapping days, ${minObs} needed`
        : 'one series has no variance over this window',
    };
  }
  return {
    a: symA, b: symB,
    correlation: +r.toFixed(4),
    observations: joined.a.length,
    from: joined.from, to: joined.to,
    window,
  };
}

/**
 * Full pairwise matrix. Cells are correlations or null; the diagonal is 1.
 * `observations` is a parallel matrix so a cell resting on 31 days is
 * distinguishable from one resting on 1,200.
 */
export function matrix(symbols, { window = null, minObs = MIN_OBSERVATIONS } = {}) {
  const syms = [...new Set(symbols)].filter(Boolean).sort();
  const latest = latestDateFor(syms);
  const n = syms.length;
  const cells = Array.from({ length: n }, () => new Array(n).fill(null));
  const obs = Array.from({ length: n }, () => new Array(n).fill(0));
  const pairs = [];

  for (let i = 0; i < n; i++) {
    cells[i][i] = 1;
    obs[i][i] = null;
    for (let j = i + 1; j < n; j++) {
      const p = pairCorrelation(syms[i], syms[j], { window, latest, minObs });
      cells[i][j] = cells[j][i] = p.correlation;
      obs[i][j] = obs[j][i] = p.observations ?? 0;
      pairs.push(p);
    }
  }

  const measured = pairs.filter(p => p.correlation != null);
  return {
    symbols: syms,
    matrix: cells,
    observations: obs,
    pairs,
    window,
    measuredPairs: measured.length,
    totalPairs: pairs.length,
    averageCorrelation: measured.length
      ? +(measured.reduce((s, p) => s + p.correlation, 0) / measured.length).toFixed(4)
      : null,
    basis: 'pairwise date-join — each cell uses its own overlapping dates',
  };
}

// ─── Multi-window and drift ───────────────────────────────────

/**
 * The same pairs measured over several windows, plus the drift between the
 * shortest and longest measurable window.
 *
 * Drift is the point: a pair at 0.45 over a year and 0.85 over the last month
 * is a diversification assumption that has quietly stopped being true, and no
 * single-window number shows it.
 */
export function windowedPairs(symbols, { windows = DEFAULT_WINDOWS, minObs = MIN_OBSERVATIONS } = {}) {
  const syms = [...new Set(symbols)].filter(Boolean).sort();
  const latest = latestDateFor(syms);
  const byWindow = {};
  for (const w of windows) byWindow[w] = matrix(syms, { window: w, minObs });

  const out = [];
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      const per = {};
      for (const w of windows) per[w] = byWindow[w].matrix[i][j];

      // Shortest and longest windows that actually produced a number.
      const shortFirst = windows.filter(w => per[w] != null);
      const longFirst = [...shortFirst].reverse();
      const shortW = shortFirst[0] ?? null;
      const longW = longFirst[0] ?? null;
      const drift = shortW && longW && shortW !== longW
        ? +(per[shortW] - per[longW]).toFixed(4)
        : null;

      out.push({
        a: syms[i], b: syms[j],
        byWindow: per,
        shortWindow: shortW, longWindow: longW,
        drift,
        // A pair whose recent correlation is materially above its long-run
        // correlation is converging: the diversification it used to provide is
        // decaying. The reverse is decoupling.
        trend: drift == null ? null : drift > 0.15 ? 'converging' : drift < -0.15 ? 'decoupling' : 'stable',
      });
    }
  }
  return { symbols: syms, windows, pairs: out, matrices: byWindow, latest };
}

// ─── Stress conditioning ──────────────────────────────────────

/**
 * Correlation on the worst days versus the rest.
 *
 * The reference series decides which days count as stressed: the equal-weight
 * (or supplied-weight) average of the aligned holdings, so "a bad day" means a
 * bad day for this portfolio rather than for an index it may not track.
 *
 * Reported as three numbers per pair — calm, stressed, and the gap — because
 * the gap is the risk statement. Correlations that hold in a selloff are
 * genuine diversification; correlations that only exist on quiet days are not.
 */
export function stressCorrelation(symbols, { window = '1y', weights = null, tail = STRESS_TAIL, minObs = 15 } = {}) {
  const aligned = alignedReturns(symbols, { window, minObs });
  const syms = aligned.symbols;

  if (syms.length < 2 || aligned.observations < minObs * 2) {
    return {
      available: false,
      reason: syms.length < 2
        ? 'fewer than two holdings share a common window'
        : `only ${aligned.observations} common days — need at least ${minObs * 2}`,
      symbols: syms,
      excluded: aligned.excluded,
    };
  }

  // Reference series: the portfolio itself over the common dates.
  const wsum = weights ? syms.reduce((s, k) => s + (weights[k] ?? 0), 0) : 0;
  const w = {};
  for (const s of syms) w[s] = wsum > 0 ? (weights[s] ?? 0) / wsum : 1 / syms.length;

  const n = aligned.observations;
  const ref = new Array(n).fill(0);
  for (const s of syms) for (let i = 0; i < n; i++) ref[i] += w[s] * aligned.returns[s][i];

  // Threshold at the tail quantile. Indices, not values, so both legs of every
  // pair are sampled on exactly the same days.
  const sorted = [...ref].sort((x, y) => x - y);
  const cutIdx = Math.max(0, Math.floor(n * tail) - 1);
  const threshold = sorted[cutIdx];
  const stressIdx = [], calmIdx = [];
  for (let i = 0; i < n; i++) (ref[i] <= threshold ? stressIdx : calmIdx).push(i);

  if (stressIdx.length < minObs || calmIdx.length < minObs) {
    return {
      available: false,
      reason: `tail split gives ${stressIdx.length} stressed and ${calmIdx.length} calm days — need ${minObs} of each`,
      symbols: syms,
      excluded: aligned.excluded,
    };
  }

  const pick = (arr, idx) => idx.map(i => arr[i]);
  const pairs = [];
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      const ra = aligned.returns[syms[i]], rb = aligned.returns[syms[j]];
      const calm = safeCorrelation(pick(ra, calmIdx), pick(rb, calmIdx), minObs);
      const stressed = safeCorrelation(pick(ra, stressIdx), pick(rb, stressIdx), minObs);
      pairs.push({
        a: syms[i], b: syms[j],
        calm: calm == null ? null : +calm.toFixed(4),
        stressed: stressed == null ? null : +stressed.toFixed(4),
        gap: calm == null || stressed == null ? null : +(stressed - calm).toFixed(4),
        // The failure mode worth naming: looked diversified, wasn't when it counted.
        failsUnderStress: calm != null && stressed != null
          && calm < DIVERSIFYING_CORR + 0.2 && stressed >= 0.7,
      });
    }
  }

  const measured = pairs.filter(p => p.gap != null);
  const avg = key => measured.length
    ? +(measured.reduce((s, p) => s + p[key], 0) / measured.length).toFixed(4) : null;

  return {
    available: true,
    symbols: syms,
    excluded: aligned.excluded,
    window,
    tail,
    thresholdReturn: +threshold.toFixed(6),
    stressedDays: stressIdx.length,
    calmDays: calmIdx.length,
    from: aligned.from, to: aligned.to,
    pairs,
    averageCalm: avg('calm'),
    averageStressed: avg('stressed'),
    averageGap: avg('gap'),
    breakdowns: pairs.filter(p => p.failsUnderStress).length,
    basis: weights
      ? 'stressed days are the worst days for this portfolio, weighted by position size'
      : 'stressed days are the worst days for an equal-weight basket of these holdings',
  };
}

// ─── Rolling average correlation ──────────────────────────────

/**
 * Portfolio-wide average pairwise correlation through time.
 *
 * A single current figure cannot distinguish "we have always been this
 * correlated" from "this doubled in the last two months". The series can.
 */
export function rollingAverageCorrelation(symbols, { window = 60, step = 5, minObs = MIN_OBSERVATIONS } = {}) {
  const aligned = alignedReturns(symbols, { window: null, minObs });
  const syms = aligned.symbols;
  if (syms.length < 2 || aligned.observations < window + 1) {
    return {
      available: false,
      reason: syms.length < 2
        ? 'fewer than two holdings share a common window'
        : `only ${aligned.observations} common days — need more than the ${window}-day window`,
      symbols: syms,
      excluded: aligned.excluded,
    };
  }

  const series = [];
  for (let end = window; end <= aligned.observations; end += step) {
    const slice = {};
    for (const s of syms) slice[s] = aligned.returns[s].slice(end - window, end);
    let sum = 0, count = 0;
    for (let i = 0; i < syms.length; i++) {
      for (let j = i + 1; j < syms.length; j++) {
        const r = safeCorrelation(slice[syms[i]], slice[syms[j]], Math.min(minObs, window));
        if (r != null) { sum += r; count++; }
      }
    }
    if (count) series.push({ date: aligned.dates[end - 1], average: +(sum / count).toFixed(4), pairs: count });
  }

  if (!series.length) {
    return { available: false, reason: 'no window produced a measurable correlation', symbols: syms, excluded: aligned.excluded };
  }

  const first = series[0].average, last = series[series.length - 1].average;
  const values = series.map(p => p.average);
  return {
    available: true,
    symbols: syms,
    excluded: aligned.excluded,
    window, step,
    series,
    current: last,
    earliest: first,
    change: +(last - first).toFixed(4),
    min: +Math.min(...values).toFixed(4),
    max: +Math.max(...values).toFixed(4),
    direction: last - first > 0.10 ? 'rising' : last - first < -0.10 ? 'falling' : 'flat',
    basis: `average of all measurable pairwise correlations in a rolling ${window}-day window over the dates every holding shares`,
  };
}

// ─── Eigen decomposition (for independent bets) ───────────────

/**
 * Cyclic Jacobi eigenvalue decomposition for a real symmetric matrix.
 * Returns eigenvalues descending with their eigenvectors.
 *
 * Jacobi rather than anything faster because it is unconditionally stable for
 * symmetric matrices, needs no external library, and at portfolio sizes (tens
 * of holdings, not thousands) its speed is irrelevant. It is also easy to
 * verify against matrices with known answers, which matters more here than
 * throughput.
 */
export function jacobiEigen(input, { maxSweeps = 100, tol = 1e-12 } = {}) {
  const n = input.length;
  const a = input.map(r => [...r]);
  // Eigenvector accumulator, starts as the identity.
  const v = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off <= tol) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) <= 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const sign = theta >= 0 ? 1 : -1;
        const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const pairs = [];
  for (let i = 0; i < n; i++) pairs.push({ value: a[i][i], vector: v.map(row => row[i]) });
  pairs.sort((x, y) => y.value - x.value);
  return { values: pairs.map(p => p.value), vectors: pairs.map(p => p.vector) };
}

/**
 * How many independent bets the portfolio actually contains.
 *
 * Two measures, because they answer different questions:
 *
 *   independentBets — the eigenvalue entropy of the correlation matrix,
 *     ignoring weights. "How many distinct things are in this set of
 *     holdings." N identical holdings score 1; N uncorrelated holdings score N.
 *
 *   effectiveBets — the squared diversification ratio: the weighted average
 *     volatility of the holdings divided by the volatility the portfolio
 *     actually realises, squared. This answers "how diversified is my money",
 *     and it falls well below independentBets when the weight is concentrated
 *     in holdings that share a factor.
 *
 * The obvious alternative for the weighted measure — Meucci's diversification
 * distribution over principal components — is not used here, and the reason is
 * worth recording. That construction projects the weights onto the eigenvectors
 * of the correlation matrix, and eigenvectors are not unique when eigenvalues
 * are close. Two genuinely independent holdings produce eigenvalues near 1.03
 * and 0.97, whose eigenvectors are an essentially arbitrary rotation, and the
 * projection lands all the variance on one component: the measure reports one
 * effective bet for a portfolio that plainly holds two. The squared
 * diversification ratio depends only on the covariance matrix, never on a
 * choice of basis, so it cannot fail that way — and it returns the textbook
 * answers on the cases where the answer is known (N for N equal-weight
 * uncorrelated holdings, 1 for any number of identical ones).
 *
 * Both are reported alongside the naive counts they replace, so the gap between
 * "I hold eleven things" and "I own three bets" is visible rather than implied.
 */
export function independence(symbols, { weights = null, window = '1y', minObs = MIN_OBSERVATIONS } = {}) {
  const aligned = alignedReturns(symbols, { window, minObs });
  const syms = aligned.symbols;
  if (syms.length < 2 || aligned.observations < minObs) {
    return {
      available: false,
      reason: syms.length < 2
        ? 'fewer than two holdings share a common window'
        : `only ${aligned.observations} common days — ${minObs} needed`,
      symbols: syms,
      excluded: aligned.excluded,
    };
  }

  const n = syms.length;
  const C = Array.from({ length: n }, () => new Array(n).fill(0));
  let unmeasurable = 0;
  for (let i = 0; i < n; i++) {
    C[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const r = safeCorrelation(aligned.returns[syms[i]], aligned.returns[syms[j]], minObs);
      // A null cell cannot be left null in a matrix that is about to be
      // decomposed. Zero is the only neutral substitute, so it is used and
      // then declared — the result is reported as resting on a matrix with
      // N assumed-independent cells rather than silently.
      if (r == null) unmeasurable++;
      C[i][j] = C[j][i] = r ?? 0;
    }
  }

  const { values } = jacobiEigen(C);
  const total = values.reduce((s, x) => s + Math.max(x, 0), 0) || n;

  // Eigenvalue entropy — unweighted independence of the holding set.
  let entropy = 0;
  for (const lam of values) {
    const p = Math.max(lam, 0) / total;
    if (p > 1e-12) entropy -= p * Math.log(p);
  }
  const independentBets = +Math.exp(entropy).toFixed(3);

  // Share of the correlation structure carried by its single dominant
  // component. Depends only on eigenvalues, so it is unaffected by the basis
  // ambiguity that rules out the projection approach above.
  const concentrationOfRisk = +(Math.max(values[0], 0) / n).toFixed(4);

  // Weighted effective bets: the squared diversification ratio.
  let effectiveBets = null, diversificationRatio = null, portfolioVol = null;
  const wsum = weights ? syms.reduce((s, k) => s + Math.abs(weights[k] ?? 0), 0) : 0;
  if (wsum > 0) {
    const vol = syms.map(s => A.stdev(aligned.returns[s]));
    const w = syms.map(s => (weights[s] ?? 0) / wsum);
    // Weight in volatility units: the correlation matrix is scale-free, so the
    // weights entering it must carry the scale that was divided out.
    const wv = syms.map((_, i) => w[i] * vol[i]);
    let variance = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) variance += wv[i] * wv[j] * C[i][j];

    const weightedAvgVol = wv.reduce((s, x) => s + x, 0);
    if (variance > 1e-18 && weightedAvgVol > 0) {
      const pv = Math.sqrt(variance);
      const dr = weightedAvgVol / pv;
      portfolioVol = +(pv * Math.sqrt(252)).toFixed(6);
      diversificationRatio = +dr.toFixed(4);
      effectiveBets = +(dr * dr).toFixed(3);
    }
  }

  return {
    available: true,
    symbols: syms,
    excluded: aligned.excluded,
    window,
    observations: aligned.observations,
    from: aligned.from, to: aligned.to,
    holdingsCount: n,
    independentBets,
    effectiveBets,
    diversificationRatio,
    annualisedPortfolioVol: portfolioVol,
    // Share of the correlation structure carried by its single largest
    // component: 0.8 means four fifths of the co-movement is one driver.
    concentrationOfRisk,
    eigenvalues: values.map(v => +v.toFixed(5)),
    // The honest caveat, always present rather than only when it bites.
    assumedIndependentCells: unmeasurable,
    basis: `complete-case matrix over ${aligned.observations} dates shared by all ${n} holdings`
      + (unmeasurable ? `; ${unmeasurable} pair(s) could not be measured and were treated as independent` : ''),
  };
}

// ─── Clustering ───────────────────────────────────────────────

/**
 * Agglomerative clustering on correlation distance (1 - correlation), using
 * average linkage.
 *
 * Average linkage rather than single linkage because single linkage chains:
 * one pair at 0.7 would merge two otherwise-unrelated groups into one blob and
 * report a diversified portfolio as a single cluster. Average linkage requires
 * the groups to be related on the whole.
 *
 * Unmeasurable pairs are treated as maximally distant, so a holding with no
 * usable history forms its own cluster rather than being assigned to one on no
 * evidence.
 */
export function clusters(symbols, { window = '1y', cut = CLUSTER_CUT, minObs = MIN_OBSERVATIONS } = {}) {
  const m = matrix(symbols, { window, minObs });
  const syms = m.symbols;
  if (syms.length < 2) {
    return { available: false, reason: 'need at least two holdings to cluster', clusters: [], window };
  }

  const dist = (i, j) => {
    const r = m.matrix[i][j];
    return r == null ? 2 : 1 - r;   // 2 is beyond any real distance (max is 2 at r = -1)
  };

  // Each holding starts as its own group.
  let groups = syms.map((s, i) => ({ members: [i] }));

  const groupDistance = (g1, g2) => {
    let sum = 0, count = 0;
    for (const i of g1.members) for (const j of g2.members) { sum += dist(i, j); count++; }
    return count ? sum / count : Infinity;
  };

  while (groups.length > 1) {
    let best = null;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = groupDistance(groups[i], groups[j]);
        if (best == null || d < best.d) best = { i, j, d };
      }
    }
    if (!best || best.d > cut) break;
    const merged = { members: [...groups[best.i].members, ...groups[best.j].members] };
    groups = groups.filter((_, k) => k !== best.i && k !== best.j).concat([merged]);
  }

  const out = groups.map(g => {
    const members = g.members.map(i => syms[i]);
    // Cohesion: how tightly the members of this cluster actually move together.
    let sum = 0, count = 0;
    for (let x = 0; x < g.members.length; x++) {
      for (let y = x + 1; y < g.members.length; y++) {
        const r = m.matrix[g.members[x]][g.members[y]];
        if (r != null) { sum += r; count++; }
      }
    }
    return {
      members,
      size: members.length,
      averageInternalCorrelation: count ? +(sum / count).toFixed(4) : null,
    };
  }).sort((a, b) => b.size - a.size);

  return {
    available: true,
    window,
    cut,
    clusters: out,
    clusterCount: out.length,
    largestCluster: out[0]?.size ?? 0,
    singletons: out.filter(c => c.size === 1).length,
    basis: `average-linkage clustering on 1 - correlation, cut at ${cut} (correlation ${+(1 - cut).toFixed(2)})`,
  };
}

// ─── Weight-aware redundancy ──────────────────────────────────

/**
 * Pairs that are both highly correlated and big enough to matter.
 *
 * Weight is the half that a bare correlation table omits. Two 0.4% holdings at
 * 0.99 are a curiosity; two 22% holdings at 0.93 are the portfolio. Ranking by
 * correlation alone puts the curiosity first.
 */
export function redundancies(positions, { window = '1y', minCorr = REDUNDANT_CORR, minWeight = MATERIAL_PAIR_WEIGHT, minObs = MIN_OBSERVATIONS } = {}) {
  const held = (positions ?? []).filter(p => p?.symbol);
  const weightOf = {};
  const total = held.reduce((s, p) => s + (typeof p.value === 'number' && isFinite(p.value) ? p.value : 0), 0);
  for (const p of held) {
    weightOf[p.symbol] = total > 0 && typeof p.value === 'number' ? p.value / total : null;
  }

  const m = matrix(held.map(p => p.symbol), { window, minObs });
  const nameOf = Object.fromEntries(held.map(p => [p.symbol, p.name ?? p.symbol]));

  const found = [];
  for (const p of m.pairs) {
    if (p.correlation == null || p.correlation < minCorr) continue;
    const wa = weightOf[p.a], wb = weightOf[p.b];
    const combined = wa == null || wb == null ? null : wa + wb;
    if (combined != null && combined < minWeight) continue;
    found.push({
      a: p.a, b: p.b,
      nameA: nameOf[p.a], nameB: nameOf[p.b],
      correlation: p.correlation,
      observations: p.observations,
      weightA: wa == null ? null : +wa.toFixed(4),
      weightB: wb == null ? null : +wb.toFixed(4),
      combinedWeight: combined == null ? null : +combined.toFixed(4),
      // What it would take to act on this: the smaller of the two is the one
      // a reader would consider dropping.
      smallerLeg: wa == null || wb == null ? null : (wa <= wb ? p.a : p.b),
    });
  }
  // Ranked by how much of the portfolio the duplication actually covers, not
  // by correlation.
  found.sort((x, y) => (y.combinedWeight ?? 0) - (x.combinedWeight ?? 0) || y.correlation - x.correlation);

  const weightInRedundantPairs = (() => {
    const syms = new Set();
    for (const f of found) { syms.add(f.a); syms.add(f.b); }
    let s = 0;
    for (const sym of syms) if (weightOf[sym] != null) s += weightOf[sym];
    return syms.size ? +s.toFixed(4) : 0;
  })();

  return {
    window,
    threshold: minCorr,
    minWeight,
    pairs: found,
    count: found.length,
    weightInvolved: weightInRedundantPairs,
    weightsAvailable: total > 0,
    basis: total > 0
      ? `pairs correlated at ${minCorr} or above whose combined weight is at least ${(minWeight * 100).toFixed(0)}% of the book`
      : `pairs correlated at ${minCorr} or above; no priced values available, so weight filtering was skipped`,
  };
}

// ─── The assembled report ─────────────────────────────────────

/** Plain-language verdict from the numbers, or null when there is nothing to
 *  judge. Never invents a reassuring answer out of missing data. */
function verdictFor({ independence: ind, stress, redundant, clustering }) {
  const notes = [];
  if (ind?.available && ind.effectiveBets != null) {
    const ratio = ind.effectiveBets / Math.max(ind.holdingsCount, 1);
    if (ratio < 0.34) notes.push(`${ind.holdingsCount} holdings behave like ${ind.effectiveBets} independent bets`);
    else if (ratio > 0.7) notes.push(`${ind.effectiveBets} independent bets across ${ind.holdingsCount} holdings — genuinely spread`);
  }
  if (stress?.available && stress.averageGap != null && stress.averageGap > 0.15) {
    notes.push(`correlation rises ${(stress.averageGap * 100).toFixed(0)} points on the worst days`);
  }
  if (redundant?.count > 0) {
    notes.push(`${redundant.count} redundant pair${redundant.count === 1 ? '' : 's'} covering ${((redundant.weightInvolved ?? 0) * 100).toFixed(0)}% of the book`);
  }
  if (clustering?.available && clustering.largestCluster > 2) {
    notes.push(`largest bloc is ${clustering.largestCluster} holdings moving as one`);
  }
  return notes.length ? notes : null;
}

/**
 * Everything, assembled: the matrix, how it has moved, whether it survives a
 * selloff, how many real bets it contains, and which pairs are duplicates.
 *
 * Each section fails independently. A portfolio with too little history for the
 * stress split still gets its matrix; a single-holding portfolio still gets an
 * honest empty answer rather than an exception.
 */
export function correlationReport(positions, {
  window = '1y',
  windows = ['30d', '90d', '1y', 'max'],
  rollingWindow = 60,
  minObs = MIN_OBSERVATIONS,
} = {}) {
  const held = (positions ?? []).filter(p => p?.symbol);
  const symbols = [...new Set(held.map(p => p.symbol))].sort();

  if (symbols.length < 2) {
    return {
      available: false,
      reason: symbols.length === 1
        ? 'correlation needs at least two holdings — there is one'
        : 'no holdings to correlate',
      symbols,
      generatedAt: new Date().toISOString(),
    };
  }

  const total = held.reduce((s, p) => s + (typeof p.value === 'number' && isFinite(p.value) ? p.value : 0), 0);
  const weights = total > 0
    ? Object.fromEntries(held.map(p => [p.symbol, (typeof p.value === 'number' ? p.value : 0) / total]))
    : null;

  const section = fn => { try { return fn(); } catch (e) { return { available: false, reason: `failed: ${e.message}` }; } };

  const current = section(() => matrix(symbols, { window, minObs }));
  const windowed = section(() => windowedPairs(symbols, { windows, minObs }));
  const stress = section(() => stressCorrelation(symbols, { window, weights, minObs: 15 }));
  const rolling = section(() => rollingAverageCorrelation(symbols, { window: rollingWindow, minObs }));
  const ind = section(() => independence(symbols, { weights, window, minObs }));
  const clustering = section(() => clusters(symbols, { window, minObs }));
  const redundant = section(() => redundancies(held, { window, minObs }));

  // Holdings that contributed nothing anywhere — named once, at the top level,
  // so a reader knows the report is about a subset before reading any number.
  const unassessable = symbols.filter(s => {
    const i = current?.symbols?.indexOf(s) ?? -1;
    if (i < 0) return true;
    return (current.matrix[i] ?? []).every((v, j) => j === i || v == null);
  });

  return {
    available: true,
    generatedAt: new Date().toISOString(),
    window,
    symbols,
    weightsAvailable: !!weights,
    matrix: current,
    windows: windowed,
    stress,
    rolling,
    independence: ind,
    clusters: clustering,
    redundancies: redundant,
    unassessable,
    headline: verdictFor({ independence: ind, stress, redundant, clustering }),
    coverage: {
      holdings: symbols.length,
      measurable: symbols.length - unassessable.length,
      pairsMeasured: current?.measuredPairs ?? 0,
      pairsTotal: current?.totalPairs ?? 0,
    },
    basis: 'daily total returns from stored bars, joined on date; pairwise for the matrix, complete-case for anything matrix-wide',
  };
}
