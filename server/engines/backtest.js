// Meridian v2 — backtesting engine
// Runs on stored bars, models commission and slippage, and always reports
// buy-and-hold alongside so a strategy has to beat doing nothing.

import { getBars } from '../db.js';
import * as A from './analytics.js';
import { TRADING_DAYS } from '../config.js';

export const STRATEGIES = {
  maCross:    { label: 'MA crossover',    params: { fast: 50, slow: 200 } },
  emaCross:   { label: 'EMA crossover',   params: { fast: 12, slow: 26 } },
  momentum:   { label: 'Momentum',        params: { lookback: 126, threshold: 0 } },
  meanRev:    { label: 'Mean reversion',  params: { lookback: 20, entryZ: -1.5, exitZ: 0 } },
  rsi:        { label: 'RSI',             params: { period: 14, buy: 30, sell: 70 } },
  breakout:   { label: 'Donchian breakout', params: { entry: 55, exit: 20 } },
  volTarget:  { label: 'Volatility target', params: { target: 0.12, lookback: 60 } },
  buyHold:    { label: 'Buy & hold',      params: {} },
};

function signalsFor(strategy, closes, params) {
  const n = closes.length;
  const sig = new Array(n).fill(0);
  const p = { ...(STRATEGIES[strategy]?.params ?? {}), ...params };

  if (strategy === 'buyHold') return sig.fill(1);

  if (strategy === 'maCross' || strategy === 'emaCross') {
    const f = strategy === 'maCross' ? A.smaSeries(closes, p.fast) : A.emaSeries(closes, p.fast);
    const s = strategy === 'maCross' ? A.smaSeries(closes, p.slow) : A.emaSeries(closes, p.slow);
    for (let i = 0; i < n; i++) sig[i] = (f[i] != null && s[i] != null && f[i] > s[i]) ? 1 : 0;
    return sig;
  }
  if (strategy === 'momentum') {
    for (let i = p.lookback; i < n; i++)
      sig[i] = (closes[i] / closes[i - p.lookback] - 1) > p.threshold ? 1 : 0;
    return sig;
  }
  if (strategy === 'meanRev') {
    let inPos = 0;
    for (let i = p.lookback; i < n; i++) {
      const w = closes.slice(i - p.lookback, i + 1);
      const sd = A.stdev(w), m = A.mean(w);
      const z = sd ? (closes[i] - m) / sd : 0;
      if (!inPos && z <= p.entryZ) inPos = 1;
      else if (inPos && z >= p.exitZ) inPos = 0;
      sig[i] = inPos;
    }
    return sig;
  }
  if (strategy === 'rsi') {
    let inPos = 0;
    for (let i = p.period + 1; i < n; i++) {
      const r = A.rsi(closes.slice(0, i + 1), p.period);
      if (r == null) continue;
      if (!inPos && r < p.buy) inPos = 1;
      else if (inPos && r > p.sell) inPos = 0;
      sig[i] = inPos;
    }
    return sig;
  }
  if (strategy === 'breakout') {
    let inPos = 0;
    for (let i = p.entry; i < n; i++) {
      const hi = Math.max(...closes.slice(i - p.entry, i));
      const lo = Math.min(...closes.slice(Math.max(0, i - p.exit), i));
      if (!inPos && closes[i] >= hi) inPos = 1;
      else if (inPos && closes[i] <= lo) inPos = 0;
      sig[i] = inPos;
    }
    return sig;
  }
  if (strategy === 'volTarget') {
    const rets = A.toReturns(closes);
    for (let i = p.lookback; i < n; i++) {
      const v = A.annualisedVol(rets.slice(i - p.lookback, i));
      sig[i] = v > 0 ? Math.max(0, Math.min(1.5, p.target / v)) : 1;
    }
    return sig;
  }
  return sig;
}

export function backtest(symbol, opts = {}) {
  const {
    strategy = 'maCross', params = {},
    initial = 10000, commission = 0.0, slippageBps = 5,
    from = null, to = null,
  } = opts;

  if (!(initial > 0)) return { error: 'Initial capital must be greater than zero.' };

  let bars = getBars(symbol, from, to);
  // The route already attempts a live sync before calling this — a symbol
  // still this short after that either doesn't trade, is misspelled, or is
  // too newly listed to backtest, not a step the caller forgot to take.
  if (bars.length < 60) return { error: `Only ${bars.length} bars stored for ${symbol} even after attempting a live sync — check the ticker, or it may be too newly listed to backtest.` };

  const dates  = bars.map(b => b.date);
  const closes = bars.map(b => b.adj_close ?? b.close);
  const sig = signalsFor(strategy, closes, params);
  const slip = slippageBps / 10000;

  let cash = initial, units = 0, pos = 0;
  const equity = [], trades = [];
  let entryPrice = null, entryDate = null;

  for (let i = 0; i < closes.length; i++) {
    const px = closes[i];
    const target = sig[i] ?? 0;

    if (Math.abs(target - pos) > 1e-9) {
      const portfolioValue = cash + units * px;
      const targetValue = portfolioValue * target;
      const currentValue = units * px;
      let diff = targetValue - currentValue;

      if (diff > 0) {                            // buying
        // Cash must cover the exposure plus slippage plus commission, so size
        // the trade from what is actually affordable rather than assuming the
        // full notional fits.
        const affordable = Math.max(0, (cash - commission) / (1 + slip));
        diff = Math.min(diff, affordable);
        if (diff > 1e-8) {
          const bought = diff / (px * (1 + slip));
          units += bought;
          cash -= diff + commission;
          if (pos <= 1e-9) { entryPrice = px; entryDate = dates[i]; }
          pos = target;
        }
      } else {                                   // selling
        const sellUnits = Math.min(units, -diff / px);
        if (sellUnits > 1e-12) {
          const proceeds = sellUnits * px * (1 - slip) - commission;
          units -= sellUnits;
          cash += proceeds;
          if (target <= 1e-9 && entryPrice != null) {
            trades.push({
              entryDate, exitDate: dates[i],
              entryPrice: +entryPrice.toFixed(4), exitPrice: +px.toFixed(4),
              returnPct: +(((px * (1 - slip)) / (entryPrice * (1 + slip)) - 1) * 100).toFixed(2),
              holdingDays: Math.round((Date.parse(dates[i]) - Date.parse(entryDate)) / 86400000),
              status: 'closed',
            });
            entryPrice = null;
          }
          pos = target;
        }
      }
    }
    equity.push(cash + units * px);
  }

  if (entryPrice != null) {
    const px = closes[closes.length - 1];
    trades.push({
      entryDate, exitDate: null,
      entryPrice: +entryPrice.toFixed(4), exitPrice: +px.toFixed(4),
      returnPct: +((px / entryPrice - 1) * 100).toFixed(2),
      holdingDays: Math.round((Date.parse(dates[dates.length - 1]) - Date.parse(entryDate)) / 86400000),
      status: 'open',
    });
  }

  const bh = closes.map(c => initial * c / closes[0]);
  const stratRets = A.toReturns(equity);
  const bhRets = A.toReturns(bh);
  const dd = A.maxDrawdown(equity, dates);
  const bhDd = A.maxDrawdown(bh, dates);

  const wins = trades.filter(t => t.returnPct > 0);
  const losses = trades.filter(t => t.returnPct <= 0);
  const grossWin = wins.reduce((a, t) => a + t.returnPct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.returnPct, 0));
  const exposure = sig.filter(s => s > 0).length / sig.length;

  const metrics = {
    totalReturn: +(A.totalReturn(equity) * 100).toFixed(2),
    cagr: +(A.cagr(equity) * 100).toFixed(2),
    volatility: +(A.annualisedVol(stratRets) * 100).toFixed(2),
    sharpe: +A.sharpe(stratRets).toFixed(3),
    sortino: +A.sortino(stratRets).toFixed(3),
    calmar: +A.calmar(equity).toFixed(3),
    maxDrawdown: +(dd.maxDrawdown * 100).toFixed(2),
    maxDrawdownWindow: dd.peakDate && dd.troughDate ? `${dd.peakDate} → ${dd.troughDate}` : null,
    daysUnderwater: dd.daysUnderwater,
    trades: trades.length,
    winRate: trades.length ? +(wins.length / trades.length * 100).toFixed(1) : 0,
    avgWin: wins.length ? +(grossWin / wins.length).toFixed(2) : 0,
    avgLoss: losses.length ? +(-grossLoss / losses.length).toFixed(2) : 0,
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : (grossWin ? Infinity : 0),
    exposure: +(exposure * 100).toFixed(1),
    finalValue: +equity[equity.length - 1].toFixed(2),
  };

  const benchmark = {
    totalReturn: +(A.totalReturn(bh) * 100).toFixed(2),
    cagr: +(A.cagr(bh) * 100).toFixed(2),
    volatility: +(A.annualisedVol(bhRets) * 100).toFixed(2),
    sharpe: +A.sharpe(bhRets).toFixed(3),
    maxDrawdown: +(bhDd.maxDrawdown * 100).toFixed(2),
    finalValue: +bh[bh.length - 1].toFixed(2),
  };

  return {
    symbol, strategy,
    strategyLabel: STRATEGIES[strategy]?.label ?? strategy,
    params: { ...(STRATEGIES[strategy]?.params ?? {}), ...params },
    period: { from: dates[0], to: dates[dates.length - 1], bars: dates.length },
    metrics, benchmark,
    verdict: verdict(metrics, benchmark),
    equityCurve: dates.map((d, i) => ({
      date: d, strategy: +equity[i].toFixed(2), buyHold: +bh[i].toFixed(2),
    })).filter((_, i) => i % Math.max(1, Math.floor(dates.length / 500)) === 0),
    drawdownCurve: A.drawdownSeries(equity)
      .map((v, i) => ({ date: dates[i], drawdown: +(v * 100).toFixed(2) }))
      .filter((_, i) => i % Math.max(1, Math.floor(dates.length / 500)) === 0),
    trades: trades.slice(-100).reverse(),
  };
}

function verdict(m, b) {
  const out = [];
  const excess = m.totalReturn - b.totalReturn;
  out.push(excess > 0
    ? `Beat buy-and-hold by ${excess.toFixed(1)} percentage points, with ${m.exposure}% time in the market.`
    : `Underperformed buy-and-hold by ${Math.abs(excess).toFixed(1)} percentage points. Doing nothing would have worked better.`);
  out.push(Math.abs(m.maxDrawdown) < Math.abs(b.maxDrawdown)
    ? `Shallower worst drawdown (${m.maxDrawdown}% vs ${b.maxDrawdown}%), so the risk reduction was real.`
    : `Deeper drawdown than buy-and-hold (${m.maxDrawdown}% vs ${b.maxDrawdown}%) — more risk for the return.`);
  if (m.trades < 10) out.push(`Only ${m.trades} trades. Too few to distinguish skill from luck.`);
  else if (m.profitFactor < 1.2) out.push(`Profit factor of ${m.profitFactor} is thin — fragile to costs.`);
  return out;
}

/** Walk-forward validation: optimise on a window, test out-of-sample on the next.
 *  A strategy that only works in-sample is the single most common backtest lie. */
export function walkForward(symbol, opts = {}) {
  const { strategy = 'maCross', grid = null, folds = 5, ...rest } = opts;
  const bars = getBars(symbol);
  if (bars.length < 500) return { error: 'Need 500+ bars for walk-forward validation.' };

  const paramGrid = grid ?? defaultGrid(strategy);
  const foldSize = Math.floor(bars.length / (folds + 1));
  const results = [];

  for (let f = 0; f < folds; f++) {
    const trainEnd = (f + 1) * foldSize;
    const testEnd = Math.min(bars.length, trainEnd + foldSize);
    const trainFrom = bars[0].date, trainTo = bars[trainEnd - 1].date;
    const testFrom = bars[trainEnd].date, testTo = bars[testEnd - 1].date;

    let best = null;
    for (const p of paramGrid) {
      const r = backtest(symbol, { ...rest, strategy, params: p, from: trainFrom, to: trainTo });
      if (r.error) continue;
      if (!best || r.metrics.sharpe > best.sharpe) best = { params: p, sharpe: r.metrics.sharpe };
    }
    if (!best) continue;
    const oos = backtest(symbol, { ...rest, strategy, params: best.params, from: testFrom, to: testTo });
    if (oos.error) continue;
    results.push({
      fold: f + 1,
      trainWindow: `${trainFrom} → ${trainTo}`,
      testWindow: `${testFrom} → ${testTo}`,
      chosenParams: best.params,
      inSampleSharpe: +best.sharpe.toFixed(3),
      outOfSampleSharpe: oos.metrics.sharpe,
      outOfSampleReturn: oos.metrics.totalReturn,
      benchmarkReturn: oos.benchmark.totalReturn,
    });
  }

  const avgIS = A.mean(results.map(r => r.inSampleSharpe));
  const avgOOS = A.mean(results.map(r => r.outOfSampleSharpe));
  return {
    symbol, strategy, folds: results.length, results,
    averageInSampleSharpe: +avgIS.toFixed(3),
    averageOutOfSampleSharpe: +avgOOS.toFixed(3),
    degradation: +(avgIS - avgOOS).toFixed(3),
    verdict: avgOOS <= 0
      ? 'Fails out of sample. The in-sample result was curve-fitting.'
      : avgOOS < avgIS * 0.5
        ? 'Substantial degradation out of sample. Treat the backtest as optimistic.'
        : 'Holds up out of sample, which is the rarer outcome.',
  };
}

function defaultGrid(strategy) {
  if (strategy === 'maCross') return [
    { fast: 20, slow: 100 }, { fast: 50, slow: 200 }, { fast: 20, slow: 50 }, { fast: 100, slow: 200 }];
  if (strategy === 'emaCross') return [
    { fast: 8, slow: 21 }, { fast: 12, slow: 26 }, { fast: 20, slow: 50 }];
  if (strategy === 'momentum') return [
    { lookback: 63 }, { lookback: 126 }, { lookback: 252 }];
  if (strategy === 'rsi') return [
    { buy: 25, sell: 75 }, { buy: 30, sell: 70 }, { buy: 35, sell: 65 }];
  if (strategy === 'meanRev') return [
    { entryZ: -1.0 }, { entryZ: -1.5 }, { entryZ: -2.0 }];
  if (strategy === 'breakout') return [
    { entry: 20, exit: 10 }, { entry: 55, exit: 20 }, { entry: 100, exit: 50 }];
  return [{}];
}
