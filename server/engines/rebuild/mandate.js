// Meridian — investment mandate
//
// Stage B. "High risk, long term" is not a mood, it is a set of numbers, and
// until those numbers are written down every recommendation downstream is
// smuggling in an assumption nobody chose. This is where they get chosen.
//
// Everything the pipeline does that could be argued with — how concentrated a
// single position may get, whether a sector may dominate, how small a position
// is too small to bother with, how many holdings is too many, how much
// evidence a name needs before it earns capital — is a field here, with a
// default that follows from the stated risk level and horizon rather than
// from a number picked to make the output look reasonable.
//
// Nothing in this file, or anywhere else in the rebuild pipeline, models tax.
// The portfolio this serves is held in wrappers where it does not apply, and
// a tax model that is not actually needed is a source of wrong answers, not
// safety.

import { getSetting, setSetting } from '../../db.js';

export const RISK_LEVELS = {
  low: {
    label: 'Low risk',
    // A low-risk mandate wants the volatility floor, not the best risk-adjusted
    // return: minimum variance is the honest objective for it.
    method: 'minVariance',
    maxPositionPct: 15,
    maxSectorPct: 30,
    minPositionPct: 3,
    maxPositions: 12,
    cashBufferPct: 5,
    // How far conviction is allowed to move an expected return away from the
    // cross-sectional average. Low risk = lean on the risk model, not on views.
    convictionTiltPct: 1.5,
    minConviction: 0.40,
  },
  balanced: {
    label: 'Balanced',
    method: 'maxSharpe',
    maxPositionPct: 20,
    maxSectorPct: 38,
    minPositionPct: 4,
    maxPositions: 10,
    cashBufferPct: 3,
    convictionTiltPct: 3,
    minConviction: 0.35,
  },
  high: {
    label: 'High risk',
    // Best risk-adjusted return, with the leash long enough that conviction
    // can actually express itself in the weights.
    method: 'maxSharpe',
    maxPositionPct: 30,
    maxSectorPct: 50,
    // A high-risk mandate that spreads into 2% slivers is not high risk, it is
    // an index with extra steps. Fewer, larger positions is the point.
    minPositionPct: 5,
    maxPositions: 8,
    cashBufferPct: 2,
    convictionTiltPct: 5,
    minConviction: 0.30,
  },
};

export const HORIZONS = {
  short: {
    label: 'Short (under 2 years)',
    // Over a short horizon the technical/timing read is most of what is
    // knowable, and a multi-year precedent study is close to irrelevant.
    signalWeights: { technical: 0.45, precedent: 0.20, quality: 0.15, cost: 0.05, trend: 0.15 },
    lookbackDays: 250,
    regimeSensitivity: 1.0,
  },
  medium: {
    label: 'Medium (2-5 years)',
    signalWeights: { technical: 0.25, precedent: 0.25, quality: 0.25, cost: 0.10, trend: 0.15 },
    lookbackDays: 500,
    regimeSensitivity: 0.6,
  },
  long: {
    label: 'Long (5 years+)',
    // Over five years, cost compounds and today's momentum does not. Weighted
    // accordingly: structural quality and fee drag lead, timing is a tiebreak.
    signalWeights: { technical: 0.15, precedent: 0.20, quality: 0.35, cost: 0.20, trend: 0.10 },
    lookbackDays: 750,
    // A long-horizon mandate should not be repositioned by this month's
    // regime. It is context in the report, not a lever on the weights.
    regimeSensitivity: 0.25,
  },
};

const SETTING_KEY = 'rebuild_mandate';

/** The mandate this project was actually described by its owner: a high-risk,
 *  long-horizon equity portfolio. Used until one is explicitly saved. */
export const DEFAULT_MANDATE = {
  riskLevel: 'high',
  horizon: 'long',
  excludeSymbols: [],
  // Overrides left null inherit from the risk level / horizon tables above, so
  // changing risk level moves every unset number with it instead of leaving a
  // stale hand-set value behind.
  overrides: {
    maxPositionPct: null,
    maxSectorPct: null,
    minPositionPct: null,
    maxPositions: null,
    cashBufferPct: null,
    minConviction: null,
    convictionTiltPct: null,
    method: null,
  },
};

const NUMERIC_BOUNDS = {
  maxPositionPct: [5, 100],
  maxSectorPct: [10, 100],
  minPositionPct: [0, 25],
  maxPositions: [2, 40],
  cashBufferPct: [0, 50],
  minConviction: [0, 1],
  convictionTiltPct: [0, 15],
};

/** Merge risk level + horizon + explicit overrides into the flat set of
 *  numbers the rest of the pipeline reads. */
export function resolveMandate(raw = null) {
  const m = { ...DEFAULT_MANDATE, ...(raw ?? {}) };
  const risk = RISK_LEVELS[m.riskLevel] ?? RISK_LEVELS.high;
  const horizon = HORIZONS[m.horizon] ?? HORIZONS.long;
  const ov = { ...DEFAULT_MANDATE.overrides, ...(m.overrides ?? {}) };

  const pick = (key, fallback) => {
    const v = ov[key];
    if (v == null || v === '' || Number.isNaN(Number(v))) return fallback;
    const bounds = NUMERIC_BOUNDS[key];
    const n = Number(v);
    return bounds ? Math.min(bounds[1], Math.max(bounds[0], n)) : n;
  };

  const resolved = {
    riskLevel: m.riskLevel,
    riskLabel: risk.label,
    horizon: m.horizon,
    horizonLabel: horizon.label,
    method: ov.method ?? risk.method,
    maxPositionPct: pick('maxPositionPct', risk.maxPositionPct),
    maxSectorPct: pick('maxSectorPct', risk.maxSectorPct),
    minPositionPct: pick('minPositionPct', risk.minPositionPct),
    maxPositions: Math.round(pick('maxPositions', risk.maxPositions)),
    cashBufferPct: pick('cashBufferPct', risk.cashBufferPct),
    minConviction: pick('minConviction', risk.minConviction),
    convictionTiltPct: pick('convictionTiltPct', risk.convictionTiltPct),
    signalWeights: horizon.signalWeights,
    lookbackDays: horizon.lookbackDays,
    regimeSensitivity: horizon.regimeSensitivity,
    excludeSymbols: (m.excludeSymbols ?? []).map(s => String(s).toUpperCase()),
    overrides: ov,
  };

  return { ...resolved, conflicts: checkConflicts(resolved) };
}

/**
 * Constraint sets can be quietly impossible — a 10% position cap with a
 * maximum of 6 holdings can never reach 100% invested, and the optimiser
 * would silently return something that satisfies neither. Better to say so.
 */
function checkConflicts(m) {
  const out = [];
  const investable = 1 - m.cashBufferPct / 100;

  if (m.maxPositions * (m.maxPositionPct / 100) < investable) {
    out.push(`${m.maxPositions} positions capped at ${m.maxPositionPct}% each cannot fill ${(investable * 100).toFixed(0)}% invested. Raise the position cap, allow more holdings, or hold more cash.`);
  }
  if (m.minPositionPct > 0 && (100 - m.cashBufferPct) / m.minPositionPct < 2) {
    out.push(`A ${m.minPositionPct}% minimum position leaves room for fewer than two holdings.`);
  }
  if (m.minPositionPct >= m.maxPositionPct) {
    out.push(`Minimum position (${m.minPositionPct}%) is not below the maximum (${m.maxPositionPct}%).`);
  }
  if (m.maxSectorPct < m.maxPositionPct) {
    out.push(`Sector cap (${m.maxSectorPct}%) is below the position cap (${m.maxPositionPct}%), so any position at its cap would breach its sector.`);
  }
  return out;
}

// getSetting/setSetting already JSON-encode and decode, so the object is
// handed over as-is — stringifying here too would store a string of a string.
export function loadMandate() {
  const stored = getSetting(SETTING_KEY, null);
  if (!stored || typeof stored !== 'object') return resolveMandate(null);
  return resolveMandate(stored);
}

export function saveMandate(patch) {
  const stored = getSetting(SETTING_KEY, null);
  const base = (stored && typeof stored === 'object')
    ? { ...DEFAULT_MANDATE, ...stored }
    : DEFAULT_MANDATE;

  const next = {
    riskLevel: RISK_LEVELS[patch.riskLevel] ? patch.riskLevel : base.riskLevel,
    horizon: HORIZONS[patch.horizon] ? patch.horizon : base.horizon,
    excludeSymbols: Array.isArray(patch.excludeSymbols)
      ? [...new Set(patch.excludeSymbols.map(s => String(s).toUpperCase().trim()).filter(Boolean))]
      : base.excludeSymbols,
    overrides: { ...base.overrides, ...(patch.overrides ?? {}) },
  };

  setSetting(SETTING_KEY, next);
  return resolveMandate(next);
}

export function resetMandate() {
  setSetting(SETTING_KEY, DEFAULT_MANDATE);
  return resolveMandate(DEFAULT_MANDATE);
}
