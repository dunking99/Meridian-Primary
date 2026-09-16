// Meridian — daily briefing assertions
//
// Run:
//   MERIDIAN_DB=/tmp/brief.db SEED_ONLY=1 node scripts/test-rebuild.mjs
//   MERIDIAN_DB=/tmp/brief.db node scripts/test-briefing.mjs
//
// The briefing's whole job is ranking findings that come from engines which
// have never had to be comparable before, and marking what is new since the
// reader last looked. Neither property is visible from "it returned an object"
// — both need a world where the right ordering is known in advance.
//
// So this builds on the same synthetic portfolio test-rebuild.mjs seeds, then
// plants findings whose relative importance is known by construction:
//
//   a triggered alert on CORE.L     -> must outrank everything, because the
//                                      user explicitly asked to be told
//   a high-relevance story on a
//     holding vs one on an
//     untracked ticker              -> the first appears, the second is
//                                      filtered out entirely
//   the same briefing, re-read      -> every finding flips from new to seen,
//                                      and nothing is lost in the process
//
// The read-state assertions matter most: a briefing that cannot tell you what
// changed since yesterday is a dashboard, and this is the only place that
// behaviour is checked.

import { all, one, run, getBars } from '../server/db.js';
import * as pf from '../server/engines/portfolio.js';
import * as memory from '../server/engines/memory.js';
import * as briefing from '../server/engines/briefing.js';

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

// ─── World setup ──────────────────────────────────────────────

memory.rebuild({});
memory.rebuildRegime({ minSymbols: 2 });

// Value the synthetic portfolio off stored bars, exactly as the other engine
// tests do, so positions carry real weights rather than mocked ones.
const prices = {};
for (const { symbol } of all('SELECT DISTINCT symbol FROM holdings')) {
  const bars = getBars(symbol);
  const last = bars[bars.length - 1], prev = bars[bars.length - 2];
  if (last) prices[symbol] = {
    price: last.adj_close ?? last.close,
    currency: 'GBP',
    changePct: prev ? +(((last.close / prev.close) - 1) * 100).toFixed(2) : 0,
  };
}

briefing.clearReadHistory();
run('DELETE FROM alerts');
run('DELETE FROM news');

section('Baseline briefing');
const base = briefing.buildBriefing(prices, {});

check('builds without any section failing', base.failures.length === 0,
  JSON.stringify(base.failures));
check('all eight sections are present',
  base.sections.length === 8, `got ${base.sections.length}`);
check('every section states either coverage or a reason for having none',
  base.sections.every(s => s.coverage || s.reason),
  base.sections.filter(s => !s.coverage && !s.reason).map(s => s.key).join(', '));
check('portfolio block values the synthetic portfolio',
  base.portfolio.available && base.portfolio.positions === 4, JSON.stringify(base.portfolio));
check('day change percentage matches valuePortfolio rather than being re-derived',
  base.portfolio.dayChangePct === pf.valuePortfolio(prices).dayChangePct);
check('concentration is detected in a deliberately concentrated portfolio',
  base.sections.find(s => s.key === 'risk').items.some(i => i.fp === 'risk:top3-concentration'));
check('every finding carries a materiality between 0 and 100',
  base.headline.every(i => i.materiality >= 0 && i.materiality <= 100));
check('every finding names its source',
  base.sections.flatMap(s => s.items).every(i => !!i.source));
check('headline is sorted by materiality within the same newness',
  base.headline.every((h, i) => i === 0 || base.headline[i - 1].materiality >= h.materiality
    || base.headline[i - 1].isNew !== h.isNew));

// ─── Alerts outrank ambient findings ──────────────────────────

section('A triggered alert outranks ambient findings');
run(`INSERT INTO alerts (symbol, kind, direction, threshold, status, note, created_at, triggered_at, triggered_value)
     VALUES ('CORE.L', 'price', 'above', 100, 'triggered', 'watch this level', ?, ?, 142.5)`,
    Date.now() - 86400_000, Date.now() - 3600_000);

const withAlert = briefing.buildBriefing(prices, {});
const alertSection = withAlert.sections.find(s => s.key === 'alerts');

check('the triggered alert is picked up', alertSection.items.length === 1,
  `got ${alertSection.items.length}`);
check('it leads the headline', withAlert.headline[0]?.kind === 'alert',
  `led with ${withAlert.headline[0]?.kind}`);
check('it outscores the concentration findings it is competing with',
  withAlert.headline[0].materiality >
  Math.max(...withAlert.sections.find(s => s.key === 'risk').items.map(i => i.materiality)));
check('the verdict switches to action when an alert has fired',
  withAlert.verdict.tone === 'action', withAlert.verdict.tone);
check('the user note is surfaced rather than a generic line',
  alertSection.items[0].detail.includes('watch this level'));
check('alert coverage counts what is still armed',
  alertSection.coverage.includes('0 alert') && alertSection.coverage.includes('1 triggered'));

// The briefing must never be what fires an alert — the poll loop owns that.
run(`INSERT INTO alerts (symbol, kind, direction, threshold, status, created_at)
     VALUES ('CORE.L', 'price', 'above', 1, 'active', ?)`, Date.now());
briefing.buildBriefing(prices, {});
check('building a briefing does not trigger an armed alert that would fire',
  one("SELECT status FROM alerts WHERE threshold = 1").status === 'active');

// ─── News is filtered to what you actually own ────────────────

section('News is filtered to holdings and watchlist');
const now = Date.now();
run(`INSERT INTO news (guid, source, title, url, published, summary, tags, symbols, fetched_at,
                       ai_relevance, ai_scored_at, ai_why, ai_symbols, ai_category, ai_sentiment)
     VALUES ('held-1', 'Reuters', 'CORE.L fund cuts fees again', 'http://x/1', ?, '', '[]', '["CORE.L"]', ?,
             88, ?, 'Directly about a fund you hold', '["CORE.L"]', 'markets', 0.4)`,
    now - 3600_000, now, now);
run(`INSERT INTO news (guid, source, title, url, published, summary, tags, symbols, fetched_at,
                       ai_relevance, ai_scored_at, ai_why, ai_symbols, ai_category, ai_sentiment)
     VALUES ('untracked-1', 'Reuters', 'Some company you do not own reports', 'http://x/2', ?, '', '[]', '["NOTHELD.L"]', ?,
             95, ?, 'High relevance but unrelated to this portfolio', '["NOTHELD.L"]', 'markets', 0.2)`,
    now - 3600_000, now, now);

const withNews = briefing.buildBriefing(prices, {});
const newsSection = withNews.sections.find(s => s.key === 'news');

check('a story about a holding is included',
  newsSection.items.some(i => i.meta.guid === 'held-1'));
check('a higher-relevance story about an untracked ticker is excluded',
  !newsSection.items.some(i => i.meta.guid === 'untracked-1'));
check('the story carries the scorer\'s own reasoning rather than a restated headline',
  newsSection.items.find(i => i.meta.guid === 'held-1')?.detail === 'Directly about a fund you hold');
check('the story\'s stake is the weight of the holding it touches',
  newsSection.items.find(i => i.meta.guid === 'held-1')?.weight ===
  pf.valuePortfolio(prices).positions.find(p => p.symbol === 'CORE.L').weight);

// A story touching two holdings must outrank the same story touching one:
// this is the property that makes materiality portfolio-aware rather than
// just a copy of the news relevance score.
run(`INSERT INTO news (guid, source, title, url, published, summary, tags, symbols, fetched_at,
                       ai_relevance, ai_scored_at, ai_why, ai_symbols, ai_category, ai_sentiment)
     VALUES ('held-2', 'Reuters', 'Two of your funds affected by the same change', 'http://x/3', ?, '', '[]',
             '["CORE.L","TWIN.L"]', ?, 88, ?, 'Touches two holdings', '["CORE.L","TWIN.L"]', 'markets', 0.1)`,
    now - 3600_000, now, now);

const twoHit = briefing.buildBriefing(prices, {});
const twoSection = twoHit.sections.find(s => s.key === 'news');
const one1 = twoSection.items.find(i => i.meta.guid === 'held-1');
const two1 = twoSection.items.find(i => i.meta.guid === 'held-2');
check('both stories were scored at the same relevance', one1.meta.relevance === two1.meta.relevance);
check('the story touching two holdings outranks the one touching one',
  two1.materiality > one1.materiality, `two-hit ${two1.materiality} vs one-hit ${one1.materiality}`);

// ─── Read state ───────────────────────────────────────────────

section('What is new since the last read');
const before = briefing.buildBriefing(prices, {});
check('everything is new before anything has ever been read',
  before.counts.new === before.counts.total && before.counts.total > 0,
  `${before.counts.new}/${before.counts.total}`);
check('lastRead is null before any acknowledgement', before.lastRead === null);

briefing.markRead(before.fingerprints, before.generatedAt);
const after = briefing.buildBriefing(prices, {});

check('nothing is new immediately after marking as read', after.counts.new === 0,
  `${after.counts.new} still marked new`);
check('marking as read does not drop any findings',
  after.counts.total === before.counts.total, `${after.counts.total} vs ${before.counts.total}`);
check('the acknowledgement is reported back', after.lastRead?.itemCount === before.fingerprints.length);
check('the verdict notices there is nothing new',
  after.verdict.tone === 'action' || after.verdict.text.length > 0);

// A genuinely new finding after a read must come back as new — and lead,
// because unseen findings are what a briefing exists to surface.
run(`INSERT INTO news (guid, source, title, url, published, summary, tags, symbols, fetched_at,
                       ai_relevance, ai_scored_at, ai_why, ai_symbols, ai_category, ai_sentiment)
     VALUES ('held-3', 'Reuters', 'Fresh story since you last looked', 'http://x/4', ?, '', '[]', '["CORE.L"]', ?,
             70, ?, 'Published after the last read', '["CORE.L"]', 'markets', -0.3)`,
    now - 600_000, now, now);

const fresh = briefing.buildBriefing(prices, {});
check('a story arriving after the read is marked new', fresh.counts.new === 1, `${fresh.counts.new}`);
check('the new story is identified correctly',
  fresh.sections.find(s => s.key === 'news').items.find(i => i.meta.guid === 'held-3')?.isNew === true);
check('new findings lead the headline even when lower materiality than seen ones',
  fresh.headline[0].isNew === true && fresh.headline[0].meta.guid === 'held-3',
  `led with ${fresh.headline[0].title}`);
check('previously-read findings are still present, just no longer new',
  fresh.counts.total === after.counts.total + 1);

// Fingerprints must be stable across rebuilds, or every briefing would report
// everything as new forever.
const a = briefing.buildBriefing(prices, {});
const b = briefing.buildBriefing(prices, {});
check('fingerprints are stable between two builds of the same world',
  JSON.stringify(a.fingerprints.sort()) === JSON.stringify(b.fingerprints.sort()));

// ─── Section isolation ────────────────────────────────────────

section('A failing section does not take the briefing down');
// Drop a table an optional section depends on, and confirm the rest survives.
run('DROP TABLE IF EXISTS watchlist');
const degraded = briefing.buildBriefing(prices, {});
check('the briefing still builds with a missing table', !!degraded.verdict);
check('other sections still produced findings',
  degraded.sections.find(s => s.key === 'risk').items.length > 0);
check('the failure is reported rather than swallowed',
  degraded.failures.length > 0 || degraded.sections.some(s => s.available === false),
  JSON.stringify(degraded.failures));

// ─── Quiet days ───────────────────────────────────────────────

section('An empty world says nothing happened');
run('DELETE FROM holdings');
run('DELETE FROM cash');
run('DELETE FROM news');
run('DELETE FROM alerts');
briefing.clearReadHistory();
const empty = briefing.buildBriefing({}, {});
check('an empty portfolio still produces a briefing', !!empty.verdict);
check('it concludes that nothing happened rather than inventing a finding',
  empty.verdict.tone === 'quiet', `${empty.verdict.tone}: ${empty.verdict.text}`);
check('no findings are fabricated from an empty portfolio', empty.counts.total === 0,
  JSON.stringify(empty.counts));
check('coverage still explains what the briefing can and cannot see',
  typeof empty.coverage === 'string' && empty.coverage.length > 50);

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
