// Meridian — candidate diligence
//
// Stages E, F and G. One candidate in, one verdict out, with every piece of
// evidence behind it and every piece that was missing.
//
// The design rule that matters most here is the one Allocate got wrong first
// time and had to be fixed for: a component that could not be measured is
// reported as unavailable and dropped from the blend. It is never defaulted
// to a neutral 0.5, because a neutral default is indistinguishable from a
// real measurement that landed at neutral, and a candidate with one weak
// signal and five blanks would otherwise score the same as one with six
// genuine middling readings. Confidence is carried alongside every component
// and the blend is weighted by it, so a precedent study built on three
// matches cannot outvote one built on thirty.
//
// The second rule: nothing here is a price forecast. Every component measures
// something that has already happened (what this instrument delivered, what
// it costs, how it behaved after similar setups) or something currently
// observable (published fee, current trend state). The output is a conviction
// that this belongs in the portfolio, not a view on where it is going.
//
// Components, and why each is here for a long-horizon mandate:
//
//   quality   — risk-adjusted delivery over the full stored history. For a
//               five-year holding this is the closest thing to the question
//               actually being asked: has this thing compounded, and how
//               painful was holding it.
//   cost      — the published expense ratio. The only input on this list that
//               is known with certainty in advance and compounds relentlessly
//               against you. For two instruments with the same exposure, this
//               is the whole difference.
//   trend     — long-horizon trend state. Slow-moving by construction (200-day
//               average, 12-month momentum), so it is a structural read, not
//               a timing one.
//   technical — the short-horizon screener composite, discounted by regime.
//               Weighted lightly on a long mandate: it is a tiebreak between
//               otherwise equal candidates, not a reason to own something.
//   precedent — what followed similar setups in this instrument's own past.
//   corroboration — the Bull/Bear signal tally, used only to detect
//               disagreement between engines, never as an independent vote.

import { getBars } from '../../db.js';
import { getNews } from '../../sources/news.js';
import * as A from '../analytics.js';
import * as research from '../research.js';
import * as bullbear from '../bullbear.js';
import { scoreSymbol } from '../screener.js';
import { getComposition } from './exposure.js';
import { TRADING_DAYS } from '../../config.js';

// ─── Component: long-run quality ──────────────────────────────

/**
 * What this instrument has actually delivered, per unit of pain, over as much
 * history as is stored.
 *
 * Scored against absolute anchors rather than against the rest of the
 * candidate set on purpose: a relative score would move a holding's quality
 * every time an unrelated candidate joined or left the scan, which makes the
 * number impossible to reason about across runs.
 */
function qualityComponent(symbol, { lookbackDays }) {
  const bars = getBars(symbol);
  if (!bars || bars.length < 250) {
    return { available: false, reason: `needs 250+ bars for a long-run read, has ${bars?.length ?? 0}` };
  }

  const closes = bars.map(b => b.adj_close ?? b.close).filter(Boolean).slice(-lookbackDays);
  if (closes.length < 250) {
    return { available: false, reason: `only ${closes.length} usable closes in the lookback window` };
  }

  const rets = A.toReturns(closes);
  const sharpe = A.sharpe(rets, 0.04, TRADING_DAYS);
  const vol = A.annualisedVol(rets, TRADING_DAYS);
  // maxDrawdown reports a negative fraction (-0.34 = a 34% fall).
  const ddMag = Math.abs(A.maxDrawdown(closes).maxDrawdown);
  const years = closes.length / TRADING_DAYS;
  const cagr = Math.pow(closes[closes.length - 1] / closes[0], 1 / years) - 1;

  // Anchors: Sharpe 0 scores 0, 1.2 scores 1. Drawdown deeper than 55% scores
  // 0, shallower than 15% scores 1. Both are bounded so an outlier in one
  // cannot carry the component on its own.
  const sharpeScore = clamp01(sharpe / 1.2);
  const ddScore = clamp01((0.55 - ddMag) / 0.40);

  const value = 0.65 * sharpeScore + 0.35 * ddScore;

  return {
    available: true,
    value: +value.toFixed(4),
    // More history is a better basis for a claim about long-run delivery.
    // Full confidence at five years, scaling down below that.
    confidence: +clamp01(closes.length / (TRADING_DAYS * 5)).toFixed(3),
    detail: {
      years: +years.toFixed(1),
      cagrPct: +(cagr * 100).toFixed(2),
      sharpe: +sharpe.toFixed(2),
      annualVolPct: +(vol * 100).toFixed(1),
      maxDrawdownPct: +(ddMag * 100).toFixed(1),
      observations: closes.length,
    },
    source: `${closes.length} stored daily closes`,
  };
}

// ─── Component: cost ──────────────────────────────────────────

/**
 * Fee drag. Deliberately harsh at the top end: on a five-year-plus horizon the
 * difference between 0.07% and 0.45% is not a rounding error, and for two
 * funds tracking the same index it is the entire basis for choosing.
 */
function costComponent(symbol) {
  const comp = getComposition(symbol);
  const er = comp?.expenseRatio;

  if (er == null) {
    return { available: false, reason: 'no published expense ratio stored' };
  }

  // Yahoo reports these as percentages (0.07 = 0.07%) for funds, but has been
  // seen returning fractions on some listings. Anything below 0.01 is treated
  // as a fraction, since a genuine 0.005% fee does not exist.
  const pct = er < 0.01 ? er * 100 : er;
  // 0.05% or cheaper scores 1, 0.75% or worse scores 0.
  const value = clamp01((0.75 - pct) / 0.70);

  return {
    available: true,
    value: +value.toFixed(4),
    // A published fee is a fact, not an estimate.
    confidence: 1,
    detail: { expenseRatioPct: +pct.toFixed(3), asOf: comp.asOf, ageDays: comp.ageDays },
    source: `published expense ratio${comp.asOf ? `, as of ${comp.asOf}` : ''}`,
  };
}

// ─── Component: long-horizon trend ────────────────────────────

function trendComponent(symbol) {
  const bars = getBars(symbol);
  const closes = bars?.map(b => b.adj_close ?? b.close).filter(Boolean) ?? [];
  if (closes.length < 260) {
    return { available: false, reason: `needs 260+ closes for a 200-day trend read, has ${closes.length}` };
  }

  const price = closes[closes.length - 1];
  const ma200 = A.sma(closes, 200);
  const ma50 = A.sma(closes, 50);
  const r12m1 = closes[closes.length - 22] / closes[closes.length - 253] - 1;

  const aboveLong = ma200 ? clamp01(((price / ma200) - 0.90) / 0.25) : null;
  const stacked = (ma50 && ma200) ? (ma50 > ma200 ? 1 : 0) : null;
  const momentum = clamp01((r12m1 + 0.20) / 0.60);

  const parts = [aboveLong, stacked, momentum].filter(v => v != null);
  const value = parts.reduce((a, b) => a + b, 0) / parts.length;

  return {
    available: true,
    value: +value.toFixed(4),
    confidence: +clamp01(closes.length / (TRADING_DAYS * 3)).toFixed(3),
    detail: {
      vs200dmaPct: ma200 ? +(((price / ma200) - 1) * 100).toFixed(2) : null,
      vs50dmaPct: ma50 ? +(((price / ma50) - 1) * 100).toFixed(2) : null,
      momentum12m1Pct: +(r12m1 * 100).toFixed(2),
      goldenCross: stacked === 1,
    },
    source: 'stored daily closes (200-day average, 12-1 momentum)',
  };
}

// ─── Component: short-horizon technical ───────────────────────

function technicalComponent(symbol, { strategy, timingTrust }) {
  const s = scoreSymbol(symbol, { strategy });
  if (!s) return { available: false, reason: 'screener needs 120+ bars' };

  const raw = clamp01(s.composite / 100);
  // The regime multiplier moves the score toward or away from neutral rather
  // than scaling it directly, so a discount in a downtrend cannot turn a
  // strong reading into a zero.
  const value = clamp01(0.5 + (raw - 0.5) * timingTrust);

  return {
    available: true,
    value: +value.toFixed(4),
    // Deliberately capped below 1: a technical composite is the least durable
    // input on this list and should never be the most confident one.
    confidence: 0.7,
    detail: {
      composite: s.composite,
      rawScore: +raw.toFixed(3),
      regimeAdjusted: +value.toFixed(3),
      signals: s.signals,
      strategy,
    },
    source: `screener composite (${strategy}), regime-adjusted x${timingTrust}`,
  };
}

// ─── Component: precedent ─────────────────────────────────────

function precedentComponent(symbol) {
  let p = null;
  try { p = research.precedents(symbol, { count: 10 }); } catch { p = null; }

  if (!p?.available || !p.aggregate) {
    return { available: false, reason: p?.note ?? 'not enough history for precedent matching' };
  }

  const agg = p.aggregate;
  const hitRate = agg.n ? agg.positiveFwd21 / agg.n : null;
  const med = agg.medianFwd63 ?? agg.medianFwd21;

  if (hitRate == null || med == null) {
    return { available: false, reason: 'precedent matches found but no usable forward window' };
  }

  // Two halves: how often the setup was followed by a gain, and how large the
  // typical move was. Both bounded — a single spectacular precedent should not
  // dominate.
  const hitScore = clamp01(hitRate);
  const sizeScore = clamp01((med + 0.10) / 0.30);
  const value = 0.6 * hitScore + 0.4 * sizeScore;

  return {
    available: true,
    value: +value.toFixed(4),
    // Full confidence at ten matches; a three-match study is worth a third.
    confidence: +clamp01(agg.n / 10).toFixed(3),
    detail: {
      matches: agg.n,
      positiveRate: +(hitRate * 100).toFixed(0),
      medianForward63Pct: agg.medianFwd63 == null ? null : +(agg.medianFwd63 * 100).toFixed(2),
      medianForward21Pct: agg.medianFwd21 == null ? null : +(agg.medianFwd21 * 100).toFixed(2),
      hasClosePrecedent: p.hasClosePrecedent,
    },
    source: `${agg.n} historical analogs in this instrument's own history`,
  };
}

// ─── Corroboration: Bull/Bear ─────────────────────────────────

/** Not a scoring component. Used only to notice that the signal engines
 *  disagree, which is worth showing to a human but should not silently move
 *  a number. */
function corroboration(symbol) {
  let bb = null;
  try { bb = bullbear.readBullBear(symbol, { timeline: false }); } catch { bb = null; }
  if (!bb?.tally) return { available: false, reason: 'no Bull/Bear signals' };

  const { bull, bear, neutral } = bb.tally;
  const total = bull + bear + neutral;
  if (!total) return { available: false, reason: 'no usable Bull/Bear signals for this instrument type' };

  return {
    available: true,
    bull, bear, neutral,
    lean: +((bull - bear) / total).toFixed(3),
    signals: (bb.signals ?? []).slice(0, 6).map(s => ({
      category: s.category, direction: s.direction, label: s.label ?? s.text ?? null,
    })),
  };
}

// ─── News gate ────────────────────────────────────────────────

/**
 * A gate, not a score.
 *
 * News is included to catch the case where everything quantitative looks fine
 * and something has just gone badly wrong that the price has not finished
 * reflecting. That is a veto question, not a contribution to a weighted
 * average — folding sentiment into conviction would let a run of mildly
 * cheerful headlines inflate a position size, which is not a thing anyone
 * should want.
 *
 * The bar for an actual veto is deliberately high, because the cost of a
 * false veto (a good holding excluded on a bad week of coverage) is real, and
 * because this app's sentiment read is a lexicon score plus an optional AI
 * pass, not a research desk. Below that bar it raises a caution that appears
 * in the report and changes nothing else.
 */
function newsGate(symbol, { days = 30 } = {}) {
  let stories = [];
  try {
    stories = getNews({
      symbol, limit: 40, since: Date.now() - days * 86400000, sort: 'date',
    }) ?? [];
  } catch { stories = []; }

  if (!stories.length) {
    return {
      available: false,
      veto: false,
      reason: `no stories mentioning ${symbol} in the last ${days} days`,
    };
  }

  const scored = stories.filter(s => typeof s.sentiment === 'number');
  if (!scored.length) {
    return { available: false, veto: false, reason: 'stories found but none carry a sentiment read' };
  }

  const severe = scored.filter(s => s.sentiment <= -0.5);
  const negative = scored.filter(s => s.sentiment < -0.2);
  const avg = scored.reduce((a, s) => a + s.sentiment, 0) / scored.length;

  // Veto needs corroboration across multiple severe stories, not one bad
  // headline — a single strongly-worded piece is noise at this sample size.
  const veto = severe.length >= 3 && avg <= -0.35;
  const caution = !veto && (severe.length >= 1 || (negative.length >= 3 && avg <= -0.2));

  return {
    available: true,
    veto,
    caution,
    stories: scored.length,
    severe: severe.length,
    negative: negative.length,
    averageSentiment: +avg.toFixed(3),
    headlines: severe.slice(0, 3).map(s => ({ title: s.title, source: s.source, url: s.url })),
    reason: veto
      ? `${severe.length} strongly negative stories in ${days} days (average sentiment ${avg.toFixed(2)})`
      : caution
      ? `${severe.length || negative.length} negative stories in ${days} days — flagged, not excluded`
      : `${scored.length} stories, average sentiment ${avg.toFixed(2)} — nothing disqualifying`,
  };
}

// ─── Blend ────────────────────────────────────────────────────

const clamp01 = x => (x == null || !isFinite(x) ? null : Math.max(0, Math.min(1, x)));

/**
 * Confidence-weighted blend of whatever components were actually measurable.
 *
 * Each component contributes mandateWeight x ownConfidence. Unavailable
 * components contribute nothing and are not replaced. The share of the
 * mandate's intended weight that was actually available is reported as
 * `evidence`, so a conviction of 0.7 built on 30% of the intended evidence is
 * visibly different from the same number built on all of it.
 */
function blend(components, signalWeights) {
  let weighted = 0, weightSum = 0, intended = 0;
  const used = [], missing = [];

  for (const [key, w] of Object.entries(signalWeights)) {
    intended += w;
    const c = components[key];
    if (!c?.available || c.value == null) {
      missing.push({ component: key, intendedWeight: w, reason: c?.reason ?? 'not measured' });
      continue;
    }
    const effective = w * (c.confidence ?? 1);
    weighted += c.value * effective;
    weightSum += effective;
    used.push({ component: key, value: c.value, confidence: c.confidence ?? 1, effectiveWeight: +effective.toFixed(4) });
  }

  if (weightSum === 0) {
    return { conviction: null, evidence: 0, used, missing };
  }

  return {
    conviction: +(weighted / weightSum).toFixed(4),
    // Fraction of the mandate's intended evidence base that was available,
    // discounted by each component's own confidence.
    evidence: +(weightSum / intended).toFixed(3),
    used, missing,
  };
}

// ─── Entry point ──────────────────────────────────────────────

/**
 * The five measurable components for one symbol, without the verdict
 * machinery around them.
 *
 * Split out so the Portfolio scorecard can score what is already held on
 * exactly the same axes, computed by exactly the same code, as the rebuild
 * pipeline scores candidates. Two engines each with their own idea of what
 * "quality" means would be worse than useless — the whole point of showing a
 * held position's score next to a candidate's is that they are comparable.
 */
export function componentScores(symbol, { lookbackDays = 750, strategy = 'balanced', timingTrust = 1 } = {}) {
  return {
    quality: qualityComponent(symbol, { lookbackDays }),
    cost: costComponent(symbol),
    trend: trendComponent(symbol),
    technical: technicalComponent(symbol, { strategy, timingTrust }),
    precedent: precedentComponent(symbol),
  };
}

export { blend as blendComponents };

/**
 * Assess one candidate end to end.
 *
 * @param {Object} candidate from universe.assembleUniverse
 * @param {Object} ctx { mandate, regime, strategy, currentWeight }
 */
export function assess(candidate, { mandate, regime, strategy = 'balanced', currentWeight = 0 } = {}) {
  const { symbol } = candidate;
  const lookbackDays = mandate?.lookbackDays ?? 750;
  const timingTrust = regime?.timingTrust ?? 1;

  const components = componentScores(symbol, { lookbackDays, strategy, timingTrust });

  const support = corroboration(symbol);
  const news = newsGate(symbol);
  const { conviction, evidence, used, missing } = blend(components, mandate.signalWeights);

  // Disagreement is worth surfacing but must not move the number: the
  // components above already read the same underlying price history that
  // most Bull/Bear signals do, so letting it vote would double-count.
  const disagreement = (support.available && conviction != null)
    ? (support.lean > 0.34 && conviction < 0.4) || (support.lean < -0.34 && conviction > 0.6)
    : false;

  const cautions = [];
  if (!candidate.assessable) cautions.push(...(candidate.limitations ?? []));
  if (evidence != null && evidence < 0.5) {
    cautions.push(`Only ${(evidence * 100).toFixed(0)}% of the intended evidence was available.`);
  }
  if (news.caution) cautions.push(news.reason);
  if (disagreement) {
    cautions.push(`Bull/Bear signals lean ${support.lean > 0 ? 'bullish' : 'bearish'} against this assessment — worth a look before acting.`);
  }

  const verdict = decide({ candidate, conviction, evidence, news, mandate });

  return {
    symbol,
    name: candidate.name,
    held: candidate.held,
    currentWeight,
    instrument: candidate.instrumentLabel,
    sources: candidate.sources,
    conviction,
    evidence,
    components,
    corroboration: support,
    news,
    cautions,
    ...verdict,
  };
}

function decide({ candidate, conviction, evidence, news, mandate }) {
  if (news.veto) {
    return {
      verdict: 'excluded',
      reason: `News veto: ${news.reason}`,
      reasonCode: 'news-veto',
    };
  }
  if (conviction == null) {
    return {
      verdict: 'excluded',
      reason: candidate.held
        ? 'Cannot be assessed — no component could be measured. Held, but this pipeline has nothing to say about it.'
        : 'Cannot be assessed — no component could be measured.',
      reasonCode: 'no-evidence',
    };
  }
  // A conviction built on almost nothing is not a conviction. Held positions
  // get the same treatment as candidates here: passing on thin evidence is
  // how a bad holding survives review.
  if (evidence < 0.25) {
    return {
      verdict: 'excluded',
      reason: `Evidence too thin to act on (${(evidence * 100).toFixed(0)}% of intended inputs available).`,
      reasonCode: 'thin-evidence',
    };
  }
  if (conviction < mandate.minConviction) {
    return {
      verdict: 'excluded',
      reason: `Conviction ${conviction.toFixed(2)} is below this mandate's bar of ${mandate.minConviction.toFixed(2)}.`,
      reasonCode: 'below-bar',
    };
  }
  return {
    verdict: 'included',
    reason: `Conviction ${conviction.toFixed(2)} clears the ${mandate.minConviction.toFixed(2)} bar on ${(evidence * 100).toFixed(0)}% of intended evidence.`,
    reasonCode: 'passed',
  };
}

export const _internal = {
  qualityComponent, costComponent, trendComponent, technicalComponent,
  precedentComponent, newsGate, blend,
};
