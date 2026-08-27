// Meridian — the research overview.
//
// Assembles everything the Research page's front tab needs in one read: a
// price series with its moving averages, the technical picture computed from
// stored bars, dated events worth marking on the chart, a plain-English
// account of where things stand, and the news-sentiment trend.
//
// Two principles run through all of it, both inherited from the rest of this
// app rather than invented here:
//
//   Nothing is asserted that the data does not support. Every derived figure
//   carries the bar count and as-of date it was computed from, and a metric
//   whose inputs are missing comes back null with a reason rather than being
//   filled in with a plausible-looking number.
//
//   The narrative is composed, not generated. Each sentence is emitted only
//   when the facts behind it exist, and the whole thing can — and regularly
//   should — conclude that nothing notable happened. No model is involved at
//   any point, so there is nothing here that can drift away from the numbers
//   shown beside it.

import { all, one, getBars } from '../db.js';
import { TRADING_DAYS } from '../config.js';
import { getNews } from '../sources/news.js';
import * as A from './analytics.js';

const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Windows are in trading days, which is why a "month" is 21 and not 30. Bars
// are the unit the whole engine counts in; calendar spans would silently
// stretch across weekends and holidays by a different amount per window.
const WINDOWS = { '1W': 5, '1M': 21, '3M': 63, '6M': 126, '1Y': 252 };

// ─── Price series ─────────────────────────────────────────────

/**
 * The full stored daily series plus its 50 and 200-day moving averages.
 *
 * Sent whole rather than per-range so switching between 1M and 5Y on the
 * chart is instant and costs no request. At twelve years that is roughly
 * three thousand points — about 100KB of JSON, which on a loopback interface
 * is not worth a second round trip to avoid.
 *
 * Arrays are index-aligned rather than an array of objects: same information,
 * roughly a third of the bytes, and the chart consumes them positionally
 * anyway.
 */
export function priceSeries(symbol) {
  const bars = getBars(symbol).filter(b => finite(b.close) != null);
  if (bars.length < 2) {
    return { available: false, reason: bars.length === 0
      ? 'No stored bars for this symbol. Run a sync from Settings, or add it as a holding to fetch history automatically.'
      : 'Only one stored bar — a line needs at least two points.', bars: bars.length };
  }

  const closes = bars.map(b => b.close);
  const sma50 = A.smaSeries(closes, 50);
  const sma200 = A.smaSeries(closes, 200);

  return {
    available: true,
    bars: bars.length,
    first: iso(bars[0].date),
    last: iso(bars[bars.length - 1].date),
    dates: bars.map(b => iso(b.date)),
    close: closes,
    // Rounded to six significant figures. Full float precision on three
    // thousand points is noise in a chart and roughly doubles the payload.
    sma50: sma50.map(v => (v == null ? null : +v.toPrecision(6))),
    sma200: sma200.map(v => (v == null ? null : +v.toPrecision(6))),
    volume: bars.map(b => finite(b.volume)),
  };
}

// ─── Technicals ───────────────────────────────────────────────

/**
 * The measurable state of the price: how far it has come, how violently, and
 * where it sits relative to its own year.
 *
 * Everything is computed from stored bars, never from the live quote — the
 * live price and the last stored bar can disagree intraday, and a mixture of
 * the two produces numbers that reconcile with neither.
 */
export function technicals(symbol, { benchmark = '^GSPC' } = {}) {
  const bars = getBars(symbol).filter(b => finite(b.close) != null);
  if (bars.length < 30) {
    return { available: false, bars: bars.length,
      reason: `Only ${bars.length} stored bar${bars.length === 1 ? '' : 's'} — at least 30 are needed before any of these mean anything.` };
  }

  const closes = bars.map(b => b.close);
  const dates = bars.map(b => iso(b.date));
  const last = closes[closes.length - 1];
  const rets = A.toReturns(closes);

  // Trailing-window return. Null rather than a partial-window figure when the
  // history is too short: "up 4% over a year" computed from four months of
  // bars is a wrong number, not an approximate one.
  const ret = n => (closes.length > n && closes[closes.length - 1 - n] > 0
    ? last / closes[closes.length - 1 - n] - 1 : null);

  const returns = {};
  for (const [label, n] of Object.entries(WINDOWS)) returns[label] = ret(n);

  // Year-to-date runs from the last bar of the previous calendar year, so a
  // year that opened mid-week is still measured from its true starting point.
  const thisYear = dates[dates.length - 1].slice(0, 4);
  const firstOfYear = dates.findIndex(d => d.slice(0, 4) === thisYear);
  returns.YTD = firstOfYear > 0 && closes[firstOfYear - 1] > 0
    ? last / closes[firstOfYear - 1] - 1 : null;

  const vol = (n, ppy = TRADING_DAYS) => (rets.length >= n
    ? A.annualisedVol(rets.slice(-n), ppy) : null);

  // The trailing year, for range position and drawdown. Shorter histories use
  // whatever exists and say so via `rangeBars` rather than silently comparing
  // against a window that isn't a year.
  const yearCloses = closes.slice(-TRADING_DAYS);
  const high52 = Math.max(...yearCloses);
  const low52 = Math.min(...yearCloses);
  const dd = A.maxDrawdown(yearCloses, dates.slice(-TRADING_DAYS));

  const sma50 = A.sma(closes, 50);
  const sma200 = A.sma(closes, 200);

  return {
    available: true,
    bars: bars.length,
    asOf: dates[dates.length - 1],
    lastClose: last,
    returns,
    vol30: vol(30),
    vol90: vol(90),
    vol1y: vol(TRADING_DAYS),
    // A ratio above 1 means the last month has been more violent than the
    // last year — the cleanest single read on whether something is waking up.
    volRatio: (vol(21) && vol(TRADING_DAYS)) ? vol(21) / vol(TRADING_DAYS) : null,
    rsi14: A.rsi(closes, 14),
    sma50, sma200,
    dist50dma: sma50 ? last / sma50 - 1 : null,
    dist200dma: sma200 ? last / sma200 - 1 : null,
    high52, low52,
    rangeBars: yearCloses.length,
    // Where the last close sits between the trailing low and high, 0-1. Not a
    // percentile of the distribution — a position in the range, which is what
    // a range bar draws.
    rangePosition: high52 > low52 ? (last - low52) / (high52 - low52) : null,
    fromHigh: high52 > 0 ? last / high52 - 1 : null,
    fromLow: low52 > 0 ? last / low52 - 1 : null,
    maxDrawdown1y: dd.maxDrawdown,
    maxDrawdownPeak: dd.peakDate,
    maxDrawdownTrough: dd.troughDate,
    stillUnderwater: dd.stillUnderwater,
    ...marketRelation(symbol, benchmark, dates, rets),
  };
}

/**
 * Beta and correlation against a benchmark, computed on the dates the two
 * actually share.
 *
 * Zipping two series by position rather than by date is the classic way to
 * get a confident, meaningless beta: a UK listing and a US index have
 * different holiday calendars, so index 400 is not the same day in both. This
 * joins on the date and refuses to answer below 120 overlapping bars.
 */
function marketRelation(symbol, benchmark, dates, rets) {
  if (!benchmark || String(symbol).toUpperCase() === benchmark.toUpperCase()) {
    return { benchmark: null, beta: null, correlation: null, benchmarkOverlap: 0 };
  }
  const benchBars = getBars(benchmark).filter(b => finite(b.close) != null);
  if (benchBars.length < 130) {
    return { benchmark, beta: null, correlation: null, benchmarkOverlap: 0,
      benchmarkReason: `No stored history for ${benchmark} to compare against.` };
  }

  const benchClose = new Map(benchBars.map(b => [iso(b.date), b.close]));
  // rets[i] is the return INTO dates[i+1], so a return is labelled by the day
  // it landed on.
  const pairs = [];
  for (let i = 1; i < dates.length; i++) {
    const d = dates[i], dPrev = dates[i - 1];
    const b1 = benchClose.get(d), b0 = benchClose.get(dPrev);
    if (b0 > 0 && b1 > 0) pairs.push([rets[i - 1], b1 / b0 - 1]);
  }
  const use = pairs.slice(-TRADING_DAYS);
  if (use.length < 120) {
    return { benchmark, beta: null, correlation: null, benchmarkOverlap: use.length,
      benchmarkReason: `Only ${use.length} trading days overlap with ${benchmark} — too few for a meaningful beta.` };
  }

  const a = use.map(p => p[0]), b = use.map(p => p[1]);
  const { beta } = A.betaAlpha(a, b);
  return { benchmark, beta, correlation: A.correlation(a, b), benchmarkOverlap: use.length };
}

// ─── Chart events ─────────────────────────────────────────────

/**
 * Dated things worth marking on the price line.
 *
 * Only events with a real, known date get in. Nothing is inferred from the
 * shape of the price except the outsized-move markers, which are explicitly
 * labelled as what they are: a move large against this symbol's own recent
 * distribution, with the z-score shown rather than implied.
 */
export function chartEvents(symbol, summary, { days = 400 } = {}) {
  const events = [];
  const cutoff = iso(new Date(Date.now() - days * 86400_000));

  for (const e of summary?.earningsHistory ?? []) {
    if (!e.quarter || e.quarter < cutoff) continue;
    const beat = e.surprisePercent;
    events.push({
      date: e.quarter, type: 'earnings',
      label: beat == null ? 'Earnings'
        : `Earnings ${beat >= 0 ? 'beat' : 'miss'} ${beat >= 0 ? '+' : ''}${beat.toFixed(1)}%`,
      direction: beat == null ? 'neutral' : beat > 0 ? 'bull' : 'bear',
      source: 'Yahoo Finance earnings history',
    });
  }

  for (const u of summary?.upgrades ?? []) {
    if (!u.date || u.date < cutoff) continue;
    const move = u.fromGrade && u.toGrade && u.fromGrade !== u.toGrade
      ? `${u.fromGrade} → ${u.toGrade}` : (u.toGrade ?? 'rating change');
    events.push({
      date: u.date, type: 'rating',
      label: `${u.firm ?? 'Analyst'}: ${move}`,
      direction: u.action === 'up' ? 'bull' : u.action === 'down' ? 'bear' : 'neutral',
      source: 'Yahoo Finance upgrade/downgrade history',
    });
  }

  // Consensus target revisions, from this app's own accrued snapshots. Only
  // exists for symbols that have been opened here before — by construction,
  // not as a gap.
  const snaps = all(
    `SELECT snapshot_date, target_mean FROM analyst_snapshots
     WHERE symbol = ? AND target_mean IS NOT NULL AND snapshot_date >= ?
     ORDER BY snapshot_date ASC`, String(symbol).toUpperCase(), cutoff);
  for (let i = 1; i < snaps.length; i++) {
    const ch = snaps[i].target_mean / snaps[i - 1].target_mean - 1;
    if (Math.abs(ch) < 0.01) continue;
    events.push({
      date: snaps[i].snapshot_date, type: 'target',
      label: `Consensus target ${ch > 0 ? 'raised' : 'cut'} ${(Math.abs(ch) * 100).toFixed(1)}%`,
      direction: ch > 0 ? 'bull' : 'bear',
      source: 'Meridian consensus snapshots',
    });
  }

  // Outsized single-day moves: at least 3 standard deviations against the
  // symbol's own trailing year. Deliberately strict — a marker on every 2%
  // day is wallpaper, not information.
  const bars = getBars(symbol).filter(b => finite(b.close) != null);
  const closes = bars.map(b => b.close);
  const dates = bars.map(b => iso(b.date));
  if (closes.length > TRADING_DAYS + 5) {
    for (let i = TRADING_DAYS; i < closes.length; i++) {
      if (dates[i] < cutoff) continue;
      const r = closes[i] / closes[i - 1] - 1;
      const window = [];
      for (let j = i - TRADING_DAYS; j < i; j++) window.push(closes[j] / closes[j - 1] - 1);
      const sd = A.stdev(window);
      if (!sd) continue;
      const z = r / sd;
      if (Math.abs(z) < 3) continue;
      events.push({
        date: dates[i], type: 'move',
        label: `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}% in one day (${z >= 0 ? '+' : ''}${z.toFixed(1)}σ)`,
        direction: r > 0 ? 'bull' : 'bear',
        source: 'Stored bars',
      });
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date));
  return events;
}

// ─── News sentiment trend ─────────────────────────────────────

/**
 * Daily mean sentiment of stories tagged to this symbol, over 90 days.
 *
 * Gated hard on coverage. Most instruments in this app's feed are mentioned a
 * handful of times a quarter, and a "sentiment trend" drawn through four
 * stories is a line through noise dressed up as a signal. Below the
 * thresholds it refuses and says how thin the coverage was, which is a more
 * honest answer than a chart.
 */
export function sentimentTrend(symbol, { days = 90 } = {}) {
  const since = Date.now() - days * 86400_000;
  const stories = getNews({ symbol, limit: 400, sort: 'newest', since })
    .filter(s => s.published && finite(s.sentiment) != null);

  const byDay = new Map();
  for (const s of stories) {
    const d = iso(new Date(s.published));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(s.sentiment);
  }

  const MIN_STORIES = 6, MIN_DAYS = 8;
  if (stories.length < MIN_STORIES || byDay.size < MIN_DAYS) {
    return { available: false, stories: stories.length, days: byDay.size,
      reason: `Only ${stories.length} scored ${stories.length === 1 ? 'story' : 'stories'} across ${byDay.size} ${byDay.size === 1 ? 'day' : 'days'} in the last ${days} — too thin to draw a trend through. Needs at least ${MIN_STORIES} stories on ${MIN_DAYS} separate days.` };
  }

  const points = [...byDay.entries()]
    .map(([date, vals]) => ({ date, value: A.mean(vals), stories: vals.length }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // A 7-day trailing mean over the days that have stories — not over calendar
  // days. Smoothing across empty days would invent a reading for a day nobody
  // wrote anything.
  const smoothed = points.map((p, i) => {
    const w = points.slice(Math.max(0, i - 6), i + 1);
    return { ...p, smooth: A.mean(w.map(x => x.value)) };
  });

  const now = smoothed[smoothed.length - 1].smooth;
  const priorIdx = smoothed.findIndex(p => p.date >= iso(new Date(Date.now() - 21 * 86400_000)));
  const prior = priorIdx > 0 ? smoothed[priorIdx - 1].smooth : null;
  const band = v => (v > 0.15 ? 'positive' : v < -0.15 ? 'negative' : 'neutral');

  return {
    available: true, days, points: smoothed,
    stories: stories.length,
    now, nowBand: band(now),
    prior, priorBand: prior == null ? null : band(prior),
    // Only claimed when the band actually changed — a drift from +0.02 to
    // +0.05 is not a shift in tone.
    shifted: prior != null && band(now) !== band(prior),
  };
}

// ─── Narrative ────────────────────────────────────────────────

const pc = (v, dp = 1) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(dp)}%`;
const apc = (v, dp = 1) => `${(Math.abs(v) * 100).toFixed(dp)}%`;

/**
 * "Where things stand", composed from the facts above.
 *
 * Three sections, each a list of sentences. A sentence is pushed only when
 * every number in it exists, so a thinly-covered instrument produces a short
 * section rather than a padded one. A section with nothing to report says so
 * explicitly — that is a real finding about a quiet asset, and suppressing it
 * in favour of something more interesting-sounding is exactly the failure
 * this app is built to avoid.
 */
export function narrative({ symbol, name, summary, tech, sentiment, events }) {
  const label = name || symbol;
  const priceAction = [];
  const street = [];
  const coming = [];

  // ── Price action ──
  if (!tech?.available) {
    priceAction.push(tech?.reason ?? 'No stored price history for this instrument, so there is nothing to describe.');
  } else {
    const r = tech.returns;
    const parts = [];
    if (r['1M'] != null) parts.push(`${pc(r['1M'])} over the last month`);
    if (r['1Y'] != null) parts.push(`${pc(r['1Y'])} over a year`);
    else if (r['3M'] != null) parts.push(`${pc(r['3M'])} over three months`);
    if (parts.length) priceAction.push(`${label} is ${parts.join(' and ')}.`);

    // Trend structure, stated only when both averages exist.
    if (tech.dist50dma != null && tech.dist200dma != null) {
      const a50 = tech.dist50dma >= 0, a200 = tech.dist200dma >= 0;
      const structure = a50 && a200
        ? `above both its 50-day (${pc(tech.dist50dma)}) and 200-day (${pc(tech.dist200dma)}) averages`
        : !a50 && !a200
          ? `below both its 50-day (${pc(tech.dist50dma)}) and 200-day (${pc(tech.dist200dma)}) averages`
          : a200
            ? `below its 50-day average (${pc(tech.dist50dma)}) but still above its 200-day (${pc(tech.dist200dma)})`
            : `above its 50-day average (${pc(tech.dist50dma)}) while still below its 200-day (${pc(tech.dist200dma)})`;
      priceAction.push(`It trades ${structure}.`);
    }

    if (tech.fromHigh != null && tech.rangePosition != null) {
      const yr = tech.rangeBars >= TRADING_DAYS ? 'its 52-week' : `its ${tech.rangeBars}-bar`;
      priceAction.push(Math.abs(tech.fromHigh) < 0.005
        ? `That puts it at ${yr} high.`
        : `That leaves it ${apc(tech.fromHigh)} below ${yr} high, ${(tech.rangePosition * 100).toFixed(0)}% of the way up the range from the low.`);
    }

    // Volatility only earns a sentence when it is doing something. A ratio
    // near 1 means the last month looks like the last year, which is the
    // default state and not worth a line.
    if (tech.volRatio != null && tech.vol30 != null) {
      if (tech.volRatio > 1.35) {
        priceAction.push(`Movement has picked up: 30-day volatility of ${apc(tech.vol30, 0)} annualised is ${tech.volRatio.toFixed(1)}x its own yearly level.`);
      } else if (tech.volRatio < 0.7) {
        priceAction.push(`It has gone quiet — 30-day volatility of ${apc(tech.vol30, 0)} annualised is ${tech.volRatio.toFixed(1)}x its yearly level.`);
      }
    }

    const bigMoves = (events ?? []).filter(e => e.type === 'move'
      && e.date >= iso(new Date(Date.now() - 90 * 86400_000)));
    if (bigMoves.length) {
      const m = bigMoves[bigMoves.length - 1];
      priceAction.push(`The largest single-day move in the last quarter was ${m.date}: ${m.label.replace(' in one day', '')}.`);
    }

    if (priceAction.length === 0) {
      priceAction.push(`Not enough stored history for ${label} to describe how it has moved.`);
    }
  }

  // ── The street ──
  const a = summary?.analyst;
  const t = summary?.ratingTrend;
  const price = finite(summary?.price) ?? tech?.lastClose ?? null;

  if (summary?.hasAnalystCoverage === false) {
    street.push(summary.inapplicable?.analyst
      ?? `Analysts do not publish ratings or targets on an instrument like this, so there is no consensus to report.`);
  } else if (!a && !t && !(summary?.upgrades?.length)) {
    street.push(`No analyst coverage came back for ${symbol}. That is normal for index trackers, funds and smaller listings rather than a fetch failure.`);
  } else {
    if (a?.targetMean != null && price) {
      const gap = a.targetMean / price - 1;
      const n = a.numberOfAnalysts;
      street.push(`The consensus target of ${a.targetMean.toFixed(2)}${n ? ` from ${n} analyst${n === 1 ? '' : 's'}` : ''} sits ${pc(gap)} against the current price.`);
      if (a.targetLow != null && a.targetHigh != null && a.targetLow > 0) {
        const spread = a.targetHigh / a.targetLow - 1;
        street.push(spread > 0.6
          ? `They disagree sharply — the range runs ${a.targetLow.toFixed(2)} to ${a.targetHigh.toFixed(2)}, a ${apc(spread, 0)} spread between most and least optimistic.`
          : spread > 0.25
            ? `The range runs ${a.targetLow.toFixed(2)} to ${a.targetHigh.toFixed(2)} — a ${apc(spread, 0)} spread, so there is real disagreement about what it is worth.`
            : `The range is tight, ${a.targetLow.toFixed(2)} to ${a.targetHigh.toFixed(2)} — they broadly agree.`);
      }
    }

    if (t) {
      const total = t.strongBuy + t.buy + t.hold + t.sell + t.strongSell;
      const buys = t.strongBuy + t.buy, sells = t.sell + t.strongSell;
      if (total > 0) {
        street.push(`${buys} of ${total} rate it a buy, ${t.hold} hold${sells ? `, ${sells} sell` : ''}.`);
      }
    }

    const changes = (summary?.upgrades ?? []).filter(u => u.date
      && u.date >= iso(new Date(Date.now() - 90 * 86400_000)));
    if (changes.length) {
      const up = changes.filter(u => u.action === 'up').length;
      const down = changes.filter(u => u.action === 'down').length;
      street.push(up || down
        ? `Over the last quarter there ${changes.length === 1 ? 'has' : 'have'} been ${up} upgrade${up === 1 ? '' : 's'} and ${down} downgrade${down === 1 ? '' : 's'}.`
        : `There ${changes.length === 1 ? 'has' : 'have'} been ${changes.length} rating action${changes.length === 1 ? '' : 's'} in the last quarter, none of them a directional change.`);
    } else if (a || t) {
      street.push('No rating changes in the last quarter.');
    }
  }

  // ── What's coming ──
  const d = summary?.dates;
  const todayIso = iso(new Date());
  if (d?.nextEarnings && d.nextEarnings >= todayIso) {
    const daysOut = Math.round((new Date(d.nextEarnings) - new Date(todayIso)) / 86400_000);
    coming.push(`Next earnings ${d.nextEarnings}${d.nextEarningsLate && d.nextEarningsLate !== d.nextEarnings ? ` – ${d.nextEarningsLate}` : ''}, ${daysOut === 0 ? 'today' : `${daysOut} day${daysOut === 1 ? '' : 's'} out`}.`);
  }
  if (d?.exDividendDate && d.exDividendDate >= todayIso) {
    coming.push(`Goes ex-dividend ${d.exDividendDate}.`);
  }
  if (d?.dividendDate && d.dividendDate >= todayIso) {
    coming.push(`Dividend payable ${d.dividendDate}.`);
  }
  if (sentiment?.available && sentiment.shifted) {
    coming.push(`News tone has moved from ${sentiment.priorBand} to ${sentiment.nowBand} over the last three weeks, across ${sentiment.stories} scored stories.`);
  }
  if (!coming.length) {
    coming.push('No earnings date, dividend date or scheduled event is known for this instrument in the next window. That may mean nothing is scheduled, or that the source does not publish dates for this instrument type.');
  }

  return {
    priceAction: { title: 'PRICE ACTION', lines: priceAction },
    street: { title: 'THE STREET', lines: street },
    coming: { title: "WHAT'S COMING", lines: coming },
    // Stated so the UI can show it: this is composition, not generation.
    method: 'Composed from stored bars, Yahoo analyst modules and the scored news feed. No language model involved.',
    asOf: tech?.asOf ?? null,
  };
}

// ─── Assembly ─────────────────────────────────────────────────

/**
 * One read for the whole overview tab.
 *
 * The caller supplies the already-fetched Yahoo summary rather than this
 * re-fetching it — the Research page needs that payload for the instrument
 * bar and the other tabs regardless, and quoteSummary is by far the slowest
 * thing in the request.
 */
export function buildOverview(symbol, { summary = null } = {}) {
  const sym = String(symbol ?? '').toUpperCase().trim();
  const s = summary && !summary.error ? summary : null;

  const series = priceSeries(sym);
  const tech = technicals(sym);
  const events = chartEvents(sym, s);
  const sentiment = sentimentTrend(sym);

  return {
    symbol: sym,
    asOf: new Date().toISOString(),
    series,
    technicals: tech,
    events,
    sentiment,
    narrative: narrative({ symbol: sym, name: s?.name, summary: s, tech, sentiment, events }),
  };
}
