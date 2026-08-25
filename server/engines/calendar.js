// Meridian — calendar of dated events for instruments actually held or watched.
//
// The page this replaces generated its events: Apple reporting in three days,
// Tesla in nine, an FOMC meeting in twelve, with invented EPS estimates and
// invented dividend amounts. Because every date was computed as an offset from
// today, it always looked current and was always wrong.
//
// What is available for free and structured is per-instrument: Yahoo's
// calendarEvents module carries real earnings and dividend dates for a given
// symbol. What is not available for free and structured is the macro calendar
// — CPI, payrolls, central bank decisions. Investing.com and the BoE's own
// site publish those and do it better than this could, so they are not
// invented here. The one exception is the UK ISA deadline, which is a fixed
// date in law and can be computed exactly.
//
// The result is narrower than the page it replaces and every line of it is
// real: the events attached to the instruments in this portfolio.

import { all, getSetting, setSetting } from '../db.js';
import * as yahoo from '../sources/yahoo.js';

const DAY = 86400_000;

/** 5 April, the UK tax year end — this year's if still ahead, else next. */
export function nextISADeadline(now = new Date()) {
  const year = now.getUTCFullYear();
  const thisYear = Date.UTC(year, 3, 5, 23, 59, 59);
  return new Date(now.getTime() <= thisYear ? thisYear : Date.UTC(year + 1, 3, 5, 23, 59, 59));
}

/**
 * Corporate dates are refreshed at most once a day per symbol.
 *
 * They change a handful of times a year, and each lookup is a quoteSummary
 * call — refetching them on every page view would spend the request budget on
 * data that is almost always identical. The cache lives in settings so it
 * survives restarts.
 */
const CACHE_KEY = 'calendar_cache';
const CACHE_TTL = DAY;

function readCache() {
  const c = getSetting(CACHE_KEY, null);
  return (c && typeof c === 'object') ? c : {};
}

export async function refreshCorporateDates(symbols, { force = false } = {}) {
  const cache = readCache();
  const now = Date.now();
  const stale = symbols.filter(s => force || !cache[s] || (now - (cache[s].fetchedAt ?? 0)) > CACHE_TTL);

  let fetched = 0;
  const failed = [];
  for (const symbol of stale) {
    try {
      const s = await yahoo.fetchSummary(symbol);
      if (s?.error) { failed.push(symbol); continue; }
      cache[symbol] = {
        name: s.name ?? null,
        dates: s.dates ?? null,
        // Kept even when null, so "checked today and there is nothing" is
        // distinguishable from "never checked".
        fetchedAt: now,
      };
      fetched++;
    } catch {
      failed.push(symbol);
    }
  }
  if (fetched) setSetting(CACHE_KEY, cache);
  return { fetched, failed, cached: symbols.length - stale.length };
}

/**
 * Build the calendar. Returns events with an explicit source per entry, and
 * reports which symbols could not be resolved rather than quietly omitting
 * them — a symbol missing from the calendar because the lookup failed looks
 * identical to one with genuinely no upcoming events otherwise.
 */
export function buildCalendar({ days = 120, now = new Date() } = {}) {
  const held = all('SELECT DISTINCT symbol, name FROM holdings');
  const watched = all('SELECT DISTINCT symbol FROM watchlist');
  const heldSet = new Set(held.map(h => h.symbol));
  const watchSet = new Set(watched.map(w => w.symbol));
  const symbols = [...new Set([...heldSet, ...watchSet])];

  const cache = readCache();
  const horizon = now.getTime() + days * DAY;
  const events = [];
  const unresolved = [];

  for (const symbol of symbols) {
    const entry = cache[symbol];
    if (!entry) { unresolved.push({ symbol, reason: 'never looked up' }); continue; }
    const d = entry.dates;
    if (!d) { unresolved.push({ symbol, reason: 'no corporate dates published' }); continue; }

    const name = entry.name ?? held.find(h => h.symbol === symbol)?.name ?? symbol;
    const relevance = heldSet.has(symbol) ? 'held' : 'watched';

    const push = (type, iso, label) => {
      if (!iso) return;
      const ts = Date.parse(iso);
      if (!Number.isFinite(ts) || ts < now.getTime() - DAY || ts > horizon) return;
      events.push({
        id: `${symbol}-${type}-${iso}`,
        type, symbol, name, relevance,
        date: iso,
        title: `${name} — ${label}`,
        daysAway: Math.round((ts - now.getTime()) / DAY),
        source: 'Yahoo Finance calendarEvents',
        checkedAt: entry.fetchedAt,
      });
    };

    push('earnings', d.nextEarnings, 'Earnings');
    push('dividend', d.exDividendDate, 'Ex-dividend');
    push('dividend-pay', d.dividendDate, 'Dividend paid');
  }

  // The one date that needs no source: it is fixed in statute.
  const isa = nextISADeadline(now);
  if (isa.getTime() <= horizon) {
    events.push({
      id: 'isa-deadline',
      type: 'deadline', symbol: null, name: null, relevance: 'account',
      date: isa.toISOString().slice(0, 10),
      title: 'UK ISA allowance deadline',
      daysAway: Math.round((isa.getTime() - now.getTime()) / DAY),
      note: 'Unused ISA allowance for this tax year expires at midnight on 5 April.',
      source: 'Fixed UK tax-year date',
      checkedAt: null,
    });
  }

  events.sort((a, b) => a.date.localeCompare(b.date));

  return {
    events,
    horizonDays: days,
    symbols: symbols.length,
    unresolved,
    // Stated so the page can say what it does not cover rather than implying
    // this is every event that matters.
    coverage: 'Earnings and dividend dates for held and watched instruments, plus the UK ISA deadline. '
            + 'Macro releases and central bank decisions are not included — no free structured source is wired up.',
  };
}
