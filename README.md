# Meridian v2 — backend

A rebuild of Meridian's data and analytics layer. v1 fetched prices and rendered
mock data on every other page. v2 stores history, computes real risk, and gives
the AI layer a single view of everything at once.

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
  index.js               HTTP server, 56 routes
  sources/
    yahoo.js             quotes, history sync, pence normalisation
    feargreed.js         CNN index (unchanged from v1 — it worked)
    news.js              RSS ingestion, symbol tagging, sentiment
    edgar.js             SEC Form 4 insider filings
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
scripts/
  start.js               cross-platform launcher
  sync.js                history backfill
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

**News & filings** — `GET /news` `/insiders?symbol=` `/filings?symbol=` ·
`POST /news/refresh`

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

## Not available for free, and therefore not built

Options flow, short interest, and 13F institutional holdings all require paid
feeds (Polygon, Quiver, WhaleWisdom). Rather than ship endpoints that silently
return nothing, they are omitted. SEC Form 4 insider filings and full filings
search *are* free and are included.

## API keys

None required for any of the above. The AI layer uses your own Gemini or
Anthropic key from the browser — no key is stored server-side. Set an EDGAR
contact string via `POST /settings {"edgarUserAgent":"Your Name your@email"}`;
the SEC rate-limits anonymous requests.
