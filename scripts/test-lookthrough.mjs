// Meridian — look-through exposure assertions
//
// Run:
//   MERIDIAN_DB=/tmp/lt.db SEED_ONLY=1 node scripts/test-rebuild.mjs
//   MERIDIAN_DB=/tmp/lt.db node scripts/test-lookthrough.mjs
//
// This engine exists because the figure it replaces was invented. The Risk
// page reported look-through US exposure from a hardcoded table of nineteen
// tickers, and for anything outside that list it read the geography label as a
// string and credited "Global" with 0.65. Rendered to one decimal place, it
// was indistinguishable from a measurement.
//
// So the assertions here are mostly about honesty rather than arithmetic:
// a fund decomposes to what its published holdings actually say, a fund that
// publishes nothing is reported as unseen rather than assigned a region, and
// percentages are expressed over the part that could be seen rather than
// silently over the whole book.

import { all, run } from '../server/db.js';
import * as lt from '../server/engines/lookthrough.js';
import * as pf from '../server/engines/portfolio.js';
import { getBars } from '../server/db.js';

const DB = process.env.MERIDIAN_DB;
if (!DB) { console.error('Set MERIDIAN_DB to a throwaway path before running this.'); process.exit(1); }
if (DB.includes('meridian.db')) {
  console.error('Refusing to run against the real database. Point MERIDIAN_DB somewhere disposable.');
  process.exit(1);
}

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, tol = 0.5) => a != null && Math.abs(a - b) <= tol;
function section(name) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); }

// ─── Venue classification ─────────────────────────────────────

section('Where a ticker trades');
check('a bare ticker is a US listing', lt.venueOf('AAPL').country === 'United States');
check('a .L suffix is London', lt.venueOf('SHEL.L').country === 'United Kingdom');
check('a .DE suffix is Germany', lt.venueOf('SAP.DE').region === 'Europe');
check('a .T suffix is Japan', lt.venueOf('7203.T').region === 'Asia-Pacific');
check('a .TO suffix is Canada, which is North America not the US',
  lt.venueOf('SHOP.TO').country === 'Canada' && lt.venueOf('SHOP.TO').region === 'North America');
check('an unrecognised suffix is unknown, not quietly US',
  lt.venueOf('THING.ZZZ').known === false, JSON.stringify(lt.venueOf('THING.ZZZ')));
check('and says which suffix it did not recognise',
  lt.venueOf('THING.ZZZ').reason.includes('.ZZZ'));

check('an index has no listing venue', lt.venueOf('^FTSE').known === false);
check('a currency pair has no listing venue', lt.venueOf('GBPUSD=X').known === false);
check('a future has no listing venue', lt.venueOf('GC=F').known === false);
check('a Yahoo fund identifier has no listing venue',
  lt.venueOf('0P0000ABCD').known === false, JSON.stringify(lt.venueOf('0P0000ABCD')));
check('every unknown venue explains itself',
  ['^FTSE', 'GBPUSD=X', 'GC=F', 'THING.ZZZ'].every(s => !!lt.venueOf(s).reason));

// ─── Decomposition against known compositions ─────────────────

section('Decomposing a fund by its published holdings');
// Half US-listed, half London-listed, publishing 80% of itself.
const halfAndHalf = {
  holdings: [
    { symbol: 'AAPL', weight: 0.20 }, { symbol: 'MSFT', weight: 0.20 },
    { symbol: 'SHEL.L', weight: 0.20 }, { symbol: 'AZN.L', weight: 0.20 },
  ],
};
let d = lt.decomposePosition({ symbol: 'MIX.L', value: 1000 }, halfAndHalf);
check('coverage equals the published weight, not 100%', near(d.covered * 100, 80, 0.01), `${d.covered}`);
check('North America gets half of what was published', near(d.byRegion['North America'] * 100, 40, 0.01));
check('the UK gets the other half', near(d.byRegion.UK * 100, 40, 0.01));
check('the note states how much of the fund was published',
  d.note.includes('80%'), d.note);
check('basis is recorded as published holdings', d.basis === 'published holdings');

// An underlying that cannot be placed must not be reassigned to the others.
const withUnknown = {
  holdings: [
    { symbol: 'AAPL', weight: 0.50 },
    { symbol: 'MYSTERY.ZZZ', weight: 0.40 },
  ],
};
d = lt.decomposePosition({ symbol: 'PART.L', value: 1000 }, withUnknown);
check('an unplaceable underlying reduces coverage rather than being reassigned',
  near(d.covered * 100, 50, 0.01), `covered ${d.covered}`);
check('and the placeable part keeps its own weight, not a scaled-up one',
  near(d.byRegion['North America'] * 100, 50, 0.01), JSON.stringify(d.byRegion));

section('Instruments that are not funds');
d = lt.decomposePosition({ symbol: 'SHEL.L', value: 1000, assetClass: 'Equity' }, null);
check('a single listed equity is placed by its own listing', d.covered === 1);
check('to the right country', d.byCountry['United Kingdom'] === 1);
check('with basis recorded as its own listing', d.basis === 'own listing');

d = lt.decomposePosition({ symbol: 'WEIRD.ZZZ', value: 1000, assetClass: 'Equity' }, null);
check('an unplaceable instrument is not placed at all', d.covered === 0);
check('and says why', d.note.length > 10, d.note);

d = lt.decomposePosition({ symbol: 'OPAQUE.L', value: 1000 }, { holdings: [] });
check('a fund storing a composition with no holdings is unseen, not empty-but-covered',
  d.covered === 0, JSON.stringify(d));
check('and distinguishes that from having no composition at all',
  d.note.includes('publishes no holdings'), d.note);

// ─── Portfolio-wide ───────────────────────────────────────────

section('Across a portfolio');
const positions = [
  { symbol: 'MIX.L', value: 1000 },                             // 80% published, half US half UK
  { symbol: 'SHEL.L', value: 1000, assetClass: 'Equity' },      // single equity, all UK
  { symbol: 'DARK.L', value: 1000, assetClass: 'ETF' },         // a fund nobody has synced
];
const comps = { 'MIX.L': halfAndHalf };
const port = lt.lookThrough(positions, comps);

check('the portfolio look-through is available', port.available === true);
// Seen = 800 (from MIX.L) + 1000 (SHEL.L) = 1800 of 3000.
check('coverage is the share of value actually seen through',
  near(port.coveragePct, 60, 0.1), `${port.coveragePct}%`);
check('the unseen remainder is reported', near(port.unseen, 1200, 0.01), `${port.unseen}`);
check('the opaque holding is named', port.opaque.some(o => o.symbol === 'DARK.L'));
check('percentages are expressed over what was seen, not the whole book',
  near(port.regions.find(r => r.label === 'UK').pctOfSeen, (400 + 1000) / 1800 * 100, 0.1),
  JSON.stringify(port.regions));
check('and the share of the whole portfolio is given separately',
  near(port.regions.find(r => r.label === 'UK').pctOfPortfolio, (400 + 1000) / 3000 * 100, 0.1));
check('the two denominators genuinely differ, so the distinction matters',
  port.regions[0].pctOfSeen !== port.regions[0].pctOfPortfolio);
check('countries are broken out as well as regions',
  port.countries.some(c => c.label === 'United Kingdom'));
check('the coverage gap is stated in words', !!port.coverageNote && port.coverageNote.includes('excluded'));
check('the listing-venue caveat travels with the figure',
  port.caveat.includes('not where its revenue comes from'));
check('per-holding detail explains each basis',
  port.detail.length === 3 && port.detail.every(x => !!x.note && !!x.basis));

section('Nothing to see through');
const blind = lt.lookThrough([{ symbol: 'DARK.L', value: 1000 }], {});
check('a portfolio with nothing decomposable is unavailable, not zero',
  blind.available === false, JSON.stringify(blind.regions));
check('and says what would fix it', blind.reason.includes('Sync compositions'), blind.reason);

// ─── The replaced figure ──────────────────────────────────────

section('The figure that used to be hardcoded');
const exposure = lt.regionExposure(positions, comps, 'North America');
check('region exposure is available when something can be seen', exposure.available === true);
check('North America is the placed US portion of what was seen',
  near(exposure.pctOfSeen, 400 / 1800 * 100, 0.1), `${exposure.pctOfSeen}`);
check('coverage travels with it so the reader knows the denominator',
  near(exposure.coveragePct, 60, 0.1));

const blindExposure = lt.regionExposure([{ symbol: 'DARK.L', value: 1000 }], {}, 'North America');
check('it is unavailable rather than 0% when nothing can be seen',
  blindExposure.available === false, JSON.stringify(blindExposure));
check('which is the whole point: "cannot tell" is not "you have none"',
  blindExposure.pctOfSeen === undefined);

// A region nobody holds is genuinely zero, which is different again.
const noAsia = lt.regionExposure(positions, comps, 'Asia-Pacific');
check('a region that is genuinely absent reads zero, not unavailable',
  noAsia.available === true && noAsia.pctOfSeen === 0, JSON.stringify(noAsia));

section('No hardcoded ticker table survives');
const src = await import('fs').then(fs => fs.readFileSync('server/engines/portfolio.js', 'utf8'));
check('the US_LOOKTHROUGH table is gone from portfolio.js', !src.includes('US_LOOKTHROUGH'));
// Checked as code rather than as a bare number: the comment explaining what
// was removed legitimately still mentions 0.65, and a grep for the digits
// would fail on the documentation of the very fix it is verifying.
const code = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('the geography-string fallback that invented a factor is gone from the code',
  !/toLowerCase\(\)\.includes\(['"]global['"]\)/.test(code) && !/0\.65/.test(code));
check('concentration now carries the look-through block',
  src.includes('lookThrough: northAmerica'));

// ─── Against the real synthetic portfolio ─────────────────────

section('Through valuePortfolio');
const prices = {};
for (const { symbol } of all('SELECT DISTINCT symbol FROM holdings')) {
  const bars = getBars(symbol);
  const last = bars[bars.length - 1];
  if (last) prices[symbol] = { price: last.adj_close ?? last.close, currency: 'GBP', changePct: 0 };
}
const valued = pf.valuePortfolio(prices);
const conc = valued.exposure?.concentration ?? valued.concentration ?? null;
check('valuePortfolio still produces concentration metrics', !!conc, Object.keys(valued).join(','));
if (conc) {
  check('and it no longer throws on the seeded world', typeof conc.herfindahl === 'number');
  check('lookThroughUS is either a real number or null, never invented',
    conc.lookThroughUS === null || typeof conc.lookThroughUS === 'number',
    String(conc.lookThroughUS));
  check('the look-through block explains itself either way',
    !!conc.lookThrough && (conc.lookThrough.available ? !!conc.lookThrough.basis : !!conc.lookThrough.reason),
    JSON.stringify(conc.lookThrough));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
