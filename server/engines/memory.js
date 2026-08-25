// Meridian — the memory layer.
//
// Every other engine in this codebase answers "what is". This one answers
// "what changed, and is that unusual". The distinction matters because levels
// are free everywhere: any site will tell you gold is at 2,910. What none of
// them will tell you is that a 1.4% move in gold is a 2.6-sigma day *by gold's
// own standards over the last year*, that it is the fourth consecutive day
// gold and the dollar have moved together after six months of moving apart,
// or that cross-sectional dispersion across your universe is in its 94th
// percentile. Those are statements about history, and they require keeping
// some.
//
// Two tables are maintained, both derived purely from stored OHLCV:
//
//   symbol_observations — one row per (date, symbol): where that instrument
//     sat that day relative to its own trailing distribution.
//   regime_observations — one row per date: what the universe as a whole was
//     doing — breadth, dispersion, correlation, leadership.
//
// Both are recomputed from bars rather than accumulated live, which means the
// memory backfills across the entire stored history the first time it runs.
// A memory layer that only starts remembering the day it is installed is
// useless for months; this one is useful immediately.
//
// Everything here returns null rather than a plausible-looking number when
// there is not enough history to compute it honestly. Null means "not
// enough data", and callers are expected to render that differently from zero.

import { all, one, db, getBars } from '../db.js';
import { TRADING_DAYS, SYMBOLS, FACTORS } from '../config.js';
import { mean, stdev, correlation } from './analytics.js';

// ─── Schema ───────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS symbol_observations (
  date        TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  close       REAL,
  ret_1d      REAL,
  ret_5d      REAL,
  ret_21d     REAL,
  ret_252d    REAL,
  -- How unusual today's move is against this symbol's own trailing year of
  -- daily returns. The single most useful number in the table.
  ret_z       REAL,
  vol_21d     REAL,
  vol_252d    REAL,
  vol_ratio   REAL,   -- 21d vol / 252d vol: is it waking up or going quiet
  pct_rank    REAL,   -- where today's close sits in its own trailing year, 0-1
  dist_50dma  REAL,   -- % above/below, null until 50 bars exist
  dist_200dma REAL,
  above_50    INTEGER,
  above_200   INTEGER,
  drawdown    REAL,   -- % below trailing 252d high
  PRIMARY KEY (date, symbol)
);
CREATE INDEX IF NOT EXISTS idx_symobs_symbol ON symbol_observations(symbol, date DESC);
CREATE INDEX IF NOT EXISTS idx_symobs_date ON symbol_observations(date DESC);

CREATE TABLE IF NOT EXISTS regime_observations (
  date          TEXT PRIMARY KEY,
  n_symbols     INTEGER NOT NULL,
  breadth_50    REAL,   -- fraction of the universe above its own 50dma
  breadth_200   REAL,
  dispersion    REAL,   -- cross-sectional stdev of same-day returns
  avg_corr      REAL,   -- mean pairwise 60d correlation across the core set
  median_ret    REAL,
  pct_up        REAL,
  -- Fraction of the universe having a >2-sigma day by its own standards.
  -- A broad move and a narrow one look identical in an index level.
  pct_extreme   REAL,
  computed_at   INTEGER NOT NULL
);
`);

// ─── Rolling helpers ──────────────────────────────────────────
// smaSeries in analytics.js re-slices and re-averages per index, which is fine
// for a single call but too slow across a 12-year backfill of 60 symbols.
// These are the same measures computed in one pass.

/** Rolling mean. Entries before the window fills are null. */
function rollingMean(xs, period) {
  const out = new Array(xs.length).fill(null);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= period) sum -= xs[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Rolling sample standard deviation, via sum and sum-of-squares. */
function rollingStdev(xs, period) {
  const out = new Array(xs.length).fill(null);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i]; sumSq += xs[i] * xs[i];
    if (i >= period) { sum -= xs[i - period]; sumSq -= xs[i - period] * xs[i - period]; }
    if (i >= period - 1) {
      // Guard the floating-point case where accumulated error drives a
      // genuinely-zero variance slightly negative.
      const variance = Math.max(0, (sumSq - (sum * sum) / period) / (period - 1));
      out[i] = Math.sqrt(variance);
    }
  }
  return out;
}

/** Rolling max, via a monotonic deque — O(n) rather than O(n·period). */
function rollingMax(xs, period) {
  const out = new Array(xs.length).fill(null);
  const dq = [];
  for (let i = 0; i < xs.length; i++) {
    while (dq.length && xs[dq[dq.length - 1]] <= xs[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - period) dq.shift();
    if (i >= period - 1) out[i] = xs[dq[0]];
  }
  return out;
}

/**
 * Fraction of the trailing window that today's value exceeds, 0-1.
 * Ranking within a window is inherently O(n·period); the window is capped at a
 * year and this runs once per backfill, so the cost is paid rarely.
 */
function rollingPctRank(xs, period) {
  const out = new Array(xs.length).fill(null);
  for (let i = period - 1; i < xs.length; i++) {
    let below = 0;
    for (let j = i - period + 1; j < i; j++) if (xs[j] < xs[i]) below++;
    out[i] = below / (period - 1);
  }
  return out;
}

// ─── Per-symbol observation series ────────────────────────────

const W = { short: 21, year: TRADING_DAYS, fast: 50, slow: 200, ret: TRADING_DAYS };

/**
 * Derive the full observation series for one symbol from its stored bars.
 * Returns [] when there is too little history to say anything at all.
 */
export function observeSymbol(symbol, bars = null) {
  const rows = (bars ?? getBars(symbol)).filter(b => typeof b.close === 'number' && isFinite(b.close) && b.close > 0);
  if (rows.length < 2) return [];

  const closes = rows.map(b => b.close);
  const dates = rows.map(b => b.date);
  const n = closes.length;

  // Daily simple returns, index-aligned with closes (index 0 has no prior bar).
  const rets = new Array(n).fill(null);
  for (let i = 1; i < n; i++) rets[i] = closes[i] / closes[i - 1] - 1;

  // Rolling stats over returns need a null-free array; index 0 is filled with
  // 0 so positions line up, and every consumer requires a full window anyway.
  const retsFilled = rets.map(r => r ?? 0);

  const sma50 = rollingMean(closes, W.fast);
  const sma200 = rollingMean(closes, W.slow);
  const retMeanY = rollingMean(retsFilled, W.ret);
  const retSdY = rollingStdev(retsFilled, W.ret);
  const sd21 = rollingStdev(retsFilled, W.short);
  const sdY = retSdY;
  const high252 = rollingMax(closes, W.year);
  const pctRank = rollingPctRank(closes, W.year);

  const ann = Math.sqrt(TRADING_DAYS);
  const out = [];

  for (let i = 1; i < n; i++) {
    const back = k => (i >= k ? closes[i] / closes[i - k] - 1 : null);

    // A z-score is only meaningful once a full year of returns has accumulated
    // AND that year actually varied. A zero-variance window (a fund quoted at
    // an unchanged NAV for a year) would otherwise divide by zero.
    const mu = retMeanY[i], sd = retSdY[i];
    const retZ = (mu != null && sd != null && sd > 0) ? (rets[i] - mu) / sd : null;

    const vol21 = sd21[i] != null ? sd21[i] * ann : null;
    const vol252 = sdY[i] != null ? sdY[i] * ann : null;

    out.push({
      date: dates[i],
      symbol,
      close: closes[i],
      ret1d: rets[i],
      ret5d: back(5),
      ret21d: back(21),
      ret252d: back(TRADING_DAYS),
      retZ,
      vol21d: vol21,
      vol252d: vol252,
      volRatio: (vol21 != null && vol252 != null && vol252 > 0) ? vol21 / vol252 : null,
      pctRank: pctRank[i],
      dist50dma: sma50[i] ? closes[i] / sma50[i] - 1 : null,
      dist200dma: sma200[i] ? closes[i] / sma200[i] - 1 : null,
      above50: sma50[i] != null ? (closes[i] > sma50[i] ? 1 : 0) : null,
      above200: sma200[i] != null ? (closes[i] > sma200[i] ? 1 : 0) : null,
      drawdown: high252[i] ? closes[i] / high252[i] - 1 : null,
    });
  }

  return out;
}

// ─── Persistence ──────────────────────────────────────────────

const insObs = db.prepare(`
  INSERT OR REPLACE INTO symbol_observations
    (date, symbol, close, ret_1d, ret_5d, ret_21d, ret_252d, ret_z,
     vol_21d, vol_252d, vol_ratio, pct_rank, dist_50dma, dist_200dma,
     above_50, above_200, drawdown)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

function saveObservations(obs) {
  if (!obs.length) return 0;
  db.exec('BEGIN');
  try {
    for (const o of obs) {
      insObs.run(o.date, o.symbol, o.close, o.ret1d, o.ret5d, o.ret21d, o.ret252d,
                 o.retZ, o.vol21d, o.vol252d, o.volRatio, o.pctRank,
                 o.dist50dma, o.dist200dma, o.above50, o.above200, o.drawdown);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return obs.length;
}

// ─── Universe-level regime observations ───────────────────────

/**
 * Mean pairwise correlation of daily returns across a set of symbols over the
 * trailing window ending at each date. Computed on a capped sample of pairs:
 * the full matrix is O(n²) per date and the mean converges fast, so a
 * deterministic stride through the pair list gives the same answer far
 * cheaper. Correlation is what matters here, not any individual pair.
 */
function averagePairCorrelation(seriesByDate, symbols, window = 60, maxPairs = 120) {
  const pairs = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) pairs.push([symbols[i], symbols[j]]);
  }
  if (!pairs.length) return null;
  const stride = Math.max(1, Math.ceil(pairs.length / maxPairs));
  const sampled = pairs.filter((_, k) => k % stride === 0);

  const vals = [];
  for (const [a, b] of sampled) {
    const ra = seriesByDate[a], rb = seriesByDate[b];
    if (!ra || !rb || ra.length < window || rb.length < window) continue;
    const c = correlation(ra.slice(-window), rb.slice(-window));
    if (c != null && isFinite(c)) vals.push(c);
  }
  return vals.length >= 3 ? mean(vals) : null;
}

/**
 * Recompute regime observations for every date that has enough coverage.
 *
 * `minSymbols` guards against the early years of the store, where only a
 * handful of symbols have bars — breadth across four instruments is noise
 * dressed as a statistic, and would read as a real reading on a chart.
 */
export function rebuildRegime({ minSymbols = 8, corrWindow = 60 } = {}) {
  const dates = all(`SELECT date, COUNT(*) n FROM symbol_observations
                     GROUP BY date HAVING n >= ? ORDER BY date ASC`, minSymbols);
  if (!dates.length) return { dates: 0, skipped: 'no observations yet' };

  // Pull everything once; per-date queries across a 12-year backfill would be
  // thousands of round trips through the statement cache.
  const rows = all(`SELECT date, symbol, ret_1d, ret_z, above_50, above_200
                    FROM symbol_observations ORDER BY date ASC`);

  const byDate = new Map();
  const retHistory = {};        // symbol -> rolling return window for correlation
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }

  const ins = db.prepare(`
    INSERT OR REPLACE INTO regime_observations
      (date, n_symbols, breadth_50, breadth_200, dispersion, avg_corr,
       median_ret, pct_up, pct_extreme, computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  const now = Date.now();
  let written = 0;

  db.exec('BEGIN');
  try {
    for (const [date, dayRows] of byDate) {
      // Keep the correlation window rolling forward over every date, including
      // ones too thin to write a row for — otherwise the window would have
      // gaps and the correlations would silently span the wrong period.
      for (const r of dayRows) {
        if (r.ret_1d == null) continue;
        (retHistory[r.symbol] ??= []).push(r.ret_1d);
        if (retHistory[r.symbol].length > corrWindow) retHistory[r.symbol].shift();
      }

      if (dayRows.length < minSymbols) continue;

      const rets = dayRows.map(r => r.ret_1d).filter(r => r != null && isFinite(r));
      const a50 = dayRows.map(r => r.above_50).filter(v => v != null);
      const a200 = dayRows.map(r => r.above_200).filter(v => v != null);
      const zs = dayRows.map(r => r.ret_z).filter(v => v != null && isFinite(v));

      const sorted = [...rets].sort((x, y) => x - y);
      const median = sorted.length
        ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
            : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
        : null;

      const symbolsToday = dayRows.map(r => r.symbol);
      const avgCorr = averagePairCorrelation(retHistory, symbolsToday, corrWindow);

      ins.run(
        date,
        dayRows.length,
        a50.length ? a50.reduce((s, v) => s + v, 0) / a50.length : null,
        a200.length ? a200.reduce((s, v) => s + v, 0) / a200.length : null,
        rets.length >= 3 ? stdev(rets) : null,
        avgCorr,
        median,
        rets.length ? rets.filter(r => r > 0).length / rets.length : null,
        zs.length >= 3 ? zs.filter(z => Math.abs(z) > 2).length / zs.length : null,
        now
      );
      written++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return { dates: written, from: dates[0].date, to: dates[dates.length - 1].date };
}

/**
 * Rebuild the whole memory from stored bars. Idempotent — safe to run on every
 * boot and after every sync. `symbols` scopes it to specific instruments.
 */
export function rebuild({ symbols = null, minBars = 30 } = {}) {
  const targets = symbols?.length
    ? symbols
    : all('SELECT symbol, COUNT(*) n FROM ohlcv GROUP BY symbol HAVING n >= ?', minBars).map(r => r.symbol);

  let written = 0;
  const skipped = [];
  for (const symbol of targets) {
    const obs = observeSymbol(symbol);
    if (!obs.length) { skipped.push(symbol); continue; }
    written += saveObservations(obs);
  }

  const regime = rebuildRegime();
  return { symbols: targets.length, observations: written, skipped, regime };
}

// ─── Reading the memory ───────────────────────────────────────

/** The most recent date the memory holds anything for. */
export function latestDate() {
  return one('SELECT MAX(date) d FROM symbol_observations')?.d ?? null;
}

/**
 * Percentile rank of `value` within a column's own trailing history — the
 * mechanism behind statements like "dispersion is in its 94th percentile".
 */
function percentileOf(table, column, value, { days = TRADING_DAYS } = {}) {
  if (value == null) return null;
  const rows = all(
    `SELECT ${column} v FROM ${table} WHERE ${column} IS NOT NULL ORDER BY date DESC LIMIT ?`, days);
  if (rows.length < 30) return null;
  const below = rows.filter(r => r.v < value).length;
  return below / rows.length;
}

/**
 * How many consecutive days, ending at the latest observation, a condition has
 * held. Answers "the fourth straight day breadth has been under half" — a
 * statement no level can make.
 */
function streak(rows, predicate) {
  let n = 0;
  for (const r of rows) {
    if (r == null || !predicate(r)) break;
    n++;
  }
  return n;
}

/**
 * The core read: what is genuinely different about the latest session,
 * measured against this universe's own history rather than against nothing.
 *
 * Deliberately capable of returning an empty `notable` list and a `quiet`
 * verdict. Most days are quiet, and a market view that manufactures a headline
 * every day trains you to ignore it.
 */
export function whatChanged({ limit = 12, zThreshold = 1.5 } = {}) {
  const date = latestDate();
  if (!date) {
    return {
      date: null, available: false,
      reason: 'No observations stored yet. Sync price history, then rebuild the memory.',
      notable: [], regime: null, verdict: null,
    };
  }

  const prev = one('SELECT MAX(date) d FROM symbol_observations WHERE date < ?', date)?.d ?? null;
  const obs = all('SELECT * FROM symbol_observations WHERE date = ? ORDER BY symbol', date);
  const regimeRows = all('SELECT * FROM regime_observations ORDER BY date DESC LIMIT ?', TRADING_DAYS);
  const today = regimeRows[0] ?? null;

  // A move is notable when it is large *for that instrument*, not when it is
  // large in absolute percentage terms. A 1% day is unremarkable for a
  // semiconductor ETF and a genuine event for a short-duration bond fund.
  const notable = obs
    .filter(o => o.ret_z != null && Math.abs(o.ret_z) >= zThreshold)
    .sort((a, b) => Math.abs(b.ret_z) - Math.abs(a.ret_z))
    .slice(0, limit)
    .map(o => ({
      symbol: o.symbol,
      close: o.close,
      ret1d: o.ret_1d,
      retZ: o.ret_z,
      pctRank: o.pct_rank,
      dist50dma: o.dist_50dma,
      dist200dma: o.dist_200dma,
      drawdown: o.drawdown,
      volRatio: o.vol_ratio,
      // Phrased as a sigma statement because that is what makes it comparable
      // across instruments with wildly different normal ranges.
      note: `${o.ret_1d >= 0 ? '+' : ''}${(o.ret_1d * 100).toFixed(2)}% — ${Math.abs(o.ret_z).toFixed(1)}σ vs its own year`,
    }));

  const regime = today ? {
    date: today.date,
    nSymbols: today.n_symbols,
    breadth50: today.breadth_50,
    breadth200: today.breadth_200,
    dispersion: today.dispersion,
    dispersionPct: percentileOf('regime_observations', 'dispersion', today.dispersion),
    avgCorr: today.avg_corr,
    avgCorrPct: percentileOf('regime_observations', 'avg_corr', today.avg_corr),
    // Breadth against its own year matters more than the raw level: 54% above
    // the 50-day sounds unremarkable and can still be the narrowest this
    // universe has been in twelve months.
    breadth50Pct: percentileOf('regime_observations', 'breadth_50', today.breadth_50),
    breadth200Pct: percentileOf('regime_observations', 'breadth_200', today.breadth_200),
    pctUp: today.pct_up,
    pctExtreme: today.pct_extreme,
    breadth50Streak: today.breadth_50 != null
      ? streak(regimeRows, r => r.breadth_50 != null &&
          (today.breadth_50 >= 0.5 ? r.breadth_50 >= 0.5 : r.breadth_50 < 0.5))
      : null,
  } : null;

  // The verdict is allowed — expected, most days — to be "nothing happened".
  const loud = notable.filter(n => Math.abs(n.retZ) >= 2).length;
  let verdict;
  if (!notable.length) {
    verdict = { tone: 'quiet', text: 'Nothing moved beyond its own normal range today.' };
  } else if (loud >= Math.max(3, obs.length * 0.2)) {
    verdict = { tone: 'broad', text: `${loud} instruments had a 2σ day — this was a move across the board, not a single story.` };
  } else if (loud >= 1) {
    verdict = { tone: 'isolated', text: `${loud} instrument${loud === 1 ? '' : 's'} moved unusually; the rest of the universe was ordinary.` };
  } else {
    verdict = { tone: 'mild', text: 'Mild movement only — nothing reached two standard deviations.' };
  }

  return {
    date, previousDate: prev, available: true,
    observed: obs.length,
    notable, regime, verdict,
    source: 'Derived from stored daily bars (Yahoo Finance), recomputed locally.',
  };
}

// ─── Relationships and leadership ─────────────────────────────

/**
 * Group-level leadership over a window, and whether it has rotated.
 *
 * A sector table showing today's percentages is available anywhere. What is
 * not is whether today's leader was also last month's leader — rotation is
 * the signal, and it needs two windows to see.
 */
export function leadership({ window = 21, prior = 21 } = {}) {
  const date = latestDate();
  if (!date) return { available: false, groups: [] };

  const col = window <= 5 ? 'ret_5d' : window <= 21 ? 'ret_21d' : 'ret_252d';
  const rows = all(`SELECT symbol, ${col} r FROM symbol_observations WHERE date = ? AND ${col} IS NOT NULL`, date);

  // The same measure as of `prior` sessions ago, for the rotation comparison.
  const past = all(
    `SELECT date FROM regime_observations WHERE date < ? ORDER BY date DESC LIMIT ?`, date, prior);
  const priorDate = past.length === prior ? past[past.length - 1].date : null;
  const priorRows = priorDate
    ? all(`SELECT symbol, ${col} r FROM symbol_observations WHERE date = ? AND ${col} IS NOT NULL`, priorDate)
    : [];
  const priorBySymbol = Object.fromEntries(priorRows.map(r => [r.symbol, r.r]));

  const buckets = {};
  for (const { symbol, r } of rows) {
    const g = SYMBOLS[symbol]?.group ?? 'other';
    (buckets[g] ??= { group: g, members: [], now: [], then: [] });
    buckets[g].members.push(symbol);
    buckets[g].now.push(r);
    if (priorBySymbol[symbol] != null) buckets[g].then.push(priorBySymbol[symbol]);
  }

  const groups = Object.values(buckets)
    .map(b => ({
      group: b.group,
      n: b.members.length,
      members: b.members,
      ret: mean(b.now),
      priorRet: b.then.length ? mean(b.then) : null,
    }))
    .sort((a, b) => b.ret - a.ret);

  // Rank movement between the two windows is the actual rotation measure.
  const priorRanked = [...groups].filter(g => g.priorRet != null).sort((a, b) => b.priorRet - a.priorRet);
  const priorRank = Object.fromEntries(priorRanked.map((g, i) => [g.group, i]));

  return {
    available: true, date, priorDate, window,
    groups: groups.map((g, i) => ({
      ...g,
      rank: i,
      priorRank: priorRank[g.group] ?? null,
      rankChange: priorRank[g.group] != null ? priorRank[g.group] - i : null,
    })),
  };
}

/**
 * Cross-asset relationships that have changed, not levels.
 *
 * For each factor pair, the current rolling correlation is compared with the
 * immediately preceding window and placed in its own trailing-year
 * distribution. A pair whose correlation has moved from +0.6 to -0.1 is a
 * regime statement; both endpoints on their own are trivia.
 */
export function correlationShifts({ window = 60, limit = 8 } = {}) {
  const names = Object.keys(FACTORS);
  const series = {};
  for (const name of names) {
    const sym = FACTORS[name];
    const rows = all(
      `SELECT date, ret_1d FROM symbol_observations WHERE symbol = ? AND ret_1d IS NOT NULL
       ORDER BY date DESC LIMIT ?`, sym, window * 2 + TRADING_DAYS);
    if (rows.length >= window * 2) series[name] = { symbol: sym, rets: rows.reverse().map(r => r.ret_1d) };
  }

  const out = [];
  const avail = Object.keys(series);
  for (let i = 0; i < avail.length; i++) {
    for (let j = i + 1; j < avail.length; j++) {
      const a = series[avail[i]], b = series[avail[j]];
      const n = Math.min(a.rets.length, b.rets.length);
      const ra = a.rets.slice(-n), rb = b.rets.slice(-n);
      if (n < window * 2) continue;

      const now = correlation(ra.slice(-window), rb.slice(-window));
      const then = correlation(ra.slice(-window * 2, -window), rb.slice(-window * 2, -window));
      if (now == null || then == null) continue;

      // Trailing distribution of this pair's own correlation, so "unusual" is
      // judged against the pair rather than against a fixed threshold.
      const history = [];
      for (let k = window; k + window <= n; k += 5) {
        const c = correlation(ra.slice(k - window, k), rb.slice(k - window, k));
        if (c != null && isFinite(c)) history.push(c);
      }
      const pct = history.length >= 20
        ? history.filter(h => h < now).length / history.length
        : null;

      out.push({
        pair: `${avail[i]} / ${avail[j]}`,
        symbols: [a.symbol, b.symbol],
        now, previous: then, change: now - then, percentile: pct,
        // Only a sign flip gets called out as a break — a correlation moving
        // from 0.7 to 0.4 is still the same relationship, weaker.
        flipped: Math.sign(now) !== Math.sign(then) && Math.abs(now - then) > 0.25,
      });
    }
  }

  return {
    window,
    available: out.length > 0,
    pairs: out.sort((x, y) => Math.abs(y.change) - Math.abs(x.change)).slice(0, limit),
  };
}

/**
 * Latest observation for each of several symbols, keyed by symbol.
 *
 * Symbols with no observations are simply absent from the result rather than
 * being given an empty row, so callers can tell "not tracked / no history"
 * apart from "tracked and flat".
 */
export function latestFor(symbols) {
  if (!symbols?.length) return {};
  const placeholders = symbols.map(() => '?').join(',');
  // One row per symbol: its own most recent date, which may differ between
  // symbols when their histories end on different days.
  const rows = all(
    `SELECT o.* FROM symbol_observations o
     JOIN (SELECT symbol, MAX(date) d FROM symbol_observations
           WHERE symbol IN (${placeholders}) GROUP BY symbol) m
       ON o.symbol = m.symbol AND o.date = m.d`,
    ...symbols);
  return Object.fromEntries(rows.map(r => [r.symbol, r]));
}

/** Full observation history for one symbol — powers per-instrument context. */
export function symbolHistory(symbol, { days = 260 } = {}) {
  const rows = all(
    `SELECT * FROM symbol_observations WHERE symbol = ? ORDER BY date DESC LIMIT ?`,
    symbol, days);
  return rows.reverse();
}

/** Universe-level series, for charting how breadth and correlation evolved. */
export function regimeHistory({ days = TRADING_DAYS } = {}) {
  return all('SELECT * FROM regime_observations ORDER BY date DESC LIMIT ?', days).reverse();
}

export function memoryStats() {
  return {
    observations: one('SELECT COUNT(*) n FROM symbol_observations').n,
    symbols: one('SELECT COUNT(DISTINCT symbol) n FROM symbol_observations').n,
    regimeDays: one('SELECT COUNT(*) n FROM regime_observations').n,
    first: one('SELECT MIN(date) d FROM symbol_observations')?.d ?? null,
    last: latestDate(),
  };
}
