// Meridian — the bull / bear case.
//
// This lays out the reasoning for and against an instrument: what has to be
// true for each side, and what would prove each side wrong. It is deliberately
// not a verdict generator and not a scoring dashboard. The argument is the
// product; any count that appears alongside it is a footnote.
//
// Two layers:
//
//   Signals — grounding facts, each computed from data already in this app
//     (the memory layer's daily observations, the news feed's scored stories,
//     parsed Form 4 transactions, Yahoo's analyst modules). Every signal
//     carries the date it was computed from and the source it came from.
//
//   Thesis — short arguments drafted from those signals by Gemini, persisted
//     so they survive a reload, and editable by hand afterwards.
//
// The model never sees prices or names it could riff on — only the structured
// signal list. That is the whole guard against it inventing an argument that
// sounds plausible and rests on nothing.

import { all, one, run, db } from '../db.js';
import { TRADING_DAYS } from '../config.js';
import { classify } from '../sources/instruments.js';
import { getNews } from '../sources/news.js';
import { insiderSummary } from '../sources/edgar.js';
import { callAI, hasGeminiKey } from '../sources/ai.js';

// ─── Schema ───────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS bullbear_theses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL CHECK(side IN ('bull','bear')),
  target_price  REAL,
  key_assumption TEXT,
  argument_json TEXT,
  disproof_json TEXT,
  source        TEXT NOT NULL DEFAULT 'ai' CHECK(source IN ('ai','manual','ai_edited')),
  updated_at    TEXT NOT NULL,
  UNIQUE(symbol, side)
);

CREATE TABLE IF NOT EXISTS bullbear_summary (
  symbol            TEXT PRIMARY KEY,
  disagreement_text TEXT,
  updated_at        TEXT NOT NULL
);

-- Daily consensus snapshots, so a revision becomes visible as a change rather
-- than only ever showing the latest level.
CREATE TABLE IF NOT EXISTS analyst_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  target_low    REAL,
  target_high   REAL,
  target_mean   REAL,
  num_analysts  INTEGER,
  rating_strong_buy  INTEGER,
  rating_buy         INTEGER,
  rating_hold        INTEGER,
  rating_sell        INTEGER,
  rating_strong_sell INTEGER,
  UNIQUE(symbol, snapshot_date)
);

-- Daily multiples, so "expensive versus its own history" eventually becomes
-- answerable. Useless for about a year after first run, by construction.
CREATE TABLE IF NOT EXISTS valuation_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  trailing_pe   REAL,
  forward_pe    REAL,
  UNIQUE(symbol, snapshot_date)
);
`);

const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const safeParse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ─── Snapshot accrual ─────────────────────────────────────────

/**
 * Record today's analyst consensus and valuation multiples.
 *
 * Called whenever the tab is read rather than from a scheduled job. For a
 * single-user app that is both simpler and better targeted: history accrues
 * for the instruments actually being looked at, and a symbol opened once a
 * month gets a monthly series instead of nothing. UNIQUE(symbol, date) makes
 * repeat calls on the same day a no-op.
 */
export function recordSnapshots(symbol, summary) {
  if (!summary || summary.error) return { recorded: false, reason: 'no summary' };
  const d = today();
  const a = summary.analyst;
  const t = summary.ratingTrend;

  if (a || t) {
    run(`INSERT OR IGNORE INTO analyst_snapshots
         (symbol, snapshot_date, target_low, target_high, target_mean, num_analysts,
          rating_strong_buy, rating_buy, rating_hold, rating_sell, rating_strong_sell)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        symbol, d, a?.targetLow ?? null, a?.targetHigh ?? null, a?.targetMean ?? null,
        a?.numberOfAnalysts ?? null,
        t?.strongBuy ?? null, t?.buy ?? null, t?.hold ?? null, t?.sell ?? null, t?.strongSell ?? null);
  }

  if (summary.pe != null || summary.forwardPe != null) {
    run(`INSERT OR IGNORE INTO valuation_snapshots (symbol, snapshot_date, trailing_pe, forward_pe)
         VALUES (?,?,?,?)`, symbol, d, summary.pe ?? null, summary.forwardPe ?? null);
  }

  return { recorded: true, date: d };
}

// ─── Signals ──────────────────────────────────────────────────

const pct = (v, dp = 0) => `${Math.abs(v * 100).toFixed(dp)}%`;

/**
 * "an ETF", "an index", "a fund" — instrument labels mix acronyms and words,
 * so neither blanket lowercasing nor a fixed article works. Acronyms keep
 * their capitals and take the article their letter-name sound wants.
 */
const anInstrument = label => {
  const l = String(label ?? 'instrument');
  const isAcronym = /^[A-Z]{2,}/.test(l);
  const word = isAcronym ? l : l.toLowerCase();
  // F, L, M, N, R, S and X are read as "eff", "ell", "em"… — vowel sounds
  // despite being consonants, which is why "an FX pair" is correct.
  const vowelSound = isAcronym ? /^[AEIOUFLMNRSX]/.test(l) : /^[aeiou]/.test(word);
  return `${vowelSound ? 'an' : 'a'} ${word}`;
};

/** 1st, 2nd, 3rd, 4th — including the 11-13 exception. */
const ordinal = n => {
  const r100 = n % 100, r10 = n % 10;
  const suffix = (r100 >= 11 && r100 <= 13) ? 'th'
    : r10 === 1 ? 'st' : r10 === 2 ? 'nd' : r10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
};

/** A signal that could not be computed, with the reason kept rather than dropped. */
const unavailable = (category, label, reason) => ({
  category, label, direction: 'unavailable', claim: null, reason, asOf: null,
});

const signal = (category, label, direction, claim, asOf, source, extra = {}) => ({
  category, label, direction, claim, asOf, source, ...extra,
});

/**
 * Where the price sits in its own yearly range.
 *
 * Reuses the memory layer's stored observations rather than recomputing a
 * 52-week high — symbol_observations already holds drawdown from the trailing
 * high and the percentile rank of the close, computed once per day for every
 * symbol with history.
 */
function rangeSignal(symbol) {
  const o = one(`SELECT * FROM symbol_observations WHERE symbol = ? ORDER BY date DESC LIMIT 1`, symbol);
  if (!o) return unavailable('valuation', 'Range', 'No stored price history for this symbol yet.');
  if (o.drawdown == null) return unavailable('valuation', 'Range', 'Needs a year of bars to place the price in its own range.');

  // Near the top of its own range is a momentum-positive fact, not a valuation
  // one — but it is what a range measure can honestly say, so it is labelled
  // as position in range rather than dressed up as cheapness.
  const dd = o.drawdown;
  const near = Math.abs(dd) < 0.02;
  return signal(
    'valuation', 'Range',
    near ? 'neutral' : dd < -0.15 ? 'bull' : 'bear',
    near
      ? 'At its 52-week high'
      : `Trading ${pct(dd, 0)} below its 52-week high${o.pct_rank != null ? ` — ${ordinal(Math.round(o.pct_rank * 100))} percentile of its own year` : ''}`,
    o.date, 'Stored daily bars',
    { value: dd }
  );
}

/**
 * Position relative to the 50-day average, and when that last changed.
 *
 * The crossover date is what makes this more than a restatement of the price:
 * "below its 50-day since 12 August" is a fact about persistence. It comes
 * from walking back through the stored above_50 flags rather than recomputing
 * a moving average.
 */
function momentumSignal(symbol) {
  const rows = all(
    `SELECT date, above_50, dist_50dma FROM symbol_observations
     WHERE symbol = ? AND above_50 IS NOT NULL ORDER BY date DESC LIMIT ?`,
    symbol, TRADING_DAYS);
  if (!rows.length) return unavailable('momentum', 'Momentum', 'Needs 50 daily bars before a 50-day average exists.');

  const current = rows[0].above_50;
  let since = rows[0].date;
  for (const r of rows) {
    if (r.above_50 !== current) break;
    since = r.date;
  }
  // If the flag never changes across the whole window, the crossover is older
  // than the data — say so instead of implying it happened at the window edge.
  const spanned = rows.every(r => r.above_50 === current);

  return signal(
    'momentum', 'Momentum',
    current ? 'bull' : 'bear',
    `Trading ${current ? 'above' : 'below'} its 50-day average${spanned ? ' for at least the past year' : ` since ${since}`}`
      + (rows[0].dist_50dma != null ? ` (${rows[0].dist_50dma >= 0 ? '+' : '-'}${pct(rows[0].dist_50dma, 1)})` : ''),
    rows[0].date, 'Stored daily bars',
    { since: spanned ? null : since }
  );
}

/** Consensus target versus the live price. */
function analystTargetSignal(symbol, summary, price) {
  const a = summary?.analyst;
  if (!a || a.targetMean == null) {
    return unavailable('analyst', 'Analyst target', 'No published consensus target for this instrument.');
  }
  if (price == null) return unavailable('analyst', 'Analyst target', 'No live price to compare the target against.');
  const gap = a.targetMean / price - 1;
  return signal(
    'analyst', 'Analyst target',
    Math.abs(gap) < 0.03 ? 'neutral' : gap > 0 ? 'bull' : 'bear',
    `Consensus target ${pct(gap, 0)} ${gap >= 0 ? 'above' : 'below'} the current price`
      + (a.numberOfAnalysts ? `, from ${a.numberOfAnalysts} analyst${a.numberOfAnalysts === 1 ? '' : 's'}` : ''),
    today(), 'Yahoo Finance analyst consensus',
    { value: gap, target: a.targetMean }
  );
}

/** How the analyst pool is split. Aggregate only — firm-level data is not available. */
function analystRatingSignal(symbol, summary) {
  const t = summary?.ratingTrend;
  if (!t) return unavailable('analyst', 'Analyst ratings', 'No rating breakdown published for this instrument.');
  const total = (t.strongBuy ?? 0) + (t.buy ?? 0) + (t.hold ?? 0) + (t.sell ?? 0) + (t.strongSell ?? 0);
  if (!total) return unavailable('analyst', 'Analyst ratings', 'No analysts currently rate this instrument.');

  const buys = (t.strongBuy ?? 0) + (t.buy ?? 0);
  const sells = (t.sell ?? 0) + (t.strongSell ?? 0);
  const share = buys / total;
  return signal(
    'analyst', 'Analyst ratings',
    share >= 0.6 ? 'bull' : sells / total >= 0.3 ? 'bear' : 'neutral',
    `${buys} of ${total} analysts rate this a buy${sells ? `, ${sells} a sell` : ''}`,
    today(), 'Yahoo Finance recommendation trend',
    { buys, sells, total }
  );
}

/**
 * Whether the consensus target has moved.
 *
 * Described as a consensus move, never as "N firms upgraded" — firm-level
 * attribution is not available through anything this app has, and inventing it
 * would mean presenting a fabricated claim as sourced.
 */
function analystChangeSignal(symbol) {
  const rows = all(
    `SELECT snapshot_date, target_mean FROM analyst_snapshots
     WHERE symbol = ? AND target_mean IS NOT NULL ORDER BY snapshot_date DESC LIMIT 2`, symbol);
  if (rows.length < 2) {
    return unavailable('analyst', 'Target revision',
      'Needs two consensus readings to detect a revision — the first was recorded today.');
  }
  const [now, prev] = rows;
  const change = now.target_mean / prev.target_mean - 1;
  if (Math.abs(change) < 0.005) {
    return signal('analyst', 'Target revision', 'neutral',
      `Consensus target unchanged since ${prev.snapshot_date}`, now.snapshot_date, 'Stored consensus snapshots');
  }
  return signal(
    'analyst', 'Target revision',
    change > 0 ? 'bull' : 'bear',
    `Consensus target revised ${change > 0 ? 'up' : 'down'} ${pct(change, 1)} since ${prev.snapshot_date}`,
    now.snapshot_date, 'Stored consensus snapshots',
    { from: prev.target_mean, to: now.target_mean }
  );
}

/**
 * Forward P/E against this symbol's own stored history.
 *
 * Deliberately refuses to answer until a year of snapshots exists. The
 * alternative — comparing against a sector average or a remembered figure —
 * would be a number with no provenance, which is exactly what this app spent
 * v3 removing.
 */
function valuationMultipleSignal(symbol, summary) {
  const inst = classify(symbol, null);
  if (!inst.stats.includes('pe') && inst.type !== 'unknown') {
    return unavailable('valuation', 'Multiple',
      inst.absent?.pe ?? `${anInstrument(inst.label)} has no P/E to compare.`.replace(/^./, c => c.toUpperCase()));
  }
  const current = summary?.forwardPe ?? summary?.pe;
  if (current == null) return unavailable('valuation', 'Multiple', 'No P/E published for this instrument.');

  const rows = all(
    `SELECT snapshot_date, COALESCE(forward_pe, trailing_pe) v FROM valuation_snapshots
     WHERE symbol = ? AND COALESCE(forward_pe, trailing_pe) IS NOT NULL
     ORDER BY snapshot_date ASC`, symbol);

  if (rows.length < 60) {
    return unavailable('valuation', 'Multiple',
      `Comparing the multiple to its own history needs about a year of daily readings — ${rows.length} stored so far.`);
  }

  const vals = rows.map(r => r.v);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const gap = current / mean - 1;
  const spanYears = Math.max(1, Math.round(
    (Date.parse(rows[rows.length - 1].snapshot_date) - Date.parse(rows[0].snapshot_date)) / (365.25 * 86400_000)));

  return signal(
    'valuation', 'Multiple',
    Math.abs(gap) < 0.05 ? 'neutral' : gap > 0 ? 'bear' : 'bull',
    `Forward P/E ${pct(gap, 0)} ${gap >= 0 ? 'above' : 'below'} its own ${spanYears}-year average`,
    rows[rows.length - 1].snapshot_date, 'Stored valuation snapshots',
    { value: gap, current, average: mean }
  );
}

/** Sentiment of recent tagged coverage. */
function newsSignal(symbol) {
  const stories = getNews({ symbol, limit: 12, sort: 'newest' })
    .filter(s => s.sentiment != null);
  if (stories.length < 3) {
    return unavailable('news', 'News',
      stories.length
        ? `Only ${stories.length} scored ${stories.length === 1 ? 'story' : 'stories'} tagged to this symbol — too few to read a direction from.`
        : 'No scored news tagged to this symbol.');
  }
  const pos = stories.filter(s => s.sentiment > 0.1).length;
  const neg = stories.filter(s => s.sentiment < -0.1).length;
  if (pos === neg) {
    return signal('news', 'News', 'neutral',
      `Recent coverage is evenly split — ${pos} positive, ${neg} negative of the last ${stories.length}`,
      new Date(stories[0].published).toISOString().slice(0, 10), 'Meridian news feed');
  }
  return signal(
    'news', 'News',
    pos > neg ? 'bull' : 'bear',
    `${Math.max(pos, neg)} of the last ${stories.length} tagged stories scored ${pos > neg ? 'positive' : 'negative'}`,
    new Date(stories[0].published).toISOString().slice(0, 10), 'Meridian news feed',
    { positive: pos, negative: neg, total: stories.length }
  );
}

/** Open-market insider buying and selling. */
function insiderSignal(symbol) {
  const inst = classify(symbol, null);
  if (inst.filings === false) {
    return unavailable('insider', 'Insiders', `${anInstrument(inst.label)} has no insider filings.`.replace(/^./, c => c.toUpperCase()));
  }
  const s = insiderSummary(symbol, { days: 90 });
  if (!s.available) return unavailable('insider', 'Insiders', s.reason);

  const net = s.net;
  if (s.buys === 0 && s.sells === 0) {
    return unavailable('insider', 'Insiders', 'No open-market insider transactions in the past 90 days.');
  }
  return signal(
    'insider', 'Insiders',
    Math.abs(net) < 1 ? 'neutral' : net > 0 ? 'bull' : 'bear',
    net > 0
      ? `${s.buys} open-market insider purchase${s.buys === 1 ? '' : 's'} in the past 90 days, net buying`
      : `${s.sells} open-market insider sale${s.sells === 1 ? '' : 's'} in the past 90 days, net selling`,
    today(), 'SEC EDGAR Form 4',
    { buys: s.buys, sells: s.sells, net }
  );
}

/**
 * Every signal for a symbol, computed and unavailable ones alike.
 *
 * Unavailable signals are returned rather than filtered out, because "we
 * cannot see insider activity for a UK fund" is genuinely useful for reading
 * how complete the picture is, and silently omitting it would make a thin
 * case look like a complete one.
 */
export function buildSignals(symbol, { summary = null, price = null } = {}) {
  const computed = [
    rangeSignal(symbol),
    momentumSignal(symbol),
    valuationMultipleSignal(symbol, summary),
    analystTargetSignal(symbol, summary, price),
    analystRatingSignal(symbol, summary),
    analystChangeSignal(symbol),
    newsSignal(symbol),
    insiderSignal(symbol),
  ];

  const usable = computed.filter(s => s.direction !== 'unavailable');
  return {
    signals: usable,
    unavailable: computed.filter(s => s.direction === 'unavailable'),
    tally: {
      bull: usable.filter(s => s.direction === 'bull').length,
      bear: usable.filter(s => s.direction === 'bear').length,
      neutral: usable.filter(s => s.direction === 'neutral').length,
    },
  };
}

// ─── Price scenarios ──────────────────────────────────────────

export function priceScenario(summary, price) {
  const a = summary?.analyst;
  if (!a || a.targetMean == null) return { available: false, reason: 'No published analyst targets for this instrument.' };
  const to = t => (t != null && price ? t / price - 1 : null);
  return {
    available: true,
    current: price ?? null,
    bear: a.targetLow ?? null,
    base: a.targetMean ?? null,
    bull: a.targetHigh ?? null,
    pctToBear: to(a.targetLow),
    pctToBase: to(a.targetMean),
    pctToBull: to(a.targetHigh),
    analysts: a.numberOfAnalysts ?? null,
    source: 'Yahoo Finance analyst consensus',
  };
}

// ─── Event timeline ───────────────────────────────────────────

/**
 * Merged, dated events over the past 90 days.
 *
 * Computed on request rather than persisted — every input is already stored
 * somewhere, so a table here would only be a stale copy.
 */
export function buildTimeline(symbol, { days = 90 } = {}) {
  const since = Date.now() - days * 86400_000;
  const sinceDate = new Date(since).toISOString().slice(0, 10);
  const events = [];

  for (const s of getNews({ symbol, limit: 40, sort: 'newest' })) {
    if (!s.published || s.published < since) continue;
    events.push({
      date: new Date(s.published).toISOString().slice(0, 10),
      category: 'news',
      claim: s.title,
      direction: s.sentiment > 0.1 ? 'bull' : s.sentiment < -0.1 ? 'bear' : 'neutral',
      url: s.url ?? null,
      source: s.source ?? null,
    });
  }

  for (const t of all(
    `SELECT * FROM insiders WHERE symbol = ? AND date >= ? ORDER BY date DESC LIMIT 30`,
    String(symbol).toUpperCase(), sinceDate)) {
    // Awards and tax withholding are compensation mechanics, not a view on the
    // price, so they are left out of a timeline meant to show conviction.
    if (!/^(Buy|Sell)$/.test(t.tx_type)) continue;
    events.push({
      date: t.date,
      category: 'insider',
      claim: `${t.filer ?? 'Insider'} ${t.tx_type === 'Buy' ? 'bought' : 'sold'} ${t.shares?.toLocaleString() ?? '?'} shares`,
      direction: t.tx_type === 'Buy' ? 'bull' : 'bear',
      url: t.url ?? null,
      source: 'SEC EDGAR Form 4',
    });
  }

  const snaps = all(
    `SELECT snapshot_date, target_mean FROM analyst_snapshots
     WHERE symbol = ? AND target_mean IS NOT NULL AND snapshot_date >= ?
     ORDER BY snapshot_date ASC`, symbol, sinceDate);
  for (let i = 1; i < snaps.length; i++) {
    const change = snaps[i].target_mean / snaps[i - 1].target_mean - 1;
    if (Math.abs(change) < 0.005) continue;
    events.push({
      date: snaps[i].snapshot_date,
      category: 'analyst',
      claim: `Consensus target ${change > 0 ? 'raised' : 'cut'} ${pct(change, 1)}`,
      direction: change > 0 ? 'bull' : 'bear',
      source: 'Stored consensus snapshots',
    });
  }

  events.sort((a, b) => b.date.localeCompare(a.date));
  return {
    events: events.slice(0, 40),
    days,
    counts: {
      bull: events.filter(e => e.direction === 'bull').length,
      bear: events.filter(e => e.direction === 'bear').length,
    },
  };
}

// ─── Thesis storage ───────────────────────────────────────────

function readThesis(symbol) {
  const rows = all('SELECT * FROM bullbear_theses WHERE symbol = ?', symbol);
  if (!rows.length) return null;
  const out = {};
  for (const r of rows) {
    out[r.side] = {
      target: r.target_price,
      keyAssumption: r.key_assumption,
      argument: safeParse(r.argument_json, []),
      disproof: safeParse(r.disproof_json, []),
      source: r.source,
      updatedAt: r.updated_at,
    };
  }
  return (out.bull || out.bear) ? out : null;
}

function writeThesis(symbol, side, t, source) {
  run(`INSERT INTO bullbear_theses
       (symbol, side, target_price, key_assumption, argument_json, disproof_json, source, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(symbol, side) DO UPDATE SET
         target_price = excluded.target_price,
         key_assumption = excluded.key_assumption,
         argument_json = excluded.argument_json,
         disproof_json = excluded.disproof_json,
         source = excluded.source,
         updated_at = excluded.updated_at`,
      symbol, side, t.target ?? null, t.keyAssumption ?? null,
      JSON.stringify(t.argument ?? []), JSON.stringify(t.disproof ?? []),
      source, nowIso());
}

/**
 * Hand-edit one side.
 *
 * A thesis that started as AI output becomes 'ai_edited' rather than 'manual',
 * so the provenance of the wording stays visible after the fact.
 */
export function editThesis(symbol, side, patch) {
  if (!['bull', 'bear'].includes(side)) return { error: 'side must be bull or bear' };
  const existing = one('SELECT * FROM bullbear_theses WHERE symbol = ? AND side = ?', symbol, side);

  const merged = {
    target: patch.target !== undefined ? patch.target : existing?.target_price ?? null,
    keyAssumption: patch.keyAssumption !== undefined ? patch.keyAssumption : existing?.key_assumption ?? null,
    argument: patch.argument !== undefined ? patch.argument : safeParse(existing?.argument_json, []),
    disproof: patch.disproof !== undefined ? patch.disproof : safeParse(existing?.disproof_json, []),
  };
  const source = !existing ? 'manual' : existing.source === 'manual' ? 'manual' : 'ai_edited';
  writeThesis(symbol, side, merged, source);
  return { ok: true, symbol, side, source, thesis: readThesis(symbol) };
}

export function clearThesis(symbol) {
  run('DELETE FROM bullbear_theses WHERE symbol = ?', symbol);
  run('DELETE FROM bullbear_summary WHERE symbol = ?', symbol);
  return { ok: true };
}

// ─── Generation ───────────────────────────────────────────────

const SCHEMA_NOTE = `{
  "bull": { "argument": string[], "key_assumption": string, "disproof": string[] },
  "bear": { "argument": string[], "key_assumption": string, "disproof": string[] },
  "disagreement": string
}`;

function buildPrompt(symbol, name, signals, unavailableSignals, scenario) {
  const lines = signals.map(s => `- [${s.label}, ${s.direction}] ${s.claim} (as of ${s.asOf}, source: ${s.source})`);
  const gaps = unavailableSignals.map(s => `- ${s.label}: ${s.reason}`);

  return `You are drafting the bull and bear case for a personal investment research tool.

Instrument: ${name} (${symbol}).

You may use ONLY the facts listed below. Do not introduce companies, products,
competitors, executives, analysts, firms, dates, prices or figures that do not
appear here. If you cannot support a side from these facts, say so in that
side's argument rather than inventing support for it.

OBSERVED SIGNALS:
${lines.length ? lines.join('\n') : '(none — no signal could be computed for this instrument)'}
${scenario?.available ? `
ANALYST PRICE TARGETS: low ${scenario.bear}, mean ${scenario.base}, high ${scenario.bull}, current price ${scenario.current}${scenario.analysts ? `, from ${scenario.analysts} analysts` : ''}.` : ''}
${gaps.length ? `
NOT OBSERVABLE for this instrument (do not speculate about these):
${gaps.join('\n')}` : ''}

For each side write:
- "argument": 2 to 4 short bullets, each following directly from a signal above.
  Do not restate a signal verbatim — say what it implies for someone holding.
- "key_assumption": one sentence naming the single thing that side depends on
  being true. This is the load-bearing claim, not a summary.
- "disproof": 1 to 2 short bullets naming the specific, observable evidence
  that would show that side is wrong.

Then write "disagreement": one paragraph identifying where the two sides
actually diverge. Not a summary of both — the specific question on which they
disagree, and what would settle it.

Plain language. No hedging filler, no disclaimers, no invented certainty. If
the signals are thin, a short honest case is correct; do not pad it.

Respond with JSON only, matching exactly this shape:
${SCHEMA_NOTE}`;
}

/** Strip markdown fences a model may wrap JSON in, then parse. */
function parseModelJson(text) {
  let t = String(text ?? '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(t);
  if (fence) t = fence[1].trim();
  // Fall back to the outermost braces if the model added prose around it.
  if (!t.startsWith('{')) {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    t = t.slice(a, b + 1);
  }
  try { return JSON.parse(t); } catch { return null; }
}

const asStrings = (v, max) =>
  (Array.isArray(v) ? v : [])
    .map(x => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, max);

/**
 * Draft both sides from the signals and persist them.
 *
 * Returns a structured error rather than writing anything when the model is
 * unavailable or its output cannot be parsed — a half-written thesis is worse
 * than none, because it looks authored.
 */
export async function generateThesis(symbol, { name, summary, price } = {}) {
  if (!hasGeminiKey()) {
    return { ok: false, error: 'no-key', message: 'No Gemini API key set. Add one in Settings.' };
  }

  const { signals, unavailable: gaps } = buildSignals(symbol, { summary, price });
  const scenario = priceScenario(summary, price);

  if (!signals.length) {
    return {
      ok: false, error: 'no-signals',
      message: 'No signal could be computed for this instrument, so there is nothing to reason from. '
             + 'Sync price history for it, or pick an instrument with more coverage.',
    };
  }

  const res = await callAI(buildPrompt(symbol, name ?? symbol, signals, gaps, scenario), {
    maxTokens: 1600,
    // A little latitude for prose, still well short of freewheeling.
    temperature: 0.4,
  });
  if (!res.ok) {
    return {
      ok: false, error: res.error,
      message: res.error === 'rate-limited'
        ? 'Gemini rate-limited the request. The free tier allows a limited number per minute — try again shortly.'
        : `The model call failed (${res.error}).`,
    };
  }

  const parsed = parseModelJson(res.text);
  if (!parsed?.bull || !parsed?.bear) {
    return { ok: false, error: 'unparseable', message: 'The model did not return usable JSON. Try regenerating.' };
  }

  for (const side of ['bull', 'bear']) {
    const p = parsed[side] ?? {};
    writeThesis(symbol, side, {
      target: side === 'bull' ? scenario.bull ?? null : scenario.bear ?? null,
      keyAssumption: String(p.key_assumption ?? '').trim() || null,
      argument: asStrings(p.argument, 4),
      disproof: asStrings(p.disproof, 2),
    }, 'ai');
  }

  const disagreement = String(parsed.disagreement ?? '').trim() || null;
  run(`INSERT INTO bullbear_summary (symbol, disagreement_text, updated_at) VALUES (?,?,?)
       ON CONFLICT(symbol) DO UPDATE SET disagreement_text = excluded.disagreement_text,
                                         updated_at = excluded.updated_at`,
      symbol, disagreement, nowIso());

  return { ok: true, groundedIn: signals.length, thesis: readThesis(symbol), disagreement };
}

// ─── Combined read ────────────────────────────────────────────

/** Everything the tab needs, in one call. */
export function readBullBear(symbol, { summary = null, price = null, timeline = true } = {}) {
  const inst = classify(symbol);
  const { signals, unavailable: gaps, tally } = buildSignals(symbol, { summary, price });
  const scenario = priceScenario(summary, price);
  const sum = one('SELECT * FROM bullbear_summary WHERE symbol = ?', symbol);

  return {
    symbol,
    instrument: summary?.instrumentLabel ?? inst.label,
    applicability: {
      analyst: summary?.hasAnalystCoverage !== false && scenario.available,
      insider: inst.filings !== false,
      valuationMultiple: inst.stats.includes('pe') || inst.type === 'unknown',
      news: signals.some(s => s.category === 'news'),
    },
    scenario,
    signals,
    unavailable: gaps,
    tally,
    thesis: readThesis(symbol),
    disagreement: sum?.disagreement_text ?? null,
    thesisUpdatedAt: sum?.updated_at ?? null,
    aiAvailable: hasGeminiKey(),
    timeline: timeline ? buildTimeline(symbol) : null,
  };
}
