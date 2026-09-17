// Meridian — portfolio X-ray assertions
//
// Run:
//   MERIDIAN_DB=/tmp/xray.db node scripts/test-xray.mjs
//
// The world here is built so every answer can be worked out on paper before
// the engine runs. Four positions, three of them funds whose disclosed
// holdings are chosen to overlap in a known pattern:
//
//   FUND_A.L  40% of book   AAPL 10%, MSFT 8%, NVDA 6%     (24% disclosed)
//   FUND_B.L  30% of book   AAPL 12%, NVDA 5%, TSLA 4%     (21% disclosed)
//   FUND_C.L  20% of book   SHEL 15%, BP 10%               (25% disclosed)
//   AAPL      10% of book   held directly                 (100%, and exact)
//
// So Apple is 0.40x0.10 + 0.30x0.12 + 0.10x1.00 = 17.6% of the book, reached
// three different ways, and no fund-level view in the app can see that.
//
// The assertion this file exists to protect is the one about scaling. Only
// 30.9% of this book's contents are disclosed. It would be trivial, and it
// would make every chart look complete, to divide through by 0.309 so the
// underlying weights sum to 100%. That asserts the undisclosed 69% is
// distributed like the disclosed 31%, which is false for any fund with a long
// tail. The test below pins the sum to 0.309 precisely so that change cannot
// be made quietly.

import { db } from '../server/db.js';
import { saveComposition } from '../server/engines/rebuild/exposure.js';
import * as X from '../server/engines/xray.js';

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
const near = (a, b, tol = 1e-6) => a != null && isFinite(a) && Math.abs(a - b) <= tol;
function section(name) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); }

db.exec('DELETE FROM instrument_composition;');

// ─── The world ────────────────────────────────────────────────

saveComposition({
  symbol: 'FUND_A.L', name: 'Fund A Global', category: 'ETF', expenseRatio: 0.07,
  holdings: [
    { symbol: 'AAPL', name: 'Apple Inc', weight: 0.10 },
    { symbol: 'MSFT', name: 'Microsoft Corporation', weight: 0.08 },
    { symbol: 'NVDA', name: 'NVIDIA Corp', weight: 0.06 },
  ],
  sectors: { technology: 0.60, healthcare: 0.25, energy: 0.15 },
  asOf: '2026-09-01',
});

saveComposition({
  symbol: 'FUND_B.L', name: 'Fund B World', category: 'Fund', expenseRatio: 0.22,
  holdings: [
    { symbol: 'AAPL', name: 'APPLE INC.', weight: 0.12 },
    { symbol: 'NVDA', name: 'Nvidia Corporation', weight: 0.05 },
    { symbol: 'TSLA', name: 'Tesla Inc', weight: 0.04 },
  ],
  sectors: { technology: 0.80, consumer: 0.20 },
  asOf: '2026-09-01',
});

saveComposition({
  symbol: 'FUND_C.L', name: 'Fund C Energy', category: 'ETF', expenseRatio: 0.15,
  holdings: [
    { symbol: 'SHEL', name: 'Shell PLC', weight: 0.15 },
    { symbol: 'BP', name: 'BP p.l.c.', weight: 0.10 },
  ],
  sectors: { energy: 1.0 },
  asOf: '2026-09-01',
});

// Publishes a composition row but no holdings and no sectors — a distinct
// case from having no row at all.
saveComposition({
  symbol: 'EMPTY.L', name: 'Empty Fund', category: 'Fund',
  expenseRatio: 0.3, holdings: [], sectors: {}, asOf: '2026-09-01',
});

const BOOK = [
  { symbol: 'FUND_A.L', name: 'Fund A Global', value: 40_000 },
  { symbol: 'FUND_B.L', name: 'Fund B World', value: 30_000 },
  { symbol: 'FUND_C.L', name: 'Fund C Energy', value: 20_000 },
  { symbol: 'AAPL', name: 'Apple Inc', value: 10_000, assetClass: 'Equity' },
];

// ─── 1. Arithmetic worked out on paper ────────────────────────

section('Underlying weights against numbers computed by hand');

const exp = X.underlyingExposure(BOOK);
const byName = Object.fromEntries(exp.underlyings.map(u => [u.symbol ?? u.name, u]));

check('Apple is 17.6% of the book, from three different places',
  near(byName['AAPL']?.weight, 0.176, 1e-6) && byName['AAPL']?.viaCount === 3,
  JSON.stringify(byName['AAPL']));

check('Nvidia is 3.9%, from two funds',
  near(byName['NVDA']?.weight, 0.039, 1e-6) && byName['NVDA']?.viaCount === 2,
  String(byName['NVDA']?.weight));

check('Microsoft is 3.2%, from one fund',
  near(byName['MSFT']?.weight, 0.032, 1e-6) && byName['MSFT']?.viaCount === 1);

check('Tesla is 1.2%', near(byName['TSLA']?.weight, 0.012, 1e-6));
check('Shell is 3.0%', near(byName['SHEL']?.weight, 0.030, 1e-6));
check('BP is 2.0%', near(byName['BP']?.weight, 0.020, 1e-6));

check('six distinct companies are found', exp.distinctNames === 6,
  JSON.stringify(exp.underlyings.map(u => u.symbol)));

check('the list is ordered by weight, largest first',
  exp.underlyings.every((u, i) => i === 0 || exp.underlyings[i - 1].weight >= u.weight));

check('Apple names all three routes, biggest first',
  byName['AAPL'].via[0].symbol === 'AAPL'
  && byName['AAPL'].via.map(v => v.symbol).sort().join() === 'AAPL,FUND_A.L,FUND_B.L',
  JSON.stringify(byName['AAPL'].via));

check('each route carries what it actually contributed',
  near(byName['AAPL'].via.find(v => v.symbol === 'FUND_B.L').contribution, 0.036, 1e-6),
  JSON.stringify(byName['AAPL'].via));

// ─── 2. The scaling assertion ─────────────────────────────────

section('Partial disclosure stays partial');

// 0.40*0.24 + 0.30*0.21 + 0.20*0.25 + 0.10*1.00 = 0.309
check('seen weight is exactly the disclosed share of the book',
  near(exp.seenWeight, 0.309, 1e-4), String(exp.seenWeight));

check('unseen weight is the rest, and is reported',
  near(exp.unseenWeight, 0.691, 1e-4), String(exp.unseenWeight));

check('seen and unseen account for the whole book',
  near(exp.seenWeight + exp.unseenWeight, 1, 1e-4));

const sumUnderlying = exp.underlyings.reduce((s, u) => s + u.weight, 0);
check('the underlying weights sum to what was disclosed, NOT to 100%',
  near(sumUnderlying, 0.309, 1e-4), `sum ${sumUnderlying.toFixed(4)}`);

check('and that sum is well short of 1 — nothing was scaled up to fill the gap',
  sumUnderlying < 0.35,
  `sum ${sumUnderlying.toFixed(4)} — if this is ~1.0 someone normalised the partial disclosure`);

check('no single underlying exceeds the position weight that carries it',
  exp.underlyings.every(u => u.weight <= 1));

// ─── 3. Identity matching ─────────────────────────────────────

section('Knowing when two entries are the same company');

check('the same ticker in two funds merges into one name',
  byName['AAPL'].viaCount === 3);

check('differing name spellings do not create duplicates',
  // "Apple Inc" / "APPLE INC." / "Apple Inc" all resolve to one entry.
  exp.underlyings.filter(u => (u.symbol ?? '').toUpperCase() === 'AAPL').length === 1);

check('a listing suffix is stripped before matching', (() => {
  // The same company reached as SHEL through one fund and SHEL.L through
  // another must not read as two separate moderate positions.
  saveComposition({
    symbol: 'FUND_D.L', name: 'Fund D', category: 'ETF',
    holdings: [{ symbol: 'SHEL.L', name: 'Shell PLC', weight: 0.20 }],
    sectors: { energy: 1 }, asOf: '2026-09-01',
  });
  const e = X.underlyingExposure([
    { symbol: 'FUND_C.L', value: 50_000 },
    { symbol: 'FUND_D.L', value: 50_000 },
  ]);
  const shell = e.underlyings.filter(u => String(u.symbol ?? '').toUpperCase().startsWith('SHEL'));
  return shell.length === 1 && shell[0].viaCount === 2;
})(), JSON.stringify(X.underlyingExposure([
  { symbol: 'FUND_C.L', value: 50_000 }, { symbol: 'FUND_D.L', value: 50_000 },
]).underlyings.map(u => [u.symbol, u.viaCount])));

check('holdings with no ticker match on normalised name', (() => {
  saveComposition({
    symbol: 'FUND_E.L', name: 'Fund E', category: 'Fund',
    holdings: [{ symbol: null, name: 'Microsoft Corp', weight: 0.10 }],
    sectors: {}, asOf: '2026-09-01',
  });
  saveComposition({
    symbol: 'FUND_F.L', name: 'Fund F', category: 'Fund',
    holdings: [{ symbol: null, name: 'MICROSOFT CORPORATION', weight: 0.10 }],
    sectors: {}, asOf: '2026-09-01',
  });
  const e = X.underlyingExposure([
    { symbol: 'FUND_E.L', value: 50_000 }, { symbol: 'FUND_F.L', value: 50_000 },
  ]);
  return e.underlyings.length === 1 && e.underlyings[0].viaCount === 2;
})());

check('the display name prefers the fuller spelling over a bare ticker',
  typeof byName['AAPL'].name === 'string' && byName['AAPL'].name.length > 4,
  byName['AAPL'].name);

check('and prefers a readable spelling over a shouted disclosure-file one',
  // Three funds spell this company "Apple Inc", "APPLE INC." and "Apple Inc".
  // Longest-wins would pick the shouted version because of its trailing dot.
  byName['AAPL'].name === 'Apple Inc', byName['AAPL'].name);

check('but still takes the longer name when both are equally readable', (() => {
  saveComposition({
    symbol: 'FUND_G.L', name: 'Fund G', category: 'Fund',
    holdings: [{ symbol: 'BRK', name: 'Berkshire', weight: 0.1 }],
    sectors: {}, asOf: '2026-09-01',
  });
  saveComposition({
    symbol: 'FUND_H.L', name: 'Fund H', category: 'Fund',
    holdings: [{ symbol: 'BRK', name: 'Berkshire Hathaway Inc', weight: 0.1 }],
    sectors: {}, asOf: '2026-09-01',
  });
  const e = X.underlyingExposure([
    { symbol: 'FUND_G.L', value: 50 }, { symbol: 'FUND_H.L', value: 50 },
  ]);
  return e.underlyings[0].name === 'Berkshire Hathaway Inc';
})());

// ─── 4. Exact versus floor ────────────────────────────────────

section('Which figures are exact and which are floors');

check('a directly held company is marked exact', (() => {
  const e = X.underlyingExposure([{ symbol: 'AAPL', name: 'Apple Inc', value: 1000, assetClass: 'Equity' }]);
  return e.underlyings[0].exact === true && near(e.underlyings[0].weight, 1, 1e-9);
})());

check('a company reached through a fund is not exact',
  byName['NVDA'].exact === false);

check('one fund leg is enough to make a mixed figure a floor',
  byName['AAPL'].exact === false,
  'Apple is held directly AND through two funds, so the total is a floor');

check('a directly held position is 100% seen',
  exp.positions.find(p => p.symbol === 'AAPL').disclosedShare === 1);

check('and says its figure is exact',
  /exact/i.test(exp.positions.find(p => p.symbol === 'AAPL').note));

// ─── 5. Multi-position names ──────────────────────────────────

section('The finding a fund-level view cannot produce');

const overlaps = X.multiFundNames(exp);
check('only companies reached more than once are listed',
  overlaps.every(o => o.viaCount > 1));

check('Apple and Nvidia are both caught',
  overlaps.map(o => o.symbol).sort().join() === 'AAPL,NVDA',
  JSON.stringify(overlaps.map(o => o.symbol)));

check('ranked by weight, so the biggest duplication is first',
  overlaps[0].symbol === 'AAPL');

check('each one says how concentrated it is in its largest route',
  near(overlaps.find(o => o.symbol === 'AAPL').concentratedIn, 0.10 / 0.176, 1e-4),
  String(overlaps.find(o => o.symbol === 'AAPL').concentratedIn));

check('a name held through only one position is excluded',
  !overlaps.some(o => o.symbol === 'MSFT'));

// ─── 6. Concentration at the right level ──────────────────────

section('Concentration measured on companies, not tickers');

const conc = X.concentration(exp, { top: 3 });
check('the top three are Apple, Nvidia, Microsoft',
  conc.top.map(t => t.symbol).join() === 'AAPL,NVDA,MSFT',
  JSON.stringify(conc.top.map(t => t.symbol)));

check('their combined weight is the sum of the three',
  near(conc.topWeight, 0.176 + 0.039 + 0.032, 1e-6), String(conc.topWeight));

check('the largest single company is named with its route count',
  conc.largestName.symbol === 'AAPL' && conc.largestName.viaCount === 3);

check('the same measure on positions is reported for contrast',
  near(conc.topPositionsWeight, 0.9, 1e-6), String(conc.topPositionsWeight));

check('the gap between the two is visible — 4 positions but 6 companies',
  conc.positionCount === 4 && conc.distinctNames === 6);

check('effective names is computed over the disclosed part and says so',
  conc.effectiveNames > 1 && /disclosed/i.test(conc.basis), conc.basis);

check('concentration refuses rather than returning zeros with nothing to see', (() => {
  const empty = X.concentration({ underlyings: [], positions: [], seenWeight: 0 });
  return empty.available === false;
})());

// ─── 7. Sectors ───────────────────────────────────────────────

section('Sector exposure blended across funds');

const sec = X.sectorExposure(BOOK);
const secBy = Object.fromEntries(sec.sectors.map(s => [s.sector, s]));

// technology: 0.40*0.60 + 0.30*0.80 = 0.24 + 0.24 = 0.48
check('technology is 48% of the book',
  near(secBy['technology']?.weightOfBook, 0.48, 1e-6), String(secBy['technology']?.weightOfBook));

// energy: 0.40*0.15 + 0.20*1.00 = 0.06 + 0.20 = 0.26
check('energy is 26%', near(secBy['energy']?.weightOfBook, 0.26, 1e-6), String(secBy['energy']?.weightOfBook));

check('a directly held company contributes its own recorded sector', (() => {
  const s = X.sectorExposure([
    { symbol: 'AAPL', value: 100, assetClass: 'Equity', sector: 'Technology' },
  ]);
  return s.sectors[0].sector === 'Technology' && near(s.covered, 1, 1e-9);
})());

check('sector coverage is reported separately from name coverage',
  sec.covered > exp.seenWeight,
  `sectors cover ${sec.covered} vs names ${exp.seenWeight} — funds publish a full sector split even when the holdings list is truncated`);

check('both denominators are given, and labelled differently',
  secBy['technology'].weightOfBook != null && secBy['technology'].weightOfCovered != null
  && secBy['technology'].weightOfBook !== secBy['technology'].weightOfCovered);

check('weights over the covered part sum to 1',
  near(sec.sectors.reduce((s, x) => s + x.weightOfCovered, 0), 1, 1e-3),
  String(sec.sectors.reduce((s, x) => s + x.weightOfCovered, 0)));

check('a holding publishing no sector is named, not averaged away', (() => {
  const s = X.sectorExposure([
    { symbol: 'FUND_C.L', value: 50_000 },
    { symbol: 'EMPTY.L', name: 'Empty Fund', value: 50_000 },
  ]);
  return s.positionsWithoutSectors.some(p => p.symbol === 'EMPTY.L') && near(s.covered, 0.5, 1e-6);
})());

check('with no priced holdings it refuses rather than weighting by nothing',
  X.sectorExposure([{ symbol: 'FUND_A.L' }]).available === false);

// ─── 8. What could not be seen ────────────────────────────────

section('Naming what is missing');

{
  const withUnseen = [...BOOK, { symbol: 'MYSTERY.L', name: 'Mystery Fund', value: 25_000 }];
  const r = X.xray(withUnseen);

  check('a holding with no composition is reported as unseen',
    r.unseenPositions.some(p => p.symbol === 'MYSTERY.L'),
    JSON.stringify(r.unseenPositions.map(p => p.symbol)));

  check('and is not silently dropped from the coverage count',
    r.coverage.positionsTotal === 5 && r.coverage.positionsUnseen === 1);

  check('its weight lands in unseen, not in seen',
    r.coverage.unseen > 0.69);

  check('a fund storing an empty holdings list is unseen too, and says which case it is', (() => {
    const e = X.xray([{ symbol: 'EMPTY.L', name: 'Empty Fund', value: 100 }]);
    const p = e.positions[0];
    return p.basis === 'unseen' && /publishes no holdings/i.test(p.note);
  })());

  check('a fund with no stored row at all reports the other case', (() => {
    const e = X.xray([{ symbol: 'NOTHING.L', name: 'Nothing', value: 100 }]);
    return /no stored composition/i.test(e.positions[0].note);
  })());

  check('an unpriced book still resolves contents but flags weights unavailable', (() => {
    const e = X.xray([{ symbol: 'FUND_A.L' }, { symbol: 'FUND_B.L' }]);
    return e.available === true && e.weightsAvailable === false;
  })());
}

check('a thinly-disclosing fund is flagged', (() => {
  saveComposition({
    symbol: 'THIN.L', name: 'Thin Fund', category: 'ETF',
    holdings: [{ symbol: 'AAPL', name: 'Apple Inc', weight: 0.05 }],
    sectors: {}, asOf: '2026-09-01',
  });
  const r = X.xray([{ symbol: 'THIN.L', name: 'Thin Fund', value: 100 }]);
  return r.positions[0].thin === true && r.coverage.thinlyDisclosed === 1;
})());

check('a well-disclosing fund is not flagged thin',
  X.xray(BOOK).positions.find(p => p.symbol === 'FUND_C.L').thin === false);

// ─── 9. The assembled report ──────────────────────────────────

section('The whole X-ray');

{
  const r = X.xray(BOOK, { top: 5 });
  check('the report is available', r.available === true);
  check('it carries the underlying list', r.underlyings.length === 6);
  check('it carries overlaps', r.overlaps.length === 2);
  check('it carries concentration', r.concentration.available === true);
  check('it carries sectors', r.sectors.available === true);
  check('it carries per-position resolution', r.positions.length === 4);

  check('the headline names the largest real exposure',
    Array.isArray(r.headline) && r.headline.some(h => h.includes('Apple')),
    JSON.stringify(r.headline));

  check('the headline mentions the multi-route holdings',
    r.headline.some(h => /more than one position/.test(h)), JSON.stringify(r.headline));

  check('the headline warns how much of the book is invisible',
    r.headline.some(h => /publishes nothing/.test(h)), JSON.stringify(r.headline));

  check('the basis states that every weight is a floor',
    /floor/i.test(r.basis) && /never scaled up/i.test(r.basis), r.basis);

  check('an empty portfolio is refused with a reason',
    X.xray([]).available === false);

  check('positions without a symbol are ignored rather than crashing',
    X.xray([{ value: 1 }, { symbol: 'FUND_A.L', value: 100 }]).available === true);

  check('the report is timestamped', typeof r.generatedAt === 'string');

  check('a section failing does not take the report down', (() => {
    // A composition row with malformed holdings must not throw the whole X-ray.
    saveComposition({
      symbol: 'BAD.L', name: 'Bad', category: 'Fund',
      holdings: [{ symbol: 'X', name: 'X', weight: NaN }, { symbol: null, name: null, weight: 0.5 }],
      sectors: {}, asOf: '2026-09-01',
    });
    const bad = X.xray([{ symbol: 'BAD.L', name: 'Bad', value: 100 }]);
    return bad.available === true;
  })());

  check('a malformed weight is dropped rather than poisoning the totals', (() => {
    const bad = X.xray([{ symbol: 'BAD.L', name: 'Bad', value: 100 }]);
    return bad.underlyings.every(u => isFinite(u.weight));
  })());

  check('a composition claiming more than 100% cannot report more than the position', (() => {
    saveComposition({
      symbol: 'OVER.L', name: 'Over', category: 'Fund',
      holdings: [{ symbol: 'AAPL', name: 'Apple', weight: 0.8 }, { symbol: 'MSFT', name: 'Microsoft', weight: 0.7 }],
      sectors: {}, asOf: '2026-09-01',
    });
    const over = X.xray([{ symbol: 'OVER.L', name: 'Over', value: 100 }]);
    return over.coverage.seen <= 1 && over.coverage.unseen >= 0;
  })());
}

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n${'='.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`${'='.repeat(52)}\n`);
process.exit(failed ? 1 : 0);
