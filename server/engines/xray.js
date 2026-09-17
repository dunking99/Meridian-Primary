// Meridian v2 — portfolio X-ray
//
// Every other view in this app answers questions about the things you bought.
// This one answers questions about what you actually own, which is a different
// list. Six fund tickers can be one bet on the same twenty companies, and no
// amount of staring at the fund-level table will show it.
//
// What it produces:
//
//   - One merged list of underlying companies, with the weight each one
//     carries across the whole book, and which of your positions it arrived
//     through. "You hold 4.2% Nvidia" is a fact about your money; "you hold
//     three global trackers" is a fact about your paperwork.
//   - The names reached through more than one position — the hidden
//     duplication that fund-level overlap between two funds does not catch
//     when the same company arrives via three of them.
//   - Concentration measured on those underlying names rather than on fund
//     tickers, which is the number that actually describes your risk.
//   - Sector exposure blended across every fund that discloses one.
//
// The honesty problem, and the single most important thing in this file:
//
//   Yahoo publishes a fund's TOP TEN holdings, not its book. For a global
//   tracker the top ten is often 15-25% of the fund; the other 75-85% is not
//   disclosed anywhere free. So every underlying weight computed here is a
//   FLOOR — "at least this much" — and never an estimate of the true figure.
//
//   The tempting move is to scale the disclosed weights up so they sum to the
//   position's full weight, which makes the output look complete and produces
//   a beautiful pie chart. It is also a fabrication: it asserts that the
//   undisclosed 80% of a fund is distributed like the disclosed 20%, which is
//   false for every fund with a long tail — precisely the funds most people
//   hold. Nothing in this engine normalises a partial disclosure up to 100%.
//   `seenWeight` and `unseenWeight` are reported separately on every figure so
//   the reader always knows which part of the book a number describes.
//
// Direct holdings are folded in at full weight. If you own Shell directly and
// also through two funds, your Shell exposure is the sum of all three, and the
// direct leg is the only one of them that is exact.

import { getComposition, listCompositions, normaliseName } from './rebuild/exposure.js';
import { isSingleCompany, venueOf } from './lookthrough.js';

/** Underlying names at or above this share of the whole book are worth
 *  surfacing on their own. 1% of a real portfolio is a position. */
export const MATERIAL_UNDERLYING = 0.01;

/** A fund disclosing less than this share of itself is too thin to say much
 *  about, and is flagged rather than quietly averaged in with the rest. */
export const THIN_DISCLOSURE = 0.15;

/** How many names a Yahoo composition typically carries. Used only to explain
 *  the truncation in prose, never to extrapolate past it. */
const TYPICAL_DISCLOSED_NAMES = 10;

// ─── Identity ─────────────────────────────────────────────────

/**
 * Key for "is this the same company". Ticker when both sides have one, else
 * the normalised name, matching the pairwise overlap rule exactly.
 *
 * Tickers are compared without their listing suffix, because the same company
 * reached through a US-listed fund and a London-listed one appears as SHEL and
 * SHEL.L, and treating those as two companies is how a concentrated position
 * hides in plain sight as two moderate ones.
 */
export function underlyingKey(holding) {
  const sym = holding?.symbol ? String(holding.symbol).trim().toUpperCase() : null;
  if (sym) return `s:${sym.replace(/\.[A-Z]{1,4}$/, '')}`;
  const n = normaliseName(holding?.name);
  return n ? `n:${n}` : null;
}

/**
 * Best display name available for an underlying.
 *
 * Fund disclosure files routinely shout — "APPLE INC." alongside another
 * fund's "Apple Inc" for the same company. Preferring the longer string alone
 * picks the shouted one, because the trailing punctuation makes it longer, so
 * readability is scored first and length only breaks ties among equally
 * readable candidates.
 */
function bestName(existing, incoming) {
  if (!existing) return incoming ?? null;
  if (!incoming) return existing;
  const readable = s => {
    const letters = s.replace(/[^A-Za-z]/g, '');
    // All-caps with more than a couple of letters is a disclosure-file
    // spelling rather than a name anyone would choose to read.
    return !(letters.length > 3 && letters === letters.toUpperCase());
  };
  const a = readable(existing), b = readable(incoming);
  if (a !== b) return a ? existing : incoming;
  return incoming.length > existing.length ? incoming : existing;
}

// ─── Per-position decomposition ───────────────────────────────

/**
 * What one position resolves into, expressed as fractions OF THAT POSITION.
 *
 * Three outcomes, and they are deliberately distinct:
 *   'composition' — a fund that publishes holdings; disclosed names only.
 *   'self'        — established as a single company by positive evidence, so
 *                   it is 100% itself and that figure is exact.
 *   'unseen'      — neither. Contributes nothing and is named in the report.
 */
export function resolvePosition(position, composition = null) {
  const comp = composition ?? (position?.symbol ? getComposition(position.symbol) : null);

  const disclosed = (comp?.holdings ?? [])
    .map(h => ({ ...h, key: underlyingKey(h) }))
    .filter(h => h.key && typeof h.weight === 'number' && isFinite(h.weight) && h.weight > 0);

  if (disclosed.length) {
    const seen = disclosed.reduce((s, h) => s + h.weight, 0);
    return {
      basis: 'composition',
      // Guard against a malformed composition claiming more than 100%: the
      // fraction seen cannot exceed the whole, whatever the source says.
      seen: Math.min(seen, 1),
      names: disclosed,
      disclosedNames: disclosed.length,
      asOf: comp?.asOf ?? null,
      ageDays: comp?.ageDays ?? null,
      note: `Top ${disclosed.length} holdings, ${(Math.min(seen, 1) * 100).toFixed(1)}% of the fund.`,
    };
  }

  if (isSingleCompany(position)) {
    const v = venueOf(position.symbol);
    return {
      basis: 'self',
      seen: 1,
      names: [{
        key: underlyingKey({ symbol: position.symbol, name: position.name }),
        symbol: position.symbol,
        name: position.name ?? position.symbol,
        weight: 1,
      }],
      disclosedNames: 1,
      country: v.known ? v.country : null,
      note: 'Held directly — this is the company, so the figure is exact.',
    };
  }

  return {
    basis: 'unseen',
    seen: 0,
    names: [],
    disclosedNames: 0,
    note: comp
      ? 'Composition is stored but publishes no holdings.'
      : 'No stored composition, and nothing establishes this as a single company.',
  };
}

// ─── The merged underlying book ───────────────────────────────

/**
 * Merge every position's disclosed contents into one list of companies.
 *
 * Each underlying carries the positions it came through and what each
 * contributed, because "4.2% Nvidia" prompts "from where?" immediately and a
 * number that cannot answer that is not usable.
 */
export function underlyingExposure(positions, compositions = null) {
  const held = (positions ?? []).filter(p => p?.symbol);
  const totalValue = held.reduce(
    (s, p) => s + (typeof p.value === 'number' && isFinite(p.value) ? p.value : 0), 0);

  const comps = compositions ?? listCompositions(held.map(p => p.symbol));

  const byKey = new Map();
  const perPosition = [];
  let seenWeight = 0, unseenWeight = 0, unpricedWeight = 0;

  for (const p of held) {
    const weight = totalValue > 0 && typeof p.value === 'number' ? p.value / totalValue : null;
    const res = resolvePosition(p, comps[p.symbol] ?? null);

    perPosition.push({
      symbol: p.symbol,
      name: p.name ?? p.symbol,
      weight: weight == null ? null : +weight.toFixed(6),
      basis: res.basis,
      disclosedShare: +res.seen.toFixed(4),
      disclosedNames: res.disclosedNames,
      asOf: res.asOf ?? null,
      ageDays: res.ageDays ?? null,
      thin: res.basis === 'composition' && res.seen < THIN_DISCLOSURE,
      note: res.note,
    });

    if (weight == null) { unpricedWeight += 0; continue; }
    if (res.basis === 'unseen') { unseenWeight += weight; continue; }

    // The part of this position we can see, and the part we cannot.
    seenWeight += weight * res.seen;
    unseenWeight += weight * (1 - res.seen);

    for (const h of res.names) {
      const contribution = weight * h.weight;
      const cur = byKey.get(h.key) ?? {
        key: h.key, symbol: h.symbol ?? null, name: null,
        weight: 0, via: [], exact: true,
      };
      cur.weight += contribution;
      cur.name = bestName(cur.name, h.name ?? h.symbol ?? null);
      if (!cur.symbol && h.symbol) cur.symbol = h.symbol;
      // Exact only while every leg is a direct holding. One fund leg makes the
      // whole figure a floor.
      if (res.basis !== 'self') cur.exact = false;
      cur.via.push({
        symbol: p.symbol,
        name: p.name ?? p.symbol,
        contribution: +contribution.toFixed(6),
        basis: res.basis,
      });
      byKey.set(h.key, cur);
    }
  }

  const underlyings = [...byKey.values()]
    .map(u => ({
      ...u,
      weight: +u.weight.toFixed(6),
      via: u.via.sort((a, b) => b.contribution - a.contribution),
      viaCount: u.via.length,
    }))
    .sort((a, b) => b.weight - a.weight);

  return {
    underlyings,
    positions: perPosition,
    totalValue,
    weightsAvailable: totalValue > 0,
    seenWeight: +seenWeight.toFixed(4),
    unseenWeight: +unseenWeight.toFixed(4),
    distinctNames: underlyings.length,
  };
}

// ─── Findings over the merged book ────────────────────────────

/**
 * Companies you hold through more than one position.
 *
 * This is the finding the fund-level view structurally cannot produce. Two
 * funds overlapping is visible by comparing them directly; the same company
 * arriving at 1.5% through each of four funds is invisible everywhere except
 * here, and it is the larger position of the two.
 */
export function multiFundNames(exposure, { min = 0 } = {}) {
  return (exposure?.underlyings ?? [])
    .filter(u => u.viaCount > 1 && u.weight >= min)
    .map(u => ({
      key: u.key, symbol: u.symbol, name: u.name,
      weight: u.weight,
      viaCount: u.viaCount,
      via: u.via,
      // The share of this exposure that would survive selling the single
      // largest contributor — i.e. how much of it is genuinely spread.
      concentratedIn: u.via[0] ? +(u.via[0].contribution / u.weight).toFixed(4) : null,
    }))
    .sort((a, b) => b.weight - a.weight);
}

/**
 * Concentration at the level that matters.
 *
 * Reported against the same measure computed on fund tickers, because the gap
 * between the two is the point: a book of eight funds can look diversified by
 * every fund-level measure and still have a quarter of its money in ten
 * companies.
 */
export function concentration(exposure, { top = 10 } = {}) {
  const us = exposure?.underlyings ?? [];
  const positions = (exposure?.positions ?? []).filter(p => p.weight != null);

  if (!us.length) {
    return { available: false, reason: 'Nothing could be looked through', top: [] };
  }

  const topNames = us.slice(0, top);
  const topWeight = topNames.reduce((s, u) => s + u.weight, 0);
  const largest = us[0];

  // Herfindahl over the visible underlying names. Computed over the seen
  // portion only and labelled as such, because the undisclosed remainder
  // would lower it and its true contribution is unknown.
  const seen = exposure.seenWeight || 0;
  const hhi = seen > 0
    ? us.reduce((s, u) => s + (u.weight / seen) ** 2, 0)
    : null;

  const posSorted = [...positions].sort((a, b) => b.weight - a.weight);
  const topPositions = posSorted.slice(0, top).reduce((s, p) => s + p.weight, 0);

  return {
    available: true,
    top: topNames.map(u => ({
      symbol: u.symbol, name: u.name,
      weight: u.weight, viaCount: u.viaCount, exact: u.exact,
    })),
    topWeight: +topWeight.toFixed(4),
    topCount: topNames.length,
    largestName: largest ? { symbol: largest.symbol, name: largest.name, weight: largest.weight, viaCount: largest.viaCount } : null,
    // Same measure on the things you bought, for contrast.
    topPositionsWeight: +topPositions.toFixed(4),
    positionCount: positions.length,
    distinctNames: us.length,
    effectiveNames: hhi ? +(1 / hhi).toFixed(2) : null,
    basis: `Over the ${(seen * 100).toFixed(1)}% of the book whose contents are disclosed. `
      + 'Undisclosed holdings would change these figures and cannot be measured.',
  };
}

/**
 * Sector exposure blended across every position that publishes one.
 *
 * Fund sector weights sum to ~100% of the fund even though the holdings list
 * is truncated, so this covers more of the book than the name-level view does
 * — a fund can disclose 18% of its holdings by name and still report its full
 * sector split. Coverage is therefore computed separately rather than reusing
 * the name-level figure.
 */
export function sectorExposure(positions, compositions = null) {
  const held = (positions ?? []).filter(p => p?.symbol);
  const totalValue = held.reduce(
    (s, p) => s + (typeof p.value === 'number' && isFinite(p.value) ? p.value : 0), 0);
  if (!(totalValue > 0)) {
    return { available: false, reason: 'No priced holdings to weight sectors by', sectors: [] };
  }

  const comps = compositions ?? listCompositions(held.map(p => p.symbol));
  const acc = {};
  let covered = 0;
  const without = [];

  for (const p of held) {
    const weight = (typeof p.value === 'number' ? p.value : 0) / totalValue;
    const sectors = comps[p.symbol]?.sectors ?? null;
    const keys = sectors ? Object.keys(sectors) : [];
    if (!keys.length) {
      // A directly-held company with a sector recorded on the holding still
      // counts — that is a real published fact, not an inference.
      const own = typeof p.sector === 'string' && p.sector.trim() ? p.sector.trim() : null;
      if (own && isSingleCompany(p)) {
        acc[own] = (acc[own] ?? 0) + weight;
        covered += weight;
      } else {
        without.push({ symbol: p.symbol, name: p.name ?? p.symbol, weight: +weight.toFixed(4) });
      }
      continue;
    }
    const sum = keys.reduce((s, k) => s + (sectors[k] ?? 0), 0);
    if (!(sum > 0)) { without.push({ symbol: p.symbol, name: p.name ?? p.symbol, weight: +weight.toFixed(4) }); continue; }
    for (const k of keys) acc[k] = (acc[k] ?? 0) + weight * (sectors[k] ?? 0);
    covered += weight * Math.min(sum, 1);
  }

  const sectors = Object.entries(acc)
    .map(([sector, w]) => ({
      sector,
      // Two denominators, both stated. Over the whole book is the honest
      // headline; over the covered part is what a pie chart would need, and is
      // labelled so it cannot be mistaken for the first.
      weightOfBook: +w.toFixed(4),
      weightOfCovered: covered > 0 ? +(w / covered).toFixed(4) : null,
    }))
    .sort((a, b) => b.weightOfBook - a.weightOfBook);

  return {
    available: sectors.length > 0,
    sectors,
    covered: +covered.toFixed(4),
    uncovered: +(1 - covered).toFixed(4),
    positionsWithoutSectors: without.sort((a, b) => b.weight - a.weight),
    basis: covered >= 0.999
      ? 'Every holding publishes a sector split.'
      : `Covers ${(covered * 100).toFixed(1)}% of the book; the rest publishes no sector split.`,
  };
}

// ─── The assembled report ─────────────────────────────────────

/** Plain-language findings, or null when there is nothing to say. Never
 *  invents reassurance from missing data. */
function headlineFor({ exposure, overlaps, conc }) {
  const notes = [];
  if (conc?.available && conc.largestName && conc.largestName.weight >= MATERIAL_UNDERLYING) {
    const l = conc.largestName;
    notes.push(
      `${l.name ?? l.symbol} is at least ${(l.weight * 100).toFixed(1)}% of the book`
      + (l.viaCount > 1 ? `, arriving through ${l.viaCount} holdings` : ''));
  }
  const material = (overlaps ?? []).filter(o => o.weight >= MATERIAL_UNDERLYING);
  if (material.length) {
    notes.push(`${material.length} compan${material.length === 1 ? 'y is' : 'ies are'} held through more than one position`);
  }
  if (exposure?.unseenWeight > 0.5) {
    notes.push(`${(exposure.unseenWeight * 100).toFixed(0)}% of the book publishes nothing to look through`);
  }
  return notes.length ? notes : null;
}

/**
 * The whole X-ray.
 *
 * Sections fail independently: a book with no stored compositions still gets
 * an honest empty answer naming what is missing, rather than an exception or a
 * confident zero.
 */
export function xray(positions, { top = 10 } = {}) {
  const held = (positions ?? []).filter(p => p?.symbol);
  if (!held.length) {
    return {
      available: false,
      reason: 'No holdings to look through',
      generatedAt: new Date().toISOString(),
    };
  }

  const comps = listCompositions(held.map(p => p.symbol));
  const section = fn => { try { return fn(); } catch (e) { return { available: false, reason: `failed: ${e.message}` }; } };

  const exposure = section(() => underlyingExposure(held, comps));
  const overlaps = section(() => multiFundNames(exposure, { min: 0 }));
  const conc = section(() => concentration(exposure, { top }));
  const sectors = section(() => sectorExposure(held, comps));

  const unseen = (exposure.positions ?? []).filter(p => p.basis === 'unseen');
  const thin = (exposure.positions ?? []).filter(p => p.thin);
  const stale = (exposure.positions ?? []).filter(p => p.ageDays != null && p.ageDays > 90);

  return {
    available: true,
    generatedAt: new Date().toISOString(),
    weightsAvailable: exposure.weightsAvailable,
    underlyings: exposure.underlyings,
    distinctNames: exposure.distinctNames,
    positions: exposure.positions,
    overlaps,
    concentration: conc,
    sectors,
    coverage: {
      // The three numbers a reader needs before trusting anything above.
      seen: exposure.seenWeight,
      unseen: exposure.unseenWeight,
      positionsTotal: held.length,
      positionsSeen: (exposure.positions ?? []).filter(p => p.basis !== 'unseen').length,
      positionsUnseen: unseen.length,
      thinlyDisclosed: thin.length,
      staleCompositions: stale.length,
    },
    unseenPositions: unseen.map(p => ({ symbol: p.symbol, name: p.name, weight: p.weight, note: p.note })),
    headline: headlineFor({ exposure, overlaps, conc }),
    basis:
      'Every weight is a floor. Fund compositions publish roughly the top '
      + `${TYPICAL_DISCLOSED_NAMES} holdings, so undisclosed positions can only push these `
      + 'figures up, never down. Disclosed weights are never scaled up to fill '
      + 'the undisclosed remainder, because that would assume the rest of each '
      + 'fund looks like its largest holdings.',
  };
}
