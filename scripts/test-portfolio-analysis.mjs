// Meridian — portfolio analysis assertions
//
// Runs against the synthetic world seeded by test-rebuild.mjs, where the right
// answer is known in advance by construction:
//
//   CORE.L  sound, cheap (0.07%)          -> should lift the cost axis
//   TWIN.L  ~0.98 correlated with CORE.L,
//           and three times the fee        -> top "moves together" pair, and
//                                             should hold the cost axis back
//   DIVR.L  independent series             -> should appear in "moves least
//                                             together", not in "moves together"
//   JUNK.L  negative drift, deep drawdown,
//           no stored composition          -> should hold the quality axis
//                                             back, and be missing from the
//                                             cost axis entirely rather than
//                                             scored as if it were free
//
// Usage:
//   MERIDIAN_DB=/tmp/pa.db node scripts/test-rebuild.mjs   (SEED_ONLY=1 first)
//   MERIDIAN_DB=/tmp/pa.db node scripts/test-portfolio-analysis.mjs

import * as pf from '../server/engines/portfolio.js';
import * as pfa from '../server/engines/portfolio-analysis.js';
import * as mandateModel from '../server/engines/rebuild/mandate.js';

let passed = 0, failed = 0;
const fail = [];

function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; fail.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

function section(name) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); }

// The synthetic world has no live price feed; value it off the last stored bar
// so positions carry real values, exactly as valuePortfolio would with quotes.
import { getBars, all } from '../server/db.js';
const prices = {};
for (const { symbol } of all('SELECT DISTINCT symbol FROM holdings')) {
  const bars = getBars(symbol);
  const last = bars[bars.length - 1];
  if (last) prices[symbol] = { price: last.adj_close ?? last.close, currency: 'GBP', changePct: 0 };
}

const v = pf.valuePortfolio(prices);
const mandate = mandateModel.loadMandate();

section('Portfolio valued from stored bars');
check('four positions are priced', v.positions.filter(p => p.hasPrice).length === 4,
  `got ${v.positions.filter(p => p.hasPrice).length}`);

// ── Holdings by type ──────────────────────────────────────────
section('Holdings by type');
const types = pfa.holdingsByType(v.positions, v.cash, v.total);
check('returns at least one row', types.length >= 1);
check('every row carries a real value', types.every(r => typeof r.value === 'number' && r.value >= 0));
check('row percentages sum to ~100', Math.abs(types.reduce((a, r) => a + r.pct, 0) - 100) < 0.5,
  `sum ${types.reduce((a, r) => a + r.pct, 0).toFixed(2)}`);
check('item counts sum to the number of holdings (plus cash row if present)',
  types.reduce((a, r) => a + r.items, 0) === v.positions.length + (v.cash > 0 ? 1 : 0));
check('cash row, when present, reports no gain percentage',
  !types.some(r => r.label === 'Cash' && r.gainPct != null));

// ── Scorecard ─────────────────────────────────────────────────
section('Scorecard');
const sc = pfa.scorecard(v.positions, { mandate });
check('scorecard is available', sc.available === true, sc.reason ?? '');
check('five axes returned', sc.axes.length === 5, `got ${sc.axes.length}`);
check('overall score is within 0..1', sc.overall > 0 && sc.overall < 1, `got ${sc.overall}`);

const cost = sc.axes.find(a => a.key === 'cost');
const quality = sc.axes.find(a => a.key === 'quality');

check('cost axis scored', cost?.score != null);
check('cost axis coverage is below 100% (JUNK.L has no published fee)',
  cost.coverage > 0 && cost.coverage < 100, `coverage ${cost?.coverage}`);
check('JUNK.L is listed as missing from the cost axis, not scored as free',
  cost.missing.some(m => m.symbol === 'JUNK.L'),
  `missing: ${cost.missing.map(m => m.symbol).join(', ')}`);
check('JUNK.L appears in neither cost lifting nor cost holding-back',
  ![...cost.lifting, ...cost.holdingBack].some(c => c.symbol === 'JUNK.L'));

check('CORE.L (0.07% fee) lifts the cost axis',
  cost.lifting.some(c => c.symbol === 'CORE.L'),
  `lifting: ${cost.lifting.map(c => c.symbol).join(', ')}`);
check('TWIN.L (0.28% fee) holds the cost axis back',
  cost.holdingBack.some(c => c.symbol === 'TWIN.L'),
  `holding back: ${cost.holdingBack.map(c => c.symbol).join(', ')}`);
check('CORE.L scores strictly better than TWIN.L on cost',
  (cost.lifting.find(c => c.symbol === 'CORE.L')?.score ?? 0) >
  (cost.holdingBack.find(c => c.symbol === 'TWIN.L')?.score ?? 1));

check('quality axis scored', quality?.score != null);
check('JUNK.L holds the quality axis back',
  quality.holdingBack.some(c => c.symbol === 'JUNK.L'),
  `holding back: ${quality.holdingBack.map(c => c.symbol).join(', ')}`);
check('JUNK.L has the worst quality score of any holding',
  Math.min(...[...quality.lifting, ...quality.holdingBack].map(c => c.score)) ===
  quality.holdingBack.find(c => c.symbol === 'JUNK.L')?.score);

// The distinction this axis is built on: drag is weight x deviation, not raw
// score. A heavier holding scoring a little below average pulls the portfolio
// mean down more than a small holding scoring zero, and the list is ordered by
// what actually moves the number. Sorting by score instead would put JUNK.L
// first and tell the reader the opposite of the truth — so this asserts the
// weight-sensitive ordering explicitly, to catch anyone "fixing" it later.
const junkPull = quality.holdingBack.find(c => c.symbol === 'JUNK.L');
const twinPull = quality.holdingBack.find(c => c.symbol === 'TWIN.L');
check('TWIN.L is scored better than JUNK.L on quality',
  twinPull?.score > junkPull?.score, `TWIN ${twinPull?.score} vs JUNK ${junkPull?.score}`);
check('TWIN.L nonetheless outweighs JUNK.L',
  twinPull?.weight > junkPull?.weight, `TWIN ${twinPull?.weight}% vs JUNK ${junkPull?.weight}%`);
check('drag is ordered by pull on the mean, not by raw score',
  quality.holdingBack[0]?.pull <= quality.holdingBack[1]?.pull,
  `order: ${quality.holdingBack.map(c => `${c.symbol}:${c.pull}`).join(', ')}`);

// The pull figures are deviations from the weighted mean, so they must cancel.
for (const a of sc.axes.filter(x => x.score != null)) {
  const sum = [...a.lifting, ...a.holdingBack].reduce((s, c) => s + c.pull, 0);
  check(`${a.key}: lifting and holding-back pulls cancel to ~0`, Math.abs(sum) < 0.5,
    `sum ${sum.toFixed(3)}`);
}

check('every holding carries a per-axis score map',
  sc.holdings.length === 4 && sc.holdings.every(h => 'quality' in h.scores && 'cost' in h.scores));
check('an unmeasurable component reads null rather than a number',
  sc.holdings.find(h => h.symbol === 'JUNK.L')?.scores.cost === null);

// ── Correlation pairs ─────────────────────────────────────────
section('Correlation pairs');
const corr = pfa.correlationPairs(v.positions, { limit: 3 });
check('correlations are available', corr.available === true);
check('all six pairs were assessable', corr.assessed === 6 && corr.unassessable.length === 0,
  `assessed ${corr.assessed}, unassessable ${corr.unassessable.length}`);

const top = corr.movesTogether[0];
check('CORE.L/TWIN.L is the top moves-together pair',
  top && top.symbols.includes('CORE.L') && top.symbols.includes('TWIN.L'),
  `got ${top?.symbols?.join('/')}`);
check('that pair is correlated above 0.9', top?.correlation > 0.9, `got ${top?.correlation}`);
check('the top pair reports its combined weight', top?.combinedWeight > 0);
check('moves-least-together is sorted the other way',
  corr.movesLeastTogether[0].correlation <= corr.movesTogether[0].correlation);
check('DIVR.L shows up among the least-correlated pairs',
  corr.movesLeastTogether.some(p => p.symbols.includes('DIVR.L')));
check('every pair states how many observations it used',
  corr.movesTogether.every(p => p.observations >= 60));

// ── Holding detail ────────────────────────────────────────────
section('Holding detail');
const detail = pfa.holdingDetail('CORE.L', v.positions, { mandate });
check('detail resolves the position', detail.position?.symbol === 'CORE.L');
check('detail carries the five component scores',
  Object.keys(detail.scores.components).length === 5);
check('conviction computed', detail.scores.conviction > 0 && detail.scores.conviction < 1,
  `got ${detail.scores.conviction}`);
check('stored composition surfaced with its real expense ratio',
  detail.composition.expenseRatio === 0.07, `got ${detail.composition.expenseRatio}`);
check('top holdings listed from stored composition',
  detail.composition.topHoldings.length > 0);
check('52-week range computed from stored bars', detail.range52.available === true);
check('52-week low is below the high', detail.range52.low < detail.range52.high);
check('most-correlated partner is TWIN.L',
  detail.correlatedWith[0]?.symbol === 'TWIN.L',
  `got ${detail.correlatedWith[0]?.symbol}`);

const junk = pfa.holdingDetail('JUNK.L', v.positions, { mandate });
check('a holding with no stored composition says so rather than inventing one',
  junk.composition.available === false && !!junk.composition.reason);
check('its cost component is reported unavailable with a reason',
  junk.scores.components.cost.available === false && !!junk.scores.components.cost.reason);

const missing = pfa.holdingDetail('NOSUCH.L', v.positions, { mandate });
check('an unknown symbol returns a null position rather than throwing',
  missing.position === null);

// ── Summary ───────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
