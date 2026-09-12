// Meridian — exposure teardown
//
// Stage A of the rebuild pipeline, and the reason the pipeline exists.
//
// Fund names lie about diversification. A holding called "S&P 500" and one
// called "World Index" read as two different bets on a holdings table, but a
// cap-weighted world index is ~70% US and its ten largest positions are the
// same ten megacaps the S&P is led by. Held together they are close to one
// position wearing two names — and no amount of weight optimisation downstream
// can fix that, because an optimiser handed two near-identical assets splits
// between them arbitrarily rather than recognising the duplication.
//
// So this runs first, and it answers one question: ignoring what these things
// are called, what do I actually own, and where am I paying twice for the
// same exposure?
//
// Three independent kinds of evidence, used together and never silently
// substituted for one another:
//
//   1. Composition overlap — shared underlying holdings, from Yahoo's
//      topHoldings. Yahoo publishes the top ten only, so this is always a
//      LOWER BOUND on true overlap and is reported as "at least N%", never as
//      a precise figure. A lower bound is still decisive: two funds that share
//      55% of their weight in ten names cannot be independent bets.
//   2. Sector-profile similarity — same source. Weak evidence on its own (a
//      UK and a US tracker can have similar sector splits and be genuinely
//      different bets), so it supports a verdict, never carries one.
//   3. Return correlation — from stored bars. The most reliably available
//      evidence here, and the most direct test of the thing that actually
//      matters: do these two move as one?
//
// Where evidence is missing it is reported missing. A pair with no overlapping
// history and no composition data is "cannot assess", never "distinct" — the
// absence of proof of redundancy is not proof of independence, and quietly
// coding it as independence is exactly how two duplicate funds survive a
// review.

import { db, all, one, run, getBars } from '../../db.js';
import * as A from '../analytics.js';
import { classify } from '../../sources/instruments.js';

// ─── Composition storage ──────────────────────────────────────
//
// fetchSummary already pulls topHoldings on every Research view but nothing
// ever kept it, so composition was re-fetched and thrown away. Stored here so
// the teardown works from one cached read per symbol rather than a live fetch
// per pair, and so it still works when Yahoo is unreachable — with the age of
// the data on display rather than implied to be current.

db.exec(`
CREATE TABLE IF NOT EXISTS instrument_composition (
  symbol        TEXT PRIMARY KEY,
  name          TEXT,
  category      TEXT,
  expense_ratio REAL,
  holdings_json TEXT,
  sector_json   TEXT,
  as_of         TEXT,
  fetched_at    INTEGER NOT NULL
);
`);

/** Normalise Yahoo's topHoldings into the stored shape.
 *  Yahoo expresses weights as fractions (0.0712 = 7.12%); kept as fractions
 *  throughout this module and only converted for display. */
export function compositionFromSummary(symbol, summary) {
  if (!summary || summary.error) return null;

  const holdings = (summary.holdings ?? [])
    .map(h => ({
      symbol: h.symbol ?? null,
      name: h.holdingName ?? null,
      weight: typeof h.holdingPercent === 'number' ? h.holdingPercent : null,
    }))
    .filter(h => h.weight != null && (h.symbol || h.name));

  // Yahoo returns sectorWeightings as an array of single-key objects:
  // [{realestate: 0.0247}, {technology: 0.3112}, ...]
  const sectors = {};
  for (const entry of summary.sectorWeights ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    for (const [k, v] of Object.entries(entry)) {
      if (typeof v === 'number' && isFinite(v)) sectors[k] = v;
    }
  }

  const hasAny = holdings.length > 0 || Object.keys(sectors).length > 0;
  if (!hasAny && summary.expenseRatio == null) return null;

  return {
    symbol,
    name: summary.name ?? null,
    category: summary.instrumentLabel ?? null,
    expenseRatio: summary.expenseRatio ?? null,
    holdings,
    sectors,
    asOf: new Date().toISOString().slice(0, 10),
  };
}

export function saveComposition(comp) {
  if (!comp?.symbol) return;
  run(`INSERT INTO instrument_composition
         (symbol, name, category, expense_ratio, holdings_json, sector_json, as_of, fetched_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(symbol) DO UPDATE SET
         name = excluded.name, category = excluded.category,
         expense_ratio = excluded.expense_ratio,
         holdings_json = excluded.holdings_json, sector_json = excluded.sector_json,
         as_of = excluded.as_of, fetched_at = excluded.fetched_at`,
      comp.symbol, comp.name ?? null, comp.category ?? null,
      comp.expenseRatio ?? null,
      JSON.stringify(comp.holdings ?? []), JSON.stringify(comp.sectors ?? {}),
      comp.asOf ?? null, Date.now());
}

export function getComposition(symbol) {
  const r = one('SELECT * FROM instrument_composition WHERE symbol = ?', symbol);
  if (!r) return null;
  return {
    symbol: r.symbol,
    name: r.name,
    category: r.category,
    expenseRatio: r.expense_ratio,
    holdings: r.holdings_json ? JSON.parse(r.holdings_json) : [],
    sectors: r.sector_json ? JSON.parse(r.sector_json) : {},
    asOf: r.as_of,
    fetchedAt: r.fetched_at,
    ageDays: r.fetched_at ? Math.floor((Date.now() - r.fetched_at) / 86400000) : null,
  };
}

export function listCompositions(symbols) {
  const out = {};
  for (const s of symbols) {
    const c = getComposition(s);
    if (c) out[s] = c;
  }
  return out;
}

/**
 * Refresh stored composition for a set of symbols.
 *
 * The fetcher is injected rather than imported so this can be exercised
 * without network access, and so a failure to reach Yahoo degrades to "the
 * stored copy is N days old" rather than taking the whole teardown down.
 * Symbols are fetched one at a time: this runs rarely, and a burst of
 * quoteSummary calls is what gets a client rate-limited.
 *
 * @param {string[]} symbols
 * @param {Function} fetchSummary  async (symbol) => summary payload
 */
export async function syncCompositions(symbols, fetchSummary, { maxAgeDays = 30, force = false } = {}) {
  const updated = [], skipped = [], failed = [];

  for (const symbol of symbols) {
    const existing = getComposition(symbol);
    if (!force && existing && existing.ageDays != null && existing.ageDays < maxAgeDays) {
      skipped.push({ symbol, reason: `stored copy is ${existing.ageDays} days old` });
      continue;
    }
    try {
      const summary = await fetchSummary(symbol);
      const comp = compositionFromSummary(symbol, summary);
      if (!comp) {
        // Not an error: a single share has no holdings list to publish, and
        // an index has neither. Recorded as "nothing to store", not a failure.
        skipped.push({ symbol, reason: 'no composition published for this instrument' });
        continue;
      }
      saveComposition(comp);
      updated.push({ symbol, holdings: comp.holdings.length, sectors: Object.keys(comp.sectors).length, expenseRatio: comp.expenseRatio });
    } catch (e) {
      failed.push({ symbol, error: e.message });
    }
  }

  return { updated, skipped, failed, requested: symbols.length };
}

// ─── Pairwise evidence ────────────────────────────────────────

/** Shared-weight overlap: sum of min(weightA, weightB) over names in both.
 *  Matched on ticker where both sides have one, else on normalised name —
 *  the same company is routinely "MICROSOFT CORP" in one fund's list and
 *  "Microsoft Corporation" in another's. */
function holdingsOverlap(a, b) {
  const key = h => (h.symbol ? `s:${String(h.symbol).toUpperCase()}` : `n:${normaliseName(h.name)}`);
  if (!a?.holdings?.length || !b?.holdings?.length) return null;

  const mapA = new Map();
  for (const h of a.holdings) mapA.set(key(h), (mapA.get(key(h)) ?? 0) + h.weight);

  let shared = 0;
  const names = [];
  for (const h of b.holdings) {
    const k = key(h);
    const wa = mapA.get(k);
    if (wa == null) continue;
    const common = Math.min(wa, h.weight);
    shared += common;
    names.push({ name: h.name ?? h.symbol, weight: +(common * 100).toFixed(2) });
  }

  return {
    // Explicitly a floor: both lists are truncated to ten names, so weight
    // shared outside the top ten is invisible here and can only push the
    // true figure up.
    atLeast: +shared.toFixed(4),
    sharedNames: names.sort((x, y) => y.weight - x.weight).slice(0, 10),
    coveredA: +a.holdings.reduce((s, h) => s + h.weight, 0).toFixed(4),
    coveredB: +b.holdings.reduce((s, h) => s + h.weight, 0).toFixed(4),
    truncated: true,
  };
}

const normaliseName = n => String(n ?? '')
  .toUpperCase()
  .replace(/\b(INC|CORP|CORPORATION|PLC|LTD|LIMITED|CO|COMPANY|GROUP|HOLDINGS|NV|SA|AG|CLASS [A-C])\b/g, '')
  .replace(/[^A-Z0-9]/g, '');

/** Total-variation similarity between two sector weight vectors: the share of
 *  weight allocated to the same sectors. 1 = identical profile, 0 = disjoint. */
function sectorSimilarity(a, b) {
  const sa = a?.sectors ?? {}, sb = b?.sectors ?? {};
  const keys = new Set([...Object.keys(sa), ...Object.keys(sb)]);
  if (!keys.size) return null;

  const sumA = Object.values(sa).reduce((x, y) => x + y, 0);
  const sumB = Object.values(sb).reduce((x, y) => x + y, 0);
  if (!sumA || !sumB) return null;

  let common = 0;
  for (const k of keys) common += Math.min((sa[k] ?? 0) / sumA, (sb[k] ?? 0) / sumB);
  return +common.toFixed(4);
}

/** Return correlation over the overlapping date range of two symbols' bars.
 *  Joined on date rather than by position: two listings with different holiday
 *  calendars do not line up index-for-index, and correlating them positionally
 *  quietly compares different days. */
export function returnCorrelation(symA, symB, { minObs = 60 } = {}) {
  const barsA = getBars(symA), barsB = getBars(symB);
  if (!barsA?.length || !barsB?.length) return null;

  const mapB = new Map(barsB.map(x => [x.date, x.adj_close ?? x.close]));
  const dates = [], pa = [], pb = [];
  for (const x of barsA) {
    const closeA = x.adj_close ?? x.close;
    const closeB = mapB.get(x.date);
    if (closeA == null || closeB == null) continue;
    dates.push(x.date); pa.push(closeA); pb.push(closeB);
  }
  if (pa.length < minObs + 1) {
    return { available: false, observations: Math.max(0, pa.length - 1), minObs };
  }

  const ra = A.toReturns(pa), rb = A.toReturns(pb);
  const r = A.correlation(ra, rb);
  if (!isFinite(r)) return { available: false, observations: ra.length, minObs };

  return {
    available: true,
    correlation: +r.toFixed(4),
    observations: ra.length,
    from: dates[0],
    to: dates[dates.length - 1],
  };
}

// Verdict thresholds. Correlation is the primary axis because it is the one
// that directly measures the thing that matters (do these move as one), and
// because it is available for anything with stored history, fund or not.
const DUPLICATE_CORR = 0.90;
const HEAVY_CORR = 0.80;
const RELATED_CORR = 0.65;
// Composition overlap is a floor, so its thresholds are deliberately lower
// than the correlation ones — 50% of weight provably shared in the top ten
// alone is already heavy duplication.
const DUPLICATE_OVERLAP = 0.55;
const HEAVY_OVERLAP = 0.35;

/**
 * Assess one pair. Returns the verdict plus every piece of evidence behind it
 * and what was missing, so the report can show its working rather than assert
 * a number.
 */
export function pairOverlap(symA, symB, { compositions = {}, minObs = 60 } = {}) {
  const compA = compositions[symA] ?? null;
  const compB = compositions[symB] ?? null;

  const overlap = holdingsOverlap(compA, compB);
  const sectors = sectorSimilarity(compA, compB);
  const corr = returnCorrelation(symA, symB, { minObs });

  const basis = [];
  let verdict = 'unknown';
  let score = null;

  const c = corr?.available ? corr.correlation : null;
  const o = overlap?.atLeast ?? null;

  if (c != null) {
    basis.push(`${corr.observations} days of return history, correlation ${c.toFixed(2)}`);
    score = c;
    verdict = c >= DUPLICATE_CORR ? 'duplicate'
            : c >= HEAVY_CORR ? 'heavy-overlap'
            : c >= RELATED_CORR ? 'related' : 'distinct';
  }

  if (o != null) {
    basis.push(`at least ${(o * 100).toFixed(0)}% of weight in shared top-ten holdings`);
    const byOverlap = o >= DUPLICATE_OVERLAP ? 'duplicate'
                    : o >= HEAVY_OVERLAP ? 'heavy-overlap' : 'distinct';
    // Composition can only strengthen a verdict, never weaken one: a low
    // top-ten overlap is uninformative (the shared weight may sit outside the
    // visible ten), whereas a high one is direct proof of duplication.
    if (RANK[byOverlap] > RANK[verdict]) verdict = byOverlap;
    if (score == null || o > score) score = o;
  }

  if (sectors != null) {
    basis.push(`sector profiles ${(sectors * 100).toFixed(0)}% alike`);
  }

  const missing = [];
  if (c == null) {
    missing.push(corr
      ? `return correlation needs ${minObs}+ overlapping days, found ${corr.observations}`
      : 'no stored price history for one or both');
  }
  if (o == null) missing.push('no published holdings for one or both');

  if (verdict === 'unknown') {
    return {
      symbols: [symA, symB], verdict: 'cannot-assess', score: null,
      evidence: { correlation: corr, holdings: overlap, sectorSimilarity: sectors },
      basis, missing,
      explain: `Not enough data to judge whether ${symA} and ${symB} overlap — ${missing.join('; ')}.`,
    };
  }

  return {
    symbols: [symA, symB],
    verdict,
    score: score == null ? null : +score.toFixed(4),
    evidence: { correlation: corr, holdings: overlap, sectorSimilarity: sectors },
    basis,
    missing,
    explain: explainPair(symA, symB, verdict, basis),
  };
}

const RANK = { unknown: -1, 'cannot-assess': -1, distinct: 0, related: 1, 'heavy-overlap': 2, duplicate: 3 };

function explainPair(a, b, verdict, basis) {
  const ev = basis.join('; ');
  switch (verdict) {
    case 'duplicate':
      return `${a} and ${b} are effectively the same position — ${ev}. Holding both adds cost without adding diversification.`;
    case 'heavy-overlap':
      return `${a} and ${b} overlap heavily — ${ev}. Most of the second holding is duplicating the first.`;
    case 'related':
      return `${a} and ${b} are related but not duplicates — ${ev}.`;
    default:
      return `${a} and ${b} look like genuinely different exposures — ${ev}.`;
  }
}

// ─── Redundancy clustering ────────────────────────────────────

/**
 * Group symbols into redundancy clusters.
 *
 * Anchored rather than single-linkage on purpose. Single linkage chains: if
 * A overlaps B and B overlaps C, A and C get merged even when they have
 * nothing to do with each other. Here each cluster is built around its
 * largest holding and admits only symbols redundant with that anchor, so
 * every member is directly justified against the same reference.
 */
export function redundancyClusters(positions, { compositions = {}, minVerdict = 'heavy-overlap', minObs = 60 } = {}) {
  const symbols = positions.map(p => p.symbol);
  const weightOf = Object.fromEntries(positions.map(p => [p.symbol, p.weight ?? 0]));
  const threshold = RANK[minVerdict];

  const pairs = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      pairs.push(pairOverlap(symbols[i], symbols[j], { compositions, minObs }));
    }
  }

  const byPair = new Map();
  for (const p of pairs) byPair.set(pairKey(p.symbols[0], p.symbols[1]), p);

  // Largest position first, so the anchor of each cluster is the holding the
  // portfolio is most committed to rather than whichever happened to sort first.
  const ordered = [...symbols].sort((a, b) => (weightOf[b] ?? 0) - (weightOf[a] ?? 0));
  const assigned = new Set();
  const clusters = [];

  for (const anchor of ordered) {
    if (assigned.has(anchor)) continue;
    const members = [anchor];
    const evidence = [];
    for (const other of ordered) {
      if (other === anchor || assigned.has(other)) continue;
      const p = byPair.get(pairKey(anchor, other));
      if (p && RANK[p.verdict] >= threshold) {
        members.push(other);
        evidence.push(p);
      }
    }
    if (members.length > 1) {
      members.forEach(m => assigned.add(m));
      clusters.push({
        anchor,
        members,
        combinedWeight: +members.reduce((s, m) => s + (weightOf[m] ?? 0), 0).toFixed(2),
        pairs: evidence,
        explain: `${members.join(' + ')} together hold ${members.reduce((s, m) => s + (weightOf[m] ?? 0), 0).toFixed(1)}% of the portfolio in what is substantially one exposure.`,
      });
    }
  }

  return {
    clusters,
    pairs,
    unassessable: pairs.filter(p => p.verdict === 'cannot-assess').map(p => p.symbols),
  };
}

const pairKey = (a, b) => [a, b].sort().join('|');

// ─── Portfolio-level look-through ─────────────────────────────

/**
 * Sector exposure with funds decomposed into what they actually hold.
 *
 * The headline sector breakdown on the Portfolio page attributes a whole
 * global tracker to whatever sector label the holding row carries, which for
 * a fund is meaningless. This attributes each fund's value across its real
 * published sector weights instead, and reports how much of the portfolio it
 * could not see through, so a 40%-covered figure is never mistaken for a
 * complete one.
 */
export function lookThroughSectors(positions, compositions) {
  const totals = {};
  let seen = 0, unseen = 0;
  const opaque = [];

  for (const p of positions) {
    const value = p.value ?? 0;
    if (value <= 0) continue;
    const comp = compositions[p.symbol];
    const sectors = comp?.sectors ?? {};
    const sum = Object.values(sectors).reduce((a, b) => a + b, 0);

    if (sum > 0) {
      for (const [k, v] of Object.entries(sectors)) {
        totals[k] = (totals[k] ?? 0) + value * (v / sum);
      }
      seen += value;
    } else if (p.sector && p.sector !== 'Unclassified') {
      // A single stock has one sector and needs no decomposition; the stored
      // label is the right answer, not a gap.
      const inst = classify(p.symbol);
      if (inst.type === 'equity' || inst.type === 'unknown') {
        totals[p.sector] = (totals[p.sector] ?? 0) + value;
        seen += value;
      } else {
        unseen += value; opaque.push(p.symbol);
      }
    } else {
      unseen += value; opaque.push(p.symbol);
    }
  }

  const total = seen + unseen;
  return {
    covered: total ? +(seen / total * 100).toFixed(2) : 0,
    opaque,
    sectors: Object.entries(totals)
      .map(([label, value]) => ({
        label: prettySector(label),
        value: +value.toFixed(2),
        // Percent of the part that could actually be seen through, stated as
        // such — expressing it over the whole portfolio would understate every
        // sector by the size of the opaque remainder without saying so.
        pctOfSeen: seen ? +(value / seen * 100).toFixed(2) : 0,
      }))
      .sort((a, b) => b.value - a.value),
    note: unseen > 0
      ? `${(unseen / (total || 1) * 100).toFixed(0)}% of the portfolio has no published sector composition (${opaque.join(', ')}) and is excluded from these percentages.`
      : null,
  };
}

const SECTOR_LABELS = {
  realestate: 'Real Estate', consumer_cyclical: 'Consumer Cyclical',
  basic_materials: 'Basic Materials', consumer_defensive: 'Consumer Defensive',
  technology: 'Technology', communication_services: 'Communication Services',
  financial_services: 'Financial Services', utilities: 'Utilities',
  industrials: 'Industrials', energy: 'Energy', healthcare: 'Healthcare',
};
const prettySector = k => SECTOR_LABELS[k] ?? String(k).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/**
 * Single-name concentration seen through funds: how much of the whole
 * portfolio sits in one company once every fund's published holdings are
 * added up. This is the figure that shows a "diversified" five-fund portfolio
 * is 8% one stock.
 */
export function lookThroughNames(positions, compositions) {
  const totals = new Map();
  let seen = 0, unseen = 0;

  for (const p of positions) {
    const value = p.value ?? 0;
    if (value <= 0) continue;
    const comp = compositions[p.symbol];
    const hs = comp?.holdings ?? [];

    if (hs.length) {
      // Only the published top ten is visible, so only that share of the
      // fund's value is attributed; the rest is explicitly unseen rather than
      // spread across the visible names, which would overstate them.
      let attributed = 0;
      for (const h of hs) {
        const k = h.symbol ? String(h.symbol).toUpperCase() : normaliseName(h.name);
        const cur = totals.get(k) ?? { name: h.name ?? h.symbol, symbol: h.symbol ?? null, value: 0, via: [] };
        cur.value += value * h.weight;
        if (!cur.via.includes(p.symbol)) cur.via.push(p.symbol);
        totals.set(k, cur);
        attributed += h.weight;
      }
      seen += value * Math.min(1, attributed);
      unseen += value * Math.max(0, 1 - attributed);
    } else {
      const inst = classify(p.symbol);
      if (inst.type === 'equity' || inst.type === 'unknown') {
        // A directly-held share is 100% itself.
        const k = p.symbol.toUpperCase();
        const cur = totals.get(k) ?? { name: p.name ?? p.symbol, symbol: p.symbol, value: 0, via: [] };
        cur.value += value;
        if (!cur.via.includes(p.symbol)) cur.via.push(p.symbol);
        totals.set(k, cur);
        seen += value;
      } else {
        unseen += value;
      }
    }
  }

  const portfolioTotal = positions.reduce((a, p) => a + (p.value ?? 0), 0);
  const names = [...totals.values()]
    .map(v => ({
      name: v.name, symbol: v.symbol,
      value: +v.value.toFixed(2),
      pctOfPortfolio: portfolioTotal ? +(v.value / portfolioTotal * 100).toFixed(2) : 0,
      heldVia: v.via,
    }))
    .sort((a, b) => b.value - a.value);

  return {
    names: names.slice(0, 25),
    // Every name reachable through more than one holding is, by definition,
    // exposure being bought twice.
    duplicatedAcross: names.filter(n => n.heldVia.length > 1).slice(0, 15),
    visibleShare: portfolioTotal ? +(seen / portfolioTotal * 100).toFixed(2) : 0,
    note: unseen > 0
      ? `Only published top-ten holdings are visible, so these are floors: ${(unseen / (portfolioTotal || 1) * 100).toFixed(0)}% of portfolio value sits in positions no holdings list covers.`
      : null,
  };
}

// ─── Entry point ──────────────────────────────────────────────

/**
 * Full teardown of a set of positions.
 * @param {Array} positions [{symbol, name, value, weight, sector, ...}] from valuePortfolio
 */
export function teardown(positions, { minObs = 60, minVerdict = 'heavy-overlap' } = {}) {
  const priced = positions.filter(p => (p.value ?? 0) > 0);
  const compositions = listCompositions(priced.map(p => p.symbol));

  const redundancy = redundancyClusters(priced, { compositions, minVerdict, minObs });
  const sectors = lookThroughSectors(priced, compositions);
  const names = lookThroughNames(priced, compositions);

  const withComposition = priced.filter(p => compositions[p.symbol]?.holdings?.length).length;

  return {
    positions: priced.map(p => {
      const c = compositions[p.symbol];
      return {
        symbol: p.symbol, name: p.name, value: p.value, weight: p.weight,
        expenseRatio: c?.expenseRatio ?? null,
        compositionKnown: !!c?.holdings?.length,
        compositionAsOf: c?.asOf ?? null,
        compositionAgeDays: c?.ageDays ?? null,
        topHoldings: (c?.holdings ?? []).slice(0, 5).map(h => ({
          name: h.name ?? h.symbol, weight: +(h.weight * 100).toFixed(2),
        })),
      };
    }),
    redundancy,
    sectors,
    names,
    coverage: {
      positions: priced.length,
      withComposition,
      withoutComposition: priced.length - withComposition,
      // Stated plainly: without composition data the teardown is running on
      // return correlation alone, which is weaker for telling apart two funds
      // that happen to be correlated from two that are the same thing.
      note: withComposition < priced.length
        ? `${priced.length - withComposition} of ${priced.length} holdings have no stored composition. Overlap for those rests on return correlation alone. Run a composition sync to improve it.`
        : null,
    },
  };
}
