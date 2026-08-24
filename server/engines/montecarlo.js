// Meridian v2 — Monte Carlo projection engine
// Bootstrapped historical returns rather than pure Gaussian GBM: real markets
// have fat tails and volatility clustering, and a normal model quietly
// understates the probability of the outcomes that actually matter.

import { mean, stdev, percentile } from './analytics.js';
import { TRADING_DAYS } from '../config.js';

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * @param {Object} opts
 *  initial        starting portfolio value
 *  monthly        monthly contribution
 *  years          horizon
 *  returns        historical daily return series (for bootstrap)
 *  mode           'bootstrap' | 'blockBootstrap' | 'normal'
 *  expectedReturn annualised, used in 'normal' mode or to re-centre bootstrap
 *  volatility     annualised, used in 'normal' mode
 *  paths          number of simulations
 *  inflation      annual, to also report real terms
 *  fees           annual fee drag (e.g. 0.0022 for 22bps)
 */
export function simulate(opts = {}) {
  const {
    initial = 10000,
    monthly = 0,
    years = 20,
    returns = null,
    mode = 'blockBootstrap',
    expectedReturn = null,
    volatility = null,
    paths = 5000,
    inflation = 0.025,
    fees = 0,
    seed = 12345,
    blockSize = 21,
  } = opts;

  if (!(paths > 0)) return { error: 'paths must be greater than zero.' };
  if (!(years > 0)) return { error: 'years must be greater than zero.' };
  if (!isFinite(initial) || initial < 0) return { error: 'initial value must be zero or positive.' };

  const rng = mulberry32(seed);
  const steps = Math.round(years * 12);
  const dailyPerMonth = Math.round(TRADING_DAYS / 12);

  let hist = Array.isArray(returns) ? returns.filter(r => isFinite(r)) : null;
  if (hist && hist.length < 60) hist = null;

  const useBootstrap = hist && mode !== 'normal';
  const muDaily = expectedReturn != null ? expectedReturn / TRADING_DAYS
                : hist ? mean(hist) : 0.07 / TRADING_DAYS;
  const sdDaily = volatility != null ? volatility / Math.sqrt(TRADING_DAYS)
                : hist ? stdev(hist) : 0.15 / Math.sqrt(TRADING_DAYS);
  const feeDaily = fees / TRADING_DAYS;

  const finals = [];

  // Record percentile bands at a thinned set of months. Sorting every path at
  // all 241 months to draw a chart that renders ~60 points is most of this
  // function's cost for no visible benefit.
  const bandEvery = Math.max(1, Math.ceil(steps / 80));
  const bandMonths = [];
  for (let m = 0; m <= steps; m += bandEvery) bandMonths.push(m);
  if (bandMonths[bandMonths.length - 1] !== steps) bandMonths.push(steps);
  const bandIndex = new Map(bandMonths.map((m, i) => [m, i]));
  const bands = bandMonths.map(() => []);
  let ruinCount = 0;
  let totalContributed = initial + monthly * steps;

  for (let p = 0; p < paths; p++) {
    let value = initial;
    bands[0].push(value);
    let lastRecorded = 0;
    let blockPos = 0, blockLeft = 0;

    for (let m = 1; m <= steps; m++) {
      if (!useBootstrap) {
        // Sum of k independent normal daily returns is itself normal with mean
        // k·μ and sd √k·σ, so drawing once per month is distributionally
        // identical to drawing 21 times and ~21x faster. Bootstrap mode still
        // steps daily, because resampling real returns is the entire point
        // there and aggregating would discard the fat tails it exists to keep.
        const muM = (muDaily - feeDaily) * dailyPerMonth;
        const sdM = sdDaily * Math.sqrt(dailyPerMonth);
        value *= Math.max(0, 1 + muM + sdM * gaussian(rng));
      } else {
        for (let d = 0; d < dailyPerMonth; d++) {
          let r;
          if (mode === 'blockBootstrap') {
            if (blockLeft <= 0) {
              blockPos = Math.floor(rng() * Math.max(1, hist.length - blockSize));
              blockLeft = blockSize;
            }
            r = hist[blockPos % hist.length];
            blockPos++; blockLeft--;
          } else {
            r = hist[Math.floor(rng() * hist.length)];
          }
          if (expectedReturn != null && hist.length) r += (muDaily - mean(hist));
          value *= (1 + r - feeDaily);
          if (value < 0) value = 0;
        }
      }
      value += monthly;
      const bi = bandIndex.get(m);
      if (bi !== undefined) { bands[bi].push(value); lastRecorded = m; }
      if (value <= 0) { ruinCount++; break; }
    }
    finals.push(value);
  }

  const pct = p => percentile(finals, p);
  const realFactor = 1 / Math.pow(1 + inflation, years);

  const percentileBands = bands.map((vals, i) => ({
    month: bandMonths[i],
    year: +(bandMonths[i] / 12).toFixed(2),
    p5:  +percentile(vals, 0.05).toFixed(0),
    p25: +percentile(vals, 0.25).toFixed(0),
    p50: +percentile(vals, 0.50).toFixed(0),
    p75: +percentile(vals, 0.75).toFixed(0),
    p95: +percentile(vals, 0.95).toFixed(0),
  }));

  const median = pct(0.5);
  return {
    finals,                       // raw terminal values — exact probabilities need these
    inputs: { initial, monthly, years, paths, mode, inflation, fees },
    contributed: +totalContributed.toFixed(0),
    outcomes: {
      p5: +pct(0.05).toFixed(0),
      p10: +pct(0.10).toFixed(0),
      p25: +pct(0.25).toFixed(0),
      median: +median.toFixed(0),
      p75: +pct(0.75).toFixed(0),
      p90: +pct(0.90).toFixed(0),
      p95: +pct(0.95).toFixed(0),
      mean: +mean(finals).toFixed(0),
      worst: +Math.min(...finals).toFixed(0),
      best: +Math.max(...finals).toFixed(0),
    },
    real: {
      median: +(median * realFactor).toFixed(0),
      p25: +(pct(0.25) * realFactor).toFixed(0),
      p75: +(pct(0.75) * realFactor).toFixed(0),
    },
    multipleOfContributions: totalContributed ? +(median / totalContributed).toFixed(2) : 0,
    probabilityOfLoss: +(finals.filter(f => f < totalContributed).length / paths * 100).toFixed(1),
    probabilityOfRuin: +(ruinCount / paths * 100).toFixed(2),
    bands: percentileBands,
  };
}

/** Probability of reaching a specific target value by a given horizon. */
/**
 * Probability of reaching a target value by the horizon.
 *
 * Previously this counted hits across five percentile values rather than the
 * simulated paths, so every answer was quantised to a multiple of 20% — a
 * "62% chance" was not possible to express. It now counts every path, and the
 * required-contribution solve reuses one simulation per bisection step at
 * reduced path count rather than running a full 5,000-path simulation 24 times,
 * which is what made this endpoint take ~15 seconds.
 */
export function goalProbability(opts = {}) {
  const { target = 100000, ...rest } = opts;
  const paths = rest.paths ?? 4000;
  const sim = simulate({ ...rest, paths });
  if (sim.error) return sim;

  const finals = sim.finals ?? [];
  const hit = finals.filter(v => v >= target).length;
  const probability = finals.length ? (hit / finals.length) * 100 : 0;

  const required = solveMonthly(target, rest);

  // Strip the raw array before returning — thousands of floats do not need to
  // cross the wire, and the percentile bands already describe the distribution.
  const { finals: _drop, ...simOut } = sim;

  return {
    target,
    probability: +probability.toFixed(1),
    pathsSimulated: finals.length,
    median: sim.outcomes.median,
    shortfallMedian: +(target - sim.outcomes.median).toFixed(0),
    surplusMedian: sim.outcomes.median > target ? +(sim.outcomes.median - target).toFixed(0) : 0,
    requiredMonthlyForFiftyPct: required,
    simulation: simOut,
  };
}

/** Bisect on monthly contribution needed for a 50% chance of hitting target. */
function solveMonthly(target, opts) {
  const years = opts.years ?? 20;
  let lo = 0, hi = Math.max(100, (target / (12 * years)) * 3);

  // 14 iterations resolves to well under 1% of the range, which is finer than
  // the simulation noise floor — more iterations buy precision that is not real.
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const s = simulate({ ...opts, monthly: mid, paths: 300, seed: 7777 });
    if (s.error) break;
    if (s.outcomes.median < target) lo = mid; else hi = mid;
  }
  return +((lo + hi) / 2).toFixed(0);
}
