// Meridian — cross-engine alert kinds
//
// alerts.js watches prices and technicals: a level, a cross, an RSI reading, a
// drawdown. All ten of its kinds answer questions about one instrument's price
// series, and all ten are evaluated on the price-poll tick because that is the
// only input they need.
//
// The engines added since then know things price does not. The news scorer
// knows a story is about a fund you own. The bull/bear engine knows the
// balance of evidence on a holding just flipped. The scorecard knows an axis
// has fallen. The memory layer knows two factors that used to move together
// have stopped. None of that could ever fire an alert, so noticing any of it
// meant remembering to go and look.
//
// This adds those kinds. They are separated from alerts.js for two reasons
// that are not stylistic:
//
//   1. Cadence. These read the news table, rebuild signals from bars and run
//      the scorecard — work measured in hundreds of milliseconds, not the
//      microseconds a price comparison takes. Running them on every poll tick
//      (every few seconds) would be wasteful and would fire the same finding
//      repeatedly within one day. They are evaluated on their own slower beat.
//
//   2. State. A price alert is stateless: the price either crossed the level
//      or it did not. "The signal balance flipped" is only answerable against
//      what it was last time, so these kinds carry their own remembered state.

import { all, one, run, db } from '../db.js';
import * as pfa from './portfolio-analysis.js';
import * as memory from './memory.js';
import * as bullbear from './bullbear.js';
import * as mandateModel from './rebuild/mandate.js';
import { getNews } from '../sources/news.js';

db.exec(`
-- Remembered readings, so a "flip" or a "drop" is answerable at all. Keyed by
-- alert so two alerts on the same symbol with different thresholds each keep
-- their own history rather than fighting over one row.
CREATE TABLE IF NOT EXISTS signal_state (
  alert_id   INTEGER NOT NULL,
  key        TEXT NOT NULL,
  value      REAL,
  text_value TEXT,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (alert_id, key)
);

-- Every firing, kept even after an alert re-arms. Without this a repeating
-- alert would overwrite its own history and "has this fired before?" would be
-- unanswerable.
CREATE TABLE IF NOT EXISTS alert_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id  INTEGER NOT NULL,
  fired_at  INTEGER NOT NULL,
  value     REAL,
  message   TEXT NOT NULL,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_events_fired ON alert_events(fired_at DESC);
`);

// Lifecycle columns, added defensively so an alerts table from before this
// feature keeps working.
for (const col of [
  "repeat_mode TEXT NOT NULL DEFAULT 'once'",  // once | daily | always
  'snooze_until INTEGER',
  'last_fired_at INTEGER',
  'fire_count INTEGER NOT NULL DEFAULT 0',
  'params TEXT',                               // JSON, kind-specific settings
]) {
  try { db.exec(`ALTER TABLE alerts ADD COLUMN ${col}`); } catch { /* already has it */ }
}

const DAY = 86400_000;
const safeParse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

/**
 * The cross-engine kinds.
 *
 * `scope` matters: a symbol kind needs a ticker, a portfolio kind is about the
 * book as a whole and would be meaningless attached to one holding.
 */
export const SIGNAL_KINDS = {
  newsBreak: {
    label: 'Important news on a holding', scope: 'symbol', needsThreshold: true,
    defaultThreshold: 70,
    describe: a => `A story scoring ${a.threshold ?? 70}+ relevance mentions ${a.symbol}`,
  },
  sentimentShift: {
    label: 'News tone shifts', scope: 'symbol', needsThreshold: false,
    describe: a => `The tone of coverage on ${a.symbol} moves between positive, neutral and negative`,
  },
  signalFlip: {
    label: 'Bull/bear balance flips', scope: 'symbol', needsThreshold: false,
    describe: a => `The balance of evidence on ${a.symbol} crosses between bullish and bearish`,
  },
  axisDrop: {
    label: 'Scorecard axis falls', scope: 'portfolio', needsThreshold: true,
    defaultThreshold: 2.5,
    describe: a => `Any portfolio scorecard axis falls below ${a.threshold ?? 2.5}/6`,
  },
  concentration: {
    label: 'Concentration breach', scope: 'portfolio', needsThreshold: true,
    defaultThreshold: 25,
    describe: a => `Any single position exceeds ${a.threshold ?? 25}% of the portfolio`,
  },
  correlationBreak: {
    label: 'Correlation breaks down', scope: 'portfolio', needsThreshold: false,
    describe: () => 'Two factors that used to move together stop doing so',
  },
};

export const isSignalKind = kind => Object.hasOwn(SIGNAL_KINDS, kind);

/**
 * Sentinel ticker for alerts about the book rather than an instrument.
 *
 * alerts.symbol is NOT NULL, and dropping that constraint in SQLite means
 * rebuilding the table — on a live database holding the user's real alerts,
 * with no backup and no undo. A reserved symbol costs one constant and no
 * migration, so that is the trade taken here.
 */
export const PORTFOLIO_SYMBOL = 'PORTFOLIO';

/**
 * Create a signal alert, defaulting the fields whose correct value follows
 * from the kind. Centralised so a caller cannot arm a portfolio-scoped alert
 * against a ticker, or a symbol-scoped one against nothing.
 */
export function createSignalAlert({ kind, symbol = null, threshold = null, note = null, repeat = 'once' }) {
  const spec = SIGNAL_KINDS[kind];
  if (!spec) throw new Error(`Unknown signal kind: ${kind}`);
  if (spec.scope === 'symbol' && !symbol) throw new Error(`${spec.label} needs a symbol.`);

  const sym = spec.scope === 'portfolio' ? PORTFOLIO_SYMBOL : String(symbol).toUpperCase().trim();
  const th = threshold ?? spec.defaultThreshold ?? null;
  const mode = ['once', 'daily', 'always'].includes(repeat) ? repeat : 'once';

  run(`INSERT INTO alerts (symbol, kind, direction, threshold, status, note, created_at, repeat_mode, fire_count)
       VALUES (?,?,'above',?,'active',?,?,?,0)`,
      sym, kind, th, note, Date.now(), mode);
  return one('SELECT * FROM alerts ORDER BY id DESC LIMIT 1');
}

// ─── Remembered state ─────────────────────────────────────────

function readState(alertId, key) {
  return one('SELECT * FROM signal_state WHERE alert_id = ? AND key = ?', alertId, key) ?? null;
}
function writeState(alertId, key, { value = null, textValue = null }) {
  run(`INSERT INTO signal_state (alert_id, key, value, text_value, observed_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(alert_id, key) DO UPDATE SET value = excluded.value,
         text_value = excluded.text_value, observed_at = excluded.observed_at`,
      alertId, key, value, textValue, Date.now());
}
export function clearSignalState(alertId) {
  run('DELETE FROM signal_state WHERE alert_id = ?', alertId);
}

// ─── Eligibility ──────────────────────────────────────────────

/**
 * Whether an alert is allowed to fire right now, before any work is done to
 * decide whether it wants to.
 *
 * Kept separate from the per-kind logic so every kind obeys the same snooze
 * and repeat rules, rather than each one re-implementing them slightly
 * differently.
 */
export function canFire(alert, now = Date.now()) {
  if (alert.status === 'muted') return { ok: false, reason: 'muted' };
  if (alert.snooze_until && alert.snooze_until > now) return { ok: false, reason: 'snoozed' };

  const mode = alert.repeat_mode ?? 'once';
  if (mode === 'once') {
    // 'once' alerts are armed until they fire, then done. This mirrors the
    // existing price-alert behaviour so the two families stay consistent.
    return alert.status === 'active' ? { ok: true } : { ok: false, reason: 'already fired' };
  }
  if (mode === 'daily') {
    if (!alert.last_fired_at) return { ok: true };
    const sameDay = new Date(alert.last_fired_at).toDateString() === new Date(now).toDateString();
    return sameDay ? { ok: false, reason: 'already fired today' } : { ok: true };
  }
  return { ok: true };   // 'always'
}

/** Record a firing and advance the alert's lifecycle. */
function fire(alert, { value = null, message, detail = null }, now = Date.now()) {
  run('INSERT INTO alert_events (alert_id, fired_at, value, message, detail) VALUES (?,?,?,?,?)',
      alert.id, now, value, message, detail);

  const mode = alert.repeat_mode ?? 'once';
  // A repeating alert stays armed; a one-shot retires. Both record the firing,
  // which is what makes history survive re-arming.
  const status = mode === 'once' ? 'triggered' : 'active';
  run(`UPDATE alerts SET status = ?, triggered_at = ?, triggered_value = ?,
       last_fired_at = ?, fire_count = COALESCE(fire_count, 0) + 1 WHERE id = ?`,
      status, now, value, now, alert.id);

  return { ...alert, status, value, message, detail, firedAt: now };
}

// ─── Per-kind evaluation ──────────────────────────────────────
//
// Each returns null (nothing to report) or { value, message, detail }. None of
// them writes anything except its own remembered state — firing is the
// caller's job, so the snooze/repeat rules cannot be bypassed by a kind.

// How many already-reported stories to remember per alert. Bounded because
// this is only ever asked "have I already said this one", and the lookback
// window below means anything older can never come back into scope anyway.
const NEWS_MEMORY = 40;

function evalNewsBreak(alert, ctx) {
  const min = alert.threshold ?? 70;
  const seen = new Set(safeParse(readState(alert.id, 'seenGuids')?.text_value, []));

  const stories = getNews({
    symbol: alert.symbol, limit: 20, sort: 'newest',
    since: Date.now() - 3 * DAY, held: ctx.held, watched: ctx.watched,
  }).filter(s => (s.relevance ?? 0) >= min);

  if (!stories.length) return null;

  // The first story not already reported — not simply the newest. Comparing
  // only against the single most recent guid would miss a genuinely new story
  // whenever it landed below one already seen, which happens routinely when
  // several stories arrive between two evaluation passes.
  const fresh = stories.find(s => !seen.has(s.guid));
  if (!fresh) return null;

  writeState(alert.id, 'seenGuids', {
    textValue: JSON.stringify([fresh.guid, ...seen].slice(0, NEWS_MEMORY)),
  });
  return {
    value: fresh.relevance ?? null,
    message: `${alert.symbol}: ${fresh.title}`,
    detail: fresh.why || `Relevance ${fresh.relevance}, ${fresh.source ?? 'unknown source'}`,
  };
}

function evalSentimentShift(alert, ctx) {
  const trend = ctx.research.sentimentTrend(alert.symbol);
  if (!trend.available) return null;

  const prev = readState(alert.id, 'band')?.text_value ?? null;
  writeState(alert.id, 'band', { textValue: trend.nowBand, value: trend.now });

  // First observation establishes a baseline rather than firing: there is no
  // shift to report against nothing.
  if (!prev || prev === trend.nowBand) return null;

  return {
    value: +trend.now.toFixed(3),
    message: `${alert.symbol} coverage turned ${trend.nowBand} (was ${prev})`,
    detail: `Across ${trend.stories} scored stories in the last ${trend.days} days.`,
  };
}

function evalSignalFlip(alert, ctx) {
  let built = null;
  try { built = bullbear.buildSignals(alert.symbol, { price: ctx.prices?.[alert.symbol]?.price ?? null }); }
  catch { return null; }
  if (!built?.signals?.length) return null;

  const net = built.tally.bull - built.tally.bear;
  const lean = net > 0 ? 'bullish' : net < 0 ? 'bearish' : 'balanced';
  const prev = readState(alert.id, 'lean')?.text_value ?? null;
  writeState(alert.id, 'lean', { textValue: lean, value: net });

  if (!prev || prev === lean) return null;
  // A move through 'balanced' is drift, not a flip. Only a genuine reversal
  // between bullish and bearish is worth waking someone for.
  if (lean === 'balanced' || prev === 'balanced') return null;

  return {
    value: net,
    message: `${alert.symbol} evidence flipped ${prev} to ${lean}`,
    detail: `${built.tally.bull} bullish, ${built.tally.bear} bearish, ${built.tally.neutral} neutral `
      + `across ${built.signals.length} usable signals.`,
  };
}

function evalAxisDrop(alert, ctx) {
  const limit = alert.threshold ?? 2.5;
  if (!ctx.positions.length) return null;

  let card = null;
  try { card = pfa.scorecard(ctx.positions, { mandate: ctx.mandate }); } catch { return null; }
  if (!card?.available) return null;

  // Scores are 0..1 internally and shown out of 6 everywhere in the UI, so the
  // threshold is taken in the units the user actually sees.
  const breached = card.axes
    .filter(a => a.score != null && a.score * 6 < limit)
    .sort((a, b) => a.score - b.score);
  if (!breached.length) return null;

  const worst = breached[0];
  const prevKey = readState(alert.id, 'axis')?.text_value ?? null;
  const signature = breached.map(a => a.key).sort().join(',');
  writeState(alert.id, 'axis', { textValue: signature, value: worst.score });

  // Re-reporting the same set of breached axes every cycle is noise; a newly
  // breached axis is the event.
  if (prevKey === signature) return null;

  return {
    value: +(worst.score * 6).toFixed(2),
    message: `${worst.label} scores ${(worst.score * 6).toFixed(1)}/6, below ${limit}`,
    detail: breached.length > 1
      ? `${breached.length} axes are below the threshold: ${breached.map(a => a.label).join(', ')}.`
      : (worst.holdingBack?.[0] ? `Held back most by ${worst.holdingBack[0].symbol}.` : null),
  };
}

function evalConcentration(alert, ctx) {
  const limit = alert.threshold ?? 25;
  const top = [...ctx.positions].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
  if (!top || top.weight == null) return null;
  if (top.weight <= limit) {
    // Clearing the breach resets the memory, so falling back below and rising
    // through the limit again is a fresh event rather than permanent silence.
    writeState(alert.id, 'breach', { textValue: null, value: top.weight });
    return null;
  }

  const prev = readState(alert.id, 'breach')?.text_value ?? null;
  writeState(alert.id, 'breach', { textValue: top.symbol, value: top.weight });
  if (prev === top.symbol) return null;

  return {
    value: top.weight,
    message: `${top.symbol} is ${top.weight.toFixed(1)}% of the portfolio, above ${limit}%`,
    detail: `Largest of ${ctx.positions.length} positions.`,
  };
}

function evalCorrelationBreak(alert) {
  let shifts = null;
  try { shifts = memory.correlationShifts({ limit: 10 }); } catch { return null; }
  if (!shifts?.available) return null;

  const flipped = shifts.pairs.filter(p => p.flipped);
  if (!flipped.length) return null;

  const signature = flipped.map(p => p.pair).sort().join('|');
  const prev = readState(alert.id, 'pairs')?.text_value ?? null;
  writeState(alert.id, 'pairs', { textValue: signature, value: flipped.length });
  if (prev === signature) return null;

  const p = flipped[0];
  return {
    value: +p.change.toFixed(3),
    message: `${p.pair} correlation flipped sign`,
    detail: `Now ${p.now.toFixed(2)}, was ${p.previous.toFixed(2)} over the prior ${shifts.window}-day window.`,
  };
}

const EVALUATORS = {
  newsBreak: evalNewsBreak,
  sentimentShift: evalSentimentShift,
  signalFlip: evalSignalFlip,
  axisDrop: evalAxisDrop,
  concentration: evalConcentration,
  correlationBreak: evalCorrelationBreak,
};

// ─── The pass ─────────────────────────────────────────────────

/**
 * Evaluate every armed signal alert.
 *
 * Deliberately takes its dependencies as an argument rather than importing
 * research.js at module scope: that module pulls in the whole research stack,
 * and this engine is imported by the alert evaluation path which should stay
 * cheap to load.
 */
export function evaluateSignals(prices = {}, { research, valued = null, now = Date.now() } = {}) {
  const alerts = all(
    `SELECT * FROM alerts WHERE kind IN (${Object.keys(SIGNAL_KINDS).map(() => '?').join(',')})`,
    ...Object.keys(SIGNAL_KINDS));

  if (!alerts.length) return { fired: [], evaluated: 0, skipped: [] };

  const positions = valued?.positions ?? [];
  const ctx = {
    prices, positions, research,
    held: positions.map(p => p.symbol),
    watched: all('SELECT DISTINCT symbol FROM watchlist').map(r => r.symbol),
    mandate: (() => { try { return mandateModel.loadMandate(); } catch { return null; } })(),
  };

  const fired = [];
  const skipped = [];
  let evaluated = 0;

  for (const alert of alerts) {
    const eligible = canFire(alert, now);
    if (!eligible.ok) { skipped.push({ id: alert.id, reason: eligible.reason }); continue; }

    const evaluator = EVALUATORS[alert.kind];
    if (!evaluator) { skipped.push({ id: alert.id, reason: 'unknown kind' }); continue; }

    // sentimentShift needs the research engine; without it the kind is simply
    // not evaluated rather than silently reporting nothing happened.
    if (alert.kind === 'sentimentShift' && !research?.sentimentTrend) {
      skipped.push({ id: alert.id, reason: 'research engine not supplied' });
      continue;
    }

    let result = null;
    try { result = evaluator(alert, ctx); evaluated++; }
    catch (e) { skipped.push({ id: alert.id, reason: `evaluation failed: ${String(e?.message ?? e)}` }); continue; }

    if (result) fired.push(fire(alert, result, now));
  }

  return { fired, evaluated, skipped };
}

// ─── Lifecycle helpers ────────────────────────────────────────

export function snooze(id, days = 7) {
  run('UPDATE alerts SET snooze_until = ? WHERE id = ?', Date.now() + days * DAY, id);
  return one('SELECT * FROM alerts WHERE id = ?', id);
}

export function unsnooze(id) {
  run('UPDATE alerts SET snooze_until = NULL WHERE id = ?', id);
  return one('SELECT * FROM alerts WHERE id = ?', id);
}

/** Re-arm a fired alert, keeping its history. */
export function rearm(id) {
  run(`UPDATE alerts SET status = 'active', triggered_at = NULL, triggered_value = NULL WHERE id = ?`, id);
  return one('SELECT * FROM alerts WHERE id = ?', id);
}

export function alertHistory(id, limit = 50) {
  return all('SELECT * FROM alert_events WHERE alert_id = ? ORDER BY fired_at DESC LIMIT ?', id, limit);
}

export function recentEvents(limit = 50) {
  return all(`SELECT e.*, a.symbol, a.kind, a.repeat_mode
              FROM alert_events e JOIN alerts a ON a.id = e.alert_id
              ORDER BY e.fired_at DESC LIMIT ?`, limit);
}

/** Everything the alerts page needs to describe one alert in words. */
export function describe(alert) {
  const spec = SIGNAL_KINDS[alert.kind];
  if (!spec) return null;
  return {
    label: spec.label,
    scope: spec.scope,
    text: spec.describe(alert),
    repeat: alert.repeat_mode ?? 'once',
    snoozedUntil: alert.snooze_until ?? null,
    fireCount: alert.fire_count ?? 0,
    lastFiredAt: alert.last_fired_at ?? null,
  };
}
