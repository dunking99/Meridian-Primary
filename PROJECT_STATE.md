# Meridian — Project State

This document is a complete technical reference to Meridian: what it is, how
it is built, everything it currently does, and why it works the way it does.
It exists specifically so that a new AI session (or a new contributor) can
read one file and be fully oriented — every database table, every backend
engine, every one of its 98 API routes, every frontend page, the design
principles that must not be violated, and the history of how it got here.

It deliberately overlaps with `README.md` and `CLAUDE.md`. Those serve
different purposes (README: a public-facing technical overview; CLAUDE.md:
short session-startup context on how the user works and how the machine is
set up) and are not superseded by this file. This document is the deep
reference the other two only partially are.

**A warning about staleness.** Meridian is under active, fast-moving
development — five substantial pull requests landed in the single session
this document was written from. Every fact below was pulled directly from
the source on the date at the bottom of this file, not from memory. If you
are reading this later and something looks off, trust the code over this
document and treat the mismatch as this file needing an update, not the code
being wrong.

---

## Table of contents

1. [What Meridian is](#1-what-meridian-is)
2. [Architecture & stack](#2-architecture--stack)
3. [Repository & deployment conventions](#3-repository--deployment-conventions)
4. [Database schema](#4-database-schema)
5. [Backend engines (`server/engines/`)](#5-backend-engines-serverengines)
6. [Backend sources (`server/sources/`)](#6-backend-sources-serversources)
7. [Full API reference](#7-full-api-reference)
8. [Frontend pages](#8-frontend-pages)
9. [The Research page, in depth](#9-the-research-page-in-depth)
10. [Data lifecycle: from a typed ticker to a stored history](#10-data-lifecycle-from-a-typed-ticker-to-a-stored-history)
11. [AI / LLM integration](#11-ai--llm-integration)
12. [Design principles that must not be violated](#12-design-principles-that-must-not-be-violated)
13. [Known gaps — deliberately not built](#13-known-gaps--deliberately-not-built)
14. [Testing methodology](#14-testing-methodology)
15. [History — how Meridian got here](#15-history--how-meridian-got-here)

---

## 1. What Meridian is

Meridian is a personal, local, single-user markets and portfolio terminal
built for one person (a private UK-based investor holding a portfolio of
ETFs and individual equities across ISA/SIPP/GIA tax wrappers). There is no
authentication, no multi-tenancy, and no deployment target beyond the user's
own machine — it is not a product, a service, or something anyone else logs
into.

**The core idea.** Price levels are free everywhere — any financial site
will tell you gold is at $2,910. What is not free anywhere, and what
Meridian's entire "memory layer" exists to compute, is whether that level is
*unusual for that instrument, by its own historical standard*: whether
today's move is a 2.6-sigma day against gold's own trailing year, whether
breadth is narrow relative to its own normal range, whether two assets'
correlation has shifted from where it normally sits. Nothing in this app
that could instead be phrased "here is a number" is left at that — it is
phrased "here is a number, and here is whether that number is unusual."

**Non-negotiable data honesty.** An earlier version of this app (see
§15) rendered fabricated, seeded, or randomly-walked numbers as if they were
live data, and a full rebuild (v2 → v3) existed specifically to purge every
instance of that. The rule that survives from that rebuild, repeated
throughout this document because it governs every design decision: **missing
data renders as visibly missing, never as a plausible-looking substitute.**

## 2. Architecture & stack

- **Backend**: Node.js, zero web framework — a hand-rolled router over the
  built-in `http` module (`server/index.js`). No Express, no Fastify.
- **Persistence**: SQLite via `node:sqlite`, the runtime built into Node
  22.5+. This was a deliberate choice over `better-sqlite3`: no native
  compilation step, nothing to fail to build on Windows (where this app
  primarily runs). Single file: `meridian.db` in the repo root, journal mode
  WAL, foreign keys on.
- **Frontend**: React, as **one single file** — `src/App.jsx`, currently
  8,000 lines. This is a deliberate (if unusual) choice for a single-user
  app with one active contributor at a time: no cross-file navigation
  overhead, everything is one `grep` away. Built with Vite.
- **Charts**: a mix of `recharts` (legacy pages) and hand-written inline SVG
  (all Research page charts — price, sentiment trend, precedent paths,
  compare overlay — are custom SVG for full control over hover behaviour,
  event markers, and honest-degradation states).
- **External data**: `yahoo-finance2` (npm package) for quotes, historical
  bars, and fundamentals via Yahoo's undocumented private API; hand-rolled
  RSS parsing (regex-based, no XML library) for news; SEC EDGAR's public
  REST API for filings and XBRL company facts; a scraper against FT's public
  tearsheet as a last-resort fallback for the handful of funds Yahoo has no
  coverage for.
- **AI**: Google Gemini (`gemini-3.6-flash`), called both from the browser
  (interactive, on-demand features) and from the server (news relevance
  scoring on the ingest loop, when no browser is necessarily open). See §11.
- **No build step for the database.** Schema is created with `CREATE TABLE
  IF NOT EXISTS` on every boot (`server/db.js`), plus a handful of
  defensive `ALTER TABLE ... ADD COLUMN` calls wrapped in try/catch for
  columns added after a table already existed in the wild. There is no
  migration framework.

## 3. Repository & deployment conventions

- **GitHub**: `dunking99/Meridian-Primary`. Everything merges into `main`.
  No long-lived feature branches — branch, commit, push, PR, merge, every
  time, for every change.
- **Where it actually runs**: the user's Windows machine, cloned at
  `C:\Meridian-Primary`. `npm start` (via `scripts/start.js`) runs the API
  (port 3001) and the Vite dev server (port 5173) together; works
  cross-platform (Windows/macOS) despite the primary deployment being
  Windows-only.
- **Self-updating.** `scripts/windows/` is a complete, already-installed
  auto-update system driven by Windows Task Scheduler:
  - `MeridianAutoUpdate` (every 5 minutes): checks GitHub for a new commit
    on `main`; if found, backs up every file about to change into
    `_archive\<timestamp>\`, fast-forward pulls, runs `npm install` if
    `package.json` changed, and restarts the app. Does **not** restart the
    app just because it finds nothing new to update — a deliberately closed
    app stays closed.
  - `MeridianStartOnLogin` (at login only): same update check, plus starts
    the app if it isn't already running.
  - Both launch via `wscript.exe` + `run-hidden.vbs` rather than
    `powershell.exe` directly, because `-WindowStyle Hidden` on
    `powershell.exe`/`cmd.exe` still briefly flashes a console window;
    `wscript.exe` never allocates one at all.
  - `restore-backup.ps1` rolls back to any previous `_archive\` snapshot.
    `stop-auto-update.ps1` disables the whole system.
  - **Practical effect**: merging a PR to `main` reaches the user's machine
    within 5 minutes, automatically. No manual pull instructions are needed
    for routine work.
- **The server also self-syncs data**, separately from the code
  auto-update: once daily, in a 5am–8am local window (checked every 30
  minutes via `setInterval` in `server/index.js`, gated by a `settings`
  table flag so it fires once per calendar day), it runs a full incremental
  history sync (`yahoo.syncAll`) across every tracked symbol and rebuilds
  the memory layer. This is independent of the Windows Task Scheduler
  system — it runs inside the Node process itself, whenever the app happens
  to be up during that window.
- **`meridian.db` is untouchable.** Gitignored, never in a fresh clone,
  never touched by `git pull` or auto-update. It is the one thing in this
  project with **no version history and no automatic backup** — a script
  that might delete, regenerate, or "start fresh" on it is a five-alarm
  situation, not a routine one. Settings → Backup (see §8) exports its
  holdings/cash/transactions to dated JSON+CSV on demand, but nothing does
  this automatically.
- **`MERIDIAN_DB` environment variable** points the whole app at a
  throwaway database file instead — used throughout development/testing so
  engine work is never tried out against real holdings.

## 4. Database schema

22 tables total, defined across `server/db.js` (15) and four engine files
that own their own schema inline (`bullbear.js`, `memory.js`,
`research.js`).

### Core tables (`server/db.js`)

| Table | Purpose |
|---|---|
| `price_ticks` | Every live-quote poll, timestamped (`symbol`, `ts`, `price`, `prev_close`, `change_pct`). Used to derive week-ago change for symbols without a stored bar for that exact date. |
| `ohlcv` | Daily bars: `open/high/low/close/adj_close/volume` per `(symbol, date)`. The backbone of almost every analytical engine in the app. |
| `holdings` | Real portfolio positions: qty, avg price, currency, sector, geography, asset class, account, tax wrapper, ISIN, resolved exchange, an optional target weight and a free-text thesis. |
| `cash` | Cash balances per account/wrapper/currency. |
| `transactions` | Buy/sell trade log (not yet surfaced as its own realised-gains view in the UI — see §13). |
| `portfolio_snapshots` | One row per day, written every 15 minutes while the app runs: total value, invested, cash, P&L, day change, and a JSON breakdown blob. Backs the portfolio value chart. |
| `alerts` | User-defined alert conditions — see the 10 `ALERT_KINDS` in §5. |
| `news` | The ingested RSS feed, deduplicated, plus a wide set of AI-scoring columns added defensively via `ALTER TABLE` (`ai_relevance`, `ai_category`, `ai_symbols`, `ai_sentiment`, `ai_why`, `ai_scored_at`, `ai_attempts`, `dup_of`, `feed_id`). |
| `watchlist` | Tiered (1–3) list of symbols followed without being held. |
| `paper_trades` | Simulated trades logged from screener signals, marked to market, to test whether a screening strategy would actually have worked. |
| `signals` | Generic timestamped engine output log (`engine`, `symbol`, `score`, JSON `payload`). |
| `insiders` | Parsed SEC Form 4 transactions: filer, role, date, buy/sell, shares, price, value. |
| `settings` | Flat key/value store — the Gemini API key, `lastOvernightSync` date, etc. |
| `ai_notes` | Persisted AI-generated notes/briefs, by kind and subject. |
| `fund_nav_cache` | Last-known NAV for funds priced via the FT fallback scraper, keyed by ISIN. |

### Engine-owned tables

| Table | Owner | Purpose |
|---|---|---|
| `bullbear_theses` | `bullbear.js` | The persisted bull/bear argument per symbol per side (`bull`/`bear`): target price, key assumption, argument/disproof as JSON, source (`ai`/`manual`/`ai_edited`). |
| `bullbear_summary` | `bullbear.js` | One-line disagreement summary per symbol. |
| `analyst_snapshots` | `bullbear.js` | Daily analyst-consensus snapshot (target low/mean/high, rating counts) — accrued as a side effect of reading the Research or Bull/Bear tab, not on a schedule. |
| `valuation_snapshots` | `bullbear.js` | Daily trailing/forward P/E snapshot, same accrual pattern. |
| `symbol_observations` | `memory.js` | The memory layer's core table: per-symbol daily z-scored returns, volatility, drawdown, distance from 50/200-day averages, percentile rank. |
| `regime_observations` | `memory.js` | Universe-wide daily breadth, dispersion, and correlation regime. |
| `research_notes` | `research.js` | The user's own dated one-line chart annotations, pinned onto the Research price chart alongside machine-derived events. |

## 5. Backend engines (`server/engines/`)

Seventeen files. `analytics.js` is the mathematical foundation everything
else calls into; the rest are domain-specific and mostly stateless
(pure functions over bars/prices passed in), with a handful owning their own
schema (above).

| File | What it does |
|---|---|
| `analytics.js` | Pure quant primitives, no I/O: returns, CAGR, Sharpe/Sortino/Calmar, max drawdown + full drawdown series, beta/alpha, tracking error, information ratio, capture ratios, **VaR by three methods** (historical, parametric, Cornish-Fisher-modified) plus CVaR, correlation/covariance matrices, portfolio risk contributions, diversification ratio, effective holdings (inverse-HHI), and technical indicators (SMA/EMA, RSI, ATR, Bollinger, MACD, rolling z-score). Every risk number surfaced anywhere in the UI traces back to a function in this file. |
| `optimiser.js` | Constrained portfolio optimisation with **no external solver** — long-only, per-asset weight caps, solved by projected gradient descent onto the capped simplex (exact projection via bisection on the dual, not an approximation). Provides min-variance, max-Sharpe, risk parity, inverse-vol, and a full efficient frontier. Ledoit-Wolf-style covariance shrinkage included. |
| `portfolio.js` | Valuation and exposure decomposition — everything the Portfolio and Risk pages read comes from here: FX conversion to GBP, per-position P&L, weight breakdowns (sector/geography/asset class/wrapper/account/currency), portfolio history reconstruction (fixed-weight, not trade-by-trade), and concentration metrics (largest position, top-3, HHI, effective holdings, look-through US exposure). |
| `rebalance.js` | Tax-wrapper-aware rebalancing: prefers selling inside an ISA/SIPP (no CGT) and using new contributions before ever proposing a taxable GIA disposal. |
| `montecarlo.js` | Goal-probability simulation, **bootstrapped from real historical returns rather than Gaussian GBM** — deliberately, since a normal-distribution model understates fat-tail outcomes. |
| `stress.js` | Replays six real historical crisis windows (COVID crash, 2022 rate shock, GFC, Q4 2018, Euro crisis, Aug 2024 yen-carry unwind — exact dates in `config.js`) against current holdings, using each holding's own history where it exists and factor-proxy regression where it doesn't (e.g. a newer ETF with no 2008 history). |
| `screener.js` | Six-strategy factor scoring (momentum, trend, mean-reversion, quality/low-vol, breakout, balanced) computed against **stored history**, not a single live quote — this was the specific fix from v1, where a "momentum" score was really just today's percentage change. |
| `backtest.js` | Eight strategies (MA/EMA crossover, momentum, mean-reversion, RSI, Donchian breakout, volatility targeting, buy-and-hold), commission and slippage modelled, **always reports buy-and-hold alongside** so a strategy has to actually beat doing nothing. Includes walk-forward validation (out-of-sample folds). |
| `alerts.js` | Ten condition types: price level, daily move %, MA cross (50/200), RSI level, new 52w high/low, volume spike, volatility-regime shift, drawdown breach, portfolio weight drift. |
| `paper.js` | Logs screener/signal-sourced trades and marks them to market — closes the loop on "does this screen actually work." |
| `analyst.js` | The unified AI-brief assembler: one structured context (portfolio + risk + regime + news + signals + alerts) fed to the model at once, replacing v1's pattern of calling the model separately per page with only that page's data. Also owns `riskProfile` (VaR/CVaR/beta/drawdown for the whole portfolio) and `correlationWatch` (detects correlation regime shifts across holdings). |
| `memory.js` | **The single most distinctive engine in the app** — see the description in §1. Computes and stores daily per-symbol z-scored observations and universe-wide breadth/dispersion/regime, backfillable across all stored history and idempotent (safe to rebuild). Powers `whatChanged` (the front page), `leadership` (rotation detection), and `correlationShifts`. |
| `calendar.js` | Real earnings/dividend dates for held and watched instruments only (replaced a predecessor that invented dates as offsets from "today," which always looked current and was always wrong). |
| `bullbear.js` | The bull/bear signal-and-thesis system. Computes 8 independent signals per symbol (range position, momentum, valuation multiple, analyst target, analyst rating, analyst rating change, news sentiment, insider activity), each carrying its date and source, and drafts a bull/bear thesis from **only that structured signal list** via Gemini — the model never sees a price or a name it could riff on freely. No overall verdict or score is ever shown; the one aggregate is a straight bull/bear/neutral signal count. |
| `research.js` | Backs the Research page's Overview/Compare/Precedents tabs and the chart-notes feature. See §9 for full detail — this is the newest and largest engine, added across three PRs in this project's most recent phase. |
| `newsscore.js` | AI relevance scoring for the news feed via Gemini: judges what a story is *about* (not just keyword-matched), assigns 0–100 relevance, a category (markets/macro/policy/geopolitics/company/commodities/crypto/noise), a symbol read, and a sentiment score. Capped at `MAX_PER_CYCLE = 40` stories and `MAX_ATTEMPTS = 3` per story so a story the model keeps failing on stops retrying forever. |
| `integrity.js` | Data-quality auditing. Exists because a single 100x-wrong price bar (a pence/pounds unit mismatch) once produced 4,402% computed volatility and a correlation matrix of forced 1.0s from one bad row. Flags outliers via median absolute deviation, and can purge + resync affected dates. |

## 6. Backend sources (`server/sources/`)

Eight files — the boundary between Meridian and the outside world.

| File | What it does |
|---|---|
| `yahoo.js` | The primary data source. Wraps `yahoo-finance2`: live quotes (`fetchQuotes`), historical bar sync (`syncHistory`, incremental — skips symbols whose last bar is under 20h old unless forced), full fundamentals + analyst data (`fetchSummary`), corporate actions/dividends/splits (`fetchCorporateActions`), Yahoo's "similar instruments" list priced into a comparables table (`fetchPeers`), and **`ensureHistory`** — the on-demand sync choke-point (see §10) added in the most recent development phase, now called before every stored-bar-dependent read across Research, Screener, Backtest, Alerts, and Risk. Also owns the pence-vs-pounds currency normalisation that reads Yahoo's live `currency` field per quote rather than trusting a static per-symbol table (a static table caused a real 100x pricing bug previously). |
| `instruments.js` | Instrument-type classification (`equity`, `etf`, `fund`, `index`, `fx`, `future`, `yield`, `crypto`, `unknown`) — each type declares which stats apply to it (a P/E doesn't apply to an index; that's a fact about indices, not missing data) and whether it carries analyst coverage or SEC filings at all. |
| `news.js` | RSS ingestion via a tolerant regex parser (no XML dependency — RSS is regular enough not to need one), keyword symbol-tagging, lexicon-based sentiment as a fallback under the AI scorer, duplicate detection (title-signature Jaccard similarity), and live one-off news search. |
| `edgar.js` | SEC EDGAR integration: CIK lookup, Form 4 filing fetch and XML parsing into real transactions, insider-activity summaries, and XBRL company-facts fetching (reported fundamentals, not estimates) with trend derivation. |
| `feargreed.js` | CNN Fear & Greed index scraper — the one component preserved unchanged from v1 because it always worked. |
| `ft.js` | Last-resort fund NAV scraper against FT's public tearsheet, used only when Yahoo has zero coverage for a fund's exact share class. Explicitly never used for history (FT gives today's snapshot only) and never treated as a primary source. |
| `funds.js` | A small hand-maintained table of UK OEIC/unit-trust funds bought via Hargreaves Lansdown that either aren't on Yahoo at all or where Yahoo's data is wrong/stale — priced once daily since these genuinely have no intraday price anywhere. |
| `ai.js` | Server-side Gemini caller, distinct from the frontend's own `callAI()` — needed because news scoring happens on the ingest loop when no browser is open. API key read from the `settings` table (pushed there by the frontend), not a `.env` file. |

## 7. Full API reference

98 routes as of this writing, all defined in one `routes` object in
`server/index.js`. Grouped by area; one line each.

**Status & data**
`GET /` `GET /health` `GET /system/health` (per-symbol bar coverage +
staleness, feed/memory freshness, last overnight sync) `GET /changelog`
(recent git commits, read live from the local clone) `GET /prices`
`GET /feargreed` `GET /symbols` `GET /history` `GET /history/batch`
(closes-only, for sparklines) `POST /sync` `GET /quote` `GET /search`
`GET /integrity` `POST /integrity/repair`

**Memory (§5)**
`GET /changes` `GET /memory` `GET /memory/latest` `GET /leadership`
`GET /relationships` `GET /memory/regime` `GET /memory/symbol`
`POST /memory/rebuild`

**Calendar**
`GET /calendar` `POST /calendar/refresh`

**Portfolio**
`GET /portfolio` `GET /portfolio/history` `GET /portfolio/history/holdings`
`GET /portfolio/snapshots` `GET|POST|PUT|DELETE /holdings`
`POST /holdings/refresh-names` `POST|PUT|DELETE /cash`
`POST|GET /transactions`

**Risk**
`GET /risk` `GET /regime` `GET /correlations` `GET /stress`
`POST /stress/shock` `GET /scenarios`

**Planning**
`POST /optimise` `POST /frontier` `POST /rebalance` `POST /contribute`
`POST /montecarlo` `POST /goal`

**Screener & backtest**
`GET /screener/strategies` `POST /screen` `GET /score` `POST /backtest`
`POST /walkforward`

**Tracking**
`GET|POST|PUT|DELETE /alerts` `GET|POST|DELETE /watchlist`
`GET|POST|PUT|DELETE /paper`

**Research — overview & deep-dive**
`GET /research/overview` `GET /research/precedents`
`GET /research/compare` `GET /research/corporate` `GET /research/peers`
`GET|POST|DELETE /research/notes`

**Research — bull/bear**
`GET /research/bullbear` `POST /research/bullbear/generate`
`PUT /research/bullbear/thesis` `DELETE /research/bullbear`

**News**
`GET /news` `POST /news/refresh` `GET /research/news`
`POST /news/score` `GET /news/divergence`

**Filings & fundamentals**
`GET /insiders` `GET /insiders/summary` `GET /filings`
`GET /fundamentals` `GET /fund-nav`

**AI**
`GET /brief` `GET|POST /ai/notes` `GET|POST /settings/ai`

**Settings**
`GET|POST /settings`

## 8. Frontend pages

Navigation is a fixed sidebar (`NAV_ITEMS`) plus a global `Ctrl/Cmd+K`
command palette that jumps to any page or, from two characters, live-searches
any ticker/company straight into Research.

| Page | What it shows |
|---|---|
| **What Changed** | The front page. Session verdict (quiet vs. notable, computed from the memory layer, never invented), sigma-scored moves, breadth/dispersion/correlation percentiles, an optional AI session read fed exactly those numbers. |
| **Risk** | Portfolio VaR/CVaR, beta, drawdown, risk contributions per holding, the correlation matrix (now defensively re-synced via `ensureHistory` on every 60s poll — see §10), stress-scenario replay. |
| **Research** | The largest page by far — 7 tabs. Full treatment in §9. |
| **Portfolio** | Holdings table with live P&L, add/edit/delete, expandable per-holding detail (own price chart, transaction history), cash tiles, breakdowns (sector/geography/asset class/wrapper/currency), concentration warnings (largest position, top-3, look-through US, effective holdings — surfaced here, not just on Risk), portfolio value chart. |
| **Watchlist** | Tiered symbol list, rebuilt on the real `watchlist` table (not invented rows). |
| **Screener** | Runs the six-strategy factor engine against a chosen universe, shows factor score breakdowns and detected technical signals per result. |
| **Markets** | FX, commodities, indices, rates, sector-ETF heatmap, dollar-correlation panel, yield curve — all symbol-driven and live, no hardcoded numbers. |
| **News** | The scored RSS feed with relevance/category/sentiment filters, plus the tone/price divergence panel (§ below) at the top when there's something to say. |
| **Settings** | Gemini API key, manual price links, **Data Health** (per-symbol staleness table with one-click resync), **Backup** (exports holdings/cash/transactions to dated JSON+CSV — the only defence for the one un-backed-up dataset in the app), **What's Changed in Meridian** (a live changelog panel reading real git history), and a "How Meridian Runs" explainer that reflects the actual current auto-update behaviour. |

**News tone/price divergence** (`NewsDivergencePanel`): compares each held
or watched symbol's 90-day news-sentiment trend against its trailing-month
price move; renders **nothing** on the (typical) day there's no
disagreement, and separately counts symbols with too little news coverage
to assess as "unassessable" rather than silently dropping them.

## 9. The Research page, in depth

The Research page (`ResearchPage` + a large supporting component tree, all
in `src/App.jsx`) is where a symbol — any symbol, typed in or reached via
Compare/the command palette — gets analysed. Seven tabs:

1. **Overview** — the default landing tab. Two columns:
   - *Left*: an interactive SVG price chart (range selector 1M→MAX, 50/200-day
     moving averages, 52-week high/low lines, dated event markers for
     earnings/rating-changes/target-revisions/outsized moves, hover
     crosshair), the user's own pinned notes rendered on the same chart, a
     composed (not AI-generated) narrative — "Where things stand" — built
     sentence-by-sentence only from facts that exist, performance/risk stat
     grid (returns across 1W–1Y/YTD, realised vol, RSI, MA distance,
     drawdown, beta), a 90-day news-sentiment trend chart, and a
     dividend/split history panel with a trailing-twelve-month realised
     yield.
   - *Right*: consensus analyst target with a range track (that explicitly
     flags a price sitting *outside* the whole published range, rather than
     pinning the marker at the end and implying "at the top"), rating
     distribution, bear/base/bull scenario tiles, recent rating changes
     (linked to Yahoo's analysis page as its actual data source — Yahoo's
     upgrade/downgrade history carries no per-item article link), ownership
     and short-interest stats, key dates, key stats, earnings track record.
2. **Compare** — up to 4 symbols rebased to 100 at their first shared
   trading date (joined on actual shared dates, never by array position —
   different exchange holiday calendars make positional alignment silently
   wrong), window return/vol/drawdown/Sharpe table, pairwise return
   correlations, and Yahoo's "similar instruments" list priced into a table
   with one-click "add to chart."
3. **Precedents** — the most distinctive tab. Finds the days in *this
   symbol's own history* whose six-dimensional technical state (RSI,
   distance from 50/200-day MAs, 1-month/1-year vol ratio, 1-month return,
   yearly range position — all z-scored against the symbol's own full
   history) most closely resembles today, and shows what happened in the
   following 5/21/63 bars as both a table and a "spaghetti chart" of
   forward paths with the median bolded. Refuses outright below ~3 years of
   history; forces matches at least a month apart so one drawn-out episode
   can't masquerade as several independent precedents; excludes the most
   recent quarter as a candidate (it overlaps the present); labels every
   match close/moderate/loose by its actual distance percentile; states
   explicitly when nothing qualifies as a close precedent. Presented, in its
   own on-page method statement, as **a described sample, never a
   forecast**.
4. **News** — symbol-scoped feed + live one-off search, merged and
   deduplicated.
5. **Bull / Bear** — the 8-signal, no-verdict argument system from §5's
   `bullbear.js`, with an editable AI-drafted or hand-written thesis per
   side and a straight bull/bear signal-count ring (never a weighted
   score) in the instrument header.
6. **Filings** — SEC filings list, insider Form 4 transactions, reported
   XBRL fundamentals (not estimates).
7. **AI Note** — free-form Gemini-generated bull/bear/base note, now fed
   the same measured technical figures the rest of the tab displays (not
   just a bare price) and instructed to reason only from those figures.

The **instrument header bar** above the tabs shows name/symbol/type badge,
a 90-day sparkline, live price and 1D/1W change, and a signal-balance ring
(a count, explicitly not a score) once the Bull/Bear tab's signals have been
computed for that symbol.

## 10. Data lifecycle: from a typed ticker to a stored history

This is the single most important recent architectural addition and worth
walking through end to end, since it changes what "just works" means
across five different pages.

1. A symbol is typed into Research, added to a Screener universe, backtested,
   given an alert, or held in the portfolio.
2. Before any stored-bar read happens, the relevant route calls
   **`yahoo.ensureHistory(symbols)`** (`server/sources/yahoo.js`).
3. `ensureHistory` checks local bar coverage per symbol. A symbol already
   holding ≥30 bars (the default `minBars`) costs **one cheap SQLite query
   and nothing else** — no network call. A symbol below that threshold
   triggers a real, persisted fetch via the existing `syncAll`/`syncHistory`
   machinery (the same code that has always populated `meridian.db`).
4. The fetched bars are written to `ohlcv` immediately, so the *next* time
   anything asks for that symbol — on any page — it is already there.

This is wired into: `GET /research/overview` (in parallel with the
quote-summary fetch, so the two independent Yahoo round-trips don't add up
sequentially), `GET /research/precedents`, `GET /research/compare` (every
symbol in the comparison, not just the primary one), `POST /screen` and
`GET /score`, `POST /backtest` and `POST /walkforward`, `POST /alerts`
(synced once at creation, since most alert kinds are otherwise permanently
inert on an unsynced symbol), and defensively in `GET /risk` /
`GET /correlations` (holdings already auto-sync on add via `POST /holdings`;
this catches a sync that failed at add-time or bars purged by an integrity
repair).

The practical result: **there is no longer a manual "sync" step for
anything you actually look at.** The database grows to cover exactly what
has been researched, held, screened, or alerted on — nothing pre-downloaded,
nothing permanently missing after the first look.

## 11. AI / LLM integration

Every AI-generated feature in Meridian shares one constraint set
(`AI_RULES` in `src/App.jsx`, reused verbatim across every prompt):

> - If the data shows nothing unusual, say so plainly and stop. A short
>   answer that says "this was an ordinary session" is correct and useful.
>   Do not manufacture a narrative to fill space.
> - Only cite numbers present in the data given to you. Never estimate,
>   recall or invent a figure, a level, or an event.
> - Where the data says a value is unavailable, say it is unavailable
>   rather than guessing or working around it.
> - Do not describe a move as significant unless the data says it is
>   unusual by its own historical standard.
> - British English. Plain text, no markdown. No disclaimers about not
>   being financial advice.

**Where the model is used:**
- The What Changed page's session read — fed the memory layer's own sigma
  scores and percentiles, with the quiet/notable verdict passed through
  explicitly rather than left for the model to infer.
- The Research page's AI Note — now fed measured technicals (returns, vol,
  RSI, MA distance, beta, analyst consensus, news-sentiment band), not just
  a bare price.
- Bull/Bear thesis generation (`bullbear.generateThesis`) — the model sees
  **only the structured 8-signal list**, never a price or company name it
  could riff on freely; a generation that fails or returns unparseable
  output writes nothing, since a half-written thesis reads as authored.
- News relevance scoring (`newsscore.js`) — a classification task (0–100
  relevance, category, symbol read, sentiment), not free-text generation;
  capped retries so a story the model keeps choking on stops being retried.
- The unified daily/risk/rebalance/position AI brief (`analyst.buildBrief`)
  — one assembled context across portfolio, risk, regime, news and alerts,
  reasoned over at once (replacing v1's per-page-isolated calls, which meant
  the model could never connect two parts of the picture).

**API key handling**: pasted into Settings, stored in `localStorage`
(frontend) and pushed to the server's `settings` table (backend) — never a
`.env` file, since the server needs it for the ingest-time news-scoring loop
when no browser is open.

## 12. Design principles that must not be violated

These are enforced by convention and by the codebase's own comments, not by
a linter — anyone (human or AI) extending this app needs to hold them
deliberately:

- **No fabricated, placeholder, or mock data, ever, in anything
  user-facing.** Missing data renders via an explicit `NoData` component or
  an explained gap, never a plausible-looking substitute.
- **Every derived figure states its source and, where relevant, its
  freshness/provenance.** An unlabelled number undermines the app's entire
  value proposition (measuring against history, not showing raw levels).
- **Honest refusal beats a guess.** Below a data threshold, every engine in
  this app returns `available: false` with a stated reason, never an
  approximation dressed as a real answer (see Precedents' 3-year floor,
  Compare's date-join refusal below 30 shared days, sentiment's 6-story/
  8-day floor).
- **No overall verdict or weighted score where the weighting couldn't be
  defended.** The bull/bear signal count and the Research signal ring are
  explicit counts, never a 0–100 "conviction score" — a single number would
  need to weight a 52-week range position against an insider sale against a
  rating change, and no such weighting has a real basis.
- **AI-generated commentary must be able to conclude "nothing happened."**
  Every prompt is written so a quiet day produces a short, correct, boring
  answer rather than a manufactured narrative.
- **Small, single-purpose commits with a message explaining *why*, not just
  what** — this repo's history is written to be read later by someone
  (human or AI) with no memory of the session that produced it.
- **Comments explain the non-obvious "why," never the "what."** Well-named
  code already says what it does.

## 13. Known gaps — deliberately not built

- **Options flow, full short-interest flow data, and 13F institutional
  holdings** all require paid feeds (Polygon, Quiver, WhaleWisdom). Rather
  than ship an endpoint that silently returns nothing, they are omitted
  entirely. (Basic short-interest *level* data — shares short, % of float,
  days to cover — is free via Yahoo's `defaultKeyStatistics` and *is*
  wired in; it is only the intraday flow/borrow-rate data that isn't.)
- **The macro calendar** (CPI, payrolls, rate-decision dates) has no free
  structured feed wired up — Investing.com does this better, and the
  calendar says so rather than leaving the gap silently undiscovered.
- **No realised-vs-unrealised tax-lot breakdown** for the `transactions`
  table yet — it's logged, but not yet surfaced as its own view.
- **No "what if I add this trade" preview** before committing a holding.
- **No forward dividend-income calendar** aggregated across the whole
  portfolio (per-symbol dividend history exists in Research; a
  portfolio-wide forward view does not).
- **No chart/data export** (PNG or CSV) from the Research page.
- **No rolling correlation-over-time view** on the Risk page — correlation
  is currently a single current-window snapshot, even though the memory
  layer already computes regime data over time that could back this.
- **No alert delivery beyond in-app** — an alert firing while no browser
  tab is open is currently silent; email/desktop notification is unbuilt.
- **macOS has no auto-update equivalent** — the Windows Task Scheduler
  system is Windows-only by design; a Mac clone is a manual `git pull` +
  `npm install` + `npm start` each time, with no persistent second
  install intended.

## 14. Testing methodology

Documented in detail in `CLAUDE.md`, summarised here because it governs how
confident any claim of "this works" in this codebase should be taken:

- **PowerShell scripts are verified against a real interpreter, not
  reasoned about.** A real `pwsh` binary is fetched into the sandbox and
  the actual `.ps1` file is parsed (`[System.Management.Automation.Language.
  Parser]::ParseFile`) and exercised against a real throwaway git
  remote/clone — this project has two real, previously-shipped bugs that
  only manifested under Windows PowerShell 5.1 specifically, not the `pwsh`
  7 available in this development environment.
- **Native command (git, npm) success/failure is checked via
  `$LASTEXITCODE`, never inferred from exceptions or stderr content** — a
  real bug here (`$ErrorActionPreference = 'Stop'` treating git's routine
  stderr status text as a failure) meant auto-update silently never applied
  updates while reporting success-shaped failures.
- **`.ps1` files are ASCII-only** — no em-dashes, no curly quotes — because
  Windows PowerShell 5.1's BOM-less-UTF-8 handling is unreliable enough to
  have caused a real, shipped parse error.
- **Frontend changes are verified by booting the real API + Vite dev
  server and driving it with Playwright**, not by reasoning about JSX from
  a distance. Since Yahoo/Google/SEC are network-blocked from the
  development sandbox, live-fetch-dependent UI is tested via Playwright
  request interception with fixtures shaped exactly like real API
  responses (see the `drive*.mjs` scripts used across the Research and
  Platform PRs for the pattern) — engines that only touch stored bars
  (Precedents, Compare, notes CRUD) are additionally exercised directly
  against a seeded throwaway SQLite database for genuine, non-mocked
  computation.
- **Genuinely unverifiable things are stated as such**, not implied to be
  tested — e.g. `Register-ScheduledTask` itself needs a real Windows Task
  Scheduler this environment doesn't have, and every PR touching it has
  said so explicitly rather than claiming full confidence.

## 15. History — how Meridian got here

- **v1** (pre-history to this repo): browser-`localStorage`-only, two
  endpoints, fabricated data across most pages, a `start.sh` macOS-only
  launcher, a pence/pounds pricing bug baked into a static per-symbol table.
- **v2**: the persistence rewrite — SQLite via `node:sqlite`, ~12 years of
  real daily history per symbol, real VaR/beta/drawdown/optimisation/
  backtesting/screening engines, a unified AI brief replacing 7 isolated
  per-page calls, currency normalisation fixed at the source, cross-platform
  `npm start`.
- **v3**: the frontend honesty rebuild — purged fabricated data from every
  remaining page (front page, missing-price handling, day-change
  calculation), added the memory layer (per-symbol and universe-wide
  observations, backfilled across all history), rebuilt the front page as
  "What Changed," deleted pages that were pure invention (the old Macro
  page, the original hardcoded Dashboard), fixed the "every symbol is a US
  common stock" assumption via instrument typing, expanded SEC EDGAR from
  filing-date-listing only to real parsed transactions and reported
  fundamentals, and let AI-generated commentary conclude nothing happened
  for the first time.
- **The Bull/Bear phase**: added the 8-signal, no-verdict bull/bear
  argument engine and its editable thesis system.
- **The auto-update phase**: built the full Windows Task Scheduler-driven
  self-update system, then fixed three real bugs surfaced only by the user
  running it on a genuine Windows machine — an encoding-caused parse error,
  a false-failure-on-every-success detection bug, and an unwanted
  window-flash/restart bug — each fixed with the sandbox-verification
  discipline in §14 rather than guessed at.
- **The Research rebuild phase** (most recent, three PRs): merged the
  separate Overview and Analyst tabs into one, built the interactive price
  chart with event markers from scratch, then added — in order — the
  Precedents engine (nearest-neighbour historical pattern matching), the
  Compare tab, dividend/split history, ownership/short-interest, user chart
  notes, and finally the cross-cutting on-demand history-sync system
  (`ensureHistory`) that now backs Research, Screener, Backtest, Alerts,
  and Risk alike.
- **The platform phase** (same session): Settings → Data Health, Settings →
  Backup, the daily server-side overnight sync, the global command palette,
  Portfolio currency/wrapper breakdowns and concentration warnings, and the
  News tone/price divergence panel.

---

*Compiled 2026-09-06, directly from the source at that commit — every
table, export, route, and number above was read from the actual files, not
recalled from memory. If this document and the code disagree, the code is
right and this file is stale.*
