// Meridian v2 — historical scenario stress testing
// Replays real crisis windows against the current portfolio. Where a holding
// has its own history in that window it is used directly; where it doesn't
// (newer ETFs), exposure is estimated by regression against factor proxies
// that do have the history.

import { betaAlpha, toReturns, mean } from './analytics.js';
import { SCENARIOS, FACTORS } from '../config.js';

/**
 * @param {Array} positions [{symbol, value}]
 * @param {Function} getBars (symbol, from, to) => [{date, close}]
 */
export function runScenario(positions, scenario, getBars, opts = {}) {
  const { proxyFactor = FACTORS.usEquity } = opts;
  const total = positions.reduce((a, p) => a + p.value, 0);
  if (!total) return { error: 'Portfolio has no value.' };

  const proxyBars = getBars(proxyFactor, scenario.from, scenario.to) ?? [];
  const proxyCloses = proxyBars.map(b => b.close).filter(Boolean);
  const proxyReturn = proxyCloses.length > 1
    ? proxyCloses[proxyCloses.length - 1] / proxyCloses[0] - 1 : 0;

  const lines = [];
  for (const p of positions) {
    const bars = getBars(p.symbol, scenario.from, scenario.to) ?? [];
    const closes = bars.map(b => b.close).filter(Boolean);

    let ret, method, beta = null;
    if (closes.length > 5) {
      ret = closes[closes.length - 1] / closes[0] - 1;
      method = 'actual';
    } else {
      // estimate beta on all available overlapping history, then scale the proxy move
      const own = getBars(p.symbol) ?? [];
      const proxyAll = getBars(proxyFactor) ?? [];
      const est = estimateBeta(own, proxyAll);
      beta = est.beta;
      ret = est.beta * proxyReturn;
      method = est.n > 60 ? 'beta-estimated' : 'beta-assumed';
      if (est.n <= 60) { beta = 1; ret = proxyReturn; }
    }

    lines.push({
      symbol: p.symbol,
      weight: p.value / total,
      valueBefore: +p.value.toFixed(2),
      scenarioReturn: +(ret * 100).toFixed(2),
      valueAfter: +(p.value * (1 + ret)).toFixed(2),
      pnl: +(p.value * ret).toFixed(2),
      method, beta: beta == null ? null : +beta.toFixed(2),
    });
  }

  const after = lines.reduce((a, l) => a + l.valueAfter, 0);
  const pnl = after - total;

  return {
    scenario: scenario.id,
    label: scenario.label,
    window: `${scenario.from} → ${scenario.to}`,
    note: scenario.note,
    benchmarkReturn: +(proxyReturn * 100).toFixed(2),
    portfolioReturn: +(pnl / total * 100).toFixed(2),
    valueBefore: +total.toFixed(2),
    valueAfter: +after.toFixed(2),
    pnl: +pnl.toFixed(2),
    relativeToBenchmark: +((pnl / total - proxyReturn) * 100).toFixed(2),
    worstContributors: [...lines].sort((a, b) => a.pnl - b.pnl).slice(0, 5),
    bestContributors: [...lines].sort((a, b) => b.pnl - a.pnl).slice(0, 3),
    lines: lines.sort((a, b) => a.pnl - b.pnl),
    coverage: {
      actual: lines.filter(l => l.method === 'actual').length,
      estimated: lines.filter(l => l.method !== 'actual').length,
      total: lines.length,
    },
  };
}

function estimateBeta(ownBars, proxyBars) {
  if (!ownBars?.length || !proxyBars?.length) return { beta: 1, n: 0 };
  const pMap = new Map(proxyBars.map(b => [b.date, b.close]));
  const dates = ownBars.map(b => b.date).filter(d => pMap.has(d));
  if (dates.length < 30) return { beta: 1, n: dates.length };
  const oMap = new Map(ownBars.map(b => [b.date, b.close]));
  const own = dates.map(d => oMap.get(d));
  const prx = dates.map(d => pMap.get(d));
  const r1 = toReturns(own), r2 = toReturns(prx);
  const { beta } = betaAlpha(r1, r2);
  return { beta: isFinite(beta) && beta !== 0 ? beta : 1, n: r1.length };
}

export function runAllScenarios(positions, getBars, opts = {}) {
  const results = SCENARIOS.map(s => runScenario(positions, s, getBars, opts))
                           .filter(r => !r.error);
  const worst = results.reduce((a, r) => (!a || r.portfolioReturn < a.portfolioReturn ? r : a), null);
  return {
    results: results.sort((a, b) => a.portfolioReturn - b.portfolioReturn),
    worstCase: worst ? { scenario: worst.label, loss: worst.portfolioReturn, value: worst.valueAfter } : null,
    averageLoss: results.length
      ? +(mean(results.map(r => r.portfolioReturn))).toFixed(2) : 0,
  };
}

/** Instantaneous shock test — arbitrary factor moves applied via betas. */
export function shockTest(positions, shocks, getBars, factor = FACTORS.usEquity) {
  const total = positions.reduce((a, p) => a + p.value, 0);
  const proxyAll = getBars(factor) ?? [];
  const betas = {};
  for (const p of positions) {
    betas[p.symbol] = estimateBeta(getBars(p.symbol) ?? [], proxyAll).beta;
  }
  return shocks.map(shock => {
    let after = 0;
    for (const p of positions) after += p.value * (1 + betas[p.symbol] * shock);
    return {
      shock: +(shock * 100).toFixed(1),
      portfolioChange: total ? +((after - total) / total * 100).toFixed(2) : 0,
      valueAfter: +after.toFixed(2),
      pnl: +(after - total).toFixed(2),
    };
  });
}
