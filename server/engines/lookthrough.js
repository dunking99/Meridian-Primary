// Meridian — look-through exposure by listing venue
//
// Two parts of this app have disagreed about what the portfolio is exposed to.
//
// exposure.js decomposes funds using their real stored compositions, reports
// what share of the book it could actually see through, and names the holdings
// it could not. The Rebuild page uses it.
//
// portfolio.js carried a hardcoded table of nineteen specific UK ETF tickers
// with a US fraction typed beside each, and for anything absent from that
// table it fell back to reading the geography label as a string: something
// tagged "Global" was credited with 0.65 US exposure and something tagged
// "Europe" with zero. The Risk page rendered that to one decimal place.
//
// The number was invented. Nothing measured it, nothing updated it when a
// tracker changed shape, and any holding outside those nineteen tickers got a
// figure derived from how its geography field happened to be spelled. It is
// exactly the class of plausible-looking fabrication this project exists to
// remove, and it sat behind one of the more consequential readings in the app.
//
// This engine replaces it with evidence: where a fund publishes its holdings,
// those holdings are classified by the venue they trade on and weighted; where
// nothing is published, the value is reported as unseen rather than guessed.
//
// **Listing venue is not domicile and not revenue.** A London-listed miner
// earns its money in Chile. This measures where the underlying instruments
// trade, which is a fact about the holdings, and it says so everywhere it is
// reported rather than letting it be read as economic exposure.

import { classify } from '../sources/instruments.js';

/**
 * Yahoo ticker suffix -> listing venue.
 *
 * A suffix is a fact about the ticker rather than an inference, which is why
 * this table is allowed to exist where the one it replaces was not: nothing
 * here is an estimate of anything. An unlisted suffix yields 'unknown' and is
 * excluded from the percentages instead of being defaulted into a region.
 */
const VENUES = {
  L: { country: 'United Kingdom', region: 'UK' },
  IL: { country: 'United Kingdom', region: 'UK' },
  DE: { country: 'Germany', region: 'Europe' },
  F: { country: 'Germany', region: 'Europe' },
  PA: { country: 'France', region: 'Europe' },
  AS: { country: 'Netherlands', region: 'Europe' },
  BR: { country: 'Belgium', region: 'Europe' },
  MI: { country: 'Italy', region: 'Europe' },
  MC: { country: 'Spain', region: 'Europe' },
  LS: { country: 'Portugal', region: 'Europe' },
  VI: { country: 'Austria', region: 'Europe' },
  SW: { country: 'Switzerland', region: 'Europe' },
  ST: { country: 'Sweden', region: 'Europe' },
  OL: { country: 'Norway', region: 'Europe' },
  CO: { country: 'Denmark', region: 'Europe' },
  HE: { country: 'Finland', region: 'Europe' },
  IR: { country: 'Ireland', region: 'Europe' },
  WA: { country: 'Poland', region: 'Europe' },
  AT: { country: 'Greece', region: 'Europe' },
  T:  { country: 'Japan', region: 'Asia-Pacific' },
  HK: { country: 'Hong Kong', region: 'Asia-Pacific' },
  SS: { country: 'China', region: 'Asia-Pacific' },
  SZ: { country: 'China', region: 'Asia-Pacific' },
  KS: { country: 'South Korea', region: 'Asia-Pacific' },
  KQ: { country: 'South Korea', region: 'Asia-Pacific' },
  TW: { country: 'Taiwan', region: 'Asia-Pacific' },
  SI: { country: 'Singapore', region: 'Asia-Pacific' },
  AX: { country: 'Australia', region: 'Asia-Pacific' },
  NZ: { country: 'New Zealand', region: 'Asia-Pacific' },
  NS: { country: 'India', region: 'Asia-Pacific' },
  BO: { country: 'India', region: 'Asia-Pacific' },
  JK: { country: 'Indonesia', region: 'Asia-Pacific' },
  BK: { country: 'Thailand', region: 'Asia-Pacific' },
  KL: { country: 'Malaysia', region: 'Asia-Pacific' },
  TO: { country: 'Canada', region: 'North America' },
  V:  { country: 'Canada', region: 'North America' },
  NE: { country: 'Canada', region: 'North America' },
  MX: { country: 'Mexico', region: 'Latin America' },
  SA: { country: 'Brazil', region: 'Latin America' },
  BA: { country: 'Argentina', region: 'Latin America' },
  SN: { country: 'Chile', region: 'Latin America' },
  JO: { country: 'South Africa', region: 'Africa / Middle East' },
  TA: { country: 'Israel', region: 'Africa / Middle East' },
  IS: { country: 'Turkey', region: 'Africa / Middle East' },
};

const US_VENUE = { country: 'United States', region: 'North America' };

/**
 * Where a ticker trades.
 *
 * A bare ticker with no suffix is US-listed — that is the convention Yahoo
 * uses, not an assumption about the company. Anything with a suffix this
 * table does not know is reported unknown rather than folded into the US,
 * which would quietly inflate the single figure most people read.
 */
export function venueOf(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  if (!s) return { country: null, region: null, known: false, reason: 'no symbol' };

  // Indices, FX, futures, rates and crypto do not have a listing venue in the
  // sense this engine means, and treating them as equities would put gold or
  // sterling into a country bucket.
  const type = classify(s).type;
  if (['index', 'fx', 'future', 'yield', 'crypto'].includes(type)) {
    return { country: null, region: null, known: false, reason: `${type} has no equity listing venue` };
  }

  const dot = s.lastIndexOf('.');
  if (dot === -1) {
    // Yahoo's OEIC/unit-trust identifiers carry no venue at all.
    if (/^0P[0-9A-Z]{8}/.test(s)) {
      return { country: null, region: null, known: false, reason: 'fund identifier carries no listing venue' };
    }
    return { ...US_VENUE, known: true, source: 'no suffix (US listing)' };
  }

  const suffix = s.slice(dot + 1);
  const venue = VENUES[suffix];
  if (!venue) {
    return { country: null, region: null, known: false, reason: `unrecognised listing suffix .${suffix}` };
  }
  return { ...venue, known: true, source: `listing suffix .${suffix}` };
}

/**
 * Decompose one position into venues.
 *
 * Returns the fraction of this position attributable to each region, plus the
 * fraction that could not be attributed at all. The three cases, in order of
 * how much they can be trusted:
 *
 *   1. A fund that publishes holdings — decomposed by those holdings' venues,
 *      covering only as much of the fund as the published list actually spans.
 *      A top-ten list is routinely 20-40% of a tracker, and the rest is
 *      genuinely unseen rather than assumed to look like the top ten.
 *   2. A single equity — its own listing is the answer. No decomposition is
 *      needed and none is invented.
 *   3. Anything else — unseen, and named as such.
 */
export function decomposePosition(position, composition) {
  const byRegion = {};
  const byCountry = {};
  let covered = 0;

  const holdings = composition?.holdings ?? [];
  const publishedWeight = holdings.reduce((a, h) => a + (h.weight ?? 0), 0);

  if (publishedWeight > 0) {
    for (const h of holdings) {
      const w = h.weight ?? 0;
      if (w <= 0) continue;
      const v = venueOf(h.symbol);
      if (!v.known) continue;                 // an unclassifiable underlying is unseen, not reassigned
      byRegion[v.region] = (byRegion[v.region] ?? 0) + w;
      byCountry[v.country] = (byCountry[v.country] ?? 0) + w;
      covered += w;
    }
    return {
      basis: 'published holdings',
      covered,                                 // fraction of the POSITION, not of the published list
      byRegion, byCountry,
      publishedWeight,
      note: covered > 0
        ? `Published holdings cover ${(publishedWeight * 100).toFixed(0)}% of this fund; `
          + `${(covered * 100).toFixed(0)}% could be placed to a listing venue.`
        : 'Holdings are published but none could be placed to a listing venue.',
    };
  }

  // Placing a whole position at its own listing requires POSITIVE evidence
  // that it is a single company. Absence of a stored composition is not that
  // evidence: classify() returns 'unknown' for any ticker outside the
  // configured universe, so treating unknown as a single equity would place a
  // London-listed world tracker entirely in the UK the moment its composition
  // had not been synced — a confidently wrong reading, and a worse one than
  // the hardcoded table this engine replaces.
  if (isSingleCompany(position)) {
    const v = venueOf(position.symbol);
    if (v.known) {
      return {
        basis: 'own listing',
        covered: 1,
        byRegion: { [v.region]: 1 },
        byCountry: { [v.country]: 1 },
        note: `Single instrument listed in ${v.country} (${v.source}).`,
      };
    }
  }

  return {
    basis: 'none',
    covered: 0,
    byRegion: {}, byCountry: {},
    note: composition
      ? 'Composition is stored but publishes no holdings to look through.'
      : 'No stored composition, and nothing establishes this as a single company — '
        + 'sync compositions to look through it.',
  };
}

/**
 * Whether this position is a single company rather than a fund.
 *
 * Both signals are positive statements from somewhere: the instrument
 * classifier having actually resolved it to an equity, or the asset class the
 * user recorded against the holding. A ticker the classifier could not place
 * is not counted, because "I do not recognise this" is not "this is a stock".
 */
function isSingleCompany(position) {
  if (classify(position.symbol).type === 'equity') return true;
  const cls = String(position.assetClass ?? '').trim().toLowerCase();
  return cls === 'equity' || cls === 'stock' || cls === 'share' || cls === 'shares';
}

/**
 * Portfolio-wide look-through by listing venue.
 *
 * Percentages are expressed over the portion that could actually be seen
 * through, and the unseen remainder is stated separately. Expressing them over
 * the whole portfolio would understate every region by the size of the opaque
 * part without ever saying so — the reader would read 40% US and not know it
 * was 40% of the 55% anybody can see.
 */
export function lookThrough(positions, compositions = {}) {
  const regionValue = {};
  const countryValue = {};
  let seen = 0, unseen = 0, total = 0;
  const opaque = [];
  const detail = [];

  for (const p of positions) {
    const value = p.value ?? 0;
    if (value <= 0) continue;
    total += value;

    const d = decomposePosition(p, compositions[p.symbol]);
    const seenValue = value * d.covered;
    const unseenValue = value - seenValue;

    for (const [region, w] of Object.entries(d.byRegion)) {
      regionValue[region] = (regionValue[region] ?? 0) + value * w;
    }
    for (const [country, w] of Object.entries(d.byCountry)) {
      countryValue[country] = (countryValue[country] ?? 0) + value * w;
    }

    seen += seenValue;
    unseen += unseenValue;
    if (unseenValue > 0) opaque.push({ symbol: p.symbol, value: +unseenValue.toFixed(2), reason: d.note });

    detail.push({
      symbol: p.symbol, value: +value.toFixed(2),
      basis: d.basis, coveredPct: +(d.covered * 100).toFixed(1),
      regions: Object.fromEntries(Object.entries(d.byRegion).map(([k, v]) => [k, +(v * 100).toFixed(1)])),
      note: d.note,
    });
  }

  const asRows = (obj, denom) => Object.entries(obj)
    .map(([label, value]) => ({
      label, value: +value.toFixed(2),
      pctOfSeen: denom ? +(value / denom * 100).toFixed(2) : 0,
      pctOfPortfolio: total ? +(value / total * 100).toFixed(2) : 0,
    }))
    .sort((a, b) => b.value - a.value);

  const coveragePct = total ? +(seen / total * 100).toFixed(1) : 0;

  return {
    available: seen > 0,
    reason: seen > 0 ? null
      : 'Nothing in the portfolio could be looked through: no stored fund compositions, and no holding '
        + 'is a single listed equity. Sync compositions from the Rebuild page to populate this.',
    regions: asRows(regionValue, seen),
    countries: asRows(countryValue, seen).slice(0, 20),
    seen: +seen.toFixed(2),
    unseen: +unseen.toFixed(2),
    total: +total.toFixed(2),
    coveragePct,
    opaque,
    detail,
    // Both caveats travel with the number, because both change what it means.
    basis: 'Listing venue of the underlying holdings, from stored fund compositions where published '
      + 'and the instrument\'s own listing where it is a single equity.',
    caveat: 'Listing venue is where an instrument trades, not where its revenue comes from. A '
      + 'London-listed miner earning in Chile counts as UK here.',
    coverageNote: coveragePct < 100
      ? `${(100 - coveragePct).toFixed(1)}% of the portfolio could not be looked through and is excluded `
        + 'from these percentages rather than assigned a region.'
      : null,
  };
}

/**
 * Exposure to one region, as a single figure.
 *
 * This is what replaced the hardcoded `lookThroughUS`. It is unavailable
 * rather than zero when nothing can be seen through, because "we cannot tell"
 * and "you have none" are different findings and the old code reported the
 * second when it meant the first.
 */
export function regionExposure(positions, compositions = {}, region = 'North America') {
  const lt = lookThrough(positions, compositions);
  if (!lt.available) {
    return { available: false, region, reason: lt.reason, coveragePct: lt.coveragePct };
  }
  const row = lt.regions.find(r => r.label === region);
  return {
    available: true,
    region,
    // Of what can be seen — the honest denominator, since the rest is unknown
    // rather than known to be elsewhere.
    pctOfSeen: row?.pctOfSeen ?? 0,
    pctOfPortfolio: row?.pctOfPortfolio ?? 0,
    coveragePct: lt.coveragePct,
    basis: lt.basis,
    caveat: lt.caveat,
    coverageNote: lt.coverageNote,
  };
}
