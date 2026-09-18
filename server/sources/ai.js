// Meridian — server-side Gemini caller
//
// The frontend has its own callAI() for interactive, on-demand features. This
// is the backend equivalent, needed because news scoring happens at ingest
// time on the refresh loop, when no browser is necessarily open.
//
// The key is stored in the settings table rather than a .env file: the user
// already pastes it into the Settings page, and the frontend pushes it here
// so there's a single place to manage it. No npm dependency — plain https,
// matching the rest of server/sources/.
//
// ─── Retrying, and why only sometimes ─────────────────────────
//
// Two failure shapes reach this function under real use, and they call for
// opposite responses. A 503 ("this model is currently experiencing high
// demand") is Google's servers being briefly overloaded — the same request a
// few seconds later routinely succeeds, so it is retried automatically with
// backoff. A 429 (quota exceeded) means the free tier's request budget for
// this window is genuinely spent — retrying immediately does not find spare
// capacity, it just spends another attempt against a budget that is already
// at zero, and stacks up the delay before the caller finds out nothing will
// work. So 429, and any other 4xx (bad key, malformed request — errors that
// are wrong about the request, not about a busy server), fail fast. Only
// network errors and 5xx responses are retried.

import https from 'https';
import { getSetting } from '../db.js';

export const GEMINI_MODEL = 'gemini-3.6-flash';
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2500];

export function getGeminiKey() {
  const k = getSetting('gemini_key', '');
  return typeof k === 'string' ? k.trim() : '';
}

export function hasGeminiKey() {
  return getGeminiKey().length > 0;
}

export function postJson(url, payload) {
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const text = Buffer.concat(c).toString();
        resolve({ status: res.statusCode, text });
      });
    });
    req.on('error', e => resolve({ status: 0, text: String(e.message || e) }));
    req.setTimeout(TIMEOUT_MS, () => req.destroy());
    req.write(body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * A human-readable message from whatever Google sent back.
 *
 * The API's own error envelope is { error: { code, message, status } }, and
 * `message` is already a real sentence — "API key not valid. Please pass a
 * valid API key.", not a code to translate. Prefer it outright; fall back to
 * a status-shaped generic only when the body isn't that envelope (a proxy
 * timeout, an HTML error page from an outage), and never hand back a
 * mid-sentence slice of raw JSON — a message truncated at an arbitrary
 * character count reads as the app being broken, not as an API error.
 */
function describeError(status, rawText) {
  try {
    const parsed = JSON.parse(rawText);
    const msg = parsed?.error?.message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch { /* not a JSON envelope — fall through */ }

  if (status === 0) return 'Could not reach Gemini — check your internet connection.';
  if (status === 429) return 'Gemini rate-limited this request (free-tier quota).';
  if (status >= 500) return 'Gemini is currently overloaded.';
  return `Gemini request failed (HTTP ${status}).`;
}

function isTransient(status) {
  return status === 0 || status >= 500;
}

/**
 * Single-shot text generation, retried automatically for transient failures.
 * Returns { ok, text, error, message } — never throws, so a scoring pass can
 * degrade to "leave these stories unscored and try again next cycle" rather
 * than taking down the refresh loop. `message` is always a clean sentence
 * fit to show a user directly; `error` is a short machine-readable code for
 * callers that branch on the failure kind (e.g. stopping a batch outright on
 * 'rate-limited' rather than ploughing through the rest of it).
 *
 * `temperature` defaults low: scoring wants consistency, not creativity.
 */
export async function callAI(prompt, { maxTokens = 2048, temperature = 0.1, transport = postJson, delay = sleep } = {}) {
  const key = getGeminiKey();
  if (!key) return { ok: false, text: '', error: 'no-key', message: 'No Gemini API key set. Add one in Settings.' };

  let last = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1]);

    const res = await transport(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature,
          responseMimeType: 'application/json',
        },
      }
    );

    if (res.status === 200) {
      try {
        const data = JSON.parse(res.text);
        const text = (data?.candidates?.[0]?.content?.parts || [])
          .map(p => p.text || '').join('').trim();
        if (!text) return { ok: false, text: '', error: 'empty', message: 'Gemini returned an empty response.' };
        return { ok: true, text, error: null, message: null };
      } catch {
        return { ok: false, text: '', error: 'unparseable-envelope', message: 'Gemini returned a response that could not be read.' };
      }
    }

    last = res;
    if (!isTransient(res.status)) break; // permanent failure — retrying wastes an attempt and, for 429, quota
  }

  const rateLimited = last.status === 429;
  return {
    ok: false,
    text: '',
    error: rateLimited ? 'rate-limited' : last.status === 0 ? 'network' : `http-${last.status}`,
    message: describeError(last.status, last.text),
    detail: last.text.slice(0, 200),
  };
}
