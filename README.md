# Meridian

A personal, local, single-user markets terminal. Node + SQLite + React.

v2 rebuilt the data and analytics layer: real storage, real history, real risk.
v3 finished the job on the front end, which was still rendering fabricated data
on most pages, and added the thing the analytics layer was missing — memory.

**Levels are free everywhere.** Any site will tell you what gold costs. The
point of this app is the part that requires keeping history: whether today's
move is unusual *for that instrument*, whether breadth is narrow *by its own
standard*, and which relationships have changed. That is what the memory layer
computes and what the front page shows.

## What changed

| | v1 | v2 |
|---|---|---|
| Storage | browser localStorage | SQLite (`meridian.db`), 15 tables |
| History | none | ~12 years of daily bars per symbol |
| Endpoints | 2 (`/prices`, `/feargreed`) | 56 |
| Risk | none | VaR (4 methods), beta, drawdown, risk contributions |
| Optimisation | none | max-Sharpe, min-variance, risk parity, efficient frontier |
| Rebalancing | none | tax-wrapper aware, CGT-estimating |
| Backtesting | signals only | walk-forward validated, costs modelled |
| Screener | live quote fields | factor scores on real history |
| Alerts | price thresholds | 10 condition types |
| AI | 7 isolated per-page calls | one unified analyst brief |
| Currency | pence bug | normalised at source |
| Launch | `start.sh` (macOS only) | `npm start` (cross-platform) |

### v3

| | before | after |
|---|---|---|
| Front page | movers, alerts, breadth and catalysts all hardcoded | derived from stored history, and able to say nothing happened |
| Missing prices | seeded from a constant, then moved by a random walk, labelled LIVE | absent, and rendered as absent |
| Day change | recomputed against the previous poll (i.e. the last 60 seconds) | the API's own previous-close figure |
| Memory | none | daily per-symbol and universe-wide observations, backfilled across all stored history |
| Screener page | 21 hardcoded rows | the factor engine that already existed |
| Watchlist page | 6 invented names in React state | the database table that already existed |
| Calendar | invented events dated relative to today | real earnings and dividend dates; folded into the front page |
| Macro page | breadth, regime and cross-asset all constants | deleted — done for real elsewhere |
| Instrument types | every symbol treated as a US common stock | 8 types, each declaring which figures apply |
| Tables | 15 | 21 |
| Endpoints | 56 | 84 |
| EDGAR | Form 4 dates, all detail columns NULL | parsed transactions + reported XBRL fundamentals |
| AI prompts | "be opinionated, no hedging" | permitted, and expected, to conclude nothing happened |

## Requirements

Node 22.5 or newer. Persistence uses the built-in `node:sqlite`, so there is
**no native compilation and nothing to install for the database** — this matters
on Windows, where `better-sqlite3` frequently fails to build.

## Install

```
npm install
```

Only `yahoo-finance2` is new. Everything else was already there.

## First run

```
npm run sync      # one-off: downloads ~12 years of bars. Takes a few minutes.
npm start         # runs API (:3001) and UI (:5173) together
```

`npm start` replaces `start.sh` and works on Windows and macOS. Ctrl+C stops both.

To run only the API: `npm run server`.

## Layout

```
server/
  config.js              symbol universe, scenarios, tax constants
  db.js                  schema + query helpers
  index.js               HTTP server, 84 routes
  sources/
    yahoo.js             quotes, history sync, pence normalisation
    feargreed.js         CNN index (unchanged from v1 — it worked)
    news.js              RSS ingestion, symbol tagging, sentiment
    edgar.js             Form 4 parsing, XBRL company facts, filings
    instruments.js       what kind of thing a ticker is, and what applies to it
    ft.js                fund NAV fallback for funds Yahoo lacks
  engines/
    analytics.js         all quantitative primitives
    optimiser.js         FISTA-solved portfolio optimisation
    portfolio.js         valuation, exposure, history reconstruction
    rebalance.js         tax-wrapper-aware trade generation
    montecarlo.js        bootstrapped projections
    stress.js            historical scenario replay
    screener.js          factor scoring
    backtest.js          simulation + walk-forward validation
    alerts.js            10 alert condition types
    paper.js             signal tracking
    analyst.js           unified AI brief assembly
    memory.js            daily observations, breadth, dispersion, leadership,
                         correlation shifts — the "what changed" layer
    calendar.js          dated events for held and watched instruments
    bullbear.js          signals for and against an instrument, and the
                         persisted thesis drafted from them
    integrity.js         bar validation and corruption repair
    newsscore.js         AI relevance scoring for the news feed
scripts/
  start.js               cross-platform launcher
  sync.js                history backfill
  seed-dev-db.js         synthetic history for offline engine testing;
                         refuses to run against anything but a *.test.db
```

## Key endpoints

**Data** — `GET /prices` `/feargreed` `/history?symbol=` `/symbols` `/quote?symbol=`
`/search?q=` · `POST /sync`

**Portfolio** — `GET /portfolio` `/portfolio/history` `/portfolio/snapshots` ·
`POST|PUT|DELETE /holdings` `/cash` `/transactions`

**Risk** — `GET /risk` `/regime` `/correlations` `/stress` `/scenarios` ·
`POST /stress/shock`

**Planning** — `POST /optimise` `/frontier` `/rebalance` `/contribute`
`/montecarlo` `/goal`

**Research** — `POST /screen` `/backtest` `/walkforward` · `GET /score?symbol=`
`/screener/strategies`

**Tracking** — `GET|POST|PUT|DELETE /alerts` `/watchlist` `/paper`

**Bull / bear** — `GET /research/bullbear?symbol=` ·
`POST /research/bullbear/generate` · `PUT /research/bullbear/thesis` ·
`DELETE /research/bullbear?symbol=`

**Memory** — `GET /changes` `/memory` `/memory/regime` `/memory/symbol?symbol=`
`/memory/latest?symbols=` `/leadership` `/relationships` · `POST /memory/rebuild`

**News & filings** — `GET /news` `/insiders?symbol=` `/insiders/summary?symbol=`
`/filings?symbol=&type=all` `/fundamentals?symbol=` `/calendar` ·
`POST /news/refresh` `/calendar/refresh`

**AI** — `GET /brief?kind=daily|risk|rebalance|position` · `GET|POST /ai/notes`

## Notes on correctness

The maths is unit-tested against analytic solutions rather than eyeballed:

- Min-variance on a diagonal covariance returns exactly the inverse-variance
  weights (0.2000 / 0.8000).
- Max-Sharpe matches brute-force search to machine precision (gap < 1e-11).
- Risk parity produces exactly equal risk contributions (20.00% each on five
  assets).
- Euler risk contributions sum to 1.
- A perfectly anti-correlated 50/50 pair has zero portfolio volatility.
- Buy-and-hold backtest equals the benchmark to the penny.

Three genuine bugs were found and fixed this way during the build: an
under-converged optimiser (fixed with FISTA and a Lipschitz step), a backtest
that never opened a position because slippage pushed cost above available cash,
and a frontier that saturated because its return ceiling ignored the weight cap.

## Things that are deliberately honest

- **Portfolio history is a fixed-weight reconstruction**, not a trade-by-trade
  record. It answers "how would today's portfolio have behaved", which is the
  right question for risk. Log transactions via `POST /transactions` if you want
  a true record later.
- **Stress tests report coverage.** If a holding has no history in the scenario
  window its exposure is beta-estimated, and the response says so.
- **Look-through US exposure** uses published fund geographies. It is an
  estimate, and typically 5–10pp above headline geography weights.
- **Sentiment scoring is a lexicon count.** It is a filter aid, not a signal.
- **Missing data is never filled in.** A symbol the API has not returned is
  absent rather than estimated, and renders as absent. Nothing on any page is
  a placeholder, a default, or a plausible-looking stand-in.
- **Every derived figure returns null rather than a guess** when there is not
  enough history to compute it honestly, so "not enough data" is visibly
  different from zero.
- **The memory layer is rebuilt from stored bars**, not accumulated live, so it
  backfills across the whole history on first run and is idempotent. It runs on
  boot and after every sync; about a second for 36k observations.
- **The macro calendar is not covered.** No free structured feed for CPI,
  payrolls or rate decisions is wired up, and Investing.com does it better. The
  calendar says so rather than leaving the gap to be discovered.
- **The bull/bear view shows no overall verdict or score.** Weighting a
  momentum signal against an analyst signal would need weights nothing here
  can justify. The only aggregate is a straight count of which way the signals
  point, and signals that cannot be computed are listed with the reason so a
  thin case looks thin.
- **The thesis model sees only the signal list** — no prices, no company
  narrative, and an explicit list of what is not observable for that
  instrument. A generation that fails or returns unparseable output writes
  nothing, since a half-written thesis still reads as authored.
- **AI commentary can conclude that nothing happened**, and on most days should.
  It is given sigma-scored moves and percentile ranks rather than raw levels,
  and is instructed never to cite a figure it was not handed.

## Not available for free, and therefore not built

Options flow, short interest, and 13F institutional holdings all require paid
feeds (Polygon, Quiver, WhaleWisdom). Rather than ship endpoints that silently
return nothing, they are omitted. SEC Form 4 insider filings and full filings
search *are* free and are included.

## API keys

None required for any of the above.

The AI layer uses your own Gemini key, entered in Settings and held in browser
localStorage. **It is also copied to the server** (`POST /settings/ai`, stored
in the `settings` table) because news relevance scoring runs on the refresh
loop with no browser attached. This is a single-user app on your own machine,
so that is a reasonable trade — but the key is on disk in `meridian.db`, which
is gitignored, and it is worth knowing rather than assuming otherwise.

Set an EDGAR contact string via
`POST /settings {"edgarUserAgent":"Your Name your@email"}`; the SEC rate-limits
anonymous requests.

## Running it on a synced folder

Vite rewrites its dependency cache constantly, and OneDrive, Dropbox and iCloud
hold file locks that make Windows refuse the rename — surfacing as an EPERM
crash on whichever module was unlucky. The cache is kept in the OS temp
directory to avoid this, and `npm start` warns if the project itself sits in a
synced folder. Moving the project out of it is the only complete fix.

## Auto-update (Windows)

`scripts/windows/` makes this repo keep itself current with GitHub without
manual `git pull`/`npm install`/restart cycles.

**One-time setup:**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\setup-auto-update.ps1
```
This registers a Windows Scheduled Task that, every 5 minutes and once at
every login:
1. Checks GitHub for a new commit on `main`.
2. If there's one, backs up every file about to change into
   `_archive\<timestamp>\`, mirroring the repo's folder structure.
3. Pulls (fast-forward only — it refuses rather than merges if the local copy
   has been hand-edited).
4. Runs `npm install` if `package.json` changed.
5. Restarts the app.

If there's nothing new, it just makes sure Meridian is actually running and
starts it if not — so `npm start` by hand is no longer needed either.

**If an update turns out to be broken:**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\restore-backup.ps1
```
Lists past backups and restores the one you pick. `meridian.db` — your
holdings, cash and price history — is never touched by any of this, since it's
gitignored and git pull doesn't go near it.

**To stop auto-updating:**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\stop-auto-update.ps1
```

Progress is logged to `auto-update.log` in the repo root. Both that file and
`_archive\` are gitignored — they're per-machine, not something to sync back.
