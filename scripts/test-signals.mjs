// Meridian — cross-engine alert assertions
//
// Run:
//   MERIDIAN_DB=/tmp/sig.db SEED_ONLY=1 node scripts/test-rebuild.mjs
//   MERIDIAN_DB=/tmp/sig.db node scripts/test-signals.mjs
//
// These alert kinds are harder to get right than price thresholds, because
// almost all of them are claims about *change*: the tone flipped, the balance
// reversed, an axis fell through a line. A claim about change is only
// answerable against a remembered previous reading, and the failure mode is
// silent — an alert that re-fires every cycle on the same unchanged finding,
// or one that establishes a baseline and then never speaks again.
//
// So the assertions here are mostly paired: the kind fires when the world
// genuinely changes, AND stays quiet when it is asked again about the same
// unchanged world. Either half passing alone would be a broken alert.

import { all, one, run } from '../server/db.js';
import * as pf from '../server/engines/portfolio.js';
import * as memory from '../server/engines/memory.js';
import * as signals from '../server/engines/signals.js';
import * as research from '../server/engines/research.js';
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
function section(name) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); }

memory.rebuild({});
memory.rebuildRegime({ minSymbols: 2 });

const prices = {};
for (const { symbol } of all('SELECT DISTINCT symbol FROM holdings')) {
  const bars = getBars(symbol);
  const last = bars[bars.length - 1];
  if (last) prices[symbol] = { price: last.adj_close ?? last.close, currency: 'GBP', changePct: 0 };
}
const valued = pf.valuePortfolio(prices);
const run1 = () => signals.evaluateSignals(prices, { research, valued });

const addAlert = ({ symbol = null, kind, threshold = null, repeat = 'once' }) =>
  signals.createSignalAlert({ kind, symbol, threshold, repeat });
function reset() {
  run('DELETE FROM alerts'); run('DELETE FROM alert_events');
  run('DELETE FROM signal_state'); run('DELETE FROM news');
}

// ─── Concentration ────────────────────────────────────────────

section('Concentration breach');
reset();
const biggest = [...valued.positions].sort((a, b) => b.weight - a.weight)[0];
const conc = addAlert({ kind: 'concentration', threshold: Math.floor(biggest.weight) - 5 });

let r = run1();
check('fires when the largest position is over the limit', r.fired.length === 1,
  JSON.stringify(r.fired.map(f => f.message)));
check('the message names the position and its actual weight',
  r.fired[0]?.message.includes(biggest.symbol) && r.fired[0].message.includes(biggest.weight.toFixed(1)));
check('the firing is recorded as an event', signals.alertHistory(conc.id).length === 1);

// Re-running against an unchanged world must not fire again. This is the
// assertion that catches an alert which would spam on every cycle.
run(`UPDATE alerts SET status = 'active' WHERE id = ?`, conc.id);
r = run1();
check('does not fire again on the same unchanged breach', r.fired.length === 0,
  JSON.stringify(r.fired.map(f => f.message)));

reset();
const high = addAlert({ kind: 'concentration', threshold: 99 });
r = run1();
check('stays quiet when no position is over the limit', r.fired.length === 0);
check('nothing is recorded when nothing fires', signals.alertHistory(high.id).length === 0);

// ─── News break ───────────────────────────────────────────────

section('Important news on a holding');
reset();
const now = Date.now();
const newsAlert = addAlert({ symbol: 'CORE.L', kind: 'newsBreak', threshold: 70 });

const story = (guid, title, sym, rel) =>
  run(`INSERT INTO news (guid, source, title, url, published, summary, tags, symbols, fetched_at,
        ai_relevance, ai_scored_at, ai_why, ai_symbols, ai_category, ai_sentiment)
       VALUES (?, 'Reuters', ?, 'http://x', ?, '', '[]', ?, ?, ?, ?, 'because', ?, 'markets', 0.1)`,
      guid, title, now - 3600_000, JSON.stringify([sym]), now, rel, now, JSON.stringify([sym]));

story('low', 'A minor mention of CORE.L', 'CORE.L', 40);
r = run1();
check('a story below the relevance threshold does not fire it', r.fired.length === 0);

story('high', 'CORE.L provider announces a major change', 'CORE.L', 88);
r = run1();
check('a story above the threshold fires it', r.fired.length === 1,
  JSON.stringify(r.fired.map(f => f.message)));
check('the alert carries the story headline', r.fired[0]?.message.includes('major change'));
check('the scorer\'s own reasoning is kept as the detail', r.fired[0]?.detail === 'because');

run(`UPDATE alerts SET status = 'active' WHERE id = ?`, newsAlert.id);
r = run1();
check('the same story does not fire it twice', r.fired.length === 0);

story('high2', 'CORE.L follow-up with new information', 'CORE.L', 91);
run(`UPDATE alerts SET status = 'active' WHERE id = ?`, newsAlert.id);
r = run1();
check('a genuinely new story does fire it again', r.fired.length === 1,
  JSON.stringify(r.fired.map(f => f.message)));

reset();
addAlert({ symbol: 'CORE.L', kind: 'newsBreak', threshold: 70 });
story('other', 'Big news about something you do not hold', 'NOTHELD.L', 95);
r = run1();
check('a high-relevance story about another ticker does not fire it', r.fired.length === 0);

// ─── Lifecycle: repeat modes ──────────────────────────────────

section('Repeat modes');
reset();
const once = addAlert({ kind: 'concentration', threshold: 1, repeat: 'once' });
r = run1();
check('a once alert fires', r.fired.length === 1);
check('and retires itself after firing',
  one('SELECT status FROM alerts WHERE id = ?', once.id).status === 'triggered');
r = run1();
check('a retired once alert does not fire again', r.fired.length === 0);

reset();
const always = addAlert({ kind: 'concentration', threshold: 1, repeat: 'always' });
r = run1();
check('an always alert fires', r.fired.length === 1);
check('and stays armed rather than retiring',
  one('SELECT status FROM alerts WHERE id = ?', always.id).status === 'active');
check('its fire count is tracked',
  one('SELECT fire_count FROM alerts WHERE id = ?', always.id).fire_count === 1);

reset();
const daily = addAlert({ kind: 'concentration', threshold: 1, repeat: 'daily' });
r = run1();
check('a daily alert fires the first time', r.fired.length === 1);
// State memory would suppress the second firing regardless, so this tests the
// gate directly rather than through an evaluator.
check('canFire refuses a second firing on the same day',
  signals.canFire(one('SELECT * FROM alerts WHERE id = ?', daily.id)).ok === false);
run('UPDATE alerts SET last_fired_at = ? WHERE id = ?', Date.now() - 2 * 86400_000, daily.id);
check('canFire allows it again the next day',
  signals.canFire(one('SELECT * FROM alerts WHERE id = ?', daily.id)).ok === true);

// ─── Lifecycle: snooze and mute ───────────────────────────────

section('Snooze and mute');
reset();
const snoozed = addAlert({ kind: 'concentration', threshold: 1, repeat: 'always' });
signals.snooze(snoozed.id, 7);
r = run1();
check('a snoozed alert does not fire', r.fired.length === 0);
check('and says why it was skipped', r.skipped.some(s => s.reason === 'snoozed'),
  JSON.stringify(r.skipped));

signals.unsnooze(snoozed.id);
r = run1();
check('it fires again once unsnoozed', r.fired.length === 1);

run(`UPDATE alerts SET status = 'muted' WHERE id = ?`, snoozed.id);
r = run1();
check('a muted alert does not fire', r.fired.length === 0);
check('and says why', r.skipped.some(s => s.reason === 'muted'));

// ─── History survives re-arming ───────────────────────────────

section('History');
reset();
const hist = addAlert({ kind: 'concentration', threshold: 1, repeat: 'once' });
run1();
signals.rearm(hist.id);
run('DELETE FROM signal_state WHERE alert_id = ?', hist.id);   // force a fresh finding
run1();
check('two firings are both recorded', signals.alertHistory(hist.id).length === 2,
  `${signals.alertHistory(hist.id).length} events`);
check('re-arming does not erase earlier events',
  signals.alertHistory(hist.id).every(e => !!e.message));
check('recentEvents joins the alert back in',
  signals.recentEvents(10)[0]?.kind === 'concentration');

// ─── Portfolio-level kinds with no portfolio ──────────────────

section('Degradation');
reset();
addAlert({ kind: 'axisDrop', threshold: 2.5 });
const noPortfolio = signals.evaluateSignals(prices, { research, valued: { positions: [] } });
check('an axis alert with no positions does not fire', noPortfolio.fired.length === 0);
check('and does not throw', typeof noPortfolio.evaluated === 'number');

reset();
addAlert({ symbol: 'CORE.L', kind: 'sentimentShift' });
const noResearch = signals.evaluateSignals(prices, { valued });
check('a kind needing the research engine is skipped rather than silently passing',
  noResearch.skipped.some(s => s.reason === 'research engine not supplied'),
  JSON.stringify(noResearch.skipped));

reset();
addAlert({ symbol: 'NOSUCH.L', kind: 'signalFlip' });
const unknown = signals.evaluateSignals(prices, { research, valued });
check('an unknown symbol does not throw or fire', unknown.fired.length === 0);

// ─── Descriptions ─────────────────────────────────────────────

section('Descriptions');
reset();
const described = addAlert({ symbol: 'CORE.L', kind: 'newsBreak', threshold: 80 });
const d = signals.describe(one('SELECT * FROM alerts WHERE id = ?', described.id));
check('every signal kind describes itself in words',
  Object.keys(signals.SIGNAL_KINDS).every(k =>
    typeof signals.SIGNAL_KINDS[k].describe({ symbol: 'X', threshold: 1 }) === 'string'));
check('the description reflects the alert\'s own threshold', d.text.includes('80'));
check('scope distinguishes symbol from portfolio kinds',
  signals.SIGNAL_KINDS.newsBreak.scope === 'symbol' &&
  signals.SIGNAL_KINDS.concentration.scope === 'portfolio');
check('isSignalKind separates these from the price kinds',
  signals.isSignalKind('newsBreak') === true && signals.isSignalKind('price') === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
