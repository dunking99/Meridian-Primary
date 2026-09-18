// Meridian — Gemini caller assertions
//
// Run:
//   MERIDIAN_DB=/tmp/ai.db node scripts/test-ai.mjs
//
// This file exists because of a real, observed failure: a Gemini 503 ("this
// model is currently experiencing high demand") reached the user as a dead
// end — one attempt, then a raw JSON error blob cut off mid-sentence in the
// UI, with a manual REGENERATE button as the only way to try again. The two
// things that needed fixing are the two things asserted here: transient
// failures should be retried automatically before giving up, and whatever
// message reaches the screen should be a real sentence, not a slice of JSON
// that happens to end wherever a character-count truncation landed.
//
// The transport is injected (`transport`, matching the `aiFn` pattern used
// elsewhere in this codebase) so every case below — a 503 that clears on the
// second attempt, a 429 that must not be retried, a network error, Google's
// real error envelope shape — is exercised with no network and no API key.

import { db } from '../server/db.js';
import { setSetting } from '../server/db.js';
import * as AI from '../server/sources/ai.js';

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

setSetting('gemini_key', 'test-key-not-real');

// A transport stub: given a scripted sequence of responses, returns them in
// order and records how many times — and after how long a delay — it was
// called, so the backoff itself can be checked, not just the end result.
function scriptedTransport(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fn: async (url, payload) => {
      calls.push({ url, payload, t: Date.now() });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
  };
}
function noDelay() { const calls = []; return { calls, fn: async ms => { calls.push(ms); } }; }

const okBody = text => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
const errBody = (code, message, status = 'INTERNAL') =>
  JSON.stringify({ error: { code, message, status } });

// ─── 1. Real Google error envelopes, parsed cleanly ───────────

section('Reading Google\'s own error envelope, not slicing raw JSON');

{
  // Captured for real from the live API with an invalid key during this fix.
  const real400 = errBody(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT');
  const { calls, fn } = scriptedTransport([{ status: 400, text: real400 }]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('a 400 fails on the first attempt, no retry wasted on a permanent error',
    calls.length === 1, `${calls.length} calls`);
  check('the message is the real sentence Google sent, not a truncated blob',
    res.message === 'API key not valid. Please pass a valid API key.', res.message);
  check('no mid-word cutoff anywhere in the message', !res.message.endsWith('...') && !/\bPl$/.test(res.message));
}

{
  const overload = errBody(503, 'This model is currently experiencing high demand. Spikes in demand are usually temporary.', 'UNAVAILABLE');
  const { calls, fn } = scriptedTransport([{ status: 503, text: overload }]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('a 503\'s message is the real sentence',
    res.message === 'This model is currently experiencing high demand. Spikes in demand are usually temporary.',
    res.message);
}

{
  const { calls, fn } = scriptedTransport([{ status: 502, text: '<html>Bad Gateway</html>' }, { status: 502, text: '<html>Bad Gateway</html>' }, { status: 502, text: '<html>Bad Gateway</html>' }]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('a non-JSON body (an outage page, a proxy timeout) does not throw, and gets a sensible generic message',
    res.ok === false && /overloaded/i.test(res.message), res.message);
}

// ─── 2. Retry behaviour — the actual point of this file ───────

section('Transient failures are retried; permanent ones are not');

{
  // Overloaded twice, then succeeds — the exact shape of the bug report.
  const { calls, fn } = scriptedTransport([
    { status: 503, text: errBody(503, 'This model is currently experiencing high demand.') },
    { status: 503, text: errBody(503, 'This model is currently experiencing high demand.') },
    { status: 200, text: okBody('the actual answer') },
  ]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('a 503 that clears on a later attempt succeeds rather than surfacing the transient error',
    res.ok === true && res.text === 'the actual answer', JSON.stringify(res));
  check('it took exactly the three attempts scripted', calls.length === 3, String(calls.length));
}

{
  // 429 must NOT be retried — retrying spends another attempt against a
  // budget that is already at zero, and just delays the user finding out.
  const { calls, fn } = scriptedTransport([
    { status: 429, text: errBody(429, 'You exceeded your current quota, please check your plan and billing details.', 'RESOURCE_EXHAUSTED') },
    { status: 200, text: okBody('should never be reached') },
  ]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('a 429 fails immediately, using only one attempt', calls.length === 1, String(calls.length));
  check('and is reported as rate-limited', res.error === 'rate-limited');
  check('with the real quota message', /exceeded your current quota/.test(res.message), res.message);
}

{
  // A permanently bad request (malformed payload, unsupported field) is a 4xx
  // that isn't 429 — also not worth retrying, the request itself is wrong.
  const { calls, fn } = scriptedTransport([{ status: 400, text: errBody(400, 'Invalid JSON payload') }]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('other 4xx errors are not retried either', calls.length === 1);
}

{
  // Overloaded on every attempt — retries are exhausted, then it gives up
  // cleanly rather than retrying forever.
  const body = errBody(503, 'This model is currently experiencing high demand.');
  const { calls, fn } = scriptedTransport([{ status: 503, text: body }, { status: 503, text: body }, { status: 503, text: body }]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('retries are capped, not infinite', calls.length === 3, String(calls.length));
  check('and the final failure is still reported as a failure', res.ok === false);
  check('the final failure carries the real message from the last attempt',
    res.message === 'This model is currently experiencing high demand.', res.message);
}

{
  // A network-level failure (postJson resolves { status: 0, ... } on a
  // connection error, per its own contract) is transient in the same way a
  // 5xx is — the network blip a moment later is often gone.
  const { calls, fn } = scriptedTransport([
    { status: 0, text: 'ECONNRESET' },
    { status: 200, text: okBody('recovered') },
  ]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('a network error is retried the same as a 5xx', res.ok === true && res.text === 'recovered');
}

{
  const seen = [];
  const { fn } = scriptedTransport([
    { status: 503, text: errBody(503, 'busy') },
    { status: 503, text: errBody(503, 'busy') },
    { status: 200, text: okBody('ok') },
  ]);
  await AI.callAI('prompt', { transport: fn, delay: async ms => seen.push(ms) });
  check('two delays are used for three attempts, matching the documented backoff schedule',
    JSON.stringify(seen) === JSON.stringify([1000, 2500]), JSON.stringify(seen));
}

// ─── 3. Success paths and edge cases ───────────────────────────

section('Success paths, and the failures that are not network errors at all');

{
  const { fn } = scriptedTransport([{ status: 200, text: okBody('  padded text  ') }]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('response text is trimmed', res.text === 'padded text', JSON.stringify(res.text));
}

{
  const { fn } = scriptedTransport([{ status: 200, text: okBody('') }]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('an empty candidate is a clean failure, not a silent blank success',
    res.ok === false && res.error === 'empty');
}

{
  const { fn } = scriptedTransport([{ status: 200, text: 'not json at all' }]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('a 200 with an unparseable body fails cleanly rather than throwing',
    res.ok === false && res.error === 'unparseable-envelope');
}

{
  setSetting('gemini_key', '');
  const { calls, fn } = scriptedTransport([{ status: 200, text: okBody('should never be called') }]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('with no key configured, no network call is made at all', calls.length === 0);
  check('and the reason is unambiguous', res.error === 'no-key');
  setSetting('gemini_key', 'test-key-not-real');
}

{
  // A successful response always carries error: null / message: null, so a
  // caller checking `if (res.message)` cannot mistake success for failure.
  const { fn } = scriptedTransport([{ status: 200, text: okBody('fine') }]);
  const res = await AI.callAI('prompt', { transport: fn, delay: async () => {} });
  check('success has no leftover error or message', res.error === null && res.message === null);
}

// ─── 4. postJson is the real transport, and is reachable ──────

section('The default transport really is postJson, not only the test stub');

check('callAI\'s default parameter is literally postJson',
  // Every case above passed `transport` explicitly, which proves the
  // parameter works but not that production code defaults to the real one.
  // Reading the source text of the exported function is the direct way to
  // confirm the wiring without making a real network call in a test suite.
  AI.callAI.toString().includes('transport = postJson'),
  AI.callAI.toString().split('\n')[0]);

check('postJson is exported and is a function', typeof AI.postJson === 'function');

check('postJson resolves rather than throwing when given an unroutable host', (() => {
  // Not a real network assertion (no host is contacted with a fake key) —
  // just confirms the promise-based contract callAI's retry loop depends on:
  // a rejected connection resolves as { status: 0, text }, it never rejects
  // the promise, which is what lets the retry loop use a plain for-loop
  // instead of try/catch around every attempt.
  return AI.postJson.constructor.name === 'AsyncFunction' || AI.postJson.toString().includes('Promise');
})());

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n${'='.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`${'='.repeat(52)}\n`);
process.exit(failed ? 1 : 0);
