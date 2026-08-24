// Meridian v2 — quantitative analytics engine
// Pure functions over return series. No I/O, no dependencies, fully testable.
// Every risk number surfaced in the UI is computed here.

import { TRADING_DAYS } from '../config.js';

// ─── Basic series maths ───────────────────────────────────────

/** Strip non-finite values. A single NaN or Infinity reaching the maths
 *  propagates silently through every downstream statistic — the same failure
 *  shape as the corrupt price bar, so it is blocked at the same kind of edge. */
export const finite = xs => (Array.isArray(xs) ? xs.filter(x => typeof x === 'number' && isFinite(x)) : []);

export const mean = xs => {
  const f = finite(xs);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0;
};

export function stdev(values, sample = true) {
  const xs = finite(values);
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((a, x) => a + (x - m) ** 2, 0);
  return Math.sqrt(ss / (n - (sample ? 1 : 0)));
}

export function median(values) {
  const xs = finite(values);
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(values, p) {
  const xs = finite(values);
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function skewness(values) {
  const xs = finite(values);
  const n = xs.length; if (n < 3) return 0;
  const m = mean(xs), sd = stdev(xs);
  if (!sd) return 0;
  return (n / ((n - 1) * (n - 2))) * xs.reduce((a, x) => a + ((x - m) / sd) ** 3, 0);
}

export function kurtosis(values) {
  const xs = finite(values);
  const n = xs.length; if (n < 4) return 0;
  const m = mean(xs), sd = stdev(xs);
  if (!sd) return 0;
  const g2 = xs.reduce((a, x) => a + ((x - m) / sd) ** 4, 0) / n;
  return g2 - 3; // excess kurtosis
}

/** Simple period-over-period returns from a price series. */
export function toReturns(prices) {
  const r = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1], p1 = prices[i];
    if (p0 > 0 && p1 > 0) r.push(p1 / p0 - 1);
  }
  return r;
}

export function toLogReturns(prices) {
  const r = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) r.push(Math.log(prices[i] / prices[i - 1]));
  }
  return r;
}

// ─── Performance metrics ──────────────────────────────────────

export const totalReturn = prices =>
  prices.length < 2 ? 0 : prices[prices.length - 1] / prices[0] - 1;

export function cagr(prices, periodsPerYear = TRADING_DAYS) {
  if (prices.length < 2) return 0;
  const years = (prices.length - 1) / periodsPerYear;
  if (years <= 0) return 0;
  const growth = prices[prices.length - 1] / prices[0];
  return growth <= 0 ? 0 : growth ** (1 / years) - 1;
}

export const annualisedVol = (returns, ppy = TRADING_DAYS) =>
  stdev(returns) * Math.sqrt(ppy);

export function sharpe(returns, rf = 0.04, ppy = TRADING_DAYS) {
  const vol = annualisedVol(returns, ppy);
  if (!vol) return 0;
  return (mean(returns) * ppy - rf) / vol;
}

export function sortino(returns, rf = 0.04, ppy = TRADING_DAYS) {
  const target = rf / ppy;
  const downside = returns.filter(r => r < target).map(r => (r - target) ** 2);
  if (!downside.length) return 0;
  const dd = Math.sqrt(mean(downside)) * Math.sqrt(ppy);
  if (!dd) return 0;
  return (mean(returns) * ppy - rf) / dd;
}

/** Max drawdown with peak/trough dates and recovery length. */
export function maxDrawdown(prices, dates = []) {
  let peak = -Infinity, peakIdx = 0, maxDD = 0, ddPeak = 0, ddTrough = 0;
  for (let i = 0; i < prices.length; i++) {
    if (prices[i] > peak) { peak = prices[i]; peakIdx = i; }
    const dd = peak > 0 ? prices[i] / peak - 1 : 0;
    if (dd < maxDD) { maxDD = dd; ddPeak = peakIdx; ddTrough = i; }
  }
  // recovery: first index after trough regaining the prior peak
  let recovery = null;
  const peakVal = prices[ddPeak];
  for (let i = ddTrough; i < prices.length; i++) {
    if (prices[i] >= peakVal) { recovery = i; break; }
  }
  return {
    maxDrawdown: maxDD,
    peakIdx: ddPeak,
    troughIdx: ddTrough,
    recoveryIdx: recovery,
    peakDate: dates[ddPeak] ?? null,
    troughDate: dates[ddTrough] ?? null,
    recoveryDate: recovery != null ? (dates[recovery] ?? null) : null,
    daysUnderwater: recovery != null ? recovery - ddPeak : prices.length - 1 - ddPeak,
    stillUnderwater: recovery == null,
  };
}

/** Full underwater curve for charting. */
export function drawdownSeries(prices) {
  let peak = -Infinity;
  return prices.map(p => {
    if (p > peak) peak = p;
    return peak > 0 ? p / peak - 1 : 0;
  });
}

export function calmar(prices, ppy = TRADING_DAYS) {
  const dd = maxDrawdown(prices).maxDrawdown;
  if (!dd) return 0;
  return cagr(prices, ppy) / Math.abs(dd);
}

// ─── Relative metrics ─────────────────────────────────────────

export function covariance(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (n - 1);
}

export function correlation(a, b) {
  const sa = stdev(a), sb = stdev(b);
  if (!sa || !sb) return 0;
  return covariance(a, b) / (sa * sb);
}

/** OLS beta and alpha of asset vs benchmark returns. */
export function betaAlpha(assetR, benchR, rf = 0.04, ppy = TRADING_DAYS) {
  const n = Math.min(assetR.length, benchR.length);
  if (n < 3) return { beta: 0, alpha: 0, r2: 0, n };
  const a = assetR.slice(-n), b = benchR.slice(-n);
  const varB = stdev(b) ** 2;
  if (!varB) return { beta: 0, alpha: 0, r2: 0, n };
  const beta = covariance(a, b) / varB;
  const alpha = (mean(a) - beta * mean(b)) * ppy;
  const r = correlation(a, b);
  return { beta, alpha, r2: r * r, n };
}

export function trackingError(assetR, benchR, ppy = TRADING_DAYS) {
  const n = Math.min(assetR.length, benchR.length);
  if (n < 2) return 0;
  const diff = [];
  for (let i = 0; i < n; i++) diff.push(assetR[i] - benchR[i]);
  return stdev(diff) * Math.sqrt(ppy);
}

export function informationRatio(assetR, benchR, ppy = TRADING_DAYS) {
  const te = trackingError(assetR, benchR, ppy);
  if (!te) return 0;
  const n = Math.min(assetR.length, benchR.length);
  const excess = (mean(assetR.slice(-n)) - mean(benchR.slice(-n))) * ppy;
  return excess / te;
}

/** Up/down capture vs benchmark — how much of the up and down moves you get. */
export function captureRatios(assetR, benchR) {
  const n = Math.min(assetR.length, benchR.length);
  const upA = [], upB = [], dnA = [], dnB = [];
  for (let i = 0; i < n; i++) {
    if (benchR[i] > 0) { upA.push(assetR[i]); upB.push(benchR[i]); }
    else if (benchR[i] < 0) { dnA.push(assetR[i]); dnB.push(benchR[i]); }
  }
  const up = upB.length && mean(upB) !== 0 ? mean(upA) / mean(upB) : 0;
  const dn = dnB.length && mean(dnB) !== 0 ? mean(dnA) / mean(dnB) : 0;
  return { upCapture: up, downCapture: dn, captureSpread: up - dn };
}

// ─── Value at Risk ────────────────────────────────────────────

const NORM_Z = { 0.90: 1.2816, 0.95: 1.6449, 0.975: 1.9600, 0.99: 2.3263 };

/** Historical VaR — empirical quantile of the loss distribution. */
export function historicalVaR(returns, conf = 0.95) {
  if (returns.length < 20) return null;
  return -percentile(returns, 1 - conf);
}

/** Parametric (variance-covariance) VaR assuming normality. */
export function parametricVaR(returns, conf = 0.95) {
  if (returns.length < 20) return null;
  const z = NORM_Z[conf] ?? 1.6449;
  return -(mean(returns) - z * stdev(returns));
}

/**
 * Cornish-Fisher modified VaR — adjusts the normal quantile for observed
 * skew and fat tails. For portfolios with negative skew this is materially
 * larger than parametric VaR, and closer to what actually happens.
 */
export function modifiedVaR(returns, conf = 0.95) {
  if (returns.length < 30) return null;
  const z = NORM_Z[conf] ?? 1.6449;
  const S = skewness(returns), K = kurtosis(returns);
  const zcf = z
    + (z * z - 1) * S / 6
    + (z ** 3 - 3 * z) * K / 24
    - (2 * z ** 3 - 5 * z) * S * S / 36;
  return -(mean(returns) - zcf * stdev(returns));
}

/** Conditional VaR (expected shortfall) — average loss beyond the VaR point. */
export function cvar(returns, conf = 0.95) {
  if (returns.length < 20) return null;
  const cut = percentile(returns, 1 - conf);
  const tail = returns.filter(r => r <= cut);
  if (!tail.length) return null;
  return -mean(tail);
}

export function varSuite(returns, conf = 0.95, ppy = TRADING_DAYS) {
  const daily = {
    historical: historicalVaR(returns, conf),
    parametric: parametricVaR(returns, conf),
    modified:   modifiedVaR(returns, conf),
    cvar:       cvar(returns, conf),
  };
  const scale = k => k == null ? null : k * Math.sqrt(ppy / 252);
  return {
    confidence: conf,
    daily,
    monthly: Object.fromEntries(Object.entries(daily).map(([k, v]) =>
      [k, v == null ? null : v * Math.sqrt(21)])),
    annual: Object.fromEntries(Object.entries(daily).map(([k, v]) =>
      [k, v == null ? null : v * Math.sqrt(ppy)])),
    skew: skewness(returns),
    excessKurtosis: kurtosis(returns),
    observations: returns.length,
  };
}

// ─── Matrix work ──────────────────────────────────────────────

/**
 * Correlation matrix over aligned return series.
 * @param {Object<string, number[]>} series
 */
export function correlationMatrix(series) {
  const keys = Object.keys(series);
  const n = Math.min(...keys.map(k => series[k].length));
  const aligned = Object.fromEntries(keys.map(k => [k, series[k].slice(-n)]));
  const matrix = keys.map(a => keys.map(b => +correlation(aligned[a], aligned[b]).toFixed(4)));
  return { symbols: keys, matrix, observations: n };
}

export function covarianceMatrix(series, ppy = TRADING_DAYS) {
  const keys = Object.keys(series);
  const n = Math.min(...keys.map(k => series[k].length));
  const aligned = keys.map(k => series[k].slice(-n));
  return keys.map((_, i) => keys.map((__, j) => covariance(aligned[i], aligned[j]) * ppy));
}

/**
 * Average pairwise correlation — a single number for "how diversified am I".
 * Rising average correlation is the classic warning that diversification is
 * evaporating exactly when it's needed.
 */
export function averageCorrelation(series) {
  const { symbols, matrix } = correlationMatrix(series);
  let sum = 0, count = 0;
  for (let i = 0; i < symbols.length; i++)
    for (let j = i + 1; j < symbols.length; j++) { sum += matrix[i][j]; count++; }
  return count ? sum / count : 0;
}

/** Rolling window of any metric — for correlation-breakdown detection. */
export function rolling(values, window, fn) {
  const out = [];
  for (let i = window; i <= values.length; i++) out.push(fn(values.slice(i - window, i)));
  return out;
}

export function rollingPairCorrelation(a, b, window = 60) {
  const n = Math.min(a.length, b.length);
  const out = [];
  for (let i = window; i <= n; i++) {
    out.push(correlation(a.slice(i - window, i), b.slice(i - window, i)));
  }
  return out;
}

// ─── Portfolio aggregation ────────────────────────────────────

/** Weighted portfolio return series from component series and weights. */
export function portfolioReturns(series, weights) {
  const keys = Object.keys(series);
  const n = Math.min(...keys.map(k => series[k].length));
  const out = new Array(n).fill(0);
  const wsum = keys.reduce((a, k) => a + (weights[k] ?? 0), 0) || 1;
  for (const k of keys) {
    const w = (weights[k] ?? 0) / wsum;
    const s = series[k].slice(-n);
    for (let i = 0; i < n; i++) out[i] += w * s[i];
  }
  return out;
}

/** Portfolio volatility from the covariance matrix — captures diversification. */
export function portfolioVol(series, weights, ppy = TRADING_DAYS) {
  const keys = Object.keys(series);
  const cov = covarianceMatrix(series, ppy);
  const wsum = keys.reduce((a, k) => a + (weights[k] ?? 0), 0) || 1;
  const w = keys.map(k => (weights[k] ?? 0) / wsum);
  let v = 0;
  for (let i = 0; i < w.length; i++)
    for (let j = 0; j < w.length; j++) v += w[i] * w[j] * cov[i][j];
  return Math.sqrt(Math.max(v, 0));
}

/**
 * Marginal and component risk contributions.
 * Answers "which holding is actually generating my portfolio risk" — usually
 * very different from which holding has the largest weight.
 */
export function riskContributions(series, weights, ppy = TRADING_DAYS) {
  const keys = Object.keys(series);
  const cov = covarianceMatrix(series, ppy);
  const wsum = keys.reduce((a, k) => a + (weights[k] ?? 0), 0) || 1;
  const w = keys.map(k => (weights[k] ?? 0) / wsum);

  const pv = portfolioVol(series, weights, ppy);
  if (!pv) return keys.map(k => ({ symbol: k, weight: (weights[k] ?? 0) / wsum, marginal: 0, contribution: 0, pctOfRisk: 0 }));

  return keys.map((k, i) => {
    let mc = 0;
    for (let j = 0; j < w.length; j++) mc += w[j] * cov[i][j];
    const marginal = mc / pv;
    const contribution = w[i] * marginal;
    return {
      symbol: k,
      weight: w[i],
      marginal,
      contribution,
      pctOfRisk: contribution / pv,
    };
  });
}

/**
 * Diversification ratio: weighted average vol / portfolio vol.
 * 1.0 means no diversification benefit at all. Above ~1.4 is genuinely diversified.
 */
export function diversificationRatio(series, weights, ppy = TRADING_DAYS) {
  const keys = Object.keys(series);
  const wsum = keys.reduce((a, k) => a + (weights[k] ?? 0), 0) || 1;
  const weightedVol = keys.reduce((a, k) =>
    a + ((weights[k] ?? 0) / wsum) * annualisedVol(series[k], ppy), 0);
  const pv = portfolioVol(series, weights, ppy);
  return pv ? weightedVol / pv : 1;
}

/** Effective number of holdings (inverse Herfindahl) — concentration in one number. */
export function effectiveHoldings(weights) {
  const vals = Object.values(weights);
  const sum = vals.reduce((a, b) => a + b, 0) || 1;
  const hhi = vals.reduce((a, w) => a + (w / sum) ** 2, 0);
  return hhi ? 1 / hhi : 0;
}

// ─── Technicals (used by screener & research) ─────────────────

export function sma(values, period) {
  if (values.length < period) return null;
  return mean(values.slice(-period));
}

export function smaSeries(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    out.push(i + 1 < period ? null : mean(values.slice(i + 1 - period, i + 1)));
  }
  return out;
}

export function ema(values, period) {
  if (!values.length) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let e = values[0];
  for (let i = 0; i < values.length; i++) {
    e = i === 0 ? values[0] : values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return mean(trs.slice(-period));
}

export function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const w = closes.slice(-period);
  const m = mean(w), sd = stdev(w, false);
  return { mid: m, upper: m + mult * sd, lower: m - mult * sd,
           width: m ? (2 * mult * sd) / m : 0,
           percentB: (2 * mult * sd) ? (closes[closes.length - 1] - (m - mult * sd)) / (2 * mult * sd) : 0.5 };
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const f = emaSeries(closes, fast), s = emaSeries(closes, slow);
  const line = closes.map((_, i) => f[i] - s[i]);
  const sig = emaSeries(line.slice(slow - 1), signal);
  const macdLine = line[line.length - 1];
  const signalLine = sig[sig.length - 1];
  return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
}

export function zScore(values, lookback = 60) {
  if (values.length < lookback) return null;
  const w = values.slice(-lookback);
  const sd = stdev(w);
  return sd ? (values[values.length - 1] - mean(w)) / sd : 0;
}
