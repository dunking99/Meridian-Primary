// Meridian — candidate universe
//
// Stage C. Allocate only ever looked at what was already held plus the
// watchlist, which means it could rebalance toward a bad holding but could
// never discover a better one. This widens the search to everything the app
// tracks — and then narrows it on two grounds that are not negotiable:
//
//   1. Investability. Most of the tracked universe is not buyable. ^GSPC is a
//      calculated level, GBPUSD=X is an exchange rate, CL=F is a futures
//      contract, ^TNX is a yield. Scanning them and ranking them alongside
//      real funds produces a recommendation to "buy the VIX", which is not a
//      thing a person can do in an ISA. Only equities, ETFs and funds survive.
//   2. Analysability. A symbol with no stored history cannot be scored,
//      correlated, optimised or stress-tested. Including it anyway would mean
//      every downstream number for it is a guess. It is reported as skipped,
//      with the reason, rather than quietly dropped — a candidate missing
//      because of a data gap is a fixable problem, and hiding it makes it
//      permanent.
//
// Current holdings are always candidates, even when they fail these tests,
// because the pipeline must reach a verdict on things already owned. A
// holding that cannot be assessed is a finding, not an omission.

import { all, getBars, barCoverage } from '../../db.js';
import { CORE_SYMBOLS, SYMBOLS } from '../../config.js';
import { classify } from '../../sources/instruments.js';

// Equities, ETFs and funds can be bought. Indices, FX pairs, futures, yields
// and (for this portfolio's wrappers) crypto cannot, and must never reach a
// recommendation.
//
// 'unknown' is included deliberately. classify() returns it for anything whose
// type has not been established — which in practice is an ordinary ticker that
// is not in the config's group table and has not yet had a quote back from
// Yahoo. Every genuinely non-investable shape (^INDEX, =X, =F, 0P…, a config
// group) is already typed by the time it gets here, so excluding 'unknown'
// would not filter out indices; it would filter out the user's own
// newly-added holdings. Those are flagged as unconfirmed rather than dropped.
const INVESTABLE_TYPES = new Set(['equity', 'etf', 'fund', 'unknown']);

export function isInvestable(symbol) {
  return INVESTABLE_TYPES.has(classify(symbol).type);
}

/** Minimum stored history for a symbol to be scoreable at all. The screener
 *  needs 120 bars, correlation needs 60 overlapping, precedents want years.
 *  120 is the floor below which most of the pipeline returns nothing useful. */
export const MIN_BARS = 120;

export function assembleUniverse({
  holdingsSymbols = [],
  includeWatchlist = true,
  includeTracked = true,
  extra = [],
  exclude = [],
  minBars = MIN_BARS,
} = {}) {
  const excluded = new Set(exclude.map(s => String(s).toUpperCase()));
  const held = new Set(holdingsSymbols);

  const sources = new Map();
  const note = (symbol, source) => {
    if (!symbol) return;
    const s = String(symbol).toUpperCase();
    const cur = sources.get(s) ?? { symbol: s, sources: [] };
    if (!cur.sources.includes(source)) cur.sources.push(source);
    sources.set(s, cur);
  };

  for (const s of holdingsSymbols) note(s, 'holding');
  if (includeWatchlist) {
    for (const r of all('SELECT DISTINCT symbol FROM watchlist')) note(r.symbol, 'watchlist');
  }
  if (includeTracked) {
    for (const s of CORE_SYMBOLS) note(s, 'tracked');
  }
  for (const s of extra) note(s, 'manual');

  const candidates = [];
  const skipped = [];

  for (const entry of sources.values()) {
    const { symbol } = entry;
    const isHeld = held.has(symbol);
    const inst = classify(symbol);
    const coverage = barCoverage(symbol);
    const bars = coverage?.n ?? 0;

    const reasons = [];
    if (excluded.has(symbol)) reasons.push('excluded by mandate');
    if (!INVESTABLE_TYPES.has(inst.type)) reasons.push(`${inst.label} — not directly investable`);
    if (bars < minBars) reasons.push(`only ${bars} stored bars, needs ${minBars}`);

    if (reasons.length && !isHeld) {
      skipped.push({ symbol, sources: entry.sources, instrument: inst.label, reasons });
      continue;
    }

    candidates.push({
      symbol,
      name: SYMBOLS[symbol]?.name ?? null,
      sources: entry.sources,
      held: isHeld,
      instrument: inst.type,
      instrumentLabel: inst.label,
      bars,
      // A held position that fails the filters still gets assessed, but the
      // pipeline needs to know it cannot be scored normally so it does not
      // present a thin-data verdict as a confident one.
      assessable: reasons.length === 0,
      limitations: reasons,
      typeConfirmed: inst.type !== 'unknown',
    });
  }

  return {
    candidates: candidates.sort((a, b) => Number(b.held) - Number(a.held) || a.symbol.localeCompare(b.symbol)),
    skipped,
    counts: {
      considered: sources.size,
      candidates: candidates.length,
      skipped: skipped.length,
      held: candidates.filter(c => c.held).length,
      new: candidates.filter(c => !c.held).length,
      unassessableHoldings: candidates.filter(c => c.held && !c.assessable).length,
    },
  };
}
