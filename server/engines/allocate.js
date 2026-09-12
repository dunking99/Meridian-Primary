// Meridian — cash allocation synthesis
//
// This is the answer to "I have cash, what do I do with it?" — the question
// Meridian was originally built to help with, and which had quietly gone
// unanswered while everything else grew around it. It does not compute
// anything new: every reading here comes from an engine that already exists
// (Bull/Bear, Precedents, the Screener, the memory layer, risk contribution).
// This file's only job is pulling one reading from each, for each candidate,
// and combining them transparently into a cash split.
//
// Two modes:
//   manual — you've already set target_pct on your holdings; this is a thin
//     pass-through to rebalance.js's directContribution, unchanged.
//   auto   — no targets required. Every candidate (existing holdings, top
//     Screener matches, watchlist symbols) gets scored from the engines
//     above; cash splits across whatever clears the bar, proportional to
//     conviction; a mean-variance optimiser run is offered alongside as a
//     labelled second opinion, never as the primary answer (a handful of
//     overlapping index trackers is exactly the case where mean-variance
//     tends to produce brittle, corner-heavy weights).
//
// A missing signal is reported as missing, never defaulted to zero or
// invented — the same rule the rest of the app applies to every derived
// number. Nothing here ever proposes a sale; it only directs new money.

import { db, all, run, getBars } from '../db.js';
import { TRADING_DAYS } from '../config.js';
import * as A from './analytics.js';
import * as bullbear from './bullbear.js';
import * as research from './research.js';
import { screen, scoreSymbol } from './screener.js';
import * as memory from './memory.js';
import { directContribution } from './rebalance.js';
import * as opt from './optimiser.js';

// ─── Schema ───────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS allocation_plans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,
  amount          REAL NOT NULL,
  mode            TEXT NOT NULL CHECK(mode IN ('manual','auto')),
  candidates_json TEXT,
  result_json     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_allocation_plans_created ON allocation_plans(created_at DESC);
`);

export function savePlan({ amount, mode, candidates = null, result }) {
  run(`INSERT INTO allocation_plans (created_at, amount, mode, candidates_json, result_json) VALUES (?,?,?,?,?)`,
      Date.now(), amount, mode, candidates ? JSON.stringify(candidates) : null, JSON.stringify(result));
}

export function listPlans(limit = 20) {
  return all('SELECT * FROM allocation_plans ORDER BY created_at DESC LIMIT ?', limit).map(r => ({
    id: r.id, createdAt: r.created_at, amount: r.amount, mode: r.mode,
    candidates: r.candidates_json ? JSON.parse(r.candidates_json) : null,
    result: JSON.parse(r.result_json),
  }));
}

// ─── Candidate assembly ────────────────────────────────────────

/** Raw candidate universe: every existing holding, whatever the Screener
 *  currently favours, and unbought watchlist symbols. Assumes ensureHistory
 *  has already run over `screenerUniverse` — this makes no network calls. */
export function assembleCandidates({
  holdingsSymbols = [],
  includeScreener = true,
  screenerStrategy = 'balanced',
  screenerUniverse = [],
  screenerMinScore = 55,
  includeWatchlist = true,
  extra = [],
} = {}) {
  const out = new Map();
  for (const s of holdingsSymbols) out.set(s, 'holding');

  if (includeWatchlist) {
    for (const w of all('SELECT DISTINCT symbol FROM watchlist')) {
      if (!out.has(w.symbol)) out.set(w.symbol, 'watchlist');
    }
  }

  if (includeScreener && screenerUniverse.length) {
    const s = screen(screenerUniverse, { strategy: screenerStrategy, minScore: screenerMinScore, limit: 8 });
    for (const r of s.results) if (!out.has(r.symbol)) out.set(r.symbol, 'screener');
  }

  for (const e of extra) if (!out.has(e)) out.set(e, 'manual');

  return [...out.entries()].map(([symbol, source]) => ({ symbol, source }));
}

// ─── Composite scoring ─────────────────────────────────────────

/** Pull one reading from each existing engine for a single candidate. Every
 *  component carries `available` — a component that couldn't be computed is
 *  reported as missing, never silently folded into the score as neutral. */
export function scoreCandidate(symbol, { weight = 0, portfolioWeights = null, portfolioSeries = null } = {}) {
  const components = {};

  try {
    const bb = bullbear.readBullBear(symbol, { timeline: false });
    const n = bb.tally.bull + bb.tally.bear + bb.tally.neutral;
    components.bullBear = n > 0
      ? { available: true, bull: bb.tally.bull, bear: bb.tally.bear, neutral: bb.tally.neutral,
          lean: (bb.tally.bull - bb.tally.bear) / n }
      : { available: false, reason: 'No usable Bull/Bear signals yet for this symbol.' };
  } catch (e) {
    components.bullBear = { available: false, reason: `Bull/Bear signal failed: ${e.message}` };
  }

  try {
    const p = research.precedents(symbol, { count: 10 });
    if (p.available && p.matches?.length) {
      const avgFwd21 = p.matches.reduce((a, m) => a + (m.fwd21 ?? 0), 0) / p.matches.length;
      // +-5% average 21-trading-day forward move maps to a full +-1 lean.
      components.precedent = {
        available: true, matchCount: p.matches.length, avgFwd21,
        lean: Math.max(-1, Math.min(1, avgFwd21 / 0.05)),
      };
    } else {
      components.precedent = { available: false, reason: p.reason ?? 'Precedent matching unavailable.' };
    }
  } catch (e) {
    components.precedent = { available: false, reason: `Precedents failed: ${e.message}` };
  }

  try {
    const sc = scoreSymbol(symbol);
    components.screener = sc
      ? { available: true, composite: sc.composite, lean: (sc.composite - 50) / 50 }
      : { available: false, reason: 'Fewer than 120 stored bars.' };
  } catch (e) {
    components.screener = { available: false, reason: `Screener scoring failed: ${e.message}` };
  }

  try {
    const lf = memory.latestFor([symbol]);
    const z = lf[symbol]?.ret_z;
    components.anomaly = z != null
      ? { available: true, retZ: z, caution: Math.abs(z) > 2 }
      : { available: false, reason: 'No memory observation yet for this symbol.' };
  } catch (e) {
    components.anomaly = { available: false, reason: `Memory lookup failed: ${e.message}` };
  }

  if (portfolioWeights && portfolioSeries && portfolioWeights[symbol] != null) {
    try {
      const rc = A.riskContributions(portfolioSeries, portfolioWeights);
      const row = rc.find(r => r.symbol === symbol);
      components.risk = row
        ? { available: true, weight: row.weight, pctOfRisk: row.pctOfRisk,
            overContributing: row.pctOfRisk - row.weight > 0.05 }
        : { available: false, reason: 'Not enough overlapping history for a risk read.' };
    } catch (e) {
      components.risk = { available: false, reason: `Risk contribution failed: ${e.message}` };
    }
  } else {
    components.risk = { available: false, reason: 'Not an existing priced holding.' };
  }

  // Weighted, not averaged, by sample size: Bull/Bear can hit its full +-1
  // lean off as few as one or two signals, while Precedent's lean rests on
  // up to ten real historical matches. Averaging them equally would let a
  // thin, noisy technical reading swamp a much better-supported one — this
  // scales each component's say by how much it's actually backed by.
  const confidence = {
    bullBear: components.bullBear.available
      ? Math.min(1, (components.bullBear.bull + components.bullBear.bear + components.bullBear.neutral) / 6)
      : 0,
    precedent: components.precedent.available ? Math.min(1, components.precedent.matchCount / 10) : 0,
    screener: components.screener.available ? 1 : 0,   // always a fixed, full indicator set
  };
  const totalConfidence = confidence.bullBear + confidence.precedent + confidence.screener;
  let tilt = totalConfidence > 0
    ? (confidence.bullBear * (components.bullBear.lean ?? 0)
     + confidence.precedent * (components.precedent.lean ?? 0)
     + confidence.screener * (components.screener.lean ?? 0)) / totalConfidence
    : null;

  const cautions = [];
  if (components.risk.available && components.risk.overContributing) {
    if (tilt != null) tilt -= 0.15;
    cautions.push('Already contributing more portfolio risk than its weight would suggest.');
  }
  if (components.anomaly.available && components.anomaly.caution) {
    if (tilt != null) tilt -= 0.1;
    cautions.push(`Currently an unusual move for this instrument (z=${components.anomaly.retZ.toFixed(2)}) — worth checking why before adding.`);
  }
  if (tilt != null) tilt = Math.max(-1, Math.min(1, tilt));

  return { symbol, weight, components, confidence, tilt, eligible: tilt != null, cautions };
}

function explainCandidate(s) {
  const reasons = [];
  const c = s.components;
  if (c.bullBear.available) {
    if (c.bullBear.lean > 0.1) reasons.push(`Bull/Bear leans bullish (${c.bullBear.bull} bull vs ${c.bullBear.bear} bear signal${c.bullBear.bear === 1 ? '' : 's'}).`);
    else if (c.bullBear.lean < -0.1) reasons.push(`Bull/Bear leans bearish (${c.bullBear.bear} bear vs ${c.bullBear.bull} bull signal${c.bullBear.bull === 1 ? '' : 's'}).`);
  }
  if (c.precedent.available) {
    const pct = (c.precedent.avgFwd21 * 100).toFixed(1);
    reasons.push(`When this setup happened before (${c.precedent.matchCount} match${c.precedent.matchCount === 1 ? '' : 'es'}), the next month averaged ${pct > 0 ? '+' : ''}${pct}%.`);
  }
  if (c.screener.available) {
    reasons.push(`Screener composite ${c.screener.composite.toFixed(0)}/100.`);
  }
  if (!reasons.length) {
    for (const [, comp] of Object.entries(c)) if (!comp.available) reasons.push(comp.reason);
  }
  return [...reasons, ...s.cautions];
}

// ─── Waterfall split ────────────────────────────────────────────

/** Split `amount` across eligible candidates, proportional to positive tilt.
 *  Nothing with a non-positive or unavailable tilt receives anything — this
 *  only ever directs new cash, it never proposes a sale (allowSelling in
 *  rebalance.js is the tool for that). A single candidate is capped at
 *  `maxShare` of the amount unless it is the only eligible one. */
export function splitByTilt(scored, { amount, maxShare = 0.5, minTilt = 0.05 } = {}) {
  const eligible = scored.filter(s => s.eligible && s.tilt > minTilt);
  const rejected = scored.filter(s => !(s.eligible && s.tilt > minTilt));

  if (!eligible.length) {
    return {
      allocations: [],
      rejected: rejected.map(s => ({ symbol: s.symbol, tilt: s.tilt, reasons: explainCandidate(s) })),
      notes: ['No candidate cleared the bar for a positive, data-backed case right now — nothing allocated.'],
    };
  }

  const totalTilt = eligible.reduce((a, s) => a + s.tilt, 0);
  const cap = eligible.length > 1 ? amount * maxShare : amount;
  let allocations = eligible.map(s => ({ symbol: s.symbol, value: Math.min(amount * (s.tilt / totalTilt), cap) }));

  // One redistribution pass for anything trimmed by the cap — sufficient in
  // practice since a cap rarely binds on more than one candidate at once.
  const allocated = allocations.reduce((a, r) => a + r.value, 0);
  const remaining = amount - allocated;
  if (remaining > 0.01) {
    const uncapped = allocations.filter(a => a.value < cap - 0.01);
    const uncappedTotal = uncapped.reduce((a, r) => a + r.value, 0);
    if (uncappedTotal > 0) {
      for (const a of allocations) if (a.value < cap - 0.01) a.value += remaining * (a.value / uncappedTotal);
    }
  }

  const bySymbol = Object.fromEntries(scored.map(s => [s.symbol, s]));
  const finalAllocations = allocations
    .map(a => ({
      symbol: a.symbol,
      value: +a.value.toFixed(2),
      pctOfContribution: +(a.value / amount * 100).toFixed(1),
      reasons: explainCandidate(bySymbol[a.symbol]),
    }))
    .filter(a => a.value >= 1)
    .sort((a, b) => b.value - a.value);

  return {
    allocations: finalAllocations,
    rejected: rejected.map(s => ({ symbol: s.symbol, tilt: s.tilt, reasons: explainCandidate(s) })),
    notes: [],
  };
}

// ─── Optional statistical second opinion ───────────────────────

/** Mean-variance optimisation over symbols with enough overlapping history.
 *  Deliberately offered as a comparison, not the primary recommendation. */
export function optimiserSecondOpinion(symbols, { method = 'maxSharpe', maxWeight = 0.5 } = {}) {
  const series = {};
  for (const s of symbols) {
    const bars = getBars(s);
    if (bars.length < 60) continue;
    const closes = bars.map(b => b.adj_close ?? b.close).filter(Boolean);
    if (closes.length >= 60) series[s] = A.toReturns(closes);
  }
  if (Object.keys(series).length < 2) return null;
  const r = opt.optimise(series, { method, maxWeight });
  return r.error ? null : r;
}

// ─── Top-level orchestrator ─────────────────────────────────────

export function generatePlan({ amount, mode = 'auto', targets = null, holdings = [], scored = [], maxShare = 0.5, minTilt = 0.05 }) {
  if (mode === 'manual') {
    const result = directContribution(holdings, targets ?? {}, amount, {});
    savePlan({ amount, mode, result });
    return result;
  }
  const result = splitByTilt(scored, { amount, maxShare, minTilt });
  savePlan({ amount, mode, candidates: scored.map(s => s.symbol), result });
  return result;
}

export const PRECEDENT_MIN_BARS = 3 * TRADING_DAYS;
