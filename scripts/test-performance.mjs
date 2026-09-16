// Meridian — performance measurement assertions
//
// Run:
//   MERIDIAN_DB=/tmp/perf.db SEED_ONLY=1 node scripts/test-rebuild.mjs
//   MERIDIAN_DB=/tmp/perf.db node scripts/test-performance.mjs
//
// A return figure is the easiest thing in this whole app to get subtly wrong
// and never notice: a sign convention flipped, a deposit counted as a gain, an
// annualisation applied to a fortnight. All of those produce a plausible
// number. None of them produce an obviously broken one.
//
// So this does not check that the engine returns a number. It checks the
// engine against schedules whose answer is known before running it:
//
//   100 in, 110 out, one year later     -> exactly 10%
//   100 in, 121 out, two years later    -> exactly 10% a year, not 21%
//   a deposit the day before measuring  -> must not read as a gain
//   money added before a fall           -> IRR below TWR, and the timing
//                                          verdict must say so
//
// The last one is the point of building this at all: it is the case the old
// fixed-weight reconstruction could not see, because it did not know when the
// money arrived.

import { all, run } from '../server/db.js';
import * as perf from '../server/engines/performance.js';

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
const near = (a, b, tol = 0.05) => a != null && Math.abs(a - b) <= tol;
function section(name) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); }

const DAY = 86400_000;
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const daysAgo = n => iso(Date.now() - n * DAY);
const clearFlows = () => run('DELETE FROM cash_flows');

// ─── XIRR against known answers ───────────────────────────────

section('IRR against analytically known answers');
clearFlows();
perf.addFlow({ date: daysAgo(365), amount: 100, kind: 'deposit' });
let r = perf.moneyWeighted(110, { asOf: Date.now() });
check('100 in, worth 110 a year later, is 10% a year',
  near(r.annualisedPct, 10, 0.1), `got ${r.annualisedPct}`);
check('and reports the simple gain alongside the rate',
  r.absoluteGain === 10 && near(r.absoluteGainPct, 10, 0.01), JSON.stringify(r.absoluteGain));

clearFlows();
perf.addFlow({ date: daysAgo(730), amount: 100, kind: 'deposit' });
r = perf.moneyWeighted(121, { asOf: Date.now() });
check('100 in, worth 121 after two years, annualises to 10% not 21%',
  near(r.annualisedPct, 10, 0.15), `got ${r.annualisedPct}`);
check('the absolute gain still reports the full 21%',
  near(r.absoluteGainPct, 21, 0.01), `got ${r.absoluteGainPct}`);

clearFlows();
perf.addFlow({ date: daysAgo(365), amount: 100, kind: 'deposit' });
r = perf.moneyWeighted(90, { asOf: Date.now() });
check('a loss returns a negative rate', r.annualisedPct < 0, `got ${r.annualisedPct}`);
check('and is about -10% for 100 down to 90 over a year',
  near(r.annualisedPct, -10, 0.1), `got ${r.annualisedPct}`);

// Two equal deposits a year apart, ending at exactly what was paid in, must
// be 0% — this is the case a naive "gain over contributions" gets right by
// luck and a mis-dated IRR gets wrong.
clearFlows();
perf.addFlow({ date: daysAgo(730), amount: 100, kind: 'deposit' });
perf.addFlow({ date: daysAgo(365), amount: 100, kind: 'deposit' });
r = perf.moneyWeighted(200, { asOf: Date.now() });
check('paying in 200 and being worth 200 is a zero return',
  near(r.annualisedPct, 0, 0.1), `got ${r.annualisedPct}`);

// ─── A deposit is not a gain ──────────────────────────────────

section('A deposit is not performance');
clearFlows();
perf.addFlow({ date: daysAgo(400), amount: 1000, kind: 'deposit' });
const before = perf.moneyWeighted(1000, { asOf: Date.now() });
perf.addFlow({ date: daysAgo(1), amount: 9000, kind: 'deposit' });
const after = perf.moneyWeighted(10000, { asOf: Date.now() });
check('adding 9000 yesterday and being worth 9000 more is still a zero return',
  near(after.annualisedPct, 0, 0.5), `got ${after.annualisedPct} (was ${before.annualisedPct})`);
check('net contributed tracks the ledger, not the valuation',
  after.netContributed === 10000, `got ${after.netContributed}`);
check('absolute gain is zero, not 900%', after.absoluteGain === 0, `got ${after.absoluteGain}`);

// ─── Withdrawals ──────────────────────────────────────────────

section('Withdrawals');
clearFlows();
const w = perf.addFlow({ date: daysAgo(100), amount: 500, kind: 'withdrawal' });
check('a withdrawal is stored negative regardless of the sign typed', w.amount === -500, `got ${w.amount}`);
const d = perf.addFlow({ date: daysAgo(200), amount: -300, kind: 'deposit' });
check('a deposit is stored positive regardless of the sign typed', d.amount === 300, `got ${d.amount}`);

clearFlows();
perf.addFlow({ date: daysAgo(365), amount: 1000, kind: 'deposit' });
perf.addFlow({ date: daysAgo(180), amount: 500, kind: 'withdrawal' });
r = perf.moneyWeighted(600, { asOf: Date.now() });
check('a portfolio that paid out and still holds value has a positive return',
  r.available && r.annualisedPct > 0, `got ${r.annualisedPct}`);
check('net contributed is deposits minus withdrawals', r.netContributed === 500, `got ${r.netContributed}`);

// ─── Refusals ─────────────────────────────────────────────────

section('What it refuses to compute');
clearFlows();
r = perf.moneyWeighted(50000);
check('no ledger means no money-weighted return', r.available === false);
check('and the reason says why guessing is not an option',
  r.reason.includes('inventing') || r.reason.includes('cannot be computed'), r.reason);

clearFlows();
perf.addFlow({ date: daysAgo(2), amount: 1000, kind: 'deposit' });
r = perf.moneyWeighted(1010);
check('two days of history is refused rather than annualised', r.available === false, JSON.stringify(r));
check('and says it is too short rather than failing silently',
  r.reason.includes('too short'), r.reason);

clearFlows();
perf.addFlow({ date: daysAgo(365), amount: 1000, kind: 'deposit' });
r = perf.moneyWeighted(0);
check('a portfolio with no value is refused', r.available === false);

const single = perf.xirr([{ when: Date.now(), amount: 100 }]);
check('a single flow cannot produce a rate', single.available === false);
const sameSign = perf.xirr([
  { when: Date.now() - 365 * DAY, amount: 100 },
  { when: Date.now(), amount: 100 },
]);
check('flows all in one direction are refused, not solved to nonsense',
  sameSign.available === false, JSON.stringify(sameSign));
check('and the refusal explains the mis-signing',
  sameSign.reason.includes('mis-signed') || sameSign.reason.includes('both money in and money out'),
  sameSign.reason);

// ─── Time-weighted ────────────────────────────────────────────

section('Time-weighted return');
clearFlows();
// A clean doubling with no flows: TWR must be exactly 100%.
let snaps = [
  { date: daysAgo(365), total_gbp: 100 },
  { date: daysAgo(1), total_gbp: 200 },
];
let t = perf.timeWeighted(snaps);
check('a portfolio that doubled with no flows is +100% cumulative',
  near(t.cumulativePct, 100, 0.01), `got ${t.cumulativePct}`);
check('annualised is about 100% over a year too', near(t.annualisedPct, 100, 2), `got ${t.annualisedPct}`);

// The same end value reached only by depositing must be 0%, not +100%. This
// is the assertion that catches a TWR which forgot to remove flows.
clearFlows();
perf.addFlow({ date: daysAgo(1), amount: 100, kind: 'deposit' });
t = perf.timeWeighted(snaps);
check('the same rise caused purely by a deposit is 0%, not 100%',
  near(t.cumulativePct, 0, 0.01), `got ${t.cumulativePct}`);
check('and it reports how many periods had a flow removed', t.flowsRemoved === 1, `got ${t.flowsRemoved}`);

check('one snapshot cannot produce a time-weighted return',
  perf.timeWeighted([{ date: daysAgo(5), total_gbp: 100 }]).available === false);
check('no snapshots at all is refused with a reason',
  !!perf.timeWeighted([]).reason);

clearFlows();
// Sparse snapshots over a long span must report their own thinness.
const sparse = [
  { date: daysAgo(300), total_gbp: 100 },
  { date: daysAgo(150), total_gbp: 110 },
  { date: daysAgo(1), total_gbp: 120 },
];
t = perf.timeWeighted(sparse);
check('sparse snapshots still produce a return', t.available === true);
check('but the coverage gap is reported rather than smoothed over',
  t.coveragePct < 60 && !!t.coverageNote, `coverage ${t.coveragePct}`);

// ─── IRR and TWR diverge on timing ────────────────────────────

section('Timing: the case the reconstruction could not see');
clearFlows();
// Small amount held through a rise, then a large deposit just before a fall.
// The strategy ends up ahead; the investor does not. Any measure that cannot
// tell these apart is the thing this engine was built to replace.
perf.addFlow({ date: daysAgo(365), amount: 1000, kind: 'deposit' });
perf.addFlow({ date: daysAgo(60), amount: 20000, kind: 'deposit' });
const timingSnaps = [
  { date: daysAgo(365), total_gbp: 1000 },
  { date: daysAgo(61), total_gbp: 1500 },
  { date: daysAgo(60), total_gbp: 21500 },
  { date: daysAgo(1), total_gbp: 19500 },
];
const report = perf.performanceReport(19500, timingSnaps, { benchmark: 'CORE.L' });

check('both returns are available', report.moneyWeighted.available && report.timeWeighted.available);
check('the money-weighted return is worse than the time-weighted one',
  report.moneyWeighted.annualisedPct < report.timeWeighted.annualisedPct,
  `mwr ${report.moneyWeighted.annualisedPct} vs twr ${report.timeWeighted.annualisedPct}`);
check('the timing gap is computed and negative',
  report.timing && report.timing.gapPct < 0, JSON.stringify(report.timing));
check('and the verdict says the timing hurt',
  report.timing.verdict.includes('worse moments'), report.timing?.verdict);

check('the benchmark is compared time-weighted, not money-weighted',
  report.versusBenchmark == null || report.versusBenchmark.note.includes('time-weighted'));
check('the benchmark reads from stored bars', report.benchmark.symbol === 'CORE.L');

check('the flow summary totals the ledger',
  report.flowSummary.count === 2 && report.flowSummary.deposited === 21000,
  JSON.stringify(report.flowSummary));
check('the report states what it can and cannot see',
  report.coverage.includes('refused rather than estimated'));

// ─── Ledger hygiene ───────────────────────────────────────────

section('Ledger');
clearFlows();
let threw = false;
try { perf.addFlow({ date: daysAgo(1), amount: 0 }); } catch { threw = true; }
check('a zero-amount flow is rejected', threw);
threw = false;
try { perf.addFlow({ date: 'not-a-date', amount: 100 }); } catch { threw = true; }
check('an unparseable date is rejected', threw);

const added = perf.addFlow({ date: daysAgo(10), amount: 250, kind: 'deposit', note: 'monthly' });
check('a flow round-trips through the ledger', perf.listFlows().some(f => f.id === added.id));
check('the note is kept', perf.listFlows().find(f => f.id === added.id).note === 'monthly');
perf.deleteFlow(added.id);
check('and can be deleted', !perf.listFlows().some(f => f.id === added.id));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
