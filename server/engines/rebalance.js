// Meridian v2 — tax-wrapper-aware rebalancing engine
// The point of difference vs a naive rebalancer: it knows that selling inside
// an ISA or SIPP is free, and selling inside a GIA can trigger CGT. So it
// prefers to rebalance using sheltered accounts and new contributions before
// it ever proposes a taxable disposal.

import { CGT_ALLOWANCE, CGT_RATE_BASIC, CGT_RATE_HIGHER, WRAPPERS } from '../config.js';

/**
 * @param {Array} holdings  [{symbol, qty, price, avgPrice, wrapper, account, currency}]
 * @param {Object} targets  { symbol: targetWeightPct (0-1) }
 * @param {Object} opts
 */
export function rebalance(holdings, targets, opts = {}) {
  const {
    contribution = 0,        // new cash going in
    cash = 0,                // existing uninvested cash
    minTradeValue = 50,      // don't propose trivial trades
    tolerance = 0.02,        // drift band before acting (2pp)
    cgtBand = 'higher',      // 'basic' | 'higher'
    cgtUsed = 0,             // allowance already consumed this tax year
    preferSheltered = true,
    allowSelling = true,
    dealingCharge = 0,       // per-trade cost, e.g. 11.95 for HL shares
  } = opts;

  const priced = holdings.filter(h => h.price > 0 && h.qty > 0);
  const invested = priced.reduce((a, h) => a + h.qty * h.price, 0);
  const totalNow = invested + cash;
  const totalAfter = totalNow + contribution;

  if (totalAfter <= 0) return { error: 'Portfolio has no value to rebalance.' };

  // Normalise targets
  const tSum = Object.values(targets).reduce((a, b) => a + b, 0);
  if (tSum <= 0) return { error: 'No target weights supplied.' };
  const tgt = Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, v / tSum]));

  // Aggregate current position per symbol, tracking wrapper split
  const bySymbol = {};
  for (const h of priced) {
    const v = h.qty * h.price;
    const s = (bySymbol[h.symbol] ||= { symbol: h.symbol, value: 0, qty: 0, lots: [] });
    s.value += v; s.qty += h.qty;
    s.lots.push({
      wrapper: h.wrapper || 'ISA',
      account: h.account || 'Main',
      qty: h.qty, price: h.price, avgPrice: h.avgPrice ?? h.price,
      value: v,
      unrealised: (h.price - (h.avgPrice ?? h.price)) * h.qty,
      sheltered: !WRAPPERS[h.wrapper || 'ISA']?.cgt,
    });
  }

  const universe = new Set([...Object.keys(bySymbol), ...Object.keys(tgt)]);
  const rows = [];
  for (const sym of universe) {
    const cur = bySymbol[sym]?.value ?? 0;
    const curW = totalNow ? cur / totalNow : 0;
    const tw = tgt[sym] ?? 0;
    const targetValue = tw * totalAfter;
    rows.push({
      symbol: sym,
      currentValue: cur,
      currentWeight: curW,
      targetWeight: tw,
      targetValue,
      drift: curW - tw,
      delta: targetValue - cur,
      lots: bySymbol[sym]?.lots ?? [],
      price: bySymbol[sym]?.lots?.[0]?.price ?? null,
    });
  }

  // Only act on positions outside the tolerance band
  const actionable = rows.filter(r => Math.abs(r.drift) > tolerance || (r.currentValue === 0 && r.targetValue > 0));

  const buys = [], sells = [], notes = [];
  let cashAvailable = cash + contribution;
  let estimatedCgt = 0, taxableGains = 0;

  // Sells first (largest overweight first), respecting shelter preference
  const overweight = actionable.filter(r => r.delta < -minTradeValue)
    .sort((a, b) => a.delta - b.delta);

  if (allowSelling) {
    for (const r of overweight) {
      let toSell = -r.delta;
      // sheltered lots first when preferring shelter
      const lots = [...r.lots].sort((a, b) => {
        if (preferSheltered && a.sheltered !== b.sheltered) return a.sheltered ? -1 : 1;
        return a.unrealised - b.unrealised;   // then lowest gain first
      });
      for (const lot of lots) {
        if (toSell <= 0.01) break;
        const sellValue = Math.min(toSell, lot.value);
        if (sellValue < minTradeValue) continue;
        const frac = lot.value ? sellValue / lot.value : 0;
        const gain = lot.unrealised * frac;
        if (!lot.sheltered && gain > 0) taxableGains += gain;
        sells.push({
          symbol: r.symbol, wrapper: lot.wrapper, account: lot.account,
          value: +sellValue.toFixed(2),
          qty: lot.price ? +(sellValue / lot.price).toFixed(4) : null,
          price: lot.price,
          realisedGain: +gain.toFixed(2),
          taxable: !lot.sheltered && gain > 0,
        });
        cashAvailable += sellValue;
        toSell -= sellValue;
      }
    }
  } else if (overweight.length) {
    notes.push('Selling disabled — overweight positions will be corrected by directing new contributions elsewhere.');
  }

  // CGT estimate on the taxable portion
  const netTaxable = Math.max(0, taxableGains - Math.max(0, CGT_ALLOWANCE - cgtUsed));
  estimatedCgt = netTaxable * (cgtBand === 'basic' ? CGT_RATE_BASIC : CGT_RATE_HIGHER);
  if (taxableGains > 0) {
    notes.push(netTaxable > 0
      ? `Taxable gains of ${taxableGains.toFixed(0)} exceed the remaining CGT allowance. Estimated tax ${estimatedCgt.toFixed(0)}.`
      : `Taxable gains of ${taxableGains.toFixed(0)} fall within the remaining CGT allowance — no tax due.`);
  }

  // Buys, proportional to shortfall, limited by available cash
  const underweight = actionable.filter(r => r.delta > minTradeValue)
    .sort((a, b) => b.delta - a.delta);
  const totalNeed = underweight.reduce((a, r) => a + r.delta, 0);
  const budget = Math.max(0, cashAvailable);
  const scale = totalNeed > 0 ? Math.min(1, budget / totalNeed) : 0;

  for (const r of underweight) {
    const value = r.delta * scale;
    if (value < minTradeValue) continue;
    buys.push({
      symbol: r.symbol,
      value: +value.toFixed(2),
      qty: r.price ? +(value / r.price).toFixed(4) : null,
      price: r.price,
      wrapper: suggestWrapper(r.symbol, bySymbol),
      newPosition: r.currentValue === 0,
    });
    cashAvailable -= value;
  }

  if (scale < 1 && totalNeed > 0) {
    notes.push(`Available cash covers ${(scale * 100).toFixed(0)}% of the required buys. Trades scaled proportionally.`);
  }

  const tradeCount = buys.length + sells.length;
  const charges = tradeCount * dealingCharge;
  const turnover = (buys.reduce((a, b) => a + b.value, 0) + sells.reduce((a, s) => a + s.value, 0));

  // Post-trade weights
  const after = {};
  for (const r of rows) {
    const bought = buys.filter(b => b.symbol === r.symbol).reduce((a, b) => a + b.value, 0);
    const sold = sells.filter(s => s.symbol === r.symbol).reduce((a, s) => a + s.value, 0);
    after[r.symbol] = (r.currentValue + bought - sold) / totalAfter;
  }

  const maxDriftBefore = Math.max(0, ...rows.map(r => Math.abs(r.drift)));
  const maxDriftAfter = Math.max(0, ...rows.map(r => Math.abs((after[r.symbol] ?? 0) - r.targetWeight)));

  return {
    summary: {
      totalBefore: +totalNow.toFixed(2),
      totalAfter: +totalAfter.toFixed(2),
      contribution, cashBefore: cash,
      cashAfter: +Math.max(0, cashAvailable).toFixed(2),
      trades: tradeCount,
      turnover: +turnover.toFixed(2),
      turnoverPct: totalAfter ? +(turnover / totalAfter * 100).toFixed(2) : 0,
      dealingCharges: +charges.toFixed(2),
      taxableGains: +taxableGains.toFixed(2),
      estimatedCgt: +estimatedCgt.toFixed(2),
      maxDriftBefore: +(maxDriftBefore * 100).toFixed(2),
      maxDriftAfter: +(maxDriftAfter * 100).toFixed(2),
    },
    buys, sells, notes,
    rows: rows.map(r => ({
      symbol: r.symbol,
      currentWeight: +(r.currentWeight * 100).toFixed(2),
      targetWeight: +(r.targetWeight * 100).toFixed(2),
      afterWeight: +((after[r.symbol] ?? 0) * 100).toFixed(2),
      drift: +(r.drift * 100).toFixed(2),
      delta: +r.delta.toFixed(2),
      action: Math.abs(r.drift) > tolerance ? (r.delta > 0 ? 'buy' : 'sell') : 'hold',
    })).sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift)),
  };
}

function suggestWrapper(symbol, bySymbol) {
  const lots = bySymbol[symbol]?.lots ?? [];
  const sheltered = lots.find(l => l.sheltered);
  return sheltered ? sheltered.wrapper : (lots[0]?.wrapper ?? 'ISA');
}

/**
 * Contribution-only rebalancing: what should the next N of new money buy to
 * move the portfolio closest to target without selling anything?
 * This is the option most people actually want and almost no tool offers.
 */
export function directContribution(holdings, targets, amount, opts = {}) {
  const r = rebalance(holdings, targets, {
    ...opts, contribution: amount, cash: 0, allowSelling: false, tolerance: 0,
  });
  if (r.error) return r;
  return {
    amount,
    allocations: r.buys.map(b => ({
      symbol: b.symbol, value: b.value, qty: b.qty, wrapper: b.wrapper,
      pctOfContribution: amount ? +(b.value / amount * 100).toFixed(1) : 0,
    })),
    driftBefore: r.summary.maxDriftBefore,
    driftAfter: r.summary.maxDriftAfter,
    notes: r.notes,
  };
}
