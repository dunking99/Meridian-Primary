// Meridian — the daily briefing
//
// Every other page in this app answers one question well and in isolation:
// Portfolio knows what you own, News knows what was published, Markets knows
// what moved, Rebuild knows what it would buy. None of them know about each
// other, so the work of noticing "that headline is about my second-largest
// position, which also had a 2.6-sigma day" is left entirely to the reader,
// every day, across five pages.
//
// This engine does that join. It pulls from the engines that already exist,
// scores every finding on one comparable scale, and ranks them against each
// other so a 2.5-sigma move on a 20% holding outranks a triggered alert on a
// 1% watchlist name — which is the ordering a person actually wants and the
// one no single page can produce.
//
// Two design rules carry most of the weight here:
//
//   1. A briefing reports CHANGE, not state. "US is 33% of your portfolio" is
//      a dashboard fact; it is true every day and belongs on the Portfolio
//      page. Findings here are diffed against the last briefing the user
//      marked as read, so `isNew` means genuinely new to them.
//
//   2. It must be able to conclude that nothing happened. Most days, nothing
//      does. An engine that always finds something to say trains the reader to
//      stop believing it, which costs more than the occasional quiet day.

import { all, one, run, db } from '../db.js';
import * as pf from './portfolio.js';
import * as pfa from './portfolio-analysis.js';
import * as memory from './memory.js';
import * as calendarEngine from './calendar.js';
import * as bullbear from './bullbear.js';
import * as mandateModel from './rebuild/mandate.js';
import * as regimeModel from './rebuild/regime.js';
import { getNews } from '../sources/news.js';

db.exec(`
CREATE TABLE IF NOT EXISTS briefing_reads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  read_at      INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  fingerprints TEXT NOT NULL,
  item_count   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_briefing_reads_at ON briefing_reads(read_at DESC);
`);

const DAY = 86400_000;
const safeParse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ─── Materiality ──────────────────────────────────────────────
//
// The whole point of a cross-engine briefing is ranking findings that come
// from engines which have never had to be comparable before. A relevance
// score of 78 from the news scorer and a 2.3-sigma price move are not on the
// same scale and cannot be sorted against each other directly.
//
// Every finding is therefore reduced to three factors, each 0..1:
//
//   strength — how extreme this finding is, in its own terms, normalised
//              against a threshold where that kind of finding stops being
//              routine (3 sigma for a move, 100 for a relevance score).
//   stake    — how much of the portfolio it actually touches. This is what
//              stops a dramatic event in a 0.5% position outranking a dull
//              one in a 30% position.
//   weight   — how inherently actionable the kind is. An alert the user set
//              themselves outranks an ambient regime reading of equal
//              strength, because they asked to be told about the first one.
//
// materiality = 100 * strength * stake * weight, so the number is
// interpretable: roughly "percent of the maximum a finding of any kind could
// score". It is not a probability and nothing downstream treats it as one.

const KIND_WEIGHT = {
  alert: 1.00,        // explicitly requested by the user
  position_move: 0.92,
  news: 0.80,
  risk: 0.78,
  event: 0.70,
  signal: 0.62,
  regime: 0.55,       // ambient context, rarely a same-day action
  correlation: 0.50,
};

// Even a tiny position is worth hearing about if something extreme happens to
// it, so stake is floored rather than scaled toward zero.
const MIN_STAKE = 0.22;

/**
 * Portfolio weight -> stake, on a square-root curve.
 *
 * The curve matters. A linear ramp makes a 2% position almost invisible, and
 * an earlier version of this saturated at 25% on the reasoning that past the
 * single-position concentration convention, extra weight adds nothing. That
 * was wrong for anything whose stake is a *sum*: a headline touching two
 * holdings worth 39% between them scored identically to one touching a single
 * 25% holding, because both had already pinned the scale.
 *
 * Square root rises steeply early — so a 5% position clears the floor
 * meaningfully — while still increasing all the way to 100%, so summed stakes
 * stay discriminating at the top of the range where concentrated portfolios
 * actually live.
 */
function stakeFromWeight(weightPct) {
  if (weightPct == null || !isFinite(weightPct)) return MIN_STAKE;
  const frac = Math.min(1, Math.abs(weightPct) / 100);
  return MIN_STAKE + (1 - MIN_STAKE) * Math.sqrt(frac);
}

function materiality(kind, strength, stake) {
  const w = KIND_WEIGHT[kind] ?? 0.5;
  const s = Math.max(0, Math.min(1, strength ?? 0));
  const k = Math.max(0, Math.min(1, stake ?? MIN_STAKE));
  return +(100 * s * k * w).toFixed(1);
}

/**
 * Stable identity for a finding, used to diff one briefing against the last.
 *
 * Deliberately excludes the finding's magnitude: a story is the same story on
 * the second day even if its relevance score has drifted, and a position that
 * is still stretched is not news again. Dated findings include the date so the
 * same instrument moving on two consecutive days reads as two events.
 */
function fingerprint(kind, key) { return `${kind}:${key}`; }

// ─── Section builders ─────────────────────────────────────────
//
// Each returns { items, coverage, available, reason? } and is called inside
// its own try/catch by buildBriefing, so one engine failing (a missing table,
// a thin-history symbol) costs that section and nothing else.

function positionMoves(positions, byWeight, { zThreshold }) {
  const changed = memory.whatChanged({ limit: 60, zThreshold });
  if (!changed.available) {
    return { items: [], available: false, reason: changed.reason, coverage: null };
  }

  const held = new Set(positions.map(p => p.symbol));
  const items = [];

  for (const n of changed.notable) {
    if (!held.has(n.symbol)) continue;          // universe moves belong on Markets, not here
    const weight = byWeight.get(n.symbol) ?? null;
    const absZ = Math.abs(n.retZ);
    items.push({
      kind: 'position_move',
      fp: fingerprint('position_move', `${n.symbol}:${changed.date}`),
      symbol: n.symbol,
      title: `${n.symbol} ${n.ret1d >= 0 ? 'rose' : 'fell'} ${Math.abs(n.ret1d * 100).toFixed(2)}%`,
      detail: `${absZ.toFixed(1)}σ against its own last year`
        + (weight != null ? ` · ${weight.toFixed(1)}% of the portfolio` : ''),
      direction: n.ret1d >= 0 ? 'up' : 'down',
      weight,
      // 3σ is the normalisation point rather than a cap on meaning: beyond it
      // the finding is already maximally worth reading.
      materiality: materiality('position_move', absZ / 3, stakeFromWeight(weight)),
      meta: { retZ: n.retZ, ret1d: n.ret1d, drawdown: n.drawdown, pctRank: n.pctRank, date: changed.date },
      source: 'Stored daily bars, z-scored against the instrument\'s own trailing year.',
    });
  }

  return {
    items,
    available: true,
    coverage: `${changed.observed} instruments observed on ${changed.date}; `
      + `${items.length} of your ${positions.length} holdings moved beyond ${zThreshold}σ.`,
  };
}

function triggeredAlerts(byWeight, { days, recentlyFired }) {
  // Strictly read-only, and deliberately does not import the alerts engine:
  // its evaluate() flips alerts to 'triggered' as a side effect, and the
  // price-poll loop already owns that call. Calling it again here would race
  // the loop and mutate alert state on every page load.
  // The briefing reports what has fired; it is not what makes alerts fire.
  const recent = all(
    `SELECT * FROM alerts WHERE status = 'triggered' AND triggered_at >= ? ORDER BY triggered_at DESC`,
    Date.now() - days * DAY);

  // The poll loop keeps the human-readable message in memory rather than in
  // the row, so pair them up where the caller passed that cache in.
  const messageById = new Map((recentlyFired ?? []).map(f => [f.id, f.message]));

  const items = [];
  for (const a of recent) {
    const weight = byWeight.get(a.symbol) ?? null;
    items.push({
      kind: 'alert',
      fp: fingerprint('alert', String(a.id)),
      symbol: a.symbol,
      title: messageById.get(a.id) ?? `${a.symbol} ${a.kind} alert triggered`,
      detail: a.note ? `Your note: ${a.note}` : `${a.kind} alert you set on ${a.symbol}`,
      direction: a.direction === 'below' ? 'down' : 'up',
      weight,
      // A fired alert is binary: the user picked the threshold, so reaching it
      // is full strength by definition rather than something to re-judge here.
      materiality: materiality('alert', 1, stakeFromWeight(weight)),
      meta: { alertId: a.id, kind: a.kind, threshold: a.threshold,
              value: a.triggered_value ?? null, triggeredAt: a.triggered_at },
      source: 'Alerts you set, fired by the price-poll loop against live quotes and stored bars.',
    });
  }

  const activeCount = one("SELECT COUNT(*) n FROM alerts WHERE status = 'active'")?.n ?? 0;
  return {
    items,
    available: true,
    coverage: `${activeCount} alert${activeCount === 1 ? '' : 's'} still armed; `
      + `${items.length} triggered in the last ${days} days.`,
  };
}

function relevantNews(positions, byWeight, { hours, minRelevance, limit }) {
  const held = positions.map(p => p.symbol);
  const watched = all('SELECT DISTINCT symbol FROM watchlist').map(r => r.symbol);
  const since = Date.now() - hours * 3600_000;

  const stories = getNews({ limit: limit * 3, since, sort: 'smart', held, watched, minRelevance });

  const heldSet = new Set(held);
  const watchSet = new Set(watched);
  const items = [];

  for (const s of stories) {
    const syms = Array.isArray(s.symbols) ? s.symbols : [];
    const heldHits = syms.filter(x => heldSet.has(x));
    const watchHits = syms.filter(x => watchSet.has(x) && !heldSet.has(x));

    // A story that touches nothing you own or watch is general market news.
    // It is not useless, but it belongs on the News page, not in a briefing
    // whose entire premise is "this is about you".
    if (!heldHits.length && !watchHits.length) continue;

    // Stake is the summed weight of the positions the story actually touches,
    // so one headline naming two holdings outranks the same headline naming
    // one of them.
    const touchedWeight = heldHits.reduce((a, sym) => a + (byWeight.get(sym) ?? 0), 0);
    const stake = heldHits.length ? stakeFromWeight(touchedWeight) : MIN_STAKE;

    items.push({
      kind: 'news',
      fp: fingerprint('news', s.guid),
      symbol: heldHits[0] ?? watchHits[0] ?? null,
      title: s.title,
      detail: s.why || `${s.source ?? 'Unknown source'} · touches ${[...heldHits, ...watchHits].join(', ')}`,
      direction: s.sentiment == null ? 'neutral' : s.sentiment > 0.15 ? 'up' : s.sentiment < -0.15 ? 'down' : 'neutral',
      weight: heldHits.length ? +touchedWeight.toFixed(2) : null,
      materiality: materiality('news', (s.relevance ?? 0) / 100, stake),
      meta: {
        guid: s.guid, url: s.url, source: s.source, published: s.published,
        relevance: s.relevance, scored: s.scored, category: s.category,
        sentiment: s.sentiment, held: heldHits, watched: watchHits,
        alsoReported: s.alsoReported ?? 0,
      },
      source: s.scored
        ? 'Local RSS feed, relevance scored by the news engine.'
        : 'Local RSS feed, heuristic relevance only — not yet AI-scored.',
    });
  }

  items.sort((a, b) => b.materiality - a.materiality);
  const kept = items.slice(0, limit);
  const unscored = kept.filter(i => !i.meta.scored).length;

  return {
    items: kept,
    available: true,
    coverage: `${stories.length} stories in the last ${hours}h above relevance ${minRelevance}; `
      + `${items.length} touched something you hold or watch`
      + (unscored ? `. ${unscored} of those shown are heuristically scored, not AI-scored.` : '.'),
  };
}

function upcomingEvents(byWeight, { days }) {
  const cal = calendarEngine.buildCalendar({ days });
  const items = [];

  for (const e of cal.events) {
    if (e.daysAway == null || e.daysAway < 0 || e.daysAway > days) continue;
    const weight = e.symbol ? (byWeight.get(e.symbol) ?? null) : null;

    // Imminence is the whole signal: an earnings date three months out is a
    // diary entry, the same date tomorrow is the reason to read today.
    const strength = Math.max(0, 1 - e.daysAway / days);

    items.push({
      kind: 'event',
      fp: fingerprint('event', e.id),
      symbol: e.symbol,
      title: e.title,
      detail: e.daysAway === 0 ? 'Today'
        : e.daysAway === 1 ? 'Tomorrow'
        : `In ${e.daysAway} days`,
      direction: 'neutral',
      weight,
      materiality: materiality('event', strength, e.symbol ? stakeFromWeight(weight) : 0.55),
      meta: { type: e.type, date: e.date, daysAway: e.daysAway, relevance: e.relevance },
      source: e.source,
    });
  }

  return {
    items,
    available: true,
    coverage: `${cal.events.length} dated events found for ${cal.symbols} instruments. ${cal.coverage}`,
    unresolved: cal.unresolved,
  };
}

function riskFlags(valued, positions, byWeight, mandate) {
  const items = [];
  const total = valued.total || 0;

  // Concentration. The thresholds are the same conventions the risk page
  // states, reused rather than re-invented so two pages cannot disagree about
  // what counts as concentrated.
  const sorted = [...positions].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const largest = sorted[0];
  if (largest && largest.weight != null) {
    const SINGLE = 25;
    if (largest.weight > SINGLE) {
      items.push({
        kind: 'risk',
        fp: fingerprint('risk', `single-concentration:${largest.symbol}`),
        symbol: largest.symbol,
        title: `${largest.symbol} is ${largest.weight.toFixed(1)}% of the portfolio`,
        detail: `Above the ${SINGLE}% single-position convention`,
        direction: 'down',
        weight: largest.weight,
        // Normalised on how far past the threshold it is, doubling the
        // threshold being the point where it is maximally worth saying.
        materiality: materiality('risk', (largest.weight - SINGLE) / SINGLE, stakeFromWeight(largest.weight)),
        meta: { threshold: SINGLE, actual: largest.weight },
        source: 'Live position weights against stated concentration conventions.',
      });
    }
  }

  const topThree = sorted.slice(0, 3).reduce((a, p) => a + (p.weight ?? 0), 0);
  const TOP3 = 60;
  if (sorted.length >= 3 && topThree > TOP3) {
    items.push({
      kind: 'risk',
      fp: fingerprint('risk', 'top3-concentration'),
      symbol: null,
      title: `Top three positions are ${topThree.toFixed(1)}% combined`,
      detail: `Above the ${TOP3}% top-three convention · ${sorted.slice(0, 3).map(p => p.symbol).join(', ')}`,
      direction: 'down',
      weight: topThree,
      materiality: materiality('risk', (topThree - TOP3) / TOP3, stakeFromWeight(topThree)),
      meta: { threshold: TOP3, actual: topThree, symbols: sorted.slice(0, 3).map(p => p.symbol) },
      source: 'Live position weights against stated concentration conventions.',
    });
  }

  // Scorecard axes that have fallen to the bottom of their range. This reuses
  // the exact same scoring function the Portfolio Analysis page shows, so the
  // briefing can never report a score the page would contradict.
  let scorecard = null;
  try {
    scorecard = pfa.scorecard(positions, { mandate });
  } catch { scorecard = null; }

  // 0.45 is where an axis stops being unremarkable and 0.15 is about as low as
  // these components realistically read, so the span between them is what the
  // strength is normalised over. Flagging at 0.4 and normalising to zero put
  // every real-world axis within a rounding error of zero strength, which made
  // a genuinely poor axis rank below a marginal one.
  const AXIS_FLOOR = 0.45, AXIS_WORST = 0.15;
  if (scorecard?.available) {
    for (const axis of scorecard.axes) {
      if (axis.score == null || axis.score >= AXIS_FLOOR) continue;
      const worst = axis.holdingBack?.[0];
      items.push({
        kind: 'risk',
        fp: fingerprint('risk', `axis:${axis.key}`),
        symbol: worst?.symbol ?? null,
        title: `${axis.label ?? axis.key} scores ${(axis.score * 6).toFixed(1)}/6`,
        detail: worst
          ? `Held back most by ${worst.symbol}${worst.weight != null ? ` (${worst.weight}%)` : ''}`
          : `Coverage ${axis.coverage ?? 0}% of portfolio value`,
        direction: 'down',
        weight: worst?.weight ?? null,
        materiality: materiality('risk', (AXIS_FLOOR - axis.score) / (AXIS_FLOOR - AXIS_WORST),
                                 stakeFromWeight(worst?.weight ?? null)),
        meta: { axis: axis.key, score: axis.score, coverage: axis.coverage },
        source: 'Portfolio scorecard — the same components the Rebuild diligence stage uses.',
      });
    }
  }

  return {
    items,
    available: true,
    coverage: scorecard?.available
      ? `Concentration conventions plus ${scorecard.axes.length} scorecard axes.`
      : `Concentration conventions only — scorecard unavailable${scorecard?.reason ? `: ${scorecard.reason}` : '.'}`,
  };
}

function regimeContext(prices, mandate) {
  const items = [];
  let reg = null;
  try { reg = regimeModel.readRegime(prices, mandate); } catch { reg = null; }

  if (reg?.available) {
    // Only a tape that is doing something worth acting on earns a slot. A
    // neutral, ordinary-volatility regime is the base case and saying so every
    // day is noise.
    const stressed = reg.volatility === 'stressed' || reg.volatility === 'elevated';
    const trending = reg.trend === 'downtrend' || reg.trend === 'uptrend';
    if (stressed || reg.trend === 'downtrend') {
      const strength = reg.volatility === 'stressed' ? 0.95 : reg.trend === 'downtrend' ? 0.7 : 0.5;
      items.push({
        kind: 'regime',
        fp: fingerprint('regime', `${reg.trend}:${reg.volatility}`),
        symbol: null,
        title: `Market regime: ${reg.label}`,
        detail: `${reg.trend}, volatility ${reg.volatility}, yield curve ${reg.yieldCurve}`,
        direction: reg.trend === 'downtrend' ? 'down' : 'neutral',
        weight: null,
        materiality: materiality('regime', strength, 0.85),
        meta: { trend: reg.trend, volatility: reg.volatility, yieldCurve: reg.yieldCurve, timingTrust: reg.timingTrust },
        source: 'Regime read from benchmark trend, volatility and the yield curve.',
      });
    } else if (trending) {
      // Recorded but low materiality, so it appears in the section without
      // ever competing for a headline slot.
      items.push({
        kind: 'regime',
        fp: fingerprint('regime', `${reg.trend}:${reg.volatility}`),
        symbol: null,
        title: `Market regime: ${reg.label}`,
        detail: `${reg.trend}, volatility ${reg.volatility}`,
        direction: 'neutral', weight: null,
        materiality: materiality('regime', 0.3, 0.6),
        meta: { trend: reg.trend, volatility: reg.volatility, timingTrust: reg.timingTrust },
        source: 'Regime read from benchmark trend, volatility and the yield curve.',
      });
    }
  }

  // Breadth at an extreme percentile of its own year is the kind of thing that
  // is invisible in the level and obvious in the distribution.
  try {
    const changed = memory.whatChanged({ limit: 1, zThreshold: 99 });
    const r = changed.regime;
    if (r && r.breadth50Pct != null && (r.breadth50Pct <= 0.1 || r.breadth50Pct >= 0.9)) {
      const extreme = r.breadth50Pct <= 0.1 ? 'narrowest' : 'broadest';
      items.push({
        kind: 'regime',
        fp: fingerprint('regime', `breadth:${r.date}`),
        symbol: null,
        title: `Market breadth is among the ${extreme} of the last year`,
        detail: `${(r.breadth50 * 100).toFixed(0)}% of the universe above its 50-day — `
          + `${(r.breadth50Pct * 100).toFixed(0)}th percentile of its own year`,
        direction: r.breadth50Pct <= 0.1 ? 'down' : 'up',
        weight: null,
        materiality: materiality('regime', Math.abs(r.breadth50Pct - 0.5) * 2, 0.8),
        meta: { breadth50: r.breadth50, percentile: r.breadth50Pct, date: r.date },
        source: 'Breadth across the tracked universe, ranked against its own trailing year.',
      });
    }
  } catch { /* breadth is optional context; its absence is not a failure */ }

  return {
    items,
    available: items.length > 0 || reg != null,
    coverage: reg?.available
      ? reg.explain
      : 'No regime read available — the benchmark has no stored history.',
  };
}

function correlationBreaks({ limit }) {
  const shifts = memory.correlationShifts({ limit });
  if (!shifts.available) {
    return { items: [], available: false, reason: 'Not enough overlapping history across factor proxies.', coverage: null };
  }

  const items = shifts.pairs
    .filter(p => p.flipped || Math.abs(p.change) >= 0.3)
    .map(p => ({
      kind: 'correlation',
      fp: fingerprint('correlation', `${p.pair}:${p.flipped ? 'flip' : 'shift'}`),
      symbol: null,
      title: p.flipped
        ? `${p.pair} correlation has flipped sign`
        : `${p.pair} correlation moved ${p.change >= 0 ? '+' : ''}${p.change.toFixed(2)}`,
      detail: `Now ${p.now.toFixed(2)}, was ${p.previous.toFixed(2)} over the prior window`,
      direction: 'neutral',
      weight: null,
      materiality: materiality('correlation', Math.min(1, Math.abs(p.change) / 0.6), p.flipped ? 0.9 : 0.6),
      meta: { pair: p.pair, now: p.now, previous: p.previous, change: p.change, flipped: p.flipped },
      source: `Rolling ${shifts.window}-day correlation between factor proxies, from stored bars.`,
    }));

  return {
    items,
    available: true,
    coverage: `${shifts.pairs.length} factor pairs compared over a ${shifts.window}-day window; `
      + `${items.length} moved enough to report.`,
  };
}

function signalShifts(positions, byWeight, { minLean }) {
  const items = [];
  let assessed = 0, thin = 0, balanced = 0;

  for (const p of positions) {
    let built = null;
    try { built = bullbear.buildSignals(p.symbol, { price: p.price ?? null }); }
    catch { thin++; continue; }

    const usable = built?.signals?.length ?? 0;
    if (!usable) { thin++; continue; }
    assessed++;

    const { bull, bear } = built.tally;
    const net = bull - bear;
    if (Math.abs(net) < minLean) { balanced++; continue; }

    const weight = byWeight.get(p.symbol) ?? null;
    items.push({
      kind: 'signal',
      fp: fingerprint('signal', `${p.symbol}:${net > 0 ? 'bull' : 'bear'}:${new Date().toISOString().slice(0, 10)}`),
      symbol: p.symbol,
      title: `${p.symbol} signals lean ${net > 0 ? 'bullish' : 'bearish'} (${bull} bull / ${bear} bear)`,
      detail: built.unavailable.length
        ? `${usable} signals usable, ${built.unavailable.length} unavailable for this instrument`
        : `${usable} signals, all available`,
      direction: net > 0 ? 'up' : 'down',
      weight,
      materiality: materiality('signal', Math.min(1, Math.abs(net) / 4), stakeFromWeight(weight)),
      meta: { bull, bear, neutral: built.tally.neutral, net, usable, unavailable: built.unavailable.length },
      source: 'Bull/bear signal engine, computed from stored bars, news and filings.',
    });
  }

  return {
    items,
    available: assessed > 0,
    reason: assessed === 0 ? 'No holding had enough stored history to build signals.' : undefined,
    // Says why a section can be simultaneously well-covered and empty, which
    // is the common case: signals were built and they simply do not lean.
    coverage: `${assessed} of ${positions.length} holdings had usable signals`
      + (balanced ? `; ${balanced} were too evenly balanced to report (needs a net lean of ${minLean})` : '')
      + (thin ? `; ${thin} had too little stored data` : '') + '.',
  };
}

// ─── Verdict ──────────────────────────────────────────────────

/**
 * The one line at the top. It is allowed — and on most days expected — to say
 * that nothing happened, which is the whole reason this is computed from the
 * findings rather than written by a language model that would rather not.
 */
function buildVerdict(items, newCount) {
  const top = items[0];
  const loud = items.filter(i => i.materiality >= 45);
  const alerts = items.filter(i => i.kind === 'alert');

  if (!items.length) {
    return { tone: 'quiet', text: 'Nothing in your portfolio, watchlist or alerts moved beyond its normal range.' };
  }
  if (alerts.length) {
    return {
      tone: 'action',
      text: `${alerts.length} alert${alerts.length === 1 ? '' : 's'} you set ${alerts.length === 1 ? 'has' : 'have'} triggered`
        + (loud.length > alerts.length ? `, alongside ${loud.length - alerts.length} other notable finding${loud.length - alerts.length === 1 ? '' : 's'}.` : '.'),
    };
  }
  if (loud.length >= 4) {
    return { tone: 'broad', text: `${loud.length} findings worth your attention — this is a busy day across several holdings, not one story.` };
  }
  if (loud.length >= 1) {
    return { tone: 'isolated', text: `${top.title}${loud.length > 1 ? ` and ${loud.length - 1} other finding${loud.length - 1 === 1 ? '' : 's'}` : ''} stand out; the rest is ordinary.` };
  }
  if (newCount === 0) {
    return { tone: 'quiet', text: 'Nothing new since you last read this briefing.' };
  }
  return { tone: 'mild', text: 'Minor findings only — nothing reached the level that usually warrants action.' };
}

// ─── Read-state ───────────────────────────────────────────────

/** Fingerprints from the last briefing the user explicitly marked as read. */
export function lastRead() {
  const row = one('SELECT * FROM briefing_reads ORDER BY read_at DESC LIMIT 1');
  if (!row) return null;
  return {
    readAt: row.read_at,
    generatedAt: row.generated_at,
    itemCount: row.item_count,
    fingerprints: new Set(safeParse(row.fingerprints, [])),
  };
}

/**
 * Mark a briefing as read.
 *
 * Takes the fingerprints from the briefing the user actually saw rather than
 * rebuilding, so a finding that appeared between render and acknowledgement is
 * not silently marked as seen.
 */
export function markRead(fingerprints, generatedAt = Date.now()) {
  const list = Array.isArray(fingerprints) ? [...new Set(fingerprints)] : [];
  run('INSERT INTO briefing_reads (read_at, generated_at, fingerprints, item_count) VALUES (?, ?, ?, ?)',
      Date.now(), generatedAt, JSON.stringify(list), list.length);
  // Keep a short history: this table exists to answer "what is new", which
  // only ever needs the most recent entry plus a little context.
  run('DELETE FROM briefing_reads WHERE id NOT IN (SELECT id FROM briefing_reads ORDER BY read_at DESC LIMIT 30)');
  return { ok: true, readAt: Date.now(), itemCount: list.length };
}

export function clearReadHistory() { run('DELETE FROM briefing_reads'); }

// ─── The briefing ─────────────────────────────────────────────

export function buildBriefing(prices = {}, {
  headlineLimit = 6,
  newsHours = 36,
  newsLimit = 8,
  newsMinRelevance = 45,
  calendarDays = 21,
  zThreshold = 1.5,
  correlationLimit = 8,
  minSignalLean = 3,
  alertDays = 7,
  recentlyFired = [],
} = {}) {
  const generatedAt = Date.now();
  const failures = [];

  let valued = null;
  try { valued = pf.valuePortfolio(prices); } catch (e) { failures.push({ section: 'portfolio', error: String(e?.message ?? e) }); }

  const positions = valued?.positions ?? [];
  const byWeight = new Map(positions.map(p => [p.symbol, p.weight ?? null]));

  let mandate = null;
  try { mandate = mandateModel.loadMandate(); } catch { mandate = null; }

  const sectionDefs = [
    { key: 'alerts',      title: 'Alerts',              run: () => triggeredAlerts(byWeight, { days: alertDays, recentlyFired }) },
    { key: 'positions',   title: 'Your holdings moved', run: () => positionMoves(positions, byWeight, { zThreshold }) },
    { key: 'news',        title: 'News about what you own', run: () => relevantNews(positions, byWeight, { hours: newsHours, minRelevance: newsMinRelevance, limit: newsLimit }) },
    { key: 'risk',        title: 'Risk and concentration', run: () => riskFlags(valued ?? { total: 0 }, positions, byWeight, mandate) },
    { key: 'events',      title: 'Coming up',           run: () => upcomingEvents(byWeight, { days: calendarDays }) },
    { key: 'signals',     title: 'Signal balance',      run: () => signalShifts(positions, byWeight, { minLean: minSignalLean }) },
    { key: 'regime',      title: 'Market backdrop',     run: () => regimeContext(prices, mandate) },
    { key: 'correlation', title: 'Relationships',       run: () => correlationBreaks({ limit: correlationLimit }) },
  ];

  const sections = [];
  let allItems = [];

  for (const def of sectionDefs) {
    let result;
    try {
      result = def.run();
    } catch (e) {
      failures.push({ section: def.key, error: String(e?.message ?? e) });
      result = { items: [], available: false, reason: `This section failed to build: ${String(e?.message ?? e)}`, coverage: null };
    }
    const items = (result.items ?? []).sort((a, b) => b.materiality - a.materiality);
    sections.push({
      key: def.key,
      title: def.title,
      available: result.available !== false,
      reason: result.reason ?? null,
      coverage: result.coverage ?? null,
      unresolved: result.unresolved ?? undefined,
      count: items.length,
      items,
    });
    allItems = allItems.concat(items.map(i => ({ ...i, section: def.key })));
  }

  // Diff against the last acknowledged briefing. Everything is new the first
  // time this is ever run, which is correct: the user has not seen any of it.
  const prev = lastRead();
  const prevFps = prev?.fingerprints ?? null;
  for (const item of allItems) {
    item.isNew = prevFps ? !prevFps.has(item.fp) : true;
  }
  for (const s of sections) {
    for (const item of s.items) item.isNew = prevFps ? !prevFps.has(item.fp) : true;
    s.newCount = s.items.filter(i => i.isNew).length;
  }

  const ranked = [...allItems].sort((a, b) => {
    // New findings lead, because a briefing's job is to surface what the
    // reader has not already accounted for. Within new and within seen,
    // materiality decides.
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    return b.materiality - a.materiality;
  });

  const newCount = allItems.filter(i => i.isNew).length;
  const headline = ranked.slice(0, headlineLimit);

  const portfolioBlock = valued ? {
    available: true,
    total: valued.total,
    cash: valued.cash,
    dayChange: valued.dayChange ?? null,
    // Taken from valuePortfolio rather than recomputed: a second derivation
    // here would use a different denominator and quietly disagree with the
    // Portfolio page about the same number.
    dayChangePct: valued.dayChangePct ?? null,
    positions: positions.length,
    priced: positions.filter(p => p.hasPrice).length,
    unpriced: positions.filter(p => !p.hasPrice).map(p => p.symbol),
  } : {
    available: false,
    reason: 'Portfolio could not be valued — see failures.',
  };

  return {
    generatedAt,
    date: new Date(generatedAt).toISOString().slice(0, 10),
    portfolio: portfolioBlock,
    verdict: buildVerdict(ranked, newCount),
    headline,
    sections,
    counts: {
      total: allItems.length,
      new: newCount,
      byKind: allItems.reduce((acc, i) => { acc[i.kind] = (acc[i.kind] ?? 0) + 1; return acc; }, {}),
    },
    lastRead: prev ? { readAt: prev.readAt, generatedAt: prev.generatedAt, itemCount: prev.itemCount } : null,
    fingerprints: allItems.map(i => i.fp),
    failures,
    // Stated rather than implied: a reader should know what this could not see.
    coverage: 'Built from your holdings, watchlist, alerts, stored price history, the local news feed '
      + 'and the calendar cache. It does not cover instruments you neither hold nor watch, macro releases '
      + '(no free structured source is wired up), or anything that happened outside the stored data.',
  };
}
