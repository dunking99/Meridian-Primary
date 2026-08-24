// Meridian v2 — factor screener, scored against stored bar history.
// v1 scored against whatever a single live quote happened to contain. This
// version uses real history, so momentum and mean-reversion actually mean
// something rather than being restatements of the daily percentage change.

import { getBars } from '../db.js';
import * as A from './analytics.js';

export const STRATEGIES = {
  momentum:      { label: 'Momentum',       weights: { trend: 0.40, momentum: 0.40, volume: 0.15, meanRev: 0.05 } },
  trend:         { label: 'Trend following',weights: { trend: 0.55, momentum: 0.25, volume: 0.10, meanRev: 0.10 } },
  meanReversion: { label: 'Mean reversion', weights: { meanRev: 0.60, volume: 0.20, trend: 0.10, momentum: 0.10 } },
  quality:       { label: 'Low volatility', weights: { lowVol: 0.55, trend: 0.25, momentum: 0.20 } },
  breakout:      { label: 'Breakout',       weights: { breakout: 0.50, volume: 0.30, momentum: 0.20 } },
  balanced:      { label: 'Balanced',       weights: { trend: 0.25, momentum: 0.25, meanRev: 0.20, volume: 0.15, lowVol: 0.15 } },
};

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const scale = (x, lo, hi) => clamp(((x - lo) / (hi - lo)) * 100);

export function scoreSymbol(symbol, opts = {}) {
  const bars = getBars(symbol);
  if (bars.length < 120) return null;

  const closes = bars.map(b => b.adj_close ?? b.close).filter(Boolean);
  const vols   = bars.map(b => b.volume ?? 0);
  const price  = closes[closes.length - 1];
  const rets   = A.toReturns(closes);

  const ma50  = A.sma(closes, 50);
  const ma200 = A.sma(closes, 200);
  const high52 = Math.max(...closes.slice(-252));
  const low52  = Math.min(...closes.slice(-252));
  const rangePos = high52 > low52 ? (price - low52) / (high52 - low52) : 0.5;

  const r1m = closes.length > 21 ? price / closes[closes.length - 22] - 1 : 0;
  const r3m = closes.length > 63 ? price / closes[closes.length - 64] - 1 : 0;
  const r6m = closes.length > 126 ? price / closes[closes.length - 127] - 1 : 0;
  const r12m1 = closes.length > 252
    ? closes[closes.length - 22] / closes[closes.length - 253] - 1 : 0;   // 12-1 momentum

  const rsi14 = A.rsi(closes, 14) ?? 50;
  const z = A.zScore(closes, 60) ?? 0;
  const bb = A.bollinger(closes, 20, 2);
  const macdVal = A.macd(closes);
  const vol = A.annualisedVol(rets.slice(-126));
  const avgVol = A.mean(vols.slice(-63)) || 0;
  const volRatio = avgVol ? (vols[vols.length - 1] || 0) / avgVol : 1;

  // Component scores, each 0–100
  const trend = clamp(
    (ma50 && price > ma50 ? 30 : 0) +
    (ma200 && price > ma200 ? 30 : 0) +
    (ma50 && ma200 && ma50 > ma200 ? 20 : 0) +
    rangePos * 20
  );
  const momentum = clamp(
    scale(r12m1, -0.30, 0.60) * 0.4 +
    scale(r6m,  -0.25, 0.45) * 0.3 +
    scale(r3m,  -0.20, 0.30) * 0.2 +
    scale(r1m,  -0.12, 0.15) * 0.1
  );
  const meanRev = clamp(
    scale(-z, -2.5, 2.5) * 0.5 +
    scale(50 - rsi14, -35, 35) * 0.3 +
    scale(1 - (bb?.percentB ?? 0.5), 0, 1) * 0.2
  );
  const volume  = clamp(scale(volRatio, 0.4, 2.5));
  const lowVol  = clamp(100 - scale(vol, 0.05, 0.55));
  const breakout = clamp(
    (price >= high52 * 0.98 ? 60 : rangePos * 50) +
    (volRatio > 1.3 ? 25 : 0) +
    (macdVal && macdVal.histogram > 0 ? 15 : 0)
  );

  const parts = { trend, momentum, meanRev, volume, lowVol, breakout };
  const strat = STRATEGIES[opts.strategy] ?? STRATEGIES.balanced;
  let composite = 0, wsum = 0;
  for (const [k, w] of Object.entries(strat.weights)) {
    composite += (parts[k] ?? 50) * w; wsum += w;
  }
  composite = wsum ? composite / wsum : 50;

  const signals = [];
  if (ma50 && ma200 && ma50 > ma200) signals.push('Golden cross');
  if (ma50 && ma200 && ma50 < ma200) signals.push('Death cross');
  if (price >= high52 * 0.98) signals.push('At 52w high');
  if (price <= low52 * 1.02) signals.push('At 52w low');
  if (rsi14 > 70) signals.push('RSI overbought');
  if (rsi14 < 30) signals.push('RSI oversold');
  if (volRatio > 1.8) signals.push('Volume spike');
  if (macdVal && macdVal.histogram > 0) signals.push('MACD positive');

  return {
    symbol, price: +price.toFixed(2),
    composite: +composite.toFixed(1),
    scores: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, +v.toFixed(1)])),
    metrics: {
      ma50: ma50 ? +ma50.toFixed(2) : null,
      ma200: ma200 ? +ma200.toFixed(2) : null,
      high52: +high52.toFixed(2), low52: +low52.toFixed(2),
      rangePosition: +(rangePos * 100).toFixed(1),
      rsi: +rsi14.toFixed(1),
      zScore: +z.toFixed(2),
      annualVol: +(vol * 100).toFixed(1),
      volumeRatio: +volRatio.toFixed(2),
      return1m: +(r1m * 100).toFixed(2),
      return3m: +(r3m * 100).toFixed(2),
      return6m: +(r6m * 100).toFixed(2),
      return12m1: +(r12m1 * 100).toFixed(2),
      macdHistogram: macdVal ? +macdVal.histogram.toFixed(3) : null,
    },
    signals,
    observations: closes.length,
  };
}

export function screen(symbols, opts = {}) {
  const { strategy = 'balanced', minScore = 0, limit = 50 } = opts;
  const results = [];
  const skipped = [];
  for (const s of symbols) {
    const r = scoreSymbol(s, { strategy });
    if (!r) { skipped.push(s); continue; }
    if (r.composite >= minScore) results.push(r);
  }
  results.sort((a, b) => b.composite - a.composite);
  return {
    strategy, strategyLabel: (STRATEGIES[strategy] ?? STRATEGIES.balanced).label,
    scanned: symbols.length,
    returned: Math.min(results.length, limit),
    skipped,
    results: results.slice(0, limit),
  };
}
