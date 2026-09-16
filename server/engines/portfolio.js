// Meridian v2 — portfolio valuation, exposure decomposition, and history
// Everything the Portfolio and Risk pages read comes from here.

import { all, one, run, getBars, saveSnapshot, getSnapshots, getFundNav } from '../db.js';
import { SYMBOLS } from '../config.js';
import * as A from './analytics.js';
import { regionExposure } from './lookthrough.js';
import { listCompositions } from './rebuild/exposure.js';

/** Convert any currency amount to GBP using live FX from the price cache. */
export function toGBP(amount, ccy, prices) {
  if (amount == null) return 0;
  if (ccy === 'GBP') return amount;
  const gbpusd = prices['GBPUSD=X']?.price;
  const eurusd = prices['EURUSD=X']?.price;
  const usdjpy = prices['USDJPY=X']?.price;
  if (ccy === 'USD') return gbpusd ? amount / gbpusd : amount;
  if (ccy === 'EUR') return (gbpusd && eurusd) ? amount * eurusd / gbpusd : amount;
  if (ccy === 'JPY') return (gbpusd && usdjpy) ? amount / usdjpy / gbpusd : amount;
  return amount;
}

export function listHoldings() { return all('SELECT * FROM holdings ORDER BY symbol'); }
export function listCash()     { return all('SELECT * FROM cash'); }

/** Value the portfolio at current prices, in GBP, with full attribution. */
export function valuePortfolio(prices) {
  const holdings = listHoldings();
  const cashRows = listCash();

  const positions = holdings.map(h => {
    const q = prices[h.symbol];
    const meta = SYMBOLS[h.symbol] ?? {};

    // Yahoo has no coverage for some HL "Class S" funds. When there's no
    // live quote but the holding has an ISIN, fall back to the last FT
    // scrape rather than showing the position as priceless. Never preferred
    // over a real live quote — only used when Yahoo has nothing.
    const ftNav = (q?.price == null && h.isin) ? getFundNav(h.isin) : null;

    // Same lesson as the price fix: prefer what Yahoo says the instrument
    // trades in right now over a hardcoded table or a typed-in guess. Only
    // fall back to the stored/config value when there's no live quote yet.
    const ccy = q?.currency || ftNav?.currency || h.currency || meta.ccy || 'GBP';
    const price = q?.price ?? ftNav?.price ?? null;
    const priceSource = q?.price != null ? 'yahoo' : ftNav ? 'ft' : null;
    const valueNative = price != null ? price * h.qty : 0;
    const costNative  = h.avg_price * h.qty;
    const valueGBP = toGBP(valueNative, ccy, prices);
    const costGBP  = toGBP(costNative, ccy, prices);
    return {
      id: h.id, symbol: h.symbol,
      name: h.name || meta.name || h.symbol,
      exchange: h.exchange || null,
      qty: h.qty, avgPrice: h.avg_price, price,
      currency: ccy,
      priceSource,
      priceAsOf: priceSource === 'ft' ? ftNav.as_of : null,
      sector: h.sector || 'Unclassified',
      geography: h.geography || 'Unclassified',
      assetClass: h.asset_class || 'Equity',
      account: h.account || 'Main',
      wrapper: h.wrapper || 'ISA',
      targetPct: h.target_pct,
      thesis: h.thesis,
      isin: h.isin,
      value: +valueGBP.toFixed(2),
      cost: +costGBP.toFixed(2),
      pnl: +(valueGBP - costGBP).toFixed(2),
      pnlPct: costGBP ? +(((valueGBP / costGBP) - 1) * 100).toFixed(2) : 0,
      dayChangePct: q?.changePct ?? (priceSource === 'ft' ? ftNav.change_pct : null),
      dayChangeGBP: q?.changePct != null ? +(valueGBP * q.changePct / 100).toFixed(2) : null,
      hasPrice: price != null,
    };
  });

  const cash = cashRows.reduce((a, c) => a + toGBP(c.amount, c.currency, prices), 0);
  const invested = positions.reduce((a, p) => a + p.value, 0);
  const cost = positions.reduce((a, p) => a + p.cost, 0);
  const total = invested + cash;
  const dayChange = positions.reduce((a, p) => a + (p.dayChangeGBP ?? 0), 0);

  const withWeights = positions.map(p => ({
    ...p, weight: total ? +(p.value / total * 100).toFixed(2) : 0,
  })).sort((a, b) => b.value - a.value);

  return {
    positions: withWeights,
    cash: +cash.toFixed(2),
    cashAccounts: cashRows,
    invested: +invested.toFixed(2),
    cost: +cost.toFixed(2),
    total: +total.toFixed(2),
    pnl: +(invested - cost).toFixed(2),
    pnlPct: cost ? +(((invested / cost) - 1) * 100).toFixed(2) : 0,
    dayChange: +dayChange.toFixed(2),
    dayChangePct: total ? +(dayChange / total * 100).toFixed(2) : 0,
    missingPrices: withWeights.filter(p => !p.hasPrice).map(p => p.symbol),
    breakdowns: {
      sector: withCashRow(groupBy(withWeights, 'sector', total), cash, total),
      geography: withCashRow(groupBy(withWeights, 'geography', total), cash, total),
      assetClass: groupBy(withWeights, 'assetClass', total),
      wrapper: withCashRow(groupBy(withWeights, 'wrapper', total), cash, total),
      account: groupBy(withWeights, 'account', total),
      currency: groupBy(withWeights, 'currency', total),
    },
    concentration: concentrationMetrics(withWeights, total),
  };
}

/**
 * Concentration diagnostics.
 *
 * `lookThroughUS` used to come from a hardcoded table of nineteen UK ETF
 * tickers with a US fraction typed beside each, falling back — for anything
 * not in that list — to reading the geography label as a string and crediting
 * "Global" with 0.65. Nothing measured any of it, nothing updated it when a
 * tracker changed shape, and the Risk page rendered the result to one decimal
 * place as though it were observed. It is now computed by lookthrough.js from
 * the fund compositions actually stored, and is unavailable rather than zero
 * when there is nothing to see through — "we cannot tell" and "you have none"
 * being different findings.
 */
function concentrationMetrics(positions, total) {
  if (!total || !positions.length) return null;
  const weights = positions.map(p => p.value / total);
  const sorted = [...weights].sort((a, b) => b - a);
  const hhi = weights.reduce((a, w) => a + w * w, 0);

  let northAmerica = null;
  try {
    const compositions = listCompositions(positions.map(p => p.symbol));
    northAmerica = regionExposure(positions, compositions, 'North America');
  } catch {
    northAmerica = { available: false, reason: 'Look-through could not be computed.' };
  }

  return {
    largestPosition: +(sorted[0] * 100).toFixed(2),
    top3: +(sorted.slice(0, 3).reduce((a, b) => a + b, 0) * 100).toFixed(2),
    top5: +(sorted.slice(0, 5).reduce((a, b) => a + b, 0) * 100).toFixed(2),
    herfindahl: +hhi.toFixed(4),
    effectiveHoldings: hhi ? +(1 / hhi).toFixed(2) : 0,
    positionCount: positions.length,
    // Kept under the old key so existing callers keep working, but null when
    // unmeasurable instead of a fabricated number. Consumers must handle null.
    lookThroughUS: northAmerica?.available ? northAmerica.pctOfSeen : null,
    lookThrough: northAmerica,
  };
}

function groupBy(positions, key, total) {
  const m = {};
  for (const p of positions) m[p[key]] = (m[p[key]] ?? 0) + p.value;
  return Object.entries(m)
    .map(([k, v]) => ({ label: k, value: +v.toFixed(2), pct: total ? +(v / total * 100).toFixed(2) : 0 }))
    .sort((a, b) => b.value - a.value);
}

/** Appends an explicit Cash/Unallocated slice so breakdown percentages sum
 *  to 100% instead of silently excluding cash from the denominator's story. */
function withCashRow(rows, cash, total) {
  if (!cash || !total) return rows;
  return [...rows, { label: 'Cash', value: +cash.toFixed(2), pct: +(cash / total * 100).toFixed(2) }]
    .sort((a, b) => b.value - a.value);
}

/** Aligned daily return series for held symbols, from stored bars. */
export function holdingReturnSeries(symbols, lookback = 750) {
  const series = {};
  for (const s of symbols) {
    const bars = getBars(s);
    if (bars.length < 30) continue;
    const closes = bars.slice(-lookback).map(b => b.adj_close ?? b.close).filter(Boolean);
    if (closes.length >= 30) series[s] = A.toReturns(closes);
  }
  return series;
}

/** Historical GBP/USD, EUR/USD, USD/JPY series, keyed by date, for converting
 *  non-GBP holdings at the price they'd actually have fetched on that day. */
function historicalFXMaps() {
  const pairs = { gbpusd: 'GBPUSD=X', eurusd: 'EURUSD=X', usdjpy: 'USDJPY=X' };
  const maps = {};
  for (const [key, sym] of Object.entries(pairs)) {
    maps[key] = new Map(getBars(sym).map(b => [b.date, b.adj_close ?? b.close]));
  }
  return maps;
}

/** Same conversion as toGBP, but for a specific historical date. Forward-fills
 *  from the last known rate when a currency pair has no bar for that date
 *  (weekends/holidays), same forward-fill any price series needs. */
function toGBPOnDate(amount, ccy, date, fxMaps, lastKnown) {
  if (ccy === 'GBP' || !amount) return amount;
  const rateFor = key => {
    const r = fxMaps[key].get(date);
    if (r != null) { lastKnown[key] = r; return r; }
    return lastKnown[key];
  };
  const gbpusd = rateFor('gbpusd');
  if (ccy === 'USD') return gbpusd ? amount / gbpusd : amount;
  if (ccy === 'EUR') { const eurusd = rateFor('eurusd'); return (gbpusd && eurusd) ? amount * eurusd / gbpusd : amount; }
  if (ccy === 'JPY') { const usdjpy = rateFor('usdjpy'); return (gbpusd && usdjpy) ? amount / usdjpy / gbpusd : amount; }
  return amount;
}

/** Core of the fixed-weight backfill, shared by the combined and per-holding
 *  views: for each overlapping date, each held symbol's GBP value using
 *  today's quantity and that day's price + FX rate. */
function buildHistorySeries(prices, lookback) {
  const v = valuePortfolio(prices);
  const heldPositions = v.positions.filter(p => p.hasPrice);
  const symbols = heldPositions.map(p => p.symbol);
  const barsBySymbol = {};
  for (const s of symbols) {
    const b = getBars(s);
    if (b.length >= 30) barsBySymbol[s] = new Map(b.map(x => [x.date, x.adj_close ?? x.close]));
  }
  const usable = Object.keys(barsBySymbol);
  const excluded = symbols.filter(s => !usable.includes(s));
  if (!usable.length) return { rows: null, usable, excluded, note: 'No stored history yet. Run a history sync.' };

  // dates present for every usable symbol
  let dates = [...barsBySymbol[usable[0]].keys()];
  for (const s of usable.slice(1)) {
    const m = barsBySymbol[s];
    dates = dates.filter(d => m.has(d));
  }
  dates = dates.sort();
  // Judge sufficiency on the full overlap, before slicing to the requested
  // window. Checking post-slice meant a short window like 1M (21 trading
  // days) could never pass a "at least 30" floor no matter how much history
  // actually existed — 1M was guaranteed to fail by construction.
  if (dates.length < 5) return { rows: null, usable, excluded, note: 'Insufficient overlapping history.' };
  dates = dates.slice(-lookback);

  const qtyBySymbol = {};
  const ccyBySymbol = {};
  for (const p of heldPositions) {
    qtyBySymbol[p.symbol] = (qtyBySymbol[p.symbol] ?? 0) + p.qty;
    ccyBySymbol[p.symbol] = p.currency;
  }

  const fx = historicalFXMaps();
  const lastFX = {};
  const rows = dates.map(d => {
    const bySymbol = {};
    for (const s of usable) {
      const priceNative = barsBySymbol[s].get(d) ?? 0;
      const valueNative = priceNative * (qtyBySymbol[s] ?? 0);
      bySymbol[s] = +toGBPOnDate(valueNative, ccyBySymbol[s], d, fx, lastFX).toFixed(2);
    }
    return { date: d, bySymbol };
  });

  return { rows, usable, excluded, note: null };
}

/** Reconstruct portfolio value history from stored bars and current holdings.
 *  This is a fixed-weight backfill: it answers "how would today's portfolio
 *  have behaved", which is the right question for risk, and is honest about
 *  not being a trade-by-trade record. */
export function reconstructHistory(prices, lookback = 750) {
  const built = buildHistorySeries(prices, lookback);
  if (!built.rows) return { series: [], symbols: built.usable, excluded: built.excluded, note: built.note };

  const series = built.rows.map(r => ({
    date: r.date,
    value: +Object.values(r.bySymbol).reduce((a, b) => a + b, 0).toFixed(2),
  }));
  return { series, symbols: built.usable, excluded: built.excluded, note: null };
}

/** Same backfill, broken out per holding instead of summed — both as raw GBP
 *  value (for a composition view) and normalized % return from the start of
 *  the window (for a performance-comparison view). */
export function reconstructHistoryByHolding(prices, lookback = 750) {
  const built = buildHistorySeries(prices, lookback);
  if (!built.rows) return { series: [], normalized: [], symbols: built.usable, excluded: built.excluded, note: built.note };

  const first = built.rows[0].bySymbol;
  const series = built.rows.map(r => ({ date: r.date, ...r.bySymbol }));
  const normalized = built.rows.map(r => {
    const row = { date: r.date };
    for (const s of built.usable) {
      const base = first[s];
      row[s] = base ? +(((r.bySymbol[s] / base) - 1) * 100).toFixed(2) : 0;
    }
    return row;
  });

  return { series, normalized, symbols: built.usable, excluded: built.excluded, note: null };
}

export function takeSnapshot(prices) {
  const v = valuePortfolio(prices);
  const date = new Date().toISOString().slice(0, 10);
  saveSnapshot({
    date, ts: Date.now(),
    total: v.total, invested: v.invested, cash: v.cash,
    pnl: v.pnl, pnlPct: v.pnlPct, dayChange: v.dayChange,
    breakdown: v.breakdowns,
  });
  return { date, total: v.total };
}

export { getSnapshots };
