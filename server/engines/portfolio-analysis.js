// Meridian — portfolio analysis
//
// The Portfolio page could always say what is held and what it is worth. It
// could never say whether the things held are any good, whether they are the
// same bet twice, or which one of them is dragging the rest down. Those are
// the three questions this file answers, and it answers all of them from
// figures that already exist rather than by inventing a new scoring system:
//
//   - the scorecard scores held positions on the same five axes, computed by
//     the same code, that the rebuild pipeline uses to judge candidates. A
//     holding's quality score here and its quality score in a rebuild run are
//     the same number, because they are the same function call. Anything else
//     would make the two pages quietly disagree about the same instrument.
//   - the correlation pairs reuse the same date-joined correlation the
//     exposure teardown uses, for the same reason.
//   - the holding detail assembles what the other engines already know about
//     one symbol into a single read, rather than making the side panel fire
//     six requests and stitch them together in the browser.
//
// Nothing here fabricates. Every axis reports what share of the portfolio it
// could actually see, every pair that cannot be assessed is listed with the
// reason, and a component that could not be measured lowers coverage instead
// of being filled in with a neutral value.

import { getBars, all } from '../db.js';
import { classify } from '../sources/instruments.js';
import { getNews } from '../sources/news.js';
import * as research from './research.js';
import * as bullbear from './bullbear.js';
import { componentScores, blendComponents } from './rebuild/diligence.js';
import { getComposition, returnCorrelation } from './rebuild/exposure.js';
import { TRADING_DAYS } from '../config.js';

// ─── Component cache ──────────────────────────────────────────
//
// A component set costs a precedent study, a screener pass and a full-history
// statistics run per symbol. All three read stored daily bars and a published
// expense ratio, none of which change between one page load and the next, so
// recomputing them on every poll is pure waste.
//
// What is deliberately NOT cached is the aggregation: weights come from live
// prices and are recomputed on every request. So the scorecard moves when the
// market moves, while the expensive per-instrument scoring refreshes on the
// same cadence as the data behind it.

const CACHE_TTL_MS = 10 * 60 * 1000;
const componentCache = new Map();

function cachedComponents(symbol, opts) {
  const key = `${symbol}|${opts.lookbackDays}|${opts.strategy}|${(opts.timingTrust ?? 1).toFixed(2)}`;
  const hit = componentCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = componentScores(symbol, opts);
  componentCache.set(key, { at: Date.now(), value });
  return value;
}

export function clearComponentCache() { componentCache.clear(); }

// ─── Holdings by type ─────────────────────────────────────────

/**
 * What kind of thing each holding is, from the most reliable source that
 * actually knows.
 *
 * classify() is the one place in this project that decides what a ticker
 * refers to, so it goes first — but it returns 'unknown' for any symbol not in
 * the config table and without a recognisable suffix, which is an ordinary
 * outcome for a newly-added holding rather than an error. In that case the
 * category Yahoo published alongside the fund's composition is the next best
 * real answer, and the asset class recorded on the holding itself is the last.
 * Only when all three are silent is it reported as unclassified, which is the
 * truth rather than a guess at 'Equity'.
 */
function instrumentTypeLabel(p) {
  const inst = classify(p.symbol);
  if (inst.type !== 'unknown') return inst.label;
  const comp = getComposition(p.symbol);
  if (comp?.category) return comp.category;
  if (p.assetClass) return p.assetClass;
  return 'Unclassified';
}

/**
 * Group holdings by what kind of instrument they actually are.
 *
 * Cash is appended as its own row because a type breakdown that silently omits
 * the cash pile misstates every other percentage in the table.
 */
export function holdingsByType(positions, cash = 0, total = 0) {
  const groups = new Map();

  for (const p of positions) {
    const label = instrumentTypeLabel(p);
    const g = groups.get(label) ?? { label, items: 0, value: 0, cost: 0, symbols: [], targetPct: 0, hasTarget: false };
    g.items += 1;
    g.value += p.value ?? 0;
    g.cost += p.cost ?? 0;
    g.symbols.push(p.symbol);
    if (p.targetPct != null) { g.targetPct += p.targetPct; g.hasTarget = true; }
    groups.set(label, g);
  }

  const rows = [...groups.values()].map(g => ({
    label: g.label,
    items: g.items,
    symbols: g.symbols,
    value: +g.value.toFixed(2),
    cost: +g.cost.toFixed(2),
    gain: +(g.value - g.cost).toFixed(2),
    gainPct: g.cost ? +(((g.value / g.cost) - 1) * 100).toFixed(2) : null,
    pct: total ? +(g.value / total * 100).toFixed(2) : 0,
    targetPct: g.hasTarget ? +g.targetPct.toFixed(2) : null,
  }));

  if (cash > 0) {
    rows.push({
      label: 'Cash', items: 1, symbols: [],
      value: +cash.toFixed(2), cost: +cash.toFixed(2),
      // Cash has no cost basis to gain against; null rather than a misleading 0%.
      gain: 0, gainPct: null,
      pct: total ? +(cash / total * 100).toFixed(2) : 0,
      targetPct: null,
    });
  }

  return rows.sort((a, b) => b.value - a.value);
}

// ─── Reconstructed return ─────────────────────────────────────

/**
 * What today's portfolio has compounded at, over as much overlapping stored
 * history as every holding shares.
 *
 * Explicitly NOT an IRR. A money-weighted return needs dated cash flows, and
 * this project's portfolio history is a fixed-weight reconstruction rather
 * than a trade-by-trade record — computing an IRR from holdings alone would
 * mean inventing the contribution dates it depends on. What this measures is
 * well defined and honestly labelled: how the portfolio as it stands today
 * would have behaved across the stored window. If dated transactions are ever
 * logged, a true money-weighted figure becomes computable and belongs here.
 */
export function reconstructedReturn(history) {
  const series = history?.series ?? [];
  if (series.length < 30) {
    return {
      available: false,
      reason: history?.note ?? `needs 30+ overlapping days of stored history, found ${series.length}`,
    };
  }

  const values = series.map(s => s.value).filter(v => v != null && v > 0);
  if (values.length < 30) {
    return { available: false, reason: `only ${values.length} usable points in the reconstructed series` };
  }

  const years = values.length / TRADING_DAYS;
  const totalPct = (values[values.length - 1] / values[0] - 1) * 100;
  const annualisedPct = (Math.pow(values[values.length - 1] / values[0], 1 / years) - 1) * 100;

  return {
    available: true,
    annualisedPct: +annualisedPct.toFixed(2),
    totalPct: +totalPct.toFixed(2),
    years: +years.toFixed(1),
    from: series[0].date,
    to: series[series.length - 1].date,
    observations: values.length,
    excluded: history?.excluded ?? [],
    basis: 'Fixed-weight reconstruction at current holdings, excluding cash',
  };
}

// ─── Scorecard ────────────────────────────────────────────────

const AXIS_LABELS = {
  quality: 'Quality',
  trend: 'Trend',
  technical: 'Technicals',
  precedent: 'Precedent',
  cost: 'Cost',
};

const AXIS_DESCRIPTIONS = {
  quality: 'Risk-adjusted delivery over the full stored history — what this has actually compounded at, and how painful holding it was.',
  trend: 'Long-horizon trend state: price against its 200-day average, and 12-month momentum.',
  technical: 'The screener composite — the short-horizon read. The least durable axis here, and weighted as such.',
  precedent: 'What followed setups like today’s in this instrument’s own history.',
  cost: 'Published expense ratio. The only input known with certainty in advance, and the one that compounds against you regardless of what markets do.',
};

/**
 * Score the portfolio on the five diligence axes.
 *
 * Weights are share of invested value, not of total value: cash has no trend
 * or expense ratio, and including it in the denominator would report every
 * axis as thinly covered purely because some of the portfolio is in cash. The
 * cash share is returned separately so the page can say so.
 *
 * Each axis reports the share of invested value that actually produced a
 * reading. An axis covering 40% of the portfolio is a different claim from one
 * covering all of it, and collapsing that distinction is how a confident
 * number gets built on two holdings out of six.
 */
export function scorecard(positions, { mandate, regime, strategy = 'balanced' } = {}) {
  const priced = positions.filter(p => (p.value ?? 0) > 0);
  const investedTotal = priced.reduce((a, p) => a + p.value, 0);

  if (!priced.length || !investedTotal) {
    return { available: false, reason: 'No priced holdings to score.', axes: [], holdings: [] };
  }

  const opts = {
    lookbackDays: mandate?.lookbackDays ?? 750,
    strategy,
    timingTrust: regime?.timingTrust ?? 1,
  };
  const signalWeights = mandate?.signalWeights ?? {
    quality: 0.35, cost: 0.20, trend: 0.10, technical: 0.15, precedent: 0.20,
  };

  // Per-holding: the five components plus the same confidence-weighted blend
  // the rebuild pipeline calls conviction, so a holding's number here and in a
  // rebuild run agree by construction.
  const holdings = priced.map(p => {
    const components = cachedComponents(p.symbol, opts);
    const blended = blendComponents(components, signalWeights);
    return {
      symbol: p.symbol,
      name: p.name,
      value: p.value,
      // Share of invested value, which is what the axis averages are weighted by.
      weight: +(p.value / investedTotal * 100).toFixed(2),
      portfolioWeight: p.weight ?? null,
      conviction: blended.conviction,
      evidence: blended.evidence,
      components,
    };
  });

  const axes = Object.keys(AXIS_LABELS).map(key => buildAxis(key, holdings, signalWeights[key] ?? null));

  // Overall: the axis scores recombined under the mandate's own signal
  // weights, restricted to axes that actually produced a reading. This is the
  // portfolio-level equivalent of a candidate's conviction.
  let overallWeighted = 0, overallWeight = 0;
  for (const a of axes) {
    if (a.score == null || a.mandateWeight == null) continue;
    overallWeighted += a.score * a.mandateWeight;
    overallWeight += a.mandateWeight;
  }

  const covered = axes.filter(a => a.score != null);

  return {
    available: covered.length > 0,
    reason: covered.length ? null : 'None of the five axes could be measured for any holding.',
    overall: overallWeight ? +(overallWeighted / overallWeight).toFixed(4) : null,
    overallBasis: overallWeight
      ? `${covered.length} of ${axes.length} axes, weighted as this mandate weights them`
      : null,
    axes,
    holdings: holdings.map(h => ({
      symbol: h.symbol, name: h.name, weight: h.weight,
      conviction: h.conviction, evidence: h.evidence,
      scores: Object.fromEntries(Object.keys(AXIS_LABELS).map(k => [
        k, h.components[k]?.available ? h.components[k].value : null,
      ])),
    })),
    scoredShare: +(holdings.reduce((a, h) => a + (h.conviction != null ? h.weight : 0), 0)).toFixed(2),
    cashExcluded: true,
    mandate: mandate ? { riskLabel: mandate.riskLabel, horizonLabel: mandate.horizonLabel } : null,
    computedAt: new Date().toISOString(),
  };
}

/**
 * One axis: the weighted score, what it covers, and which holdings are pulling
 * it up or down.
 *
 * "Lifting" and "holding back" are measured as each holding's actual pull on
 * the weighted mean — weight x (its score - the mean) - not simply by whose
 * score is highest. A 2% position with a perfect score barely moves the
 * portfolio and should not be presented as though it carries the axis; a 30%
 * position scoring slightly below average drags it more than a 3% position
 * scoring terribly. Sorting by raw score would tell the reader the opposite of
 * the truth in both cases.
 */
function buildAxis(key, holdings, mandateWeight) {
  const available = holdings.filter(h => h.components[key]?.available && h.components[key].value != null);
  const totalWeight = holdings.reduce((a, h) => a + h.weight, 0);
  const coveredWeight = available.reduce((a, h) => a + h.weight, 0);

  if (!available.length) {
    const reasons = [...new Set(holdings.map(h => h.components[key]?.reason).filter(Boolean))];
    return {
      key, label: AXIS_LABELS[key], description: AXIS_DESCRIPTIONS[key],
      score: null, scoreOutOf100: null, coverage: 0, mandateWeight,
      lifting: [], holdingBack: [],
      note: reasons.length ? `Not measurable for any holding — ${reasons[0]}` : 'Not measurable for any holding.',
    };
  }

  // Effective weight blends position size with the component's own confidence,
  // so a quality read built on one year of history counts for less than one
  // built on ten, exactly as it does inside a rebuild run.
  let weighted = 0, weightSum = 0;
  const effective = available.map(h => {
    const c = h.components[key];
    const w = h.weight * (c.confidence ?? 1);
    weighted += c.value * w;
    weightSum += w;
    return { holding: h, component: c, effectiveWeight: w };
  });

  const score = weightSum ? weighted / weightSum : null;

  const contributions = effective.map(e => ({
    symbol: e.holding.symbol,
    name: e.holding.name,
    weight: e.holding.weight,
    score: +e.component.value.toFixed(4),
    scoreOutOf100: Math.round(e.component.value * 100),
    confidence: e.component.confidence ?? 1,
    // Signed pull on the weighted mean, in score points. These sum to zero
    // across all holdings by construction.
    pull: +(((e.effectiveWeight / weightSum) * (e.component.value - score)) * 100).toFixed(2),
    detail: e.component.detail ?? null,
  }));

  const lifting = contributions.filter(c => c.pull > 0).sort((a, b) => b.pull - a.pull);
  const holdingBack = contributions.filter(c => c.pull < 0).sort((a, b) => a.pull - b.pull);
  const missing = holdings
    .filter(h => !h.components[key]?.available)
    .map(h => ({ symbol: h.symbol, weight: h.weight, reason: h.components[key]?.reason ?? 'not measured' }));

  return {
    key,
    label: AXIS_LABELS[key],
    description: AXIS_DESCRIPTIONS[key],
    score: +score.toFixed(4),
    scoreOutOf100: Math.round(score * 100),
    coverage: totalWeight ? +(coveredWeight / totalWeight * 100).toFixed(1) : 0,
    mandateWeight,
    lifting,
    holdingBack,
    missing,
    note: missing.length
      ? `${missing.map(m => m.symbol).join(', ')} contributed nothing to this axis — ${missing[0].reason}.`
      : null,
  };
}

// ─── Correlation pairs ────────────────────────────────────────

/**
 * Which holdings move as one, and which actually spread risk.
 *
 * The matrix is deliberately not built here. With five or six holdings a
 * matrix is fifteen numbers to read in order to find the two that matter,
 * and the two that matter are the extremes. Combined weight is reported
 * alongside every pair because "these two are 0.97 correlated" means something
 * very different at 4% of the portfolio than at 45%.
 */
export function correlationPairs(positions, { minObs = 60, limit = 5 } = {}) {
  const priced = positions.filter(p => (p.value ?? 0) > 0);
  const pairs = [];
  const unassessable = [];

  for (let i = 0; i < priced.length; i++) {
    for (let j = i + 1; j < priced.length; j++) {
      const a = priced[i], b = priced[j];
      const corr = returnCorrelation(a.symbol, b.symbol, { minObs });
      if (!corr?.available) {
        unassessable.push({
          symbols: [a.symbol, b.symbol],
          reason: corr
            ? `needs ${minObs}+ overlapping trading days, found ${corr.observations}`
            : 'no stored price history for one or both',
        });
        continue;
      }
      pairs.push({
        symbols: [a.symbol, b.symbol],
        names: [a.name, b.name],
        correlation: corr.correlation,
        observations: corr.observations,
        from: corr.from,
        to: corr.to,
        weights: [a.weight ?? null, b.weight ?? null],
        combinedWeight: +(((a.weight ?? 0) + (b.weight ?? 0))).toFixed(2),
      });
    }
  }

  const byCorr = [...pairs].sort((x, y) => y.correlation - x.correlation);
  const avg = pairs.length ? pairs.reduce((a, p) => a + p.correlation, 0) / pairs.length : null;

  // With few holdings the two lists would otherwise overlap: six pairs shown
  // five-and-five puts four of them in both columns, which reads as a bug and
  // makes neither list mean anything. Each side takes at most half the pairs,
  // so "most correlated" and "least correlated" are always disjoint sets.
  const half = Math.max(1, Math.min(limit, Math.floor(pairs.length / 2)));

  return {
    available: pairs.length > 0,
    movesTogether: byCorr.slice(0, half),
    movesLeastTogether: [...byCorr].reverse().slice(0, half),
    averageCorrelation: avg == null ? null : +avg.toFixed(4),
    assessed: pairs.length,
    unassessable,
    minObs,
    note: pairs.length
      ? `Daily return correlation over each pair's overlapping history, joined on date. ${pairs.length} of ${pairs.length + unassessable.length} pairs had enough overlap to measure.`
      : 'No pair of holdings has enough overlapping stored history to correlate.',
  };
}

// ─── Per-holding detail ───────────────────────────────────────

/** 52-week high/low and where the current price sits in that range, from
 *  stored bars rather than a separate quote field, so it stays available when
 *  Yahoo is unreachable and matches the history the rest of the page uses. */
function rangeFromBars(bars, price) {
  const closes = bars.slice(-TRADING_DAYS).map(b => b.adj_close ?? b.close).filter(v => v != null);
  if (closes.length < 30) return { available: false, reason: `only ${closes.length} stored closes in the last year` };
  const low = Math.min(...closes), high = Math.max(...closes);
  const span = high - low;
  return {
    available: true,
    low: +low.toFixed(2),
    high: +high.toFixed(2),
    observations: closes.length,
    // Where today sits between the two, clamped only for display honesty:
    // a price outside the stored range is reported as outside it.
    positionPct: span > 0 && price != null ? +(((price - low) / span) * 100).toFixed(1) : null,
    aboveRange: price != null && price > high,
    belowRange: price != null && price < low,
  };
}

/**
 * Everything the side panel shows for one holding, in one read.
 *
 * Deliberately one endpoint rather than six: the panel opens on a click and
 * every extra round trip is a visible stall. Each section degrades on its own
 * — no stored composition means the composition block reports that and the
 * rest still renders.
 */
export function holdingDetail(symbol, positions, { mandate, regime, strategy = 'balanced', newsDays = 60 } = {}) {
  const sym = String(symbol ?? '').toUpperCase().trim();
  if (!sym) return { error: 'symbol is required.' };

  const position = positions.find(p => p.symbol === sym) ?? null;
  const inst = classify(sym);
  // Same fallback chain the type breakdown uses, so the panel does not label a
  // fund "Unknown" merely because its ticker is not in the config table while
  // the table three inches to the left correctly calls it an ETF.
  const instrumentLabel = position ? instrumentTypeLabel(position) : inst.label;
  const bars = getBars(sym) ?? [];
  const opts = {
    lookbackDays: mandate?.lookbackDays ?? 750,
    strategy,
    timingTrust: regime?.timingTrust ?? 1,
  };
  const signalWeights = mandate?.signalWeights ?? null;

  const components = cachedComponents(sym, opts);
  const blended = signalWeights ? blendComponents(components, signalWeights) : null;

  const comp = getComposition(sym);

  let bb = null;
  try { bb = bullbear.readBullBear(sym, { timeline: false }); } catch { bb = null; }

  let precedent = null;
  try { precedent = research.precedents(sym, { count: 8 }); } catch { precedent = null; }

  let news = [];
  try {
    news = (getNews({ symbol: sym, limit: 8, since: Date.now() - newsDays * 86400000, sort: 'date' }) ?? [])
      .map(n => ({
        title: n.title, source: n.source, url: n.url,
        published: n.published ?? n.published_at ?? null,
        sentiment: typeof n.sentiment === 'number' ? n.sentiment : null,
      }));
  } catch { news = []; }

  let notes = [];
  try { notes = research.listNotes(sym) ?? []; } catch { notes = []; }

  // Which held positions this one actually moves with. The panel's job here is
  // to answer "is this a distinct bet or another copy of something I own",
  // which is a per-holding question the portfolio-wide pair list cannot answer
  // for the specific holding in front of you.
  const partners = [];
  for (const p of positions) {
    if (p.symbol === sym || (p.value ?? 0) <= 0) continue;
    const corr = returnCorrelation(sym, p.symbol, { minObs: 60 });
    if (corr?.available) {
      partners.push({ symbol: p.symbol, name: p.name, correlation: corr.correlation, observations: corr.observations, weight: p.weight ?? null });
    }
  }
  partners.sort((a, b) => b.correlation - a.correlation);

  const holdingRow = position ? one_(sym) : null;

  return {
    symbol: sym,
    name: position?.name ?? comp?.name ?? sym,
    instrument: { type: inst.type, label: instrumentLabel },
    position,
    thesis: holdingRow?.thesis ?? null,
    range52: rangeFromBars(bars, position?.price ?? null),
    barCount: bars.length,
    scores: {
      conviction: blended?.conviction ?? null,
      evidence: blended?.evidence ?? null,
      components,
    },
    composition: comp ? {
      expenseRatio: comp.expenseRatio,
      asOf: comp.asOf,
      ageDays: comp.ageDays,
      topHoldings: (comp.holdings ?? []).slice(0, 10).map(h => ({
        name: h.name ?? h.symbol, symbol: h.symbol ?? null, weight: +(h.weight * 100).toFixed(2),
      })),
      sectors: Object.entries(comp.sectors ?? {})
        .map(([k, v]) => ({ label: k, pct: +(v * 100).toFixed(2) }))
        .sort((a, b) => b.pct - a.pct),
    } : { available: false, reason: 'No stored composition for this instrument. Run a composition sync from Rebuild.' },
    bullbear: bb ? { tally: bb.tally ?? null, signals: (bb.signals ?? []).slice(0, 8) } : null,
    precedent: precedent?.available ? {
      matches: precedent.aggregate?.n ?? null,
      positiveRatePct: precedent.aggregate?.n ? Math.round((precedent.aggregate.positiveFwd21 / precedent.aggregate.n) * 100) : null,
      medianForward63Pct: precedent.aggregate?.medianFwd63 == null ? null : +(precedent.aggregate.medianFwd63 * 100).toFixed(2),
      hasClosePrecedent: precedent.hasClosePrecedent ?? null,
    } : { available: false, reason: precedent?.note ?? 'not enough stored history for precedent matching' },
    news,
    notes,
    correlatedWith: partners.slice(0, 4),
    computedAt: new Date().toISOString(),
  };
}

/** The stored holdings row, for the fields valuePortfolio does not carry
 *  through (currently just the free-text thesis). */
function one_(symbol) {
  const rows = all('SELECT thesis FROM holdings WHERE symbol = ?', symbol);
  return rows.find(r => r.thesis) ?? rows[0] ?? null;
}
