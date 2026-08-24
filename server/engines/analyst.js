// Meridian v2 — unified analyst context
//
// The central architectural change to the AI layer. In v1 each page called the
// model in isolation with only its own data, so the model could never say
// anything that connected two parts of the picture. Here the server assembles
// one structured brief — portfolio, risk, regime, news, signals, alerts — and
// the model reasons over all of it at once.
//
// The server builds the context; the browser makes the model call with the
// user's own key. No key ever touches this file.

import * as A from './analytics.js';
import { valuePortfolio, holdingReturnSeries, reconstructHistory } from './portfolio.js';
import { getNews } from '../sources/news.js';
import { listAlerts } from './alerts.js';
import { screen } from './screener.js';
import { getBars } from '../db.js';
import { BENCHMARK, FACTORS } from '../config.js';

/** Market regime derived from live data rather than hardcoded thresholds. */
export function computeRegime(prices) {
  const vix = prices['^VIX']?.price;
  const spx = prices['^GSPC'];
  const tnx = prices['^TNX']?.price;
  const irx = prices['^IRX']?.price;
  const gold = prices['GC=F'];
  const dxy = prices['DX-Y.NYB'];

  const bars = getBars('^GSPC');
  const closes = bars.map(b => b.adj_close ?? b.close).filter(Boolean);
  const ma200 = A.sma(closes, 200);
  const ma50 = A.sma(closes, 50);
  const px = spx?.price ?? closes[closes.length - 1];

  const trend = (ma50 && ma200 && px)
    ? (px > ma50 && ma50 > ma200 ? 'uptrend'
      : px < ma50 && ma50 < ma200 ? 'downtrend' : 'mixed')
    : 'unknown';

  const volState = vix == null ? 'unknown'
    : vix < 14 ? 'complacent' : vix < 20 ? 'calm' : vix < 28 ? 'elevated' : 'stressed';

  const curve = (tnx != null && irx != null) ? tnx - irx : null;
  const curveState = curve == null ? 'unknown'
    : curve < -0.2 ? 'inverted' : curve < 0.3 ? 'flat' : 'normal';

  let score = 50;
  if (trend === 'uptrend') score += 18; else if (trend === 'downtrend') score -= 22;
  if (volState === 'complacent') score += 6;
  else if (volState === 'elevated') score -= 12;
  else if (volState === 'stressed') score -= 22;
  if (curveState === 'inverted') score -= 10;
  if (gold?.changePct > 1 && spx?.changePct < 0) score -= 5;
  score = Math.max(0, Math.min(100, score));

  return {
    label: score >= 70 ? 'Risk-on' : score >= 50 ? 'Constructive'
         : score >= 32 ? 'Cautious' : 'Risk-off',
    score,
    trend, volatility: volState, yieldCurve: curveState,
    inputs: {
      vix: vix ?? null,
      spxVs200dma: (px && ma200) ? +(((px / ma200) - 1) * 100).toFixed(2) : null,
      spxVs50dma: (px && ma50) ? +(((px / ma50) - 1) * 100).toFixed(2) : null,
      curveSpread: curve != null ? +curve.toFixed(2) : null,
      dollarChange: dxy?.changePct ?? null,
      goldChange: gold?.changePct ?? null,
    },
  };
}

/** Full risk profile of the current portfolio from stored history. */
export function riskProfile(prices, opts = {}) {
  const { confidence = 0.95, lookback = 750 } = opts;
  const v = valuePortfolio(prices);
  const symbols = v.positions.filter(p => p.hasPrice && p.value > 0).map(p => p.symbol);
  if (!symbols.length) return { error: 'No priced holdings.' };

  const series = holdingReturnSeries(symbols, lookback);
  const covered = Object.keys(series);
  const missingHistory = symbols.filter(s => !covered.includes(s));

  // These are two different failures and were previously reported with the
  // same message, which sent debugging in the wrong direction: a single-holding
  // portfolio is not a history problem.
  if (covered.length === 0) {
    return {
      error: symbols.length
        ? `No stored price history for ${symbols.join(', ')}. Run a history sync.`
        : 'No priced holdings.',
      covered, missingHistory,
    };
  }
  if (covered.length === 1) {
    return {
      error: 'Risk analysis needs at least two holdings with history — correlation, diversification and risk contribution are undefined for a single position.',
      covered, missingHistory,
      singleHolding: covered[0],
    };
  }

  const weights = Object.fromEntries(
    covered.map(s => [s, v.positions.find(p => p.symbol === s).value])
  );

  const portRets = A.portfolioReturns(series, weights);
  const benchBars = getBars(BENCHMARK);
  const benchRets = A.toReturns(benchBars.map(b => b.adj_close ?? b.close).filter(Boolean));

  const hist = reconstructHistory(prices, lookback);
  const values = hist.series.map(s => s.value);

  const ba = benchRets.length > 30 ? A.betaAlpha(portRets, benchRets) : null;
  const cap = benchRets.length > 30 ? A.captureRatios(portRets, benchRets) : null;

  return {
    asOf: new Date().toISOString(),
    totalValue: v.total,
    coverage: { analysed: covered.length, total: symbols.length,
                excluded: symbols.filter(s => !covered.includes(s)) },
    observations: portRets.length,
    volatility: +(A.annualisedVol(portRets) * 100).toFixed(2),
    sharpe: +A.sharpe(portRets).toFixed(3),
    sortino: +A.sortino(portRets).toFixed(3),
    beta: ba ? +ba.beta.toFixed(3) : null,
    alpha: ba ? +(ba.alpha * 100).toFixed(2) : null,
    r2: ba ? +ba.r2.toFixed(3) : null,
    upCapture: cap ? +(cap.upCapture * 100).toFixed(1) : null,
    downCapture: cap ? +(cap.downCapture * 100).toFixed(1) : null,
    var: A.varSuite(portRets, confidence),
    varInPounds: (() => {
      const s = A.varSuite(portRets, confidence);
      return {
        daily95: s.daily.historical != null ? +(s.daily.historical * v.total).toFixed(0) : null,
        monthly95: s.monthly.historical != null ? +(s.monthly.historical * v.total).toFixed(0) : null,
        cvarDaily: s.daily.cvar != null ? +(s.daily.cvar * v.total).toFixed(0) : null,
      };
    })(),
    drawdown: values.length > 30 ? (() => {
      const dd = A.maxDrawdown(values, hist.series.map(s => s.date));
      return {
        max: +(dd.maxDrawdown * 100).toFixed(2),
        window: dd.peakDate && dd.troughDate ? `${dd.peakDate} → ${dd.troughDate}` : null,
        current: +(A.drawdownSeries(values).pop() * 100).toFixed(2),
        stillUnderwater: dd.stillUnderwater,
      };
    })() : null,
    diversification: {
      averageCorrelation: +A.averageCorrelation(series).toFixed(3),
      diversificationRatio: +A.diversificationRatio(series, weights).toFixed(3),
      effectiveHoldings: +A.effectiveHoldings(weights).toFixed(2),
    },
    riskContributions: A.riskContributions(series, weights)
      .map(r => ({
        symbol: r.symbol,
        weight: +(r.weight * 100).toFixed(2),
        pctOfRisk: +(r.pctOfRisk * 100).toFixed(2),
        riskPerUnitWeight: r.weight ? +(r.pctOfRisk / r.weight).toFixed(2) : 0,
      }))
      .sort((a, b) => b.pctOfRisk - a.pctOfRisk),
    concentration: v.concentration,
    correlationMatrix: A.correlationMatrix(series),
  };
}

/** Detect correlation breakdown — diversification failing when it's needed. */
export function correlationWatch(prices, { window = 60 } = {}) {
  const v = valuePortfolio(prices);
  const symbols = v.positions.filter(p => p.hasPrice).map(p => p.symbol);
  const series = holdingReturnSeries(symbols, 750);
  const covered = Object.keys(series);
  if (covered.length < 2) return { error: 'Insufficient history.' };

  const recent = Object.fromEntries(covered.map(s => [s, series[s].slice(-window)]));
  const prior = Object.fromEntries(covered.map(s => [s, series[s].slice(-window * 3, -window)]));

  const recentAvg = A.averageCorrelation(recent);
  const priorAvg = Object.values(prior).every(x => x.length > 20)
    ? A.averageCorrelation(prior) : null;

  const pairs = [];
  for (let i = 0; i < covered.length; i++) {
    for (let j = i + 1; j < covered.length; j++) {
      const a = covered[i], b = covered[j];
      const now = A.correlation(recent[a], recent[b]);
      const before = prior[a]?.length > 20 ? A.correlation(prior[a], prior[b]) : null;
      pairs.push({ pair: `${a} / ${b}`, recent: +now.toFixed(3),
                   prior: before == null ? null : +before.toFixed(3),
                   change: before == null ? null : +(now - before).toFixed(3) });
    }
  }
  pairs.sort((a, b) => (b.change ?? -9) - (a.change ?? -9));

  return {
    window,
    averageCorrelationRecent: +recentAvg.toFixed(3),
    averageCorrelationPrior: priorAvg == null ? null : +priorAvg.toFixed(3),
    shift: priorAvg == null ? null : +(recentAvg - priorAvg).toFixed(3),
    warning: priorAvg != null && recentAvg - priorAvg > 0.15
      ? 'Correlations have risen materially. Diversification is providing less protection than the historical average suggests.'
      : null,
    mostIncreased: pairs.slice(0, 5),
    mostDecreased: pairs.slice(-5).reverse(),
  };
}

/**
 * Assemble the complete analyst brief. This is the object the frontend sends
 * to the model. It is deliberately compact — structured facts, no prose — so
 * the model spends its context reasoning rather than reading boilerplate.
 */
export function buildBrief(prices, opts = {}) {
  const { includeScreen = true, newsLimit = 18 } = opts;

  const v = valuePortfolio(prices);
  const regime = computeRegime(prices);
  const risk = riskProfile(prices);
  const held = v.positions.map(p => p.symbol);

  const news = getNews({ limit: newsLimit });
  const relevantNews = news.filter(n => n.symbols.some(s => held.includes(s)));

  const alerts = listAlerts('triggered').slice(0, 10);

  let screenResults = null;
  if (includeScreen && held.length) {
    const s = screen(held, { strategy: 'balanced' });
    screenResults = s.results.map(r => ({
      symbol: r.symbol, composite: r.composite,
      signals: r.signals, rsi: r.metrics.rsi,
      vs50dma: r.metrics.ma50 ? +(((r.price / r.metrics.ma50) - 1) * 100).toFixed(1) : null,
      rangePosition: r.metrics.rangePosition,
    }));
  }

  const movers = [...v.positions]
    .filter(p => p.dayChangePct != null)
    .sort((a, b) => Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct))
    .slice(0, 5)
    .map(p => ({ symbol: p.symbol, changePct: p.dayChangePct, weight: p.weight }));

  return {
    generatedAt: new Date().toISOString(),
    portfolio: {
      total: v.total, invested: v.invested, cash: v.cash,
      pnl: v.pnl, pnlPct: v.pnlPct,
      dayChange: v.dayChange, dayChangePct: v.dayChangePct,
      positionCount: v.positions.length,
      topPositions: v.positions.slice(0, 10).map(p => ({
        symbol: p.symbol, weight: p.weight, pnlPct: p.pnlPct,
        dayChangePct: p.dayChangePct, sector: p.sector, geography: p.geography,
      })),
      breakdowns: {
        geography: v.breakdowns.geography,
        assetClass: v.breakdowns.assetClass,
      },
      concentration: v.concentration,
      missingPrices: v.missingPrices,
    },
    regime,
    risk: risk.error ? { unavailable: risk.error } : {
      volatility: risk.volatility, beta: risk.beta, sharpe: risk.sharpe,
      var95Daily: risk.varInPounds?.daily95,
      currentDrawdown: risk.drawdown?.current,
      averageCorrelation: risk.diversification?.averageCorrelation,
      diversificationRatio: risk.diversification?.diversificationRatio,
      topRiskContributors: risk.riskContributions?.slice(0, 5),
    },
    movers,
    signals: screenResults,
    triggeredAlerts: alerts.map(a => ({ symbol: a.symbol, kind: a.kind, value: a.triggered_value })),
    news: relevantNews.slice(0, 10).map(n => ({
      title: n.title, source: n.source, symbols: n.symbols,
      sentiment: n.sentiment, published: n.published,
    })),
    marketNews: news.filter(n => !relevantNews.includes(n)).slice(0, 6)
      .map(n => ({ title: n.title, source: n.source })),
  };
}

/**
 * The instruction half of the prompt. Kept server-side so it can be improved
 * without touching the UI, and so the model is consistently told to be
 * specific and to decline when the data does not support a claim.
 */
export function briefPrompt(kind = 'daily') {
  const base = `You are the analyst layer of Meridian, a personal investment dashboard. You receive a structured JSON brief containing the user's actual portfolio, computed risk metrics, market regime indicators, technical signals, and tagged news.

Rules:
- Reason across the whole brief. The value you add is connecting things: a risk metric to a news item to a position weight. Single-fact restatements are worthless.
- Cite the actual numbers from the brief. Never invent a figure that is not there.
- If the brief says a metric is unavailable, say so plainly rather than guessing.
- British English. No preamble, no bullet-point padding, no disclaimers about not being financial advice.
- Be willing to say nothing important happened, if nothing important happened.`;

  const modes = {
    daily: `${base}

Write a morning brief of at most 250 words in three short paragraphs:
1. What actually moved in this portfolio and why, using the movers and news.
2. What the risk and regime numbers say about the current position.
3. One specific thing worth attention today. Not a trade instruction — an observation with a number attached.`,

    risk: `${base}

Write a risk assessment of at most 300 words. Lead with the single largest risk in this portfolio as the numbers show it, not as convention would assume. Address concentration, the gap between weights and risk contributions, and correlation. Where a holding contributes far more risk than its weight, name it.`,

    rebalance: `${base}

Assess whether this portfolio needs rebalancing. Use drift, concentration, and risk contributions. If the answer is no, say so in one sentence. If yes, say which positions and why, and note any tax friction the brief flags.`,

    position: `${base}

Assess the named position in the context of the whole portfolio: its weight, its risk contribution, its correlation with the rest, its technical state, and any tagged news. Give a bull case, a bear case, and the specific condition that would change the picture.`,
  };
  return modes[kind] ?? modes.daily;
}
