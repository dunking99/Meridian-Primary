// Meridian v2 — Yahoo Finance source
// Wraps yahoo-finance2 with pence normalisation, batching, and bar persistence.

import YahooFinance from 'yahoo-finance2';
import { SYMBOLS } from '../config.js';
import { classify } from './instruments.js';
import { saveBars, getBars, barCoverage } from '../db.js';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

/**
 * LSE instruments sometimes quote in pence (Yahoo marks these "GBp") and
 * sometimes already in pounds ("GBP"), and which one applies can differ by
 * ticker and can change. Trusting a hardcoded per-symbol table was the bug —
 * this checks Yahoo's own currency field on every quote instead, so it's
 * self-correcting rather than a guess frozen in config.
 */
export function normaliseByCurrency(value, yahooCurrency) {
  if (value == null) return null;
  return yahooCurrency === 'GBp' ? value / 100 : value;
}

/** Back-compat wrapper for code paths without a live currency field. */
export function normalise(symbol, value) {
  if (value == null) return null;
  return SYMBOLS[symbol]?.pence ? value / 100 : value;
}

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export async function fetchQuotes(symbols) {
  const out = {};
  for (const batch of chunk(symbols, 25)) {
    try {
      const res = await yf.quote(batch, {}, { validateResult: false });
      for (const q of (Array.isArray(res) ? res : [res])) {
        if (!q?.symbol) continue;
        const key = symbols.find(s => s.toUpperCase() === q.symbol.toUpperCase()) || q.symbol;
        const raw = q.regularMarketPrice ?? q.ask ?? q.bid;
        if (raw == null || isNaN(raw)) continue;

        const meta  = SYMBOLS[key] ?? { decimals: 2 };
        const yCcy  = q.currency ?? null;                 // 'GBp' or 'GBP' etc, straight from Yahoo
        const price = normaliseByCurrency(raw, yCcy);
        const prev  = normaliseByCurrency(q.regularMarketPreviousClose ?? raw, yCcy);
        const change = price - prev;

        // `decimals` is a DISPLAY hint only (see config.js) — it must never
        // truncate the value actually used for qty * price. Rounding a
        // pence-denominated fund's price to 2dp here (e.g. 460.5p -> £4.605
        // -> £4.61) previously threw the total off by real money at scale.
        out[key] = {
          price,
          prev,
          change,
          changePct:  prev ? +((change / prev) * 100).toFixed(2) : 0,
          dayHigh:    normaliseByCurrency(q.regularMarketDayHigh, yCcy),
          dayLow:     normaliseByCurrency(q.regularMarketDayLow, yCcy),
          volume:     q.regularMarketVolume ?? null,
          avgVolume:  q.averageDailyVolume3Month ?? null,
          high52:     normaliseByCurrency(q.fiftyTwoWeekHigh, yCcy),
          low52:      normaliseByCurrency(q.fiftyTwoWeekLow, yCcy),
          marketState: q.marketState ?? null,
          currency:   (yCcy === 'GBp') ? 'GBP' : (yCcy ?? meta.ccy ?? 'USD'),
          name:       meta.name ?? q.shortName ?? key,
          rawCurrency: yCcy,
          instrument: classify(key, q.quoteType ?? null).type,
          live: true,
        };
      }
    } catch (e) {
      console.log(`  quote batch failed (${batch.length} symbols): ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 120));
  }
  return out;
}

/**
 * Fetch daily bars and persist them. Incremental after the first run — this
 * is what turns Meridian from "shows today's price" into something that can
 * compute real risk numbers.
 */
export async function syncHistory(symbol, { years = 12, force = false } = {}) {
  const cov = barCoverage(symbol);
  const today = new Date();
  let from = new Date(today.getTime() - years * 365.25 * 86400000);

  if (!force && cov?.n > 0 && cov.last) {
    const lastDate = new Date(cov.last + 'T00:00:00Z');
    if (today - lastDate < 20 * 3600 * 1000) return { symbol, added: 0, cached: cov.n, skipped: true };
    from = new Date(lastDate.getTime() - 5 * 86400000);
  }

  try {
    const res = await yf.chart(symbol, { period1: from, period2: today, interval: '1d' });
    const yCcy = res?.meta?.currency ?? null;
    const quotes = res?.quotes ?? [];
    const bars = quotes.filter(q => q.close != null).map(q => ({
      date: q.date,
      open:  normaliseByCurrency(q.open, yCcy),
      high:  normaliseByCurrency(q.high, yCcy),
      low:   normaliseByCurrency(q.low, yCcy),
      close: normaliseByCurrency(q.close, yCcy),
      adjClose: normaliseByCurrency(q.adjclose ?? q.close, yCcy),
      volume: q.volume ?? null,
    }));
    const result = saveBars(symbol, bars);
    return {
      symbol,
      added: result.saved,
      rejected: result.rejected,
      cached: barCoverage(symbol)?.n ?? 0,
      currency: yCcy,
      integrity: result.report ?? null,
    };
  } catch (e) {
    return { symbol, added: 0, error: e.message };
  }
}

export async function syncAll(symbols, opts = {}) {
  const results = [];
  for (const s of symbols) {
    results.push(await syncHistory(s, opts));
    await new Promise(r => setTimeout(r, 150));
  }
  return {
    synced: results.filter(r => !r.error).length,
    failed: results.filter(r => r.error).map(r => ({ symbol: r.symbol, error: r.error })),
    totalBars: results.reduce((a, r) => a + (r.cached ?? 0), 0),
    results,
  };
}

const isoDate = d => {
  if (!d) return null;
  const t = new Date(d);
  return isNaN(t) ? null : t.toISOString().slice(0, 10);
};

export async function fetchSummary(symbol) {
  try {
    const r = await yf.quoteSummary(symbol, {
      modules: ['price', 'summaryDetail', 'defaultKeyStatistics', 'assetProfile', 'topHoldings'],
    });
    const sd = r.summaryDetail ?? {}, ks = r.defaultKeyStatistics ?? {}, pr = r.price ?? {};
    const yCcy = pr.currency ?? null;

    // Analyst targets, earnings/dividend dates, rating trend and upgrade
    // history live in separate modules that many non-equity symbols (indices,
    // FX, commodities, funds) simply don't have. Fetched in a second call so
    // a module that doesn't apply to this symbol can't take down the core
    // quote fields above, which every symbol needs regardless of type.
    let analyst = null, dates = null, ratingTrend = null, upgrades = [], earningsHistory = [];
    try {
      const r2 = await yf.quoteSummary(symbol, {
        modules: ['financialData', 'calendarEvents', 'recommendationTrend', 'upgradeDowngradeHistory', 'earningsHistory'],
      });
      const fd = r2.financialData;
      if (fd) {
        analyst = {
          targetMean: normaliseByCurrency(fd.targetMeanPrice, yCcy),
          targetHigh: normaliseByCurrency(fd.targetHighPrice, yCcy),
          targetLow: normaliseByCurrency(fd.targetLowPrice, yCcy),
          targetMedian: normaliseByCurrency(fd.targetMedianPrice, yCcy),
          recommendationKey: fd.recommendationKey ?? null,
          recommendationMean: fd.recommendationMean ?? null,
          numberOfAnalysts: fd.numberOfAnalystOpinions ?? null,
        };
      }
      const ce = r2.calendarEvents;
      if (ce) {
        const earn = ce.earnings?.earningsDate ?? [];
        dates = {
          nextEarnings: isoDate(earn[0]),
          nextEarningsLate: isoDate(earn[1]),
          exDividendDate: isoDate(ce.exDividendDate),
          dividendDate: isoDate(ce.dividendDate),
        };
      }
      const trend = r2.recommendationTrend?.trend?.[0];
      if (trend) {
        ratingTrend = {
          period: trend.period ?? '0m',
          strongBuy: trend.strongBuy ?? 0, buy: trend.buy ?? 0, hold: trend.hold ?? 0,
          sell: trend.sell ?? 0, strongSell: trend.strongSell ?? 0,
        };
      }
      upgrades = (r2.upgradeDowngradeHistory?.history ?? []).slice(0, 8).map(h => ({
        date: isoDate(h.epochGradeDate), firm: h.firm ?? null,
        action: h.action ?? null, fromGrade: h.fromGrade ?? null, toGrade: h.toGrade ?? null,
      }));
      earningsHistory = (r2.earningsHistory?.history ?? []).slice(-4).reverse().map(h => ({
        quarter: isoDate(h.quarter), epsActual: h.epsActual ?? null,
        epsEstimate: h.epsEstimate ?? null, surprisePercent: h.surprisePercent ?? null,
      }));
    } catch { /* analyst/date modules unavailable for this symbol type — fields stay null */ }

    // What kind of instrument this is decides which of the fields below are
    // meaningful at all. Without it the caller asks every symbol for a P/E.
    const instrument = classify(symbol, pr.quoteType ?? null);

    return {
      symbol,
      instrument: instrument.type,
      instrumentLabel: instrument.label,
      applicableStats: instrument.stats,
      // Why a field is absent, per field — so a blank can be explained rather
      // than looking like a fetch failure.
      inapplicable: instrument.absent,
      hasAnalystCoverage: instrument.analyst,
      // 'us-only' means EDGAR could have it if the issuer is a US registrant;
      // false means the instrument type has no filings at all.
      filingsSupport: instrument.filings,
      name: pr.longName ?? pr.shortName ?? symbol,
      price: normaliseByCurrency(pr.regularMarketPrice, yCcy),
      marketCap: pr.marketCap ?? null,
      sharesOutstanding: ks.sharesOutstanding ?? null,
      pe: sd.trailingPE ?? null,
      forwardPe: sd.forwardPE ?? null,
      dividendYield: sd.dividendYield ?? sd.yield ?? null,
      beta: sd.beta ?? ks.beta3Year ?? null,
      expenseRatio: r.topHoldings?.annualReportExpenseRatio ?? null,
      high52: normaliseByCurrency(sd.fiftyTwoWeekHigh, yCcy),
      low52: normaliseByCurrency(sd.fiftyTwoWeekLow, yCcy),
      avgVolume: sd.averageVolume ?? null,
      sector: r.assetProfile?.sector ?? null,
      industry: r.assetProfile?.industry ?? null,
      country: r.assetProfile?.country ?? null,
      holdings: r.topHoldings?.holdings?.slice(0, 10) ?? null,
      sectorWeights: r.topHoldings?.sectorWeightings ?? null,
      rawCurrency: yCcy,
      analyst,
      dates,
      ratingTrend,
      upgrades,
      earningsHistory,
    };
  } catch (e) {
    return { symbol, error: e.message };
  }
}

// Yahoo returns exchange venue as a short code (NMS, NYQ...) or a longer
// platform name (NasdaqGS, "New York Stock Exchange"...) depending on which
// field and endpoint answered — normalised here to the short label people
// actually recognise, e.g. for the holdings table. Unknown codes pass through
// as-is rather than disappearing, since a raw code is still more useful than
// nothing.
const EXCHANGE_LABELS = {
  LSE: 'LSE', 'London Stock Exchange': 'LSE', IOB: 'LSE',
  NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ',
  NasdaqGS: 'NASDAQ', NasdaqGM: 'NASDAQ', NasdaqCM: 'NASDAQ',
  NYQ: 'NYSE', 'New York Stock Exchange': 'NYSE',
  ASE: 'AMEX', NYSEAmerican: 'AMEX', AMEX: 'AMEX',
  PCX: 'NYSE Arca', NYSEArca: 'NYSE Arca',
  TOR: 'TSX', 'Toronto Stock Exchange': 'TSX',
  GER: 'XETRA', Xetra: 'XETRA',
  FRA: 'Frankfurt', PAR: 'Euronext Paris', AMS: 'Euronext Amsterdam',
  MIL: 'Borsa Italiana', SWX: 'SIX Swiss', HKG: 'HKEX',
  TYO: 'TSE', 'Tokyo Stock Exchange': 'TSE',
  ASX: 'ASX', SES: 'SGX', JNB: 'JSE',
};
const friendlyExchange = raw => (raw ? (EXCHANGE_LABELS[raw] ?? raw) : null);

/**
 * Name + listing venue for one symbol — funds like "0P0000WN7J.L" have no
 * useful display name on their own, so this is what turns a raw ticker into
 * something a human recognises. Uses the same lightweight quote() endpoint as
 * fetchQuotes rather than the heavier quoteSummary() fetchSummary() calls,
 * since this only needs two fields and may run across many holdings at once.
 */
export async function resolveNameAndExchange(symbol) {
  try {
    const res = await yf.quote(symbol, {}, { validateResult: false });
    const q = Array.isArray(res) ? res[0] : res;
    if (!q) return { symbol, error: 'No data returned for this symbol.' };
    return {
      symbol,
      name: q.longName ?? q.shortName ?? null,
      exchange: friendlyExchange(q.fullExchangeName ?? q.exchange ?? null),
    };
  } catch (e) {
    return { symbol, error: e.message };
  }
}

/** Batch form of resolveNameAndExchange, for backfilling many holdings at once. */
export async function resolveNamesAndExchanges(symbols) {
  const out = {};
  for (const batch of chunk(symbols, 25)) {
    try {
      const res = await yf.quote(batch, {}, { validateResult: false });
      for (const q of (Array.isArray(res) ? res : [res])) {
        if (!q?.symbol) continue;
        const key = symbols.find(s => s.toUpperCase() === q.symbol.toUpperCase()) || q.symbol;
        out[key] = {
          name: q.longName ?? q.shortName ?? null,
          exchange: friendlyExchange(q.fullExchangeName ?? q.exchange ?? null),
        };
      }
    } catch (e) {
      console.log(`  name/exchange batch failed (${batch.length} symbols): ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 120));
  }
  return out;
}

export async function search(query) {
  try {
    const r = await yf.search(query, { quotesCount: 12, newsCount: 0 });
    return (r.quotes ?? []).filter(q => q.symbol).map(q => ({
      symbol: q.symbol,
      name: q.shortname ?? q.longname ?? q.symbol,
      exchange: q.exchange,
      type: q.quoteType,
    }));
  } catch {
    return [];
  }
}

export { getBars };
