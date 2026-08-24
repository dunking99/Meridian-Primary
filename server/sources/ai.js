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

import https from 'https';
import { getSetting } from '../db.js';

export const GEMINI_MODEL = 'gemini-3.6-flash';
const TIMEOUT_MS = 30_000;

export function getGeminiKey() {
  const k = getSetting('gemini_key', '');
  return typeof k === 'string' ? k.trim() : '';
}

export function hasGeminiKey() {
  return getGeminiKey().length > 0;
}

function postJson(url, payload) {
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

/**
 * Single-shot text generation.
 * Returns { ok, text, error } — never throws, so a scoring pass can degrade
 * to "leave these stories unscored and try again next cycle" rather than
 * taking down the refresh loop.
 *
 * `temperature` defaults low: scoring wants consistency, not creativity.
 */
export async function callAI(prompt, { maxTokens = 2048, temperature = 0.1 } = {}) {
  const key = getGeminiKey();
  if (!key) return { ok: false, text: '', error: 'no-key' };

  const res = await postJson(
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

  if (res.status !== 200) {
    // 429 is the free tier's rate limit — the caller backs off rather than
    // hammering, and unscored stories simply wait for the next cycle.
    const rateLimited = res.status === 429;
    return {
      ok: false,
      text: '',
      error: rateLimited ? 'rate-limited' : `http-${res.status}`,
      detail: res.text.slice(0, 200),
    };
  }

  try {
    const data = JSON.parse(res.text);
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '').join('').trim();
    if (!text) return { ok: false, text: '', error: 'empty' };
    return { ok: true, text };
  } catch {
    return { ok: false, text: '', error: 'unparseable-envelope' };
  }
}
