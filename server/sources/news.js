// Meridian v2 — RSS news ingestion with symbol tagging
// No XML library: RSS is regular enough that a tolerant regex parser handles
// every feed in config without adding a dependency.

import https from 'https';
import http from 'http';
import { RSS_FEEDS, SYMBOLS } from '../config.js';
import { run, all, one } from '../db.js';

// A hard timeout matters more now than it did at 8 feeds: refreshNews() awaits
// each feed serially, so one stalled connection (no response, no error, just
// silence) would otherwise block the entire refresh cycle indefinitely.
const FETCH_TIMEOUT_MS = 15_000;

function fetchText(url, redirects = 3) {
  return new Promise(resolve => {
    const lib = url.startsWith('http://') ? http : https;
    const u = new URL(url);
    const req = lib.get({
      hostname: u.hostname, path: u.pathname + u.search, port: u.port || undefined,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Meridian/2.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).href, redirects - 1));
      }
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve({ ok: res.statusCode === 200, body: Buffer.concat(c).toString() }));
    });
    req.on('error', () => resolve({ ok: false, body: '' }));
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy());
  });
}

const strip = s => (s ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? strip(m[1]) : null;
};

export function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) ?? [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    if (!title) continue;
    let link = tag(b, 'link');
    if (!link) {
      const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = m ? m[1] : null;
    }
    const dateStr = tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'dc:date');
    const published = dateStr ? Date.parse(dateStr) : Date.now();
    items.push({
      guid: tag(b, 'guid') ?? link ?? title,
      title,
      url: link,
      published: isNaN(published) ? Date.now() : published,
      summary: (tag(b, 'description') ?? tag(b, 'summary') ?? '').slice(0, 600),
    });
  }
  return items;
}

// Map company/instrument words to symbols so stories can be flagged against holdings.
const NAME_HINTS = {
  'VUSA.L': ['s&p 500', 's&p500', 'sp500'],
  '^GSPC': ['s&p 500', 'wall street'],
  '^FTSE': ['ftse', 'footsie', 'london stock exchange'],
  '^IXIC': ['nasdaq'],
  'GC=F': ['gold'], 'IGLN.L': ['gold'], 'SGLN.L': ['gold'],
  'CL=F': ['oil', 'crude', 'wti'], 'BZ=F': ['brent'],
  'NG=F': ['natural gas', 'gas price'],
  'SEMI.L': ['semiconductor', 'chipmaker', 'chips', 'nvidia', 'tsmc', 'asml'],
  'DFND.L': ['defence', 'defense', 'aerospace'],
  'SJPA.L': ['japan', 'nikkei', 'bank of japan'],
  'IIND.L': ['india', 'rupee'],
  'EEM': ['emerging market'], 'EXCS.L': ['emerging market'],
  '^VIX': ['volatility', 'vix'],
  '^TNX': ['treasury', 'yields', 'bond market'],
  'GBPUSD=X': ['sterling', 'pound', 'gbp'],
  'EURUSD=X': ['euro', 'ecb'],
};

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `extraHoldings` is a list of held/watched instruments beyond the SYMBOLS
// universe — either plain ticker strings (watchlist) or { symbol, name }
// objects (portfolio holdings, which have a real company name in the DB).
export function tagSymbols(text, extraHoldings = []) {
  const lower = text.toLowerCase();
  const found = new Set();

  // Thematic hints and instrument display names (case-insensitive phrase match).
  for (const [sym, words] of Object.entries(NAME_HINTS)) {
    if (words.some(w => lower.includes(w))) found.add(sym);
  }
  for (const [sym, meta] of Object.entries(SYMBOLS)) {
    if (meta.name && lower.includes(meta.name.toLowerCase())) found.add(sym);
  }

  // Ticker match — checked against the ORIGINAL (case-preserved) text.
  // A lowercased scan turns any real-word ticker (e.g. ALL, SO, IT) into a
  // near-constant false positive on ordinary prose, since news text is
  // mostly lowercase common words but tickers are conventionally written
  // in caps. Requires an exact-case whole-word match instead.
  const tickers = [...Object.keys(SYMBOLS), ...extraHoldings.map(h => typeof h === 'string' ? h : h.symbol)];
  for (const sym of tickers) {
    const base = sym.replace(/[\^]|\.L$|=X$|=F$/g, '');
    if (base.length >= 3 && new RegExp(`\\b${escapeRegex(base)}\\b`).test(text)) found.add(sym);
  }

  // Company-name match for individual stock holdings, which aren't in the
  // SYMBOLS universe and almost never appear in prose by their ticker
  // ("Meta Platforms fell 4%", not "META fell 4%").
  for (const h of extraHoldings) {
    if (typeof h === 'string' || !h.name) continue;
    const name = h.name.toLowerCase().replace(/\s+(plc|inc\.?|corp\.?|corporation|ltd\.?|class\s+\w+.*)$/i, '').trim();
    if (name.length >= 4 && lower.includes(name)) found.add(h.symbol);
  }

  return [...found];
}

/** Crude lexicon sentiment. Deliberately simple — it is a filter aid, not a signal. */
const POS = ['rally','surge','gain','jump','beat','upgrade','record','boost','optimism','recovery','strong','rise','soar','profit','rebound','outperform'];
const NEG = ['fall','slump','plunge','loss','miss','downgrade','fear','recession','warn','weak','crash','slide','cut','risk','tumble','selloff','underperform'];

// Words that flip the polarity of a nearby POS/NEG hit — "fears eased" is not
// bearish even though "fear" is a NEG word. Checked in a small window around
// each hit rather than a substring scan, so word order matters.
const NEGATORS = ['not', 'no', 'never', 'without', 'unlikely', 'fails', 'failed', 'denies', 'denied', 'avoid', 'avoids', 'avoided', 'despite'];
const SOFTENERS = ['eased', 'eases', 'easing', 'cooled', 'cools', 'cooling', 'recede', 'recedes', 'receded', 'receding', 'abate', 'abated', 'abating', 'soften', 'softened', 'softening', 'calmed', 'calms', 'calming'];

export function scoreSentiment(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
  let s = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let sign = POS.some(kw => w.includes(kw)) ? 1 : NEG.some(kw => w.includes(kw)) ? -1 : 0;
    if (!sign) continue;
    const before = words.slice(Math.max(0, i - 3), i);
    const after = words.slice(i + 1, i + 3);
    if (before.some(b => NEGATORS.includes(b) || b.endsWith("n't"))) sign = -sign;
    if (after.some(a => SOFTENERS.includes(a))) sign = -sign;
    s += sign;
  }
  return Math.max(-1, Math.min(1, s / 4));
}

// ─── Deduplication ────────────────────────────────────────────
// The same story reaches us from several feeds at once (and some feeds repeat
// their own items), which is why the feed showed identical headlines stacked
// back to back. Rather than deleting repeats, the later copy is marked with
// dup_of so the canonical story can advertise "also reported by N sources" —
// which is itself a useful signal that a story is a big one.

const DUP_STOPWORDS = new Set([
  'the','a','an','and','or','but','of','to','in','on','at','for','with','from',
  'by','as','is','are','was','were','be','been','it','its','that','this','after',
  'over','into','than','then','says','say','said','new','up','down','out','not',
]);

/** Order-independent fingerprint of a headline's significant words. */
export function titleSignature(title) {
  const words = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !DUP_STOPWORDS.has(w));
  return [...new Set(words)].sort();
}

export function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const w of a) if (setB.has(w)) shared++;
  return shared / (a.length + b.length - shared);
}

// Two headlines counting as "the same story". Tuned high: merging two genuinely
// different stories hides news, which is worse than showing a near-duplicate.
const DUP_THRESHOLD = 0.82;
const DUP_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Find an existing story this one duplicates, within a recent window.
 * `recent` is passed in (rather than queried per item) so a refresh of ~47
 * feeds doesn't run thousands of queries.
 */
export function findDuplicate(title, recent) {
  const sig = titleSignature(title);
  if (sig.length < 3) return null;   // too short to compare meaningfully
  for (const r of recent) {
    if (jaccard(sig, r.sig) >= DUP_THRESHOLD) return r.guid;
  }
  return null;
}

// ─── Live on-demand search (Research page) ─────────────────────
// The standing 47-feed pipeline above only surfaces a story if it happened to
// be tagged against a symbol already in SYMBOLS or a current holding/watchlist
// item — fine for the News page, useless for "look up an arbitrary ticker the
// app has never heard of". Google News' public search RSS needs no API key
// and reuses the same tolerant parseFeed() this file already has, so a fresh
// per-query fetch fills that gap instead of adding a second parser.
function splitGoogleNewsTitle(title) {
  // Google News RSS titles are "Headline - Publisher". A plain rsplit on the
  // last " - " misparses headlines that themselves contain a hyphenated
  // clause, but publisher names essentially never contain " - ", so anchoring
  // on the last occurrence is the safer split of the two.
  const i = title.lastIndexOf(' - ');
  return i === -1 ? { headline: title, source: 'Google News' } : { headline: title.slice(0, i), source: title.slice(i + 3) };
}

export async function searchLiveNews(query, { limit = 15 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-GB&gl=GB&ceid=GB:en`;
  const res = await fetchText(url);
  if (!res.ok || !res.body) return [];
  const items = parseFeed(res.body);
  return items.slice(0, limit).map(it => {
    const { headline, source } = splitGoogleNewsTitle(it.title);
    return {
      guid: it.guid,
      source,
      title: headline,
      url: it.url,
      published: it.published,
      summary: it.summary,
      sentiment: scoreSentiment(`${headline} ${it.summary}`),
      live: true,
    };
  });
}

export async function refreshNews(extraHoldings = []) {
  let added = 0, duplicates = 0, failed = [];

  // Recent stories, kept in memory for the whole pass so each new item can be
  // compared against both what was already stored and what this run just added.
  const recent = all(
    'SELECT guid, title FROM news WHERE published >= ? AND dup_of IS NULL ORDER BY published DESC LIMIT 600',
    Date.now() - DUP_WINDOW_MS
  ).map(r => ({ guid: r.guid, sig: titleSignature(r.title) }));

  for (const feed of RSS_FEEDS) {
    const res = await fetchText(feed.url);
    if (!res.ok || !res.body) { failed.push(feed.source); continue; }
    const items = parseFeed(res.body);
    if (!items.length) { failed.push(feed.source); continue; }
    for (const it of items) {
      const text = `${it.title} ${it.summary}`;
      const syms = tagSymbols(text, extraHoldings);
      try {
        const existing = one('SELECT guid FROM news WHERE guid = ?', it.guid);
        if (existing) continue;

        const dupOf = findDuplicate(it.title, recent);

        run(`INSERT INTO news (guid, source, title, url, published, summary, tags, symbols, sentiment, fetched_at, dup_of, feed_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            it.guid, feed.source, it.title, it.url, it.published, it.summary,
            JSON.stringify(feed.tags), JSON.stringify(syms),
            scoreSentiment(text), Date.now(), dupOf, feed.id);

        if (dupOf) {
          duplicates++;
        } else {
          added++;
          recent.unshift({ guid: it.guid, sig: titleSignature(it.title) });
        }
      } catch { /* duplicate guid */ }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  // keep the table bounded
  run(`DELETE FROM news WHERE guid IN (
        SELECT guid FROM news ORDER BY published DESC LIMIT -1 OFFSET 2000)`);
  // Several feeds share a source name (BBC has three), so the raw list repeats
  // — dedupe before it reaches the UI's "N feeds failed" banner.
  return { added, duplicates, failed: [...new Set(failed)], failedCount: failed.length,
           sources: RSS_FEEDS.length };
}

// ─── Ranking ──────────────────────────────────────────────────
// A pure newest-first feed buries the stories that matter. The smart ordering
// combines: how relevant the story is (AI verdict where we have one), how much
// weight the source carries, whether it touches something actually owned, and
// how fresh it is.

// Keyed by feed id, not source name: BBC publishes a business feed and a
// homepage feed, and treating them as one "BBC" weight would throw away
// exactly the signal-vs-noise distinction this ranking exists to make.
const FEED_WEIGHTS = Object.fromEntries(
  RSS_FEEDS.map(f => [f.id, f.weight ?? 1])
);
// Rows written before feed_id existed only have a source name — fall back to
// the average weight across that source's feeds rather than assuming 1.
const SOURCE_WEIGHTS = {};
for (const f of RSS_FEEDS) {
  (SOURCE_WEIGHTS[f.source] ??= []).push(f.weight ?? 1);
}
for (const [src, ws] of Object.entries(SOURCE_WEIGHTS)) {
  SOURCE_WEIGHTS[src] = ws.reduce((a, b) => a + b, 0) / ws.length;
}

export function feedWeight(row) {
  if (row.feed_id && FEED_WEIGHTS[row.feed_id] != null) return FEED_WEIGHTS[row.feed_id];
  return SOURCE_WEIGHTS[row.source] ?? 1;
}

/**
 * Relevance for a story the AI hasn't reached yet.
 * Deliberately mediocre-but-safe: it leans on the feed's own tags so a
 * dedicated markets feed outranks a general one, without pretending to the
 * judgement the AI pass provides. Sits mid-range so unscored stories neither
 * dominate the top nor get buried.
 */
export function heuristicRelevance(row) {
  const tags = safeParse(row.tags, []);
  const marketish = ['markets', 'economic-data', 'centralbank', 'commodities', 'crypto'];
  let base = tags.some(t => marketish.includes(t)) ? 50 : 35;
  if (safeParse(row.symbols, []).length) base += 8;
  return Math.min(base, 60);
}

const HOUR = 3600_000;

export function rankScore(row, { held = [], watched = [] } = {}) {
  const relevance = row.ai_scored_at != null
    ? (row.ai_relevance ?? 0)
    : heuristicRelevance(row);

  // Source weight matters less as relevance rises: a genuinely important story
  // from a general-interest feed should still surface.
  const w = feedWeight(row);
  let score = relevance * (1 + (w - 1) * (1 - relevance / 100));

  // The AI's symbol read is better than the keyword tagger's — prefer it.
  const aiSyms = safeParse(row.ai_symbols, null);
  const syms = aiSyms ?? safeParse(row.symbols, []);
  if (syms.some(s => held.includes(s))) score += 35;
  else if (syms.some(s => watched.includes(s))) score += 18;

  // Recency decay, gentle for the first few hours then steeper. A day-old
  // major story should still beat a fresh trivial one, so this is bounded.
  const ageH = Math.max(0, (Date.now() - (row.published ?? 0)) / HOUR);
  score -= Math.min(30, 6 * Math.log2(1 + ageH));

  return score;
}

export function getNews({
  limit = 60, symbol = null, source = null, since = null,
  sort = 'smart', minRelevance = 0, category = null,
  includeDupes = false, held = [], watched = [],
} = {}) {
  let sql = 'SELECT * FROM news WHERE 1=1';
  const p = [];
  if (symbol) { sql += ' AND (symbols LIKE ? OR ai_symbols LIKE ?)'; p.push(`%"${symbol}"%`, `%"${symbol}"%`); }
  if (source) { sql += ' AND source = ?'; p.push(source); }
  if (since)  { sql += ' AND published >= ?'; p.push(since); }
  if (category) { sql += ' AND ai_category = ?'; p.push(category); }
  if (!includeDupes) sql += ' AND dup_of IS NULL';
  // An unscored story has no AI relevance yet — judge it by the heuristic
  // rather than excluding it, or a threshold filter would blank the feed
  // every time fresh stories arrive ahead of the scoring pass.
  if (minRelevance > 0) {
    sql += ' AND (ai_relevance >= ? OR ai_scored_at IS NULL)';
    p.push(minRelevance);
  }

  // Over-fetch when ranking: the top N by score isn't the top N by date.
  const pool = sort === 'smart' ? Math.max(limit * 4, 200) : limit;
  sql += ' ORDER BY published DESC LIMIT ?'; p.push(pool);

  let rows = all(sql, ...p);

  // Duplicate counts let the UI show "also reported by N" on the canonical row.
  const dupCounts = {};
  for (const r of all('SELECT dup_of, COUNT(*) n FROM news WHERE dup_of IS NOT NULL GROUP BY dup_of')) {
    dupCounts[r.dup_of] = r.n;
  }

  let mapped = rows.map(r => {
    const aiSymbols = safeParse(r.ai_symbols, null);
    return {
      ...r,
      tags: safeParse(r.tags, []),
      // Prefer the AI's symbol read, falling back to the keyword tagger.
      symbols: aiSymbols ?? safeParse(r.symbols, []),
      keywordSymbols: safeParse(r.symbols, []),
      aiSymbols,
      relevance: r.ai_scored_at != null ? r.ai_relevance : heuristicRelevance(r),
      scored: r.ai_scored_at != null,
      // The AI reads market sentiment properly; the lexicon is a fallback.
      sentiment: r.ai_scored_at != null && r.ai_sentiment != null ? r.ai_sentiment : r.sentiment,
      why: r.ai_why || null,
      category: r.ai_category || null,
      alsoReported: dupCounts[r.guid] ?? 0,
      _score: rankScore(r, { held, watched }),
    };
  });

  if (minRelevance > 0) mapped = mapped.filter(r => (r.relevance ?? 0) >= minRelevance);

  if (sort === 'smart') mapped.sort((a, b) => b._score - a._score);
  else mapped.sort((a, b) => (b.published ?? 0) - (a.published ?? 0));

  // _score is a ranking intermediate, not part of the API surface.
  return mapped.slice(0, limit).map(({ _score, ...rest }) => rest);
}

const safeParse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
