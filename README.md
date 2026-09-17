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
  index.js               HTTP server, 140 routes
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
    portfolio-analysis.js  scorecard, correlation pairs, holdings-by-type and
                         the per-holding detail read behind the side panel
    performance.js       money-weighted (XIRR) and time-weighted return from
                         a dated cash-flow ledger and stored snapshots
    signals.js           cross-engine alert kinds - news, sentiment tone,
                         bull/bear flips, scorecard axes, concentration and
                         correlation breaks - plus repeat/snooze lifecycle
    briefing.js          the cross-engine daily read: ranks findings from
                         portfolio, alerts, news, calendar, signals, regime
                         and correlation on one materiality scale, and diffs
                         them against the last briefing marked as read
    correlation.js       date-joined correlation: multi-window matrix, calm vs
                         stressed conditioning, clustering, and how many
                         independent bets the book actually contains
    xray.js              what the book actually holds once every fund is looked
                         through: merged underlying companies, the ones reached
                         through several holdings, and blended sectors
    attribution.js       where the return came from: Cariño-linked contribution
                         per holding, allocation and selection against the
                         portfolio's own average, and commentary over the
                         reconciled figures
    importer.js          broker statement parsing: delimiter and header
                         sniffing, column mapping, and a preview that writes
                         nothing until told
    reports.js           periodic reports assembled from every engine, rendered
                         self-contained and archived once each period closes
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
    research.js          the Research overview: price series with moving
                         averages, technicals from stored bars, dated chart
                         events, news-sentiment trend, and the composed
                         "where things stand" narrative
    integrity.js         bar validation and corruption repair
    newsscore.js         AI relevance scoring for the news feed
    allocate.js          cash deployment across existing engines
    rebuild/             "what portfolio should exist?" — see below
      exposure.js        look-through decomposition and overlap detection
      mandate.js         risk/horizon constraints, persisted
      universe.js        investable + analysable candidate assembly
      regime.js          market context, scales trust in timing signals only
      diligence.js       per-candidate evidence and verdict
      construct.js       redundancy resolution, weights, constraints, trades
      index.js           pipeline orchestration and run history
scripts/
  start.js               cross-platform launcher
  sync.js                history backfill
  seed-dev-db.js         synthetic history for offline engine testing;
                         refuses to run against anything but a *.test.db
  test-rebuild.mjs       rebuild pipeline assertions against synthetic
                         fixtures with known-correct answers
  test-portfolio-analysis.mjs
                         scorecard, correlation and holding-detail assertions
                         against the same synthetic world
  test-briefing.mjs      cross-engine ranking, read-state diffing and
                         quiet-day behaviour, same synthetic world
  test-signals.mjs       each cross-engine alert kind firing and, just as
                         importantly, staying quiet on an unchanged world
  test-performance.mjs   IRR and TWR against schedules whose answer is known
                         analytically before the engine runs
  test-lookthrough.mjs   venue classification and fund decomposition, including
                         that an unseen fund stays unseen
  test-correlation.mjs   correlation against closed-form answers, and the
                         date-alignment case that returns 1.0 joined on date
                         and -0.04 compared by position on the same bars
  test-xray.mjs          look-through arithmetic worked out on paper, and the
                         assertion that partial fund disclosure is never scaled
                         up to look complete
  test-attribution.mjs   the exact identities a decomposition must satisfy:
                         contributions summing to the compounded return, effects
                         summing to zero, and commentary that can say nothing
                         happened
  test-importer.mjs      messy real-world statement shapes, and every case where
                         the importer refuses rather than guesses
  test-reports.mjs       period arithmetic, self-contained rendering, and a
                         schedule that survives the app being closed
```

## Rebuild — "what portfolio should exist?"

Three engines answer three different questions and should not be confused:

| Engine | Question | Scope |
|---|---|---|
| `rebalance.js` | How do I drift back to my existing targets? | Current holdings, needs targets set |
| `allocate.js` | Where does this spare cash go? | New money only, never proposes a sale |
| `rebuild/` | What should I own at all? | Everything investable; can exit and can buy new |

Rebuild exists because the other two both take the current holdings as given.
Neither can notice that two of them are the same fund wearing different names,
and neither can propose owning something never owned.

It runs as a funnel, each stage recording what it found *and what it could not
see*:

- **A · exposure** — decomposes every holding into what it actually holds.
  Detects duplicated exposure from three independent kinds of evidence
  (shared top-ten holdings, sector-profile similarity, return correlation),
  each reported with its own basis. A pair with no data reads
  `cannot-assess`, never `distinct`.
- **B · mandate** — risk level and horizon resolve to explicit numbers
  (position cap, sector cap, minimum position, maximum holdings, cash buffer,
  conviction bar, signal weights). Unsatisfiable combinations are flagged.
- **C · universe** — holdings, watchlist and the tracked universe, filtered to
  what can actually be bought (an index, an FX pair, a yield and a futures
  contract are all excluded) and what has enough history to be scored.
- **D · regime** — market context. Deliberately limited: it scales how far the
  short-horizon timing signal is trusted and supplies context for the report.
  It never vetoes a candidate, sets a weight, or overrides the mandate.
- **E–G · diligence** — per candidate: long-run risk-adjusted delivery, fee
  drag, long-horizon trend, screener composite, precedent study, with
  Bull/Bear as corroboration and news as a *gate* rather than a score.
  Unmeasurable components are dropped from the blend, never defaulted to
  neutral, and the share of intended evidence actually available is reported
  alongside every conviction.
- **H · construct** — duplicates are collapsed to one winner (conviction, then
  cost) *before* optimising, because a mean-variance solver handed two
  0.98-correlated assets splits between them arbitrarily. Expected returns are
  the candidate set's average historical return tilted by conviction and
  capped by the mandate, never raw trailing means. Caps are enforced after the
  solve, and where the caps make full investment impossible the shortfall is
  left in cash and explained rather than renormalised away.

Output is advisory: a trade list, a risk and stress comparison against the
current portfolio, and an explicit list of everything the run could not see.
It never writes to holdings. **No tax modelling anywhere in this pipeline** —
the portfolio it serves is held in wrappers where it does not apply, and a tax
model that is not needed is a source of wrong answers rather than safety.

Verify it with `MERIDIAN_DB=/tmp/rb.db node scripts/test-rebuild.mjs`, which
builds a synthetic portfolio containing a deliberate duplicate pair, a
deliberate junk holding and a strong unheld candidate, and asserts the
pipeline finds each. `SEED_ONLY=1` stops after seeding, for driving the UI.

## Portfolio → Analysis

The Portfolio page could always say what is held and what it is worth. It could
not say whether the things held are any good, whether two of them are the same
bet, or which one is dragging the rest down. That is what this sub-page adds,
and it adds it without inventing a new scoring system:

- **Scorecard.** The five axes are the *same* axes the rebuild pipeline scores
  candidates on — quality, trend, technicals, precedent, cost — computed by the
  same function, so a holding's quality score here and in a rebuild run are the
  same number rather than two engines quietly disagreeing about one instrument.
  They are deliberately not Value/Future/Past/Health/Dividend: those are built
  for picking individual shares, and "dividend" or a blended P/E means very
  little for an index tracker or a gold ETF.
- **Attribution.** Each axis names which holdings lift it and which hold it
  back, ranked by each one's *actual pull on the weighted average* — position
  size times its distance from the mean — not by whose raw score is highest. A
  25% holding scoring slightly below average drags the portfolio more than an
  11% holding scoring zero, and ranking by score would tell you the opposite.
  The pulls sum to zero across holdings by construction, which the test suite
  asserts.
- **Correlation.** The most and least correlated pairs, each with the combined
  weight of the two holdings, because 0.97 between two 4% positions and 0.97
  between two 25% positions are not the same finding. The full matrix is
  deliberately not drawn: with six holdings it is fifteen numbers to read in
  order to find the two that matter. The two lists are always disjoint.
- **Coverage, everywhere.** Every axis reports the share of invested value that
  actually produced a reading, and names the holdings that produced none. A
  holding with no published expense ratio is missing from the cost axis rather
  than scored as though it were free. Cash is excluded from the axes, and the
  page says so.

The side panel on the Holdings tab is one read (`GET /portfolio/holding`)
rather than six, so opening it does not stall on a chain of round trips. Each
block degrades on its own: no stored composition means that block explains
itself and the rest still renders.

**The fourth summary tile is a reconstruction, not an IRR.** A money-weighted
return needs dated cash flows, and this project stores holdings rather than a
trade-by-trade record — an "IRR" derived from holdings alone would mean
inventing the contribution dates it depends on. It is labelled as what it is.

Verify with `MERIDIAN_DB=/tmp/rb.db node scripts/test-portfolio-analysis.mjs`
against the same seeded world: it asserts the cheap fund lifts the cost axis,
the expensive near-duplicate holds it back, the junk holding is missing from
the cost axis entirely rather than scored as free, and that the duplicate pair
is the top "moves together" result.

## Performance

The Portfolio page has shown a reconstructed return with an honest caveat
attached: it holds current weights fixed and replays them over stored bars,
which answers "how would this book have done" and not "how did I do". The
difference is not academic — buy heavily into something just before it falls
and the reconstruction never sees it, because it does not know when the money
arrived.

Knowing when the money arrived needed a fact the database did not hold.
`transactions` records buys and sells, but those are *internal*: a buy moves
value from cash into a security without changing what the portfolio is worth.
The flows that matter are the ones crossing the boundary — money paid in and
taken out — so `performance.js` ships with a ledger for exactly those.

It then computes the two returns that answer different questions and routinely
disagree:

- **Money-weighted (XIRR)** — what *your money* earned, including the effect of
  when you added and removed it. The honest answer to "how am I doing".
- **Time-weighted** — what *the strategy* earned, with deposit timing stripped
  out. The figure comparable to an index, because an index has no deposits.

The gap between them is the timing effect, and it is the most useful number on
the page: the only one that says whether *when* you bought helped or hurt,
separately from *what* you bought. A portfolio can show a strong time-weighted
return and a poor money-weighted one at the same time; both are correct, and
showing only one is how a tool flatters its user.

IRR is solved by **bisection, not Newton-Raphson**. Newton converges faster and
can walk off to a nonsense root on the schedules real portfolios produce — a
large late withdrawal, several sign changes — and a wrong IRR presented
confidently is worse than a refused one. Bisection cannot leave its bracket: it
either finds the root inside it or reports that it could not.

Nothing is inferred. No ledger means no money-weighted return, and the page
says so rather than guessing a contribution schedule. Under about a week of
history is refused rather than annualised, because annualising a fortnight
turns a rounding difference into a headline. Snapshots are only taken while the
app runs, so time-weighted coverage is stated as a percentage of the days in
the span rather than smoothed over.

Verify with `MERIDIAN_DB=/tmp/perf.db node scripts/test-performance.mjs`: it
checks the engine against schedules whose answer is known in advance — 100 in
and 110 out a year later is exactly 10%; 121 after two years annualises to 10%
and not 21%; a 9,000 deposit yesterday that raised the value by 9,000 is a zero
return and not 900%; and money added before a fall produces an IRR below the
TWR with a timing verdict that says so.

## Alerts

The alert engine has had ten price and technical kinds since v2, a full
evaluation loop, and four routes — and no page. Nothing could be armed without
curl, so in practice nothing ever was. There is now a page, and the kinds it
can arm are no longer limited to what a price series knows.

`signals.js` adds six cross-engine kinds: an important story on a holding, the
tone of its coverage shifting, the bull/bear balance flipping, a scorecard axis
falling through a line, a concentration breach, and two factors that used to
move together coming apart.

They are separate from `alerts.js` for two reasons that are not stylistic.
**Cadence** — these read the news table, rebuild signals from bars and run the
scorecard, which is hundreds of milliseconds rather than the microseconds a
price comparison costs, so they run on their own 15-minute beat instead of the
price tick. **State** — a price alert is stateless, but "the balance flipped"
is only answerable against what it was last time, so each carries a remembered
reading in `signal_state`.

That remembered state is what stops the common failure: an alert that re-fires
every cycle on the same unchanged finding. Every kind is tested in both
directions — it fires when the world genuinely changes, and stays silent when
asked again about the same world.

Lifecycle is shared by both families: `once` retires on firing, `daily` fires
at most once a day, `always` stays armed; any alert can be snoozed or muted.
Firings are recorded in `alert_events`, so history survives a repeating alert
re-arming.

Portfolio-scoped alerts use a reserved `PORTFOLIO` symbol rather than a null.
`alerts.symbol` is `NOT NULL`, and dropping that constraint in SQLite means
rebuilding the table — on a live database holding real alerts, with no backup
and no undo. A constant was the cheaper trade.

**Delivery is in-app only, and the page says so.** An alert that fires while
nothing is open is recorded and waiting, not delivered; there is no email or
desktop notification wired up.

Verify with `MERIDIAN_DB=/tmp/sig.db node scripts/test-signals.mjs`.

## Briefing

Every other page answers one question in isolation. Noticing that a headline is
about your second-largest position, which also had a 2.6-sigma day and has an
alert armed on it, is work left to the reader across five pages. The briefing
does that join.

Findings from eight sources — alerts, held-symbol moves, news touching
holdings, concentration and scorecard flags, calendar events, signal balance,
regime and correlation — are reduced to one **materiality** score so they can
be ranked against each other:

    materiality = 100 x strength x stake x kind weight

- **strength** — how extreme the finding is in its own terms, normalised
  against the point where that kind stops being routine (3 sigma for a move,
  100 for a relevance score).
- **stake** — how much of the portfolio it touches, on a square-root curve so a
  5% position clears the floor while summed stakes stay discriminating at the
  top of the range, where concentrated portfolios actually live.
- **kind weight** — how inherently actionable it is. An alert the user set
  themselves outranks an ambient regime reading of equal strength.

**It reports change, not state.** "US is 33% of your portfolio" is true every
day and belongs on the Portfolio page. Findings are fingerprinted and diffed
against the last briefing marked as read (`POST /briefing/read`), so `isNew`
means new *to the reader* — and new findings lead the headline even when a
seen finding scores higher. Acknowledgement takes the fingerprints the client
actually rendered, so a finding arriving between render and click is not
silently marked as seen.

It is strictly read-only. The alerts engine's `evaluate()` flips alerts to
triggered as a side effect and the price-poll loop owns that call; the briefing
reports what fired, it is never what makes an alert fire.

Every section states its own coverage, an empty section says why it is empty
without being opened, and the verdict is allowed to conclude that nothing
happened — which on most days it should.

Verify with `MERIDIAN_DB=/tmp/brief.db node scripts/test-briefing.mjs` against
the seeded world: it asserts a triggered alert outranks ambient findings, a
story touching two holdings outranks one touching a single holding at the same
relevance, a high-relevance story about an untracked ticker is excluded
entirely, fingerprints are stable across rebuilds, and an empty portfolio
concludes nothing happened rather than inventing a finding.

## Correlation

The Risk page used to draw its correlation matrix from
`analytics.correlationMatrix`, which takes the last N bars of each symbol and
correlates them index-for-index. That is only valid if every symbol's stored
history lines up perfectly, and it does not: two London listings with different
suspension histories, or any symbol with a gap in its bars, shift against each
other, and the cell then compares one holding's Tuesday against another's
Thursday. The number it produced looked exactly like a measurement.

`engines/correlation.js` joins on date instead. The test that matters seeds two
symbols holding **identical prices on every date they share**, one of them
missing a day each week. Joined on date they correlate at 1.0. Compared by
position — the old behaviour, on the same bars — they come out at **-0.04**.

Four things it does that a single correlation number cannot:

- **Windows.** The same pairs over 3m, 6m, 1y and everything stored, plus the
  drift between the shortest and longest measurable window. A pair at 0.29 over
  a year and 0.99 over three months is a diversification assumption that has
  quietly stopped holding, and one figure averaged across both regimes hides it.
  There is deliberately no one-month window: 30 calendar days is ~22 trading
  days, and a correlation from 22 points has a 95% interval roughly 0.66 wide.
- **Calm versus stressed.** Correlation measured on the worst 10% of days for
  *this* portfolio, against the other 90%. Diversification failing is a tail
  event, so the full-sample number is dominated by exactly the days you do not
  care about. A pair at 0.06 normally and 1.00 in a selloff is not diversified,
  and the full-sample figure for that pair is 0.77.
- **Independent bets.** Holding count and weight-based concentration both treat
  two 0.98-correlated funds as two holdings. `independentBets` (eigenvalue
  entropy of the correlation matrix) and `effectiveBets` (the squared
  diversification ratio) give the honest count — four identical holdings score
  1.0, four independent ones score 4.0.
- **Blocs.** Average-linkage clustering on `1 - correlation`, so "six of your
  eleven holdings are one thing" is visible without reading a grid. Average
  rather than single linkage because single linkage chains: one incidental pair
  merges two unrelated groups and reports a diversified book as one blob.

Nothing that cannot be measured is filled in. A pair with too little overlap,
or a series with no variance, is `null` — never `0`, which is a claim that two
things move independently and is a much stronger statement than "we could not
tell". Holdings that could not be assessed are named at the top of the report
rather than silently dropped, and the matrix is pairwise (each cell on its own
overlap) while anything matrix-wide is complete-case (the dates every holding
shares), because those are different samples and substituting one for the other
quietly changes what the answer is about.

Verify with `MERIDIAN_DB=/tmp/corr.db node scripts/test-correlation.mjs` — 107
assertions, most against answers known in advance: a perfect linear relation
correlates at exactly 1, the identity matrix has every eigenvalue 1,
`[[1,r],[r,1]]` gives 1±r, four identical holdings collapse to one bet, two
factor blocs cluster as two blocs, and a pair engineered to correlate only in a
selloff is caught by the stress split and missed by the full-sample number.

## Portfolio X-ray

Every other view answers questions about the things you bought. This one
answers questions about what you actually own, which is a different list. Six
fund tickers can be one bet on the same twenty companies, and no amount of
staring at the fund-level table will show it.

It merges every fund's disclosed holdings, weighted by position size, into one
list of underlying companies — each carrying which of your holdings it arrived
through. On the test book, Apple is 17.6% of the portfolio reached three
separate ways, a fact no fund-level view in the app can produce. The tab leads
with the contrast: **you bought 5 holdings, you own 6 disclosed companies.**

**The thing that matters most here is what it refuses to do.** Yahoo publishes
a fund's top ten holdings, not its book — for a global tracker that is often
15-25% of the fund, and the rest is not available anywhere free. So every
weight is a **floor**: "at least this much", never an estimate of the truth.

The tempting move is to scale the disclosed weights up so they sum to the
position's full weight. It makes the output look complete and produces a
beautiful pie chart. It is also a fabrication — it asserts the undisclosed 80%
of a fund is distributed like the disclosed 20%, which is false for every fund
with a long tail, i.e. precisely the funds most people hold. Nothing here
normalises a partial disclosure up to 100%, `seenWeight` and `unseenWeight` are
reported on every figure, and the UI leads with a coverage bar that draws the
undisclosed remainder rather than describing it. There is a test pinning the
sum of underlying weights to the disclosed share specifically so that change
cannot be made quietly later.

Other things it keeps honest:

- A directly held company is marked `exact`; anything reached through a fund is
  a floor. One fund leg is enough to make a mixed figure a floor — Apple held
  directly *and* through two funds is still `≥`.
- Sector coverage is computed separately from name coverage, because a fund can
  disclose 18% of its holdings by name and still publish its full sector split.
  Reusing one coverage figure for both would understate the sector picture.
- Tickers are matched with the listing suffix stripped, so the same company
  reached as `SHEL` through one fund and `SHEL.L` through another does not read
  as two separate moderate positions. Names fall back to the same normaliser
  the pairwise overlap uses, exported rather than duplicated so the two cannot
  drift apart and disagree about whether two entries are one company.
- Holdings that publish nothing are listed by name with their weight, and
  separated into "stores a composition with no holdings" versus "has no stored
  composition at all", which are different problems with different fixes.

Verify with `MERIDIAN_DB=/tmp/xray.db node scripts/test-xray.mjs` — 72
assertions against a book whose every answer is worked out on paper in the file
header before the engine runs.

## Attribution

The performance engine says what the portfolio returned. This one says where
that return came from.

**What is deliberately not here.** The textbook answer is Brinson attribution:
split excess return against a benchmark into an allocation effect (you were
overweight the sectors that did well) and a selection effect (within each
sector you picked the right names). Morningstar Direct and Bloomberg PORT both
do this and it is the right decomposition.

It also needs the benchmark's sector weights *and* the benchmark's return
within each sector, at each point in the period. Meridian can fetch an index's
price series. It cannot fetch the FTSE All-Share's technology weight as at
March, because no free source publishes index constituent weights as a time
series. Two of the four inputs are missing, so a Brinson attribution here would
be a Brinson attribution against invented benchmark weights.

So this engine decomposes the portfolio against **itself** — every effect is
measured relative to the portfolio's own average return — and says so on every
label it returns. The total-level comparison against a real index *is* honestly
computable and is reported separately, rather than folded in where it would
imply the sector splits were benchmark-relative too.

Per holding, per day, with `w` the weight at yesterday's close:

```
contribution      = w x r                        what it added to the total
baseline          = w x r_portfolio              what it would have added earning the average
allocation effect = w x (r_group - r_portfolio)  its group beating the book
selection effect  = w x (r_holding - r_group)    it beating its own group
```

and `contribution = baseline + allocation + selection` exactly, per holding and
in total.

**Why the sums are not naive.** Daily contributions are arithmetic; the total
return is geometric. Summing `w x r` across 250 days does not equal the
compounded return, and the gap grows with volatility — on the test book the
unlinked sum is -6.95% against a true -7.09%. Every contribution is therefore
Cariño-linked, scaled by a per-day factor derived from the log return, so the
parts sum to the compounded whole exactly. The test asserts that identity to
1e-9 and also measures the unlinked version, so the linking is visibly doing
work rather than being asserted.

**A defect this caught.** Group-level selection is *structurally* zero — a group
return is the weighted average of its members, so nothing inside can beat it on
net. A UI column showing that sum would have read `0.00%` for every group
forever. The group view reports the selection *spread* instead (how much moved
from laggards to leaders inside the group), and per-holding selection is shown
on the holding rows where it does mean something. There is an assertion pinning
the zero so it is understood rather than rediscovered.

The commentary is written from the reconciled figures only — the model is handed
the numbers this engine computed, never the raw report to interpret as it likes.
It is permitted, and told, to conclude that nothing notable happened. It is
generated on request rather than with the numbers, because it costs an API call
and the page should render without one. The AI function is injectable, so all
of it is tested with no key and no network.

Verify with `MERIDIAN_DB=/tmp/attr.db node scripts/test-attribution.mjs` — 68
assertions, most of them exact identities a correct decomposition must satisfy
whatever the prices happen to be.

## Importing a statement

Every engine here is only as good as the holdings behind it, and until now
those were typed in by hand.

`engines/importer.js` parses what a broker actually exports: preamble rows above
the header, semicolon or tab delimiters, `£1,234.50`, `(1,500.00)` for a
negative, `2750p`, quoted fields containing commas and newlines, and the dozen
different names brokers give the same column (`EPIC`, `No. of Shares`, `Price
Per Share`, `Account Type`).

**Nothing writes on the first call.** `preview()` parses, maps, validates and
reports what WOULD happen row by row, and touches nothing. `apply()` is a
separate call that takes the preview's own rows back, so what is written is what
was shown. Rows the preview rejected cannot be applied even if handed back
directly. No path deletes a holding, and an existing position is only changed
when that is explicitly requested — a statement not mentioning a position is not
evidence it was sold.

Three ways a statement import goes silently wrong, and what happens instead:

- **Dates.** `03/04/2026` is 3 April to a British broker and 4 March to an
  American one. The order is inferred from the whole column — one row with a
  first component above 12 settles it for every row — and where a column is
  genuinely undecidable the import is **blocked** with the choice handed to the
  reader. Guessing here corrupts a transaction history in a way that looks
  entirely normal.
- **Pence.** UK brokers quote many LSE lines in pence, so `1,234.50` may be
  £1,234.50 or £12.345 — a 100x error. The suspicion is raised by comparing
  against the instrument's own stored bars, which is the only evidence that
  settles it, and nothing is ever converted on a guess.
- **Tickers.** An unrecognised symbol imports but is flagged as having no stored
  history, rather than being mapped to whatever looks closest.

Verify with `MERIDIAN_DB=/tmp/imp.db node scripts/test-importer.mjs` — 102
assertions, weighted towards what it refuses to do.

## Reports

Stock Rover emails a performance report on a schedule. The value in that is not
the email — it is that the report exists without you remembering to look, and
that last month's version is still there when you want to compare.

`engines/reports.js` assembles every engine's answer for a period, renders it to
a single self-contained HTML document (no external stylesheet, font or script,
so it still opens years later from a folder with nothing running), and stores
both the document and the underlying numbers. Storing the numbers matters: a
report generated in March should still say what March said after the engines
that produced it have changed.

Two things it gets right that a naive scheduler does not:

- **A report covers a period that has ENDED.** Reporting on the week currently
  running produces a partial figure labelled as a full one, and then quietly
  changes every time it regenerates.
- **The schedule is driven by the table, not by a timer's memory.** The app is
  closed most of the time. A schedule that only fired while the process happened
  to be running would skip every period the user did not open it during — so
  `generateDue` asks which completed periods have no report yet. Close the app
  for three weeks and the missing reports appear on the next run.

**Email delivery is deliberately not implemented**, and the reason is this
project's own testing rule rather than laziness. The sandbox this was built in
cannot reach a mail server, so an SMTP client written here could be checked for
syntax and against a fake socket and nothing more — the parts that actually
break (a provider's TLS quirks, app-password auth, implicit TLS on 465 versus
STARTTLS on 587) would ship unverified, against real credentials. This project
has a specific history of exactly that failure. The scheduling half is real; the
transport is left to the user and said plainly rather than half-built.

Verify with `MERIDIAN_DB=/tmp/rep.db node scripts/test-reports.mjs` — 49
assertions, including that closing the app across three week boundaries still
produces three reports.

## Key endpoints

**Data** — `GET /prices` `/feargreed` `/history?symbol=` `/symbols` `/quote?symbol=`
`/search?q=` · `POST /sync`

**Portfolio** — `GET /portfolio` `/portfolio/history` `/portfolio/snapshots` ·
`POST|PUT|DELETE /holdings` `/cash` `/transactions`

**Risk** — `GET /risk` `/regime` `/correlations` `/stress` `/scenarios` ·
`POST /stress/shock`

**Correlation** — `GET /correlation?window=` (the whole report) ·
`/correlation/matrix` `/correlation/independence` `/correlation/stress`
`/correlation/redundancies`

**X-ray** — `GET /xray` `/xray/overlaps` `/xray/sectors`

**Attribution** — `GET /attribution?grouping=` · `POST /attribution/explain`

**Import** — `POST /import/preview` `/import/apply`

**Reports** — `GET /reports` `/reports/one?id=` · `POST /reports/generate` ·
`DELETE /reports?id=`

**Planning** — `POST /optimise` `/frontier` `/rebalance` `/contribute`
`/montecarlo` `/goal` `/allocate` · `GET /allocate/candidates` `/allocate/history`

**Portfolio analysis** — `GET /portfolio/types` (holdings grouped by what kind
of instrument they actually are) `/portfolio/scorecard` (the five diligence
axes, portfolio-weighted, with per-axis attribution) `/portfolio/correlations`
(most and least correlated pairs) `/portfolio/holding?symbol=` (one read for
the whole side panel) `/portfolio/return` (reconstructed annualised return)

**Performance** — `GET /performance` (both returns, timing gap and benchmark
comparison) · `GET|POST|DELETE /performance/flows` (the cash-flow ledger)

**Alerts** — `GET /signals` (both families, with descriptions, progress and
firing history) · `POST /signals` `/signals/snooze` `/signals/unsnooze`
`/signals/rearm` `/signals/evaluate` · `GET|POST|PUT|DELETE /alerts`

**Briefing** — `GET /briefing` (the ranked cross-engine read, with per-section
coverage) · `POST /briefing/read` (mark the rendered findings as seen, so the
next build can say what is new)

**Rebuild** — `POST /rebuild` `/rebuild/mandate` `/rebuild/compositions/sync` ·
`GET /rebuild/mandate` `/rebuild/mandate/options` `/rebuild/exposure`
`/rebuild/history` `/rebuild/run?id=`

**Research** — `POST /screen` `/backtest` `/walkforward` · `GET /score?symbol=`
`/screener/strategies`

**Tracking** — `GET|POST|PUT|DELETE /alerts` `/watchlist` `/paper`

**Research overview** — `GET /research/overview?symbol=` — one read backing the
whole Overview tab: the Yahoo summary, the full stored price series with its
50/200-day averages, technicals, dated chart events, ownership and short
interest, the news-sentiment trend, the user's chart notes and the composed
narrative.

**Research deep-dive** — `GET /research/precedents?symbol=` (nearest historical
analogs to today's technical setup, from stored bars only, with forward paths
and strict honesty gates) · `GET /research/compare?symbols=A,B&days=` (up to
four symbols rebased to 100, joined on shared trading dates, with window stats
and return correlations) · `GET /research/corporate?symbol=` (dividend and
split history, live from Yahoo chart events) · `GET /research/peers?symbol=`
(Yahoo's similar-instruments list priced into a comparables table) ·
`GET|POST|DELETE /research/notes` (the user's own dated chart annotations).

**Bull / bear** — `GET /research/bullbear?symbol=` ·
`POST /research/bullbear/generate` · `PUT /research/bullbear/thesis` ·
`DELETE /research/bullbear?symbol=`

**Memory** — `GET /changes` `/memory` `/memory/regime` `/memory/symbol?symbol=`
`/memory/latest?symbols=` `/leadership` `/relationships` · `POST /memory/rebuild`

**News & filings** — `GET /news` `/insiders?symbol=` `/insiders/summary?symbol=`
`/filings?symbol=&type=all` `/fundamentals?symbol=` `/calendar` ·
`POST /news/refresh` `/calendar/refresh`

**AI** — `GET /brief?kind=daily|risk|rebalance|position` · `GET|POST /ai/notes`

**System** — `GET /system/health` (per-symbol bar coverage with staleness,
feed and memory freshness, last overnight sync) · `GET /changelog` (recent
commits from the local clone) · `GET /news/divergence` (held/watched symbols
whose news tone and trailing-month price disagree)

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
- **The Research narrative is composed, not generated.** "Where things stand"
  is assembled sentence by sentence from the same figures shown beside it, and
  a sentence is emitted only when every number in it exists. No model is
  involved, so nothing in it can drift away from the numbers on screen. A
  thinly-covered instrument gets a short section rather than a padded one.
- **The Research chart draws only what it has.** Ranges longer than the stored
  history are disabled rather than shown part-empty, and if the selected range
  cannot be filled the chart falls back to the longest that can and says so —
  nineteen bars are never labelled "1Y". Moving averages are hidden when too
  few bars exist to compute them, and events that fall on non-trading days are
  dropped rather than nudged onto a neighbouring bar they did not happen on.
- **News sentiment refuses thin coverage.** The 90-day trend needs at least six
  scored stories across eight separate days before it will draw anything; below
  that it reports the coverage it found instead. Smoothing runs over days that
  had stories, never across empty ones.
- **Beta is joined on dates, not positions.** Zipping two series by index is
  how a confident, meaningless beta gets computed for a UK listing against a US
  index — different holiday calendars mean the same index is a different day in
  each. It joins on the date and refuses below 120 overlapping bars.
- **A value outside its range is said to be outside it.** A price above every
  published analyst target pins the range marker at the end of the track, which
  reads as "at the top of the range" when the truth is "past it" — so the track
  says which, rather than clamping quietly.
- **Precedents are a described sample, not a forecast.** The precedent finder
  matches today's technical state against the symbol's own history, z-scored
  in its own terms, and reports what followed — with matches forced at least a
  month apart so one episode can't pose as several, the latest quarter
  excluded as candidates, every match labelled close/moderate/loose by its
  distance percentile, and an explicit "no close precedent" banner when
  nothing lands in the nearest decile. The method statement ships in the
  response and renders under the table.
- **Similar instruments are labelled as Yahoo's picks.** How Yahoo builds its
  similarity list is not published, so the panel says so instead of presenting
  it as a curated sector peer group.
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
This registers two Windows Scheduled Tasks:

- **`MeridianAutoUpdate`** — every 5 minutes:
  1. Checks GitHub for a new commit on `main`.
  2. If there's one, backs up every file about to change into
     `_archive\<timestamp>\`, mirroring the repo's folder structure.
  3. Pulls (fast-forward only — it refuses rather than merges if the local
     copy has been hand-edited).
  4. Runs `npm install` if `package.json` changed.
  5. Restarts the app.

  If there's nothing new, it does nothing else — in particular, it does
  **not** relaunch the app if you've closed it yourself. Only a real update
  restarts things.

- **`MeridianStartOnLogin`** — once, at login: same update check, but also
  starts the app if it isn't already running. This is the only place that
  happens, so `npm start` by hand is no longer needed after a reboot or
  sign-in, while deliberately closing Meridian during the day keeps it closed
  until you next log in or start it yourself.

Both tasks run via `wscript.exe` and `scripts\windows\run-hidden.vbs`
instead of launching `powershell.exe`/`npm.cmd` directly. PowerShell's own
`-WindowStyle Hidden` doesn't reliably stop a console window from briefly
flashing on screen — `powershell.exe` and `cmd.exe` (which `npm.cmd` runs
through) both still momentarily allocate a console even under that flag.
`wscript.exe` never allocates one at all, so routing through it removes the
flash rather than just trying to hide it.

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

The server also syncs price history itself once a day (between 5 and 8am
local, while the app is running) and rebuilds the memory layer afterwards, so
stored bars stay at most a day old without any manual `POST /sync`. Settings →
Data Health shows per-symbol freshness and offers one-click resyncs; Settings →
Backup exports holdings, cash and transactions — the only data in this project
with no other copy anywhere — as dated JSON + CSV files.

`Ctrl+K` (or `Cmd+K`) anywhere opens a command palette: jump to any page, or
type a ticker or company name to land straight on its Research page.
