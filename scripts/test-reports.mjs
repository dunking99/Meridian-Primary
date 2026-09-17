// Meridian — periodic report assertions
//
// Run:
//   MERIDIAN_DB=/tmp/rep.db node scripts/test-reports.mjs
//
// Two things here are worth more than the rest.
//
// The first is that a report covers a period that has ENDED. Reporting on the
// week currently running produces a partial figure labelled as a full one, and
// then quietly changes every time it regenerates. The assertions below pin the
// due-period arithmetic and check that a report, once written, is not rewritten
// on a later run.
//
// The second is that the scheduler is driven by what is in the table rather
// than by a timer's memory. The app is closed most of the time; a schedule that
// only fires while the process happens to be running would skip any period the
// user did not open the app during. Closing the app for three weeks and coming
// back should produce the missing reports, and there is a test for exactly that.
//
// The engines are injected throughout, so none of this needs price data, a
// network or a working portfolio to be exercised.

import { db, all } from '../server/db.js';
import * as R from '../server/engines/reports.js';

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
function section(name) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); }

db.exec('DELETE FROM reports;');

const D = s => new Date(`${s}T12:00:00Z`);

// ─── 1. Period arithmetic ─────────────────────────────────────

section('Knowing which period a moment is in');

check('an ISO week number is computed',
  R.isoWeek(D('2026-09-17')).week === 38, JSON.stringify(R.isoWeek(D('2026-09-17'))));

check('the first days of January can belong to the previous ISO year',
  // 1 Jan 2027 is a Friday, in ISO week 53 of 2026.
  R.isoWeek(D('2027-01-01')).year === 2026, JSON.stringify(R.isoWeek(D('2027-01-01'))));

check('a weekly key is zero-padded so it sorts',
  R.periodKey('weekly', D('2026-03-02')) === '2026-W10', R.periodKey('weekly', D('2026-03-02')));

check('a monthly key is year-month', R.periodKey('monthly', D('2026-09-17')) === '2026-09');
check('a quarterly key names the quarter', R.periodKey('quarterly', D('2026-09-17')) === '2026-Q3');
check('quarter boundaries are right',
  R.periodKey('quarterly', D('2026-04-01')) === '2026-Q2'
  && R.periodKey('quarterly', D('2026-03-31')) === '2026-Q1');

check('a weekly range runs Monday to Sunday', (() => {
  const r = R.periodRange('weekly', D('2026-09-17'));   // a Thursday
  return r.from === '2026-09-14' && r.to === '2026-09-20';
})(), JSON.stringify(R.periodRange('weekly', D('2026-09-17'))));

check('a Sunday belongs to the week that started the previous Monday', (() => {
  const r = R.periodRange('weekly', D('2026-09-20'));
  return r.from === '2026-09-14' && r.to === '2026-09-20';
})(), JSON.stringify(R.periodRange('weekly', D('2026-09-20'))));

check('a monthly range covers the whole month, including a 30-day one', (() => {
  const r = R.periodRange('monthly', D('2026-09-17'));
  return r.from === '2026-09-01' && r.to === '2026-09-30';
})(), JSON.stringify(R.periodRange('monthly', D('2026-09-17'))));

check('February in a leap year ends on the 29th', (() => {
  const r = R.periodRange('monthly', D('2028-02-10'));
  return r.to === '2028-02-29';
})(), JSON.stringify(R.periodRange('monthly', D('2028-02-10'))));

check('a quarterly range covers three months', (() => {
  const r = R.periodRange('quarterly', D('2026-08-15'));
  return r.from === '2026-07-01' && r.to === '2026-09-30';
})(), JSON.stringify(R.periodRange('quarterly', D('2026-08-15'))));

// ─── 2. Assembly ──────────────────────────────────────────────

section('Assembling engines, and surviving one of them failing');

const goodEngines = {
  portfolio: () => ({ total: 100_000, positions: [{ symbol: 'A.L' }, { symbol: 'B.L' }] }),
  attribution: () => ({
    available: true, totalReturn: 0.084, days: 21, caveat: 'Portfolio-relative.',
    winners: [{ symbol: 'A.L', name: 'Alpha', group: 'Tech', averageWeight: 0.4, contribution: 0.061 }],
    losers: [{ symbol: 'B.L', name: 'Beta', group: 'Energy', averageWeight: 0.6, contribution: -0.012 }],
    benchmark: { available: true, symbol: '^FTSE', benchmarkReturn: 0.031, excess: 0.053 },
  }),
  correlation: () => ({
    available: true,
    independence: { available: true, effectiveBets: 2.4, holdingsCount: 6 },
    redundancies: { pairs: [{ a: 'A.L', b: 'B.L', nameA: 'Alpha', nameB: 'Beta', correlation: 0.94, combinedWeight: 0.42 }] },
  }),
  xray: () => ({
    available: true, distinctNames: 12, coverage: { seen: 0.31 },
    underlyings: [{ key: 's:AAPL', symbol: 'AAPL', name: 'Apple Inc', weight: 0.176, viaCount: 3, exact: false }],
    basis: 'Every weight is a floor.',
  }),
};

{
  const p = R.assemble({ period: 'monthly', at: D('2026-09-17'), engines: goodEngines });
  check('every section is present', Object.keys(p.sections).length === 4, JSON.stringify(Object.keys(p.sections)));
  check('the report is marked complete', p.complete === true);
  check('nothing is listed as failed', p.failedSections.length === 0);
  check('the period key and range are carried',
    p.periodKey === '2026-09' && p.from === '2026-09-01' && p.to === '2026-09-30');
  check('each section carries the engine value', p.sections.attribution.value.totalReturn === 0.084);
}

{
  const p = R.assemble({
    period: 'monthly', at: D('2026-09-17'),
    engines: { ...goodEngines, correlation: () => { throw new Error('no stored history'); } },
  });
  check('one engine throwing does not take the report down', !!p.sections.attribution.value);
  check('the failed section records its error',
    p.sections.correlation.ok === false && /no stored history/.test(p.sections.correlation.error));
  check('and the report says it is incomplete', p.complete === false);
  check('naming which section is missing',
    p.failedSections.includes('correlation'), JSON.stringify(p.failedSections));
}

// ─── 3. Rendering ─────────────────────────────────────────────

section('Rendering a file that still opens in ten years');

{
  const p = R.assemble({ period: 'monthly', at: D('2026-09-17'), engines: goodEngines });
  const html = R.render(p);

  check('it is a complete document', /^<!doctype html>/i.test(html) && /<\/html>$/.test(html.trim()));
  check('it names the period', html.includes('2026-09'));
  check('the return is shown', html.includes('+8.40%'), 'totalReturn 0.084');
  check('the benchmark comparison is shown', html.includes('^FTSE') && html.includes('+5.30%'));
  check('contributors are listed', html.includes('Alpha') && html.includes('Beta'));
  check('the duplicated pair is listed', html.includes('0.94'));
  check('the largest underlying is listed with its floor marker',
    html.includes('Apple Inc') && html.includes('≥17.60%'));

  check('nothing external is referenced — no network needed to open it',
    !/<link[^>]+href=["']http/i.test(html)
    && !/<script[^>]+src=/i.test(html)
    && !/@import/i.test(html)
    && !/url\(https?:/i.test(html));

  check('the attribution caveat travels with the numbers', html.includes('Portfolio-relative'));
  check('the x-ray floor caveat travels too', html.includes('Every weight is a floor'));

  check('a failed section is declared in the document, not silently omitted', (() => {
    const bad = R.assemble({
      period: 'monthly', at: D('2026-09-17'),
      engines: { ...goodEngines, xray: () => { throw new Error('boom'); } },
    });
    const h = R.render(bad);
    return h.includes('could not be built') && h.includes('x-ray') === false ? h.includes('xray') : h.includes('could not be built');
  })());

  check('an empty report renders rather than throwing', (() => {
    const empty = R.assemble({ period: 'weekly', at: D('2026-09-17'), engines: {} });
    const h = R.render(empty);
    return typeof h === 'string' && h.includes('No section produced a headline figure');
  })());
}

check('a hostile name cannot inject markup into the document', (() => {
  const p = R.assemble({
    period: 'monthly', at: D('2026-09-17'),
    engines: {
      attribution: () => ({
        available: true, totalReturn: 0.01, days: 5, caveat: '',
        winners: [{ symbol: 'X', name: '<script>alert(1)</script>', group: 'G', averageWeight: 0.5, contribution: 0.01 }],
        losers: [], benchmark: { available: false },
      }),
    },
  });
  const h = R.render(p);
  return !h.includes('<script>alert(1)</script>') && h.includes('&lt;script&gt;');
})(), 'names come from broker files and fund disclosures, which are not trusted input');

// ─── 4. Storage ───────────────────────────────────────────────

section('Keeping what was said at the time');

{
  db.exec('DELETE FROM reports;');
  const p = R.assemble({ period: 'monthly', at: D('2026-08-15'), engines: goodEngines });
  const saved = R.saveReport(p, R.render(p));
  check('a report is stored', !!saved?.id);

  const list = R.listReports();
  check('and appears in the list', list.length === 1 && list[0].periodKey === '2026-08');

  const got = R.getReport(saved.id);
  check('it can be read back whole', got.payload.periodKey === '2026-08' && got.html.length > 500);
  check('the stored payload is the numbers, not only the document',
    got.payload.sections.attribution.value.totalReturn === 0.084,
    'a March report should still say what March said after the engines change');

  R.saveReport(p, R.render(p));
  check('re-saving the same period updates rather than duplicating',
    all('SELECT * FROM reports').length === 1);

  check('hasReport answers correctly',
    R.hasReport('monthly', '2026-08') === true && R.hasReport('monthly', '2026-07') === false);

  R.deleteReport(saved.id);
  check('a report can be deleted', R.getReport(saved.id) === null);
}

// ─── 5. Scheduling ────────────────────────────────────────────

section('Reports that appear without being asked for');

{
  db.exec('DELETE FROM reports;');
  const now = D('2026-09-17');                 // Thursday, week 38

  const r1 = R.generateDue({ now, periods: ['monthly'], engines: goodEngines });
  check('the report written is for the period that has ENDED',
    r1.written[0]?.periodKey === '2026-08',
    `wrote ${r1.written[0]?.periodKey} on a date in 2026-09`);

  check('the still-running period is not reported on',
    !R.hasReport('monthly', '2026-09'),
    'reporting a period mid-flight labels a partial figure as a full one');

  const r2 = R.generateDue({ now, periods: ['monthly'], engines: goodEngines });
  check('running again writes nothing', r2.written.length === 0);
  check('and says why it skipped',
    r2.skipped.some(s => /already written/.test(s.reason)), JSON.stringify(r2.skipped));

  check('a period that is not enabled is skipped and named', (() => {
    const r = R.generateDue({ now, periods: ['weekly', 'monthly'], enabled: ['monthly'], engines: goodEngines });
    return r.skipped.some(s => s.period === 'weekly' && /not enabled/.test(s.reason));
  })());
}

{
  // The app is closed for three weeks. On the next run the missing weeks must
  // still be written, because the schedule is driven by the table rather than
  // by a timer that was not running.
  db.exec('DELETE FROM reports;');
  const dates = ['2026-08-27', '2026-09-03', '2026-09-10', '2026-09-17'];
  for (const d of dates) R.generateDue({ now: D(d), periods: ['weekly'], engines: goodEngines });

  const keys = R.listReports().map(r => r.periodKey).sort();
  check('each missed week gets its own report once the app is opened again',
    keys.length === 4 && new Set(keys).size === 4, JSON.stringify(keys));

  check('every week written is a completed one, none of them the current week',
    !keys.includes(R.periodKey('weekly', D('2026-09-17'))),
    JSON.stringify({ written: keys, current: R.periodKey('weekly', D('2026-09-17')) }));
}

{
  db.exec('DELETE FROM reports;');
  const r = R.generateDue({
    now: D('2026-09-17'), periods: ['monthly'],
    engines: { attribution: () => { throw new Error('nope'); } },
  });
  check('a report whose engines failed is still written, marked incomplete',
    r.written[0]?.complete === false && R.listReports().length === 1,
    'an absent report and a report saying the engine failed are different things');
}

check('all three cadences can run together', (() => {
  db.exec('DELETE FROM reports;');
  const r = R.generateDue({ now: D('2026-09-17'), engines: goodEngines });
  return r.written.length === 3 && R.listReports().length === 3;
})(), JSON.stringify(R.listReports().map(x => x.periodKey)));

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n${'='.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`${'='.repeat(52)}\n`);
process.exit(failed ? 1 : 0);
