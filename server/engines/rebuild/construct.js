// Meridian — portfolio reconstruction
//
// Stage H. Everything upstream decided which instruments deserve capital.
// This decides how much each gets, and what has to be traded to get there.
//
// Three things here are deliberate and worth stating, because each is a place
// where a naive implementation produces confident nonsense.
//
// 1. REDUNDANCY IS RESOLVED BEFORE OPTIMISATION, NOT BY IT.
//    Handed two assets with a 0.97 correlation, a mean-variance optimiser does
//    not say "these are the same thing, pick one" — it finds the split between
//    them near-arbitrarily, because the objective is almost flat along that
//    axis. Tiny differences in estimated return flip the answer between 60/40
//    and 5/95 run to run. So duplicates are collapsed to a single winner
//    first, on stated grounds (conviction, then cost), and only the survivors
//    reach the optimiser.
//
// 2. EXPECTED RETURNS COME FROM CONVICTION, NOT FROM HISTORICAL MEANS.
//    Mean-variance is notoriously sensitive to its return inputs, and a
//    trailing mean return is among the worst available estimators of the next
//    one — feeding it in produces portfolios that pile into whatever has
//    recently run. Instead every candidate starts from the same neutral
//    anchor and is tilted around it by its conviction relative to the rest of
//    the set, with the maximum spread capped by the mandate. The optimiser is
//    therefore being asked "given these are roughly similar bets, with these
//    relative preferences, how do I combine them" — a question covariance
//    estimation is actually good at.
//
// 3. GROUP CAPS ARE ENFORCED AFTER THE SOLVE, AND SAID TO BE.
//    The optimiser supports per-asset bounds, not per-sector ones. Rather than
//    pretend otherwise, sector caps are applied by iterative rescaling
//    afterwards and any cap that could not be satisfied is reported instead of
//    quietly dropped.
//
// No tax modelling anywhere in this file. The trade list is buys and sells.

import * as A from '../analytics.js';
import * as opt from '../optimiser.js';
import { getComposition, pairOverlap } from './exposure.js';
import { TRADING_DAYS } from '../../config.js';

// ─── Redundancy resolution ────────────────────────────────────

/**
 * Collapse near-duplicate candidates to one winner each.
 *
 * Winner is the highest conviction; cost breaks a near-tie, because two funds
 * tracking the same thing differ in almost nothing else that matters over a
 * long horizon. A conviction gap under this threshold is treated as noise —
 * these scores are not precise enough for 0.02 to mean anything.
 */
const CONVICTION_TIE = 0.05;

export function resolveRedundancy(assessments, { compositions = {}, minVerdict = 'heavy-overlap', minObs = 60 } = {}) {
  const RANK = { 'cannot-assess': -1, distinct: 0, related: 1, 'heavy-overlap': 2, duplicate: 3 };
  const threshold = RANK[minVerdict];

  // Highest conviction first, so each group forms around its strongest member.
  const ordered = [...assessments].sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0));
  const dropped = new Map();
  const groups = [];
  const kept = [];

  for (const cand of ordered) {
    if (dropped.has(cand.symbol)) continue;
    const members = [];

    for (const other of ordered) {
      if (other.symbol === cand.symbol || dropped.has(other.symbol)) continue;
      if (kept.some(k => k.symbol === other.symbol)) continue;
      const pair = pairOverlap(cand.symbol, other.symbol, { compositions, minObs });
      if (RANK[pair.verdict] >= threshold) members.push({ candidate: other, pair });
    }

    kept.push(cand);
    if (!members.length) continue;

    // Cost decides when conviction does not separate them.
    const costOf = s => {
      const er = getComposition(s)?.expenseRatio;
      if (er == null) return null;
      return er < 0.01 ? er * 100 : er;
    };
    let winner = cand;
    const contenders = [cand, ...members.map(m => m.candidate)];
    const best = Math.max(...contenders.map(c => c.conviction ?? 0));
    const tied = contenders.filter(c => (best - (c.conviction ?? 0)) <= CONVICTION_TIE);
    if (tied.length > 1) {
      const priced = tied.filter(c => costOf(c.symbol) != null);
      if (priced.length) {
        winner = priced.reduce((a, b) => (costOf(a.symbol) <= costOf(b.symbol) ? a : b));
      }
    }

    const losers = contenders.filter(c => c.symbol !== winner.symbol);
    for (const l of losers) {
      const pair = l.symbol === cand.symbol
        ? members.find(m => m.candidate.symbol === winner.symbol)?.pair
        : members.find(m => m.candidate.symbol === l.symbol)?.pair;
      dropped.set(l.symbol, {
        symbol: l.symbol,
        droppedFor: winner.symbol,
        verdict: pair?.verdict ?? minVerdict,
        reason: buildDropReason(l, winner, pair, costOf),
        evidence: pair?.basis ?? [],
      });
    }

    // The winner may not be the member the group formed around.
    if (winner.symbol !== cand.symbol) {
      const i = kept.findIndex(k => k.symbol === cand.symbol);
      if (i >= 0) kept.splice(i, 1);
      kept.push(winner);
    }

    groups.push({
      kept: winner.symbol,
      dropped: losers.map(l => l.symbol),
      verdict: members[0]?.pair?.verdict ?? minVerdict,
      evidence: members.map(m => ({ pair: m.pair.symbols, verdict: m.pair.verdict, basis: m.pair.basis })),
    });
  }

  return {
    survivors: kept.filter(k => !dropped.has(k.symbol)),
    dropped: [...dropped.values()],
    groups,
  };
}

function buildDropReason(loser, winner, pair, costOf) {
  const lc = costOf(loser.symbol), wc = costOf(winner.symbol);
  const evidence = pair?.basis?.length ? ` (${pair.basis.join('; ')})` : '';
  const convGap = (winner.conviction ?? 0) - (loser.conviction ?? 0);

  if (convGap > CONVICTION_TIE) {
    return `Duplicates ${winner.symbol}${evidence}. ${winner.symbol} kept on higher conviction (${(winner.conviction ?? 0).toFixed(2)} vs ${(loser.conviction ?? 0).toFixed(2)}).`;
  }
  if (lc != null && wc != null) {
    return `Duplicates ${winner.symbol}${evidence}. Conviction is level, so cost decided: ${wc.toFixed(2)}% vs ${lc.toFixed(2)}%.`;
  }
  return `Duplicates ${winner.symbol}${evidence}. Kept the higher-conviction holding; no fee data to separate them further.`;
}

// ─── Expected returns from conviction ─────────────────────────

/**
 * Turn conviction scores into the return vector the optimiser consumes.
 *
 * Anchored on the equal-weighted historical mean of the candidate set, then
 * tilted by each candidate's conviction relative to the set average, scaled so
 * the best and worst differ by at most the mandate's convictionTiltPct. The
 * anchor keeps the numbers in a plausible range for the covariance they are
 * paired with; the cap keeps a 0.9-vs-0.4 conviction gap from being expressed
 * as a 30% return difference, which would produce a single-asset portfolio
 * every time.
 */
export function expectedReturnsFromConviction(series, assessments, mandate) {
  const symbols = Object.keys(series);
  const convictionBy = Object.fromEntries(assessments.map(a => [a.symbol, a.conviction ?? 0]));

  const histMeans = symbols.map(s => A.mean(series[s]) * TRADING_DAYS);
  const anchor = A.mean(histMeans);

  const convictions = symbols.map(s => convictionBy[s] ?? 0);
  const meanConv = A.mean(convictions);
  const spread = Math.max(...convictions) - Math.min(...convictions);
  const maxTilt = (mandate.convictionTiltPct ?? 3) / 100;
  // When every candidate scores alike there is no view to express, and the
  // scaling would otherwise divide by ~0 and manufacture one.
  const scale = spread > 1e-6 ? (maxTilt / (spread / 2)) : 0;

  const expected = {};
  for (const s of symbols) {
    expected[s] = anchor + ((convictionBy[s] ?? 0) - meanConv) * scale;
  }

  return {
    expected,
    anchor: +anchor.toFixed(5),
    maxTiltPct: +(maxTilt * 100).toFixed(2),
    note: spread > 1e-6
      ? `Expected returns are the set's average historical return (${(anchor * 100).toFixed(1)}%) tilted by conviction, capped at ±${(maxTilt * 100).toFixed(1)}pp.`
      : 'All candidates scored alike, so no conviction tilt was applied — weights come from the risk model alone.',
  };
}

// ─── Constraint enforcement ───────────────────────────────────

const renormalise = w => {
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (!sum) return w;
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / sum]));
};

/**
 * Sector exposure of one instrument, as a distribution rather than a label.
 *
 * Attributing a whole fund to its single largest sector is the same category
 * of error the exposure teardown exists to correct. A global tracker that is
 * 31% technology is not a technology fund, and counting all of it against a
 * technology cap would wrongly constrain the most diversified holding in the
 * set while leaving a genuinely concentrated one unchecked. So each holding
 * contributes to every sector it actually holds, in proportion, and the cap is
 * applied to the resulting portfolio-level exposure.
 */
export function sectorProfile(symbol, positionSector = null) {
  const comp = getComposition(symbol);
  const sectors = comp?.sectors ?? {};
  const entries = Object.entries(sectors).filter(([, v]) => v > 0);

  if (entries.length) {
    const total = entries.reduce((a, [, v]) => a + v, 0);
    const distribution = Object.fromEntries(
      entries.map(([k, v]) => [prettySector(k), v / total]));
    const [dominant, topWeight] = entries.sort((a, b) => b[1] - a[1])[0];
    return {
      distribution,
      dominant: prettySector(dominant),
      concentration: +(topWeight / total).toFixed(3),
      basis: 'published sector weights',
      diversified: topWeight / total < 0.4,
    };
  }

  // A single share sits wholly in its own sector; an instrument with no sector
  // information at all is tracked as Unclassified rather than being spread
  // across sectors it may not hold.
  const label = positionSector || 'Unclassified';
  return {
    distribution: { [label]: 1 },
    dominant: label,
    concentration: 1,
    basis: positionSector ? 'holding record' : 'unknown',
    diversified: false,
  };
}

const prettySector = k => String(k).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Portfolio-level sector exposure from per-holding distributions. */
function sectorExposure(weights, sectors) {
  const out = {};
  for (const [symbol, w] of Object.entries(weights)) {
    const dist = sectors[symbol]?.distribution ?? { Unclassified: 1 };
    for (const [label, share] of Object.entries(dist)) {
      out[label] = (out[label] ?? 0) + w * share;
    }
  }
  return out;
}

/**
 * Largest fraction of the portfolio the position cap alone allows.
 *
 * This is the calculation that stops the caps being quietly violated. Three
 * surviving candidates under a 30% position cap can hold at most 90% — there
 * is no valid weight vector summing to 1, and forcing one (by renormalising)
 * silently pushes every position over the cap the mandate just set. The honest
 * answer is that 10% cannot be invested under these rules and stays in cash.
 *
 * Sector limits are not predicted here. With proportional attribution a
 * holding contributes to several sectors at once, so the binding combination
 * is not a closed form; the fill loop below discovers it and stops when no
 * further weight can be placed.
 */
function feasibleInvested(symbols, { maxPos }) {
  return Math.min(1, symbols.length * maxPos);
}

/**
 * Apply mandate caps to a weight vector.
 *
 * Order matters: the position count is trimmed first (so the minimum-position
 * rule is applied to the set that will actually be held), then dust is
 * removed, then caps are enforced by water-filling toward the largest total
 * the caps actually permit. The result is allowed to sum to less than 1 — the
 * shortfall is uninvested and reported as such, never renormalised away.
 */
export function applyConstraints(weights, { mandate, sectors = {} }) {
  const adjustments = [];
  let w = renormalise({ ...weights });

  // 1. Position count.
  const ranked = Object.entries(w).sort((a, b) => b[1] - a[1]);
  if (ranked.length > mandate.maxPositions) {
    const keep = ranked.slice(0, mandate.maxPositions);
    const cut = ranked.slice(mandate.maxPositions);
    w = renormalise(Object.fromEntries(keep));
    adjustments.push({
      rule: 'maxPositions',
      detail: `Kept the ${mandate.maxPositions} largest weights; dropped ${cut.map(([s]) => s).join(', ')}.`,
      dropped: cut.map(([s]) => s),
    });
  }

  // 2. Minimum position size. Repeated because removing dust lifts the rest,
  //    which can push another holding below the floor.
  for (let pass = 0; pass < 10; pass++) {
    const min = mandate.minPositionPct / 100;
    const small = Object.entries(w).filter(([, v]) => v > 0 && v < min);
    if (!small.length || Object.keys(w).length <= 1) break;
    for (const [s] of small) delete w[s];
    w = renormalise(w);
    adjustments.push({
      rule: 'minPositionPct',
      detail: `Dropped ${small.map(([s]) => s).join(', ')} — below the ${mandate.minPositionPct}% minimum position size.`,
      dropped: small.map(([s]) => s),
    });
  }

  // 3. Position and sector caps, water-filled to the feasible maximum.
  const maxPos = mandate.maxPositionPct / 100;
  const maxSec = mandate.maxSectorPct / 100;
  const symbols = Object.keys(w);
  const target = feasibleInvested(symbols, { maxPos });
  let capped = false;

  for (let pass = 0; pass < 200; pass++) {
    let changed = false;

    for (const [s, v] of Object.entries(w)) {
      if (v > maxPos + 1e-12) { w[s] = maxPos; changed = true; capped = true; }
    }

    // Sector caps, proportionally attributed.
    //
    // The cut each holding takes is proportional to w_i * share_i — how much
    // of the scarce sector budget it consumes — rather than to its weight
    // alone. That distinction is the whole point: a pure-sector fund spends a
    // full unit of the cap per unit of weight while a broad fund holding 30%
    // of that sector spends 0.3, so the concentrated holding should give up
    // more. (Cutting in proportion to each holding's *contribution* looks like
    // the same idea but is not — the share term cancels and every contributor
    // ends up cut by the same fraction of its weight, which ignores how
    // expensive each one is against the constraint.)
    //
    // Scale k solves sum(cut_i * share_i) = excess, so one pass lands exactly
    // on the cap rather than creeping toward it.
    const exposure = sectorExposure(w, sectors);
    for (const [label, used] of Object.entries(exposure)) {
      if (used <= maxSec + 1e-12) continue;
      const excess = used - maxSec;
      const contributors = Object.keys(w)
        .map(s => ({ s, share: sectors[s]?.distribution?.[label] ?? 0 }))
        .filter(c => c.share > 0 && w[c.s] > 0);
      const denom = contributors.reduce((a, c) => a + w[c.s] * c.share * c.share, 0);
      if (denom <= 1e-15) continue;
      const k = excess / denom;
      for (const c of contributors) {
        w[c.s] = Math.max(0, w[c.s] - Math.min(w[c.s], k * w[c.s] * c.share));
      }
      changed = true; capped = true;
    }

    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    const deficit = target - sum;

    if (deficit > 1e-9) {
      // Fill toward the position-cap target. Each holding's room is its own
      // headroom, further limited by the tightest sector it contributes to, so
      // filling one constraint cannot breach another.
      const exposureNow = sectorExposure(w, sectors);
      const room = {};
      let totalRoom = 0;
      for (const s of Object.keys(w)) {
        let limit = Math.max(0, maxPos - w[s]);
        const dist = sectors[s]?.distribution ?? { Unclassified: 1 };
        for (const [label, share] of Object.entries(dist)) {
          if (share <= 0) continue;
          const sectorRoom = Math.max(0, maxSec - (exposureNow[label] ?? 0));
          limit = Math.min(limit, sectorRoom / share);
        }
        room[s] = limit;
        totalRoom += limit;
      }
      if (totalRoom > 1e-9) {
        const place = Math.min(deficit, totalRoom);
        for (const s of Object.keys(w)) {
          if (room[s] <= 0) continue;
          w[s] += place * (room[s] / totalRoom);
        }
        changed = true;
      } else break;
    } else if (deficit < -1e-9) {
      const factor = target / sum;
      for (const s of Object.keys(w)) w[s] *= factor;
      changed = true;
    }

    if (!changed) break;
  }

  const invested = Object.values(w).reduce((a, b) => a + b, 0);
  const uninvested = Math.max(0, 1 - invested);

  if (capped) {
    adjustments.push({
      rule: 'caps',
      detail: `Position cap ${mandate.maxPositionPct}% and sector cap ${mandate.maxSectorPct}% applied by rescaling after optimisation.`,
    });
  }
  if (uninvested > 0.001) {
    adjustments.push({
      rule: 'feasibility',
      detail: `${Object.keys(w).length} holdings under a ${mandate.maxPositionPct}% position cap can hold at most ${(invested * 100).toFixed(1)}% of the portfolio. The remaining ${(uninvested * 100).toFixed(1)}% stays in cash rather than breaching the cap.`,
      uninvestedPct: +(uninvested * 100).toFixed(2),
    });
  }

  return {
    weights: w,
    // Fractions of the whole portfolio, so they are allowed to sum to less
    // than 1. Callers must not renormalise these.
    investedShare: +invested.toFixed(6),
    uninvestedShare: +uninvested.toFixed(6),
    adjustments,
    breaches: findBreaches(w, { maxPos, maxSec, sectors }),
    // Honest about the mechanism: the solve was unconstrained by sector and
    // the caps were imposed on its answer, which is not the same portfolio a
    // sector-constrained solver would have produced.
    note: capped
      ? 'Sector caps are enforced by rescaling the optimiser\'s output, not inside the solve. The result satisfies the caps but is not the exact sector-constrained optimum.'
      : null,
  };
}

function findBreaches(w, { maxPos, maxSec, sectors }) {
  const out = [];
  for (const [s, v] of Object.entries(w)) {
    if (v > maxPos + 1e-6) out.push({ kind: 'position', symbol: s, weightPct: +(v * 100).toFixed(2), capPct: +(maxPos * 100).toFixed(2) });
  }
  for (const [label, v] of Object.entries(sectorExposure(w, sectors))) {
    if (v > maxSec + 1e-6) out.push({ kind: 'sector', sector: label, weightPct: +(v * 100).toFixed(2), capPct: +(maxSec * 100).toFixed(2) });
  }
  return out;
}

// ─── Trade list ───────────────────────────────────────────────

/**
 * Difference the proposed portfolio against what is actually held.
 *
 * Plain buys and sells — no tax modelling, no wrapper logic, no lot selection.
 * Trades smaller than the threshold are reported as HOLD with the drift
 * stated, because a £12 top-up on a £60k portfolio is noise that costs a
 * dealing fee to act on.
 */
export function buildActions({ targetWeights, positions, total, cashBufferPct, minTradeValue = 50, prices = {} }) {
  const investable = total * (1 - cashBufferPct / 100);
  const currentBySymbol = Object.fromEntries(positions.map(p => [p.symbol, p]));
  const symbols = new Set([...Object.keys(targetWeights), ...positions.map(p => p.symbol)]);

  const actions = [];
  for (const symbol of symbols) {
    const pos = currentBySymbol[symbol];
    const currentValue = pos?.value ?? 0;
    const targetWeight = targetWeights[symbol] ?? 0;
    const targetValue = investable * targetWeight;
    const delta = targetValue - currentValue;

    let action;
    if (currentValue <= 0 && targetValue > 0) action = 'BUY';
    else if (currentValue > 0 && targetWeight === 0) action = 'SELL';
    else if (Math.abs(delta) < minTradeValue) action = 'HOLD';
    else action = delta > 0 ? 'ADD' : 'TRIM';

    const price = pos?.price ?? prices[symbol]?.price ?? null;

    actions.push({
      symbol,
      name: pos?.name ?? symbol,
      action,
      currentValue: +currentValue.toFixed(2),
      currentWeightPct: total ? +(currentValue / total * 100).toFixed(2) : 0,
      targetValue: +targetValue.toFixed(2),
      targetWeightPct: +(targetWeight * 100).toFixed(2),
      deltaValue: +delta.toFixed(2),
      // Units are only stated where a price is actually known; a share count
      // derived from a missing price would be a fabricated number.
      units: price ? +(Math.abs(delta) / price).toFixed(4) : null,
      price,
      priceKnown: price != null,
    });
  }

  const order = { SELL: 0, TRIM: 1, BUY: 2, ADD: 3, HOLD: 4 };
  actions.sort((a, b) => order[a.action] - order[b.action] || Math.abs(b.deltaValue) - Math.abs(a.deltaValue));

  const sells = actions.filter(a => a.action === 'SELL' || a.action === 'TRIM');
  const buys = actions.filter(a => a.action === 'BUY' || a.action === 'ADD');
  const investedAfter = actions.reduce((a, x) => a + x.targetValue, 0);

  return {
    actions,
    summary: {
      sells: sells.length,
      buys: buys.length,
      holds: actions.filter(a => a.action === 'HOLD').length,
      raised: +sells.reduce((a, x) => a + Math.abs(x.deltaValue), 0).toFixed(2),
      deployed: +buys.reduce((a, x) => a + x.deltaValue, 0).toFixed(2),
      turnoverPct: total
        ? +(actions.reduce((a, x) => a + Math.abs(x.deltaValue), 0) / 2 / total * 100).toFixed(2)
        : 0,
      investedAfter: +investedAfter.toFixed(2),
      // Whatever the target weights do not claim stays in cash — the mandate's
      // buffer plus anything the caps made it impossible to invest.
      cashAfter: +(total - investedAfter).toFixed(2),
      cashBufferValue: +(total - investable).toFixed(2),
      minTradeValue,
    },
  };
}

// ─── Risk comparison ──────────────────────────────────────────

/** Current vs proposed on the measures that decide whether this is actually
 *  an improvement, computed identically for both so the comparison is fair. */
export function compareRisk(series, currentWeights, targetWeights) {
  const usable = ws => Object.fromEntries(
    Object.entries(ws).filter(([s, v]) => v > 0 && series[s]?.length));

  const measure = ws => {
    const w = usable(ws);
    const keys = Object.keys(w);
    if (keys.length < 2) {
      return { available: false, reason: `needs 2+ holdings with stored history, has ${keys.length}` };
    }
    const sub = Object.fromEntries(keys.map(k => [k, series[k]]));
    const vol = A.portfolioVol(sub, w, TRADING_DAYS);
    return {
      available: true,
      annualVolPct: +(vol * 100).toFixed(2),
      diversificationRatio: +A.diversificationRatio(sub, w, TRADING_DAYS).toFixed(3),
      effectiveHoldings: +A.effectiveHoldings(w).toFixed(2),
      largestWeightPct: +(Math.max(...Object.values(w)) / Object.values(w).reduce((a, b) => a + b, 0) * 100).toFixed(2),
      positions: keys.length,
      riskContributions: A.riskContributions(sub, w, TRADING_DAYS)
        .map(r => ({ symbol: r.symbol, weightPct: +(r.weight * 100).toFixed(2), pctOfRiskPct: +(r.pctOfRisk * 100).toFixed(2) }))
        .sort((a, b) => b.pctOfRiskPct - a.pctOfRiskPct),
    };
  };

  const current = measure(currentWeights);
  const proposed = measure(targetWeights);

  const changes = (current.available && proposed.available) ? {
    annualVolPct: +(proposed.annualVolPct - current.annualVolPct).toFixed(2),
    diversificationRatio: +(proposed.diversificationRatio - current.diversificationRatio).toFixed(3),
    effectiveHoldings: +(proposed.effectiveHoldings - current.effectiveHoldings).toFixed(2),
    largestWeightPct: +(proposed.largestWeightPct - current.largestWeightPct).toFixed(2),
  } : null;

  return { current, proposed, changes };
}

// ─── Entry point ──────────────────────────────────────────────

/**
 * Build the target portfolio from the surviving candidates.
 *
 * Returns an explicit failure rather than a portfolio whenever the inputs
 * cannot support one. This is the single most important property in the file:
 * a plausible-looking set of weights produced from insufficient data is worse
 * than no answer, because it cannot be told apart from a good one.
 */
export function construct({ survivors, series, mandate, positions, total, prices = {}, minTradeValue = 50 }) {
  const symbols = survivors.map(s => s.symbol).filter(s => series[s]?.length);
  const withoutHistory = survivors.filter(s => !series[s.symbol]?.length).map(s => s.symbol);

  if (symbols.length < 2) {
    return {
      ok: false,
      error: symbols.length === 1
        ? `Only ${symbols[0]} survived with usable history — a portfolio cannot be constructed from one holding.`
        : 'No surviving candidate has enough stored history to optimise.',
      withoutHistory,
    };
  }

  const sub = Object.fromEntries(symbols.map(s => [s, series[s]]));
  const { expected, anchor, maxTiltPct, note: returnNote } =
    expectedReturnsFromConviction(sub, survivors, mandate);

  const raw = opt.optimise(sub, {
    method: mandate.method,
    maxWeight: mandate.maxPositionPct / 100,
    minWeight: 0,
    expectedReturns: expected,
  });

  if (raw.error) {
    return { ok: false, error: `Optimiser could not solve: ${raw.error}`, withoutHistory };
  }

  const sectors = Object.fromEntries(symbols.map(s => {
    const pos = positions.find(p => p.symbol === s);
    return [s, sectorProfile(s, pos?.sector)];
  }));

  const constrained = applyConstraints(raw.weights, { mandate, sectors });
  const currentWeights = Object.fromEntries(
    positions.filter(p => (p.value ?? 0) > 0).map(p => [p.symbol, p.value / (total || 1)]));

  const { actions, summary } = buildActions({
    targetWeights: constrained.weights, positions, total,
    cashBufferPct: mandate.cashBufferPct, minTradeValue, prices,
  });

  return {
    ok: true,
    method: mandate.method,
    optimiser: {
      expectedReturnPct: +(raw.expectedReturn * 100).toFixed(2),
      volatilityPct: +(raw.volatility * 100).toFixed(2),
      sharpe: +raw.sharpe.toFixed(3),
      observations: raw.observations,
      rawWeights: Object.fromEntries(Object.entries(raw.weights).map(([k, v]) => [k, +v.toFixed(4)])),
    },
    expectedReturns: { anchor, maxTiltPct, note: returnNote, values: expected },
    targetWeights: constrained.weights,
    sectors,
    sectorExposure: Object.entries(sectorExposure(constrained.weights, sectors))
      .map(([label, v]) => ({ label, pct: +(v * 100).toFixed(2) }))
      .sort((a, b) => b.pct - a.pct),
    constraints: {
      adjustments: constrained.adjustments,
      breaches: constrained.breaches,
      investedShare: constrained.investedShare,
      uninvestedShare: constrained.uninvestedShare,
      note: constrained.note,
    },
    actions,
    summary,
    risk: compareRisk(series, currentWeights, constrained.weights),
    withoutHistory,
  };
}
