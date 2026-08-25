// Meridian v2 — persistence layer
// Uses node:sqlite (built into Node 22.5+). No native compilation, no npm install.
// This is the single biggest architectural change from v1: everything that
// mattered used to live in browser localStorage and vanish. Now it persists,
// accumulates history, and can be queried.

import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.js';
import { validateBars } from './engines/integrity.js';

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS price_ticks (
  symbol      TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  price       REAL NOT NULL,
  prev_close  REAL,
  change_pct  REAL,
  PRIMARY KEY (symbol, ts)
);
CREATE INDEX IF NOT EXISTS idx_ticks_symbol_ts ON price_ticks(symbol, ts DESC);

CREATE TABLE IF NOT EXISTS ohlcv (
  symbol TEXT NOT NULL,
  date   TEXT NOT NULL,
  open   REAL, high REAL, low REAL, close REAL, adj_close REAL,
  volume INTEGER,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_date ON ohlcv(symbol, date DESC);

CREATE TABLE IF NOT EXISTS holdings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT NOT NULL,
  name       TEXT,
  qty        REAL NOT NULL DEFAULT 0,
  avg_price  REAL NOT NULL DEFAULT 0,
  currency   TEXT NOT NULL DEFAULT 'GBP',
  sector     TEXT,
  geography  TEXT,
  asset_class TEXT DEFAULT 'Equity',
  account    TEXT DEFAULT 'Main',
  wrapper    TEXT DEFAULT 'ISA',
  acc_dist   TEXT,
  link       TEXT,
  target_pct REAL,
  thesis     TEXT,
  added_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cash (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  account  TEXT NOT NULL,
  wrapper  TEXT DEFAULT 'ISA',
  currency TEXT NOT NULL DEFAULT 'GBP',
  amount   REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol  TEXT NOT NULL,
  date    TEXT NOT NULL,
  side    TEXT NOT NULL,
  qty     REAL NOT NULL,
  price   REAL NOT NULL,
  fees    REAL DEFAULT 0,
  currency TEXT DEFAULT 'GBP',
  account TEXT DEFAULT 'Main',
  wrapper TEXT DEFAULT 'ISA',
  note    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_symbol ON transactions(symbol, date);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  date          TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  total_gbp     REAL NOT NULL,
  invested_gbp  REAL NOT NULL,
  cash_gbp      REAL NOT NULL,
  pnl_gbp       REAL,
  pnl_pct       REAL,
  day_change_gbp REAL,
  breakdown     TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'price',
  direction  TEXT NOT NULL DEFAULT 'above',
  threshold  REAL,
  status     TEXT NOT NULL DEFAULT 'active',
  note       TEXT,
  created_at INTEGER NOT NULL,
  triggered_at INTEGER,
  triggered_value REAL
);

CREATE TABLE IF NOT EXISTS news (
  guid      TEXT PRIMARY KEY,
  source    TEXT,
  title     TEXT NOT NULL,
  url       TEXT,
  published INTEGER,
  summary   TEXT,
  tags      TEXT,
  symbols   TEXT,
  sentiment REAL,
  fetched_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_news_published ON news(published DESC);

CREATE TABLE IF NOT EXISTS watchlist (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol   TEXT NOT NULL UNIQUE,
  tier     INTEGER DEFAULT 3,
  note     TEXT,
  target   REAL,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  source      TEXT,
  signal      TEXT,
  thesis      TEXT,
  entry_date  TEXT NOT NULL,
  entry_price REAL NOT NULL,
  qty         REAL NOT NULL DEFAULT 1,
  exit_date   TEXT,
  exit_price  REAL,
  status      TEXT NOT NULL DEFAULT 'open',
  target      REAL,
  stop        REAL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  engine  TEXT NOT NULL,
  symbol  TEXT NOT NULL,
  score   REAL,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts DESC);

CREATE TABLE IF NOT EXISTS insiders (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol   TEXT NOT NULL,
  accession TEXT UNIQUE,
  filer    TEXT,
  role     TEXT,
  date     TEXT,
  tx_type  TEXT,
  shares   REAL,
  price    REAL,
  value    REAL,
  url      TEXT,
  fetched_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ai_notes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  subject TEXT,
  body    TEXT NOT NULL,
  context TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_ts ON ai_notes(ts DESC);

-- Fallback fund pricing for holdings Yahoo has no data for (e.g. HL "Class S"
-- share classes). Scraped from FT's public tearsheet, never a primary source.
CREATE TABLE IF NOT EXISTS fund_nav_cache (
  isin         TEXT PRIMARY KEY,
  name         TEXT,
  price        REAL NOT NULL,
  change       REAL,
  change_pct   REAL,
  currency     TEXT NOT NULL DEFAULT 'GBP',
  as_of        TEXT,
  fetched_at   INTEGER NOT NULL
);
`);

// A fund_nav_cache table pre-dating this schema may lack `name` — add it
// defensively rather than failing every insert against an older database.
try { db.exec('ALTER TABLE fund_nav_cache ADD COLUMN name TEXT'); } catch { /* already has it */ }

// isin lets a holding be priced via the FT fallback when Yahoo has nothing.
try { db.exec('ALTER TABLE holdings ADD COLUMN isin TEXT'); } catch { /* already has it */ }

// Listing venue (LSE, NASDAQ, NYSE...), resolved from Yahoo alongside the
// holding's display name — see resolveNameAndExchange() in sources/yahoo.js.
try { db.exec('ALTER TABLE holdings ADD COLUMN exchange TEXT'); } catch { /* already has it */ }

// AI relevance scoring for news. Keyword tagging alone can't tell a market
// story from a general-interest one that merely mentions a country, so each
// story gets scored once by the AI and the result is cached here forever —
// re-scoring the same story on every refresh would burn quota for no gain.
// Added defensively so an existing news table from before this feature works.
for (const col of [
  'ai_relevance INTEGER',   // 0-100, how much this matters to an investor
  'ai_category TEXT',       // markets | macro | policy | geopolitics | company | commodities | crypto | noise
  'ai_symbols TEXT',        // JSON array — AI's own read of which tickers are implicated
  'ai_sentiment REAL',      // -1..1, replaces the lexicon guess when present
  'ai_why TEXT',            // one line: why an investor should care
  'ai_scored_at INTEGER',
  'ai_attempts INTEGER',    // capped, so a story the AI keeps choking on stops retrying
  'dup_of TEXT',            // guid of the canonical story when this is a repeat
  'feed_id TEXT',           // which specific feed it came from — BBC's business
                            // feed and BBC's homepage feed carry very different
                            // signal, and `source` alone can't tell them apart
]) {
  try { db.exec(`ALTER TABLE news ADD COLUMN ${col}`); } catch { /* already has it */ }
}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_news_scored ON news(ai_scored_at)'); } catch { /* already has it */ }

// ─── Generic helpers ──────────────────────────────────────────

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ─── Price history ────────────────────────────────────────────

const insTick = db.prepare(
  `INSERT OR REPLACE INTO price_ticks (symbol, ts, price, prev_close, change_pct)
   VALUES (?, ?, ?, ?, ?)`
);

export function recordTicks(prices, ts = Date.now()) {
  db.exec('BEGIN');
  try {
    for (const [sym, p] of Object.entries(prices)) {
      if (p?.price == null || isNaN(p.price)) continue;
      insTick.run(sym, ts, p.price, p.prev ?? null, p.changePct ?? null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const insBar = db.prepare(
  `INSERT OR REPLACE INTO ohlcv (symbol, date, open, high, low, close, adj_close, volume)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

export function saveBars(symbol, bars, opts = {}) {
  if (!bars?.length) return { saved: 0, rejected: 0, report: null };

  // Validate before writing. Previously this function wrote whatever it was
  // handed, which is how a 100x-wrong bar entered twice and poisoned every
  // downstream statistic. Nothing reaches the table unexamined now.
  const { clean, rejected, report } = validateBars(symbol, bars, opts);

  if (report?.fatal) {
    console.log(`  ⚠ ${symbol}: rejected ${report.fatal} corrupt bar(s) — ${report.details[0]?.reason}`);
    for (const r of report.details.filter(d => d.severity === 'fatal').slice(0, 3)) {
      console.log(`      ${r.date}: ${r.close} (expected ~${r.expected})`);
    }
  }

  db.exec('BEGIN');
  try {
    for (const b of clean) {
      insBar.run(symbol, b.date, b.open ?? null, b.high ?? null, b.low ?? null,
                 b.close ?? null, b.adjClose ?? b.close ?? null, b.volume ?? null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return { saved: clean.length, rejected: rejected.length, report };
}

/** Remove specific dates for a symbol, or across all symbols. Used by repair. */
export function purgeBars(date, symbol = null) {
  const r = symbol
    ? run('DELETE FROM ohlcv WHERE date = ? AND symbol = ?', date, symbol)
    : run('DELETE FROM ohlcv WHERE date = ?', date);
  return r.changes;
}

export function allStoredSymbols() {
  return all('SELECT DISTINCT symbol FROM ohlcv ORDER BY symbol').map(r => r.symbol);
}

export function getBars(symbol, from, to) {
  if (from && to) {
    return all(`SELECT date, open, high, low, close, adj_close, volume FROM ohlcv
                WHERE symbol = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
               symbol, from, to);
  }
  return all(`SELECT date, open, high, low, close, adj_close, volume FROM ohlcv
              WHERE symbol = ? ORDER BY date ASC`, symbol);
}

export function barCoverage(symbol) {
  return one(`SELECT COUNT(*) n, MIN(date) first, MAX(date) last FROM ohlcv WHERE symbol = ?`, symbol);
}

// ─── Settings ─────────────────────────────────────────────────

export function getSetting(key, fallback = null) {
  const r = one('SELECT value FROM settings WHERE key = ?', key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return r.value; }
}

export function setSetting(key, value) {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      key, JSON.stringify(value));
}

// ─── Fund NAV fallback cache (FT scrape) ───────────────────────

export function getFundNav(isin) {
  return one('SELECT * FROM fund_nav_cache WHERE isin = ?', isin);
}

export function saveFundNav(nav) {
  run(`INSERT INTO fund_nav_cache (isin, name, price, change, change_pct, currency, as_of, fetched_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(isin) DO UPDATE SET
         name = excluded.name, price = excluded.price, change = excluded.change,
         change_pct = excluded.change_pct, currency = excluded.currency,
         as_of = excluded.as_of, fetched_at = excluded.fetched_at`,
      nav.isin, nav.name ?? null, nav.price, nav.change ?? null, nav.changePct ?? null,
      nav.currency ?? 'GBP', nav.asOf ?? null, Date.now());
}

// ─── Portfolio snapshots ──────────────────────────────────────

export function saveSnapshot(s) {
  run(`INSERT OR REPLACE INTO portfolio_snapshots
       (date, ts, total_gbp, invested_gbp, cash_gbp, pnl_gbp, pnl_pct, day_change_gbp, breakdown)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.date, s.ts, s.total, s.invested, s.cash,
      s.pnl ?? null, s.pnlPct ?? null, s.dayChange ?? null,
      JSON.stringify(s.breakdown ?? {}));
}

export function getSnapshots(limit = 3650) {
  return all(`SELECT * FROM portfolio_snapshots ORDER BY date ASC LIMIT ?`, limit);
}

export function healthCheck() {
  return {
    ticks:     one('SELECT COUNT(*) n FROM price_ticks').n,
    bars:      one('SELECT COUNT(*) n FROM ohlcv').n,
    symbols:   one('SELECT COUNT(DISTINCT symbol) n FROM ohlcv').n,
    holdings:  one('SELECT COUNT(*) n FROM holdings').n,
    snapshots: one('SELECT COUNT(*) n FROM portfolio_snapshots').n,
    news:      one('SELECT COUNT(*) n FROM news').n,
    alerts:    one("SELECT COUNT(*) n FROM alerts WHERE status='active'").n,
    paper:     one("SELECT COUNT(*) n FROM paper_trades WHERE status='open'").n,
  };
}
