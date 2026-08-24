// Meridian — AI relevance scoring for news
//
// The problem this solves: keyword tagging can't tell "Japan faces $63bn fiscal
// shortfall" from "Japan's busy PM had one Saturday for errands". Both mention
// Japan, both got tagged SJPA.L, and with a newest-first feed the second one
// outranked genuinely market-moving stories. No amount of keyword tuning fixes
// that — it needs judgement about what the story is actually about.
//
// So each story is scored once by the AI and the verdict cached forever.
// Scoring is deliberately incremental: a bounded number of stories per refresh
// cycle, batched into few requests, so this stays inside the Gemini free tier.
//
// Everything degrades safely. No key, rate limit, malformed JSON, AI offline —
// stories just stay unscored and the ranking falls back to a heuristic. The
// news pipeline never depends on the AI being reachable.

import { all, one, run } from '../db.js';
import { callAI, hasGeminiKey } from '../sources/ai.js';

// Batch/volume limits. 10 stories per request keeps each prompt well inside
// the output token budget while making ~4 requests cover a typical refresh.
export const BATCH_SIZE = 10;
export const MAX_PER_CYCLE = 40;
// After this many failed attempts a story is left alone permanently — usually
// it's something the model refuses or a parse that never resolves, and retrying
// forever would silently eat quota on every single cycle.
export const MAX_ATTEMPTS = 3;

export const CATEGORIES = [
  'markets', 'macro', 'policy', 'geopolitics',
  'company', 'commodities', 'crypto', 'noise',
];

function buildPrompt(stories, universe) {
  const list = stories.map((s, i) =>
    `${i + 1}. [${s.source}] ${s.title}${s.summary ? `\n   ${s.summary.slice(0, 240)}` : ''}`
  ).join('\n');

  return `You are a buy-side analyst triaging a news feed for a UK private investor.

Their portfolio and watchlist symbols: ${universe.length ? universe.join(', ') : '(none set)'}

For EACH numbered story below, judge how much it matters to an investor making
decisions — not how interesting it is as general news.

Scoring guide for "relevance" (0-100):
  85-100: directly moves markets or this investor's holdings (central bank decisions,
          major economic data, a held company's results, big commodity moves)
  60-84:  clear market or macro significance, indirect effect
  35-59:  business/economic news with limited market impact
  15-34:  general news with a faint economic angle
  0-14:   no investment relevance (human interest, sport, lifestyle, crime,
          local politics with no market channel)

Be strict. A story that merely MENTIONS a country or company an investor holds is
NOT relevant unless the story itself has market significance. "Japan's PM visited a
dentist" is 0-5 even for an investor holding Japanese equities.

Return ONLY a JSON array, one object per story, in the same order:
[{"n":1,"relevance":0-100,"category":"markets|macro|policy|geopolitics|company|commodities|crypto|noise","symbols":["TICKER"],"sentiment":-1.0..1.0,"why":"one short sentence"}]

Rules:
- "symbols": ONLY tickers from the list above that the story genuinely implicates. Empty array if none. Never invent tickers.
- "sentiment": market sentiment, not editorial tone. Positive = risk-on/bullish.
- "why": max 15 words, plain English, why an investor should care. For irrelevant stories: "Not market relevant".
- "category": "noise" for anything scoring under 15.

Stories:
${list}`;
}

/** Pull the first JSON array out of a model response, tolerating stray prose or code fences. */
export function extractJsonArray(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Coerce one raw AI object into a trusted row.
 * The model is an untrusted source here — every field is range-checked, and
 * symbols are intersected against the real universe so a hallucinated ticker
 * can never enter the database.
 */
export function normalizeVerdict(raw, universe) {
  if (!raw || typeof raw !== 'object') return null;

  const relevance = clamp(Math.round(Number(raw.relevance)), 0, 100);
  if (!Number.isFinite(relevance)) return null;

  let category = String(raw.category ?? '').toLowerCase().trim();
  if (!CATEGORIES.includes(category)) category = relevance < 15 ? 'noise' : 'markets';

  const allowed = new Set(universe);
  const symbols = Array.isArray(raw.symbols)
    ? [...new Set(raw.symbols.map(s => String(s).trim()).filter(s => allowed.has(s)))]
    : [];

  let sentiment = Number(raw.sentiment);
  sentiment = Number.isFinite(sentiment) ? clamp(sentiment, -1, 1) : 0;

  const why = String(raw.why ?? '').trim().slice(0, 200);

  return { relevance, category, symbols, sentiment, why };
}

function persist(guid, v) {
  run(`UPDATE news SET ai_relevance = ?, ai_category = ?, ai_symbols = ?,
                       ai_sentiment = ?, ai_why = ?, ai_scored_at = ?
       WHERE guid = ?`,
      v.relevance, v.category, JSON.stringify(v.symbols),
      v.sentiment, v.why, Date.now(), guid);
}

function bumpAttempts(guids) {
  for (const g of guids) {
    run('UPDATE news SET ai_attempts = COALESCE(ai_attempts, 0) + 1 WHERE guid = ?', g);
  }
}

/** Stories still awaiting a verdict, newest first — recent news matters most. */
export function pendingStories(limit = MAX_PER_CYCLE) {
  return all(
    `SELECT guid, source, title, summary FROM news
      WHERE ai_scored_at IS NULL
        AND COALESCE(ai_attempts, 0) < ?
        AND dup_of IS NULL
      ORDER BY published DESC
      LIMIT ?`,
    MAX_ATTEMPTS, limit
  );
}

export function scoringStats() {
  const r = one(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN ai_scored_at IS NOT NULL THEN 1 ELSE 0 END) scored,
      SUM(CASE WHEN ai_scored_at IS NULL AND COALESCE(ai_attempts,0) >= ? THEN 1 ELSE 0 END) gaveUp
    FROM news WHERE dup_of IS NULL`, MAX_ATTEMPTS);
  return {
    total: r?.total ?? 0,
    scored: r?.scored ?? 0,
    gaveUp: r?.gaveUp ?? 0,
    pending: Math.max(0, (r?.total ?? 0) - (r?.scored ?? 0) - (r?.gaveUp ?? 0)),
  };
}

/**
 * Score a bounded slice of unscored stories.
 * `aiFn` is injectable purely so this can be tested without network access.
 */
export async function scoreNewStories(universe = [], { aiFn = callAI, maxPerCycle = MAX_PER_CYCLE } = {}) {
  if (!hasGeminiKey() && aiFn === callAI) {
    return { scored: 0, skipped: 0, reason: 'no-key' };
  }

  const pending = pendingStories(maxPerCycle);
  if (!pending.length) return { scored: 0, skipped: 0, reason: 'nothing-pending' };

  let scored = 0, skipped = 0, reason = null;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const res = await aiFn(buildPrompt(batch, universe), { maxTokens: 2048, temperature: 0.1 });

    if (!res.ok) {
      // Rate limiting means every further request this cycle fails too — stop
      // immediately rather than burning through the remaining batches.
      bumpAttempts(batch.map(s => s.guid));
      skipped += batch.length;
      reason = res.error;
      if (res.error === 'rate-limited' || res.error === 'no-key') break;
      continue;
    }

    const arr = extractJsonArray(res.text);
    if (!arr) {
      bumpAttempts(batch.map(s => s.guid));
      skipped += batch.length;
      reason = 'unparseable';
      continue;
    }

    // Match verdicts back by their "n" index where given, falling back to
    // positional order — models occasionally drop the field but keep the order.
    const seen = new Set();
    arr.forEach((raw, idx) => {
      const n = Number(raw?.n);
      const pos = Number.isFinite(n) ? n - 1 : idx;
      const story = batch[pos];
      if (!story || seen.has(story.guid)) return;
      const v = normalizeVerdict(raw, universe);
      if (!v) return;
      seen.add(story.guid);
      persist(story.guid, v);
      scored++;
    });

    // Anything the model silently omitted counts as an attempt so a story that
    // consistently gets dropped eventually stops being retried.
    const missed = batch.filter(s => !seen.has(s.guid));
    if (missed.length) {
      bumpAttempts(missed.map(s => s.guid));
      skipped += missed.length;
    }

    // Gentle pacing between batches — the free tier is per-minute limited.
    if (i + BATCH_SIZE < pending.length) await new Promise(r => setTimeout(r, 1200));
  }

  return { scored, skipped, reason };
}
