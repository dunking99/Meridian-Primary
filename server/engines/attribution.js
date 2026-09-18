// Meridian v2 — return attribution
//
// The performance engine says what the portfolio returned. This one says where
// that return came from, which is the question anyone actually asks next.
//
// ─── What is not here, and why ────────────────────────────────
//
// The textbook answer to "where did my return come from" is Brinson
// attribution: split excess return against a benchmark into an allocation
// effect (you were overweight the sectors that did well) and a selection
// effect (within each sector you picked the right names). Morningstar Direct
// and Bloomberg PORT both do this, and it is genuinely the right decomposition.
//
// It also requires the benchmark's sector weights and the benchmark's return
// WITHIN each sector, at each point in the period. Meridian can fetch an
// index's price series. It cannot fetch the FTSE All-Share's technology weight
// as at March, or what that sector returned inside the index, because no free
// source publishes index constituent weights as a time series.
//
// Two of those four inputs are missing, so a Brinson attribution here would be
// a Brinson attribution against invented benchmark weights. Rather than produce
// a number with the right name and no basis, this engine decomposes the
// portfolio against ITSELF — every effect below is measured relative to the
// portfolio's own average return, not to an index — and says so in every label
// it returns. The total-level comparison against a real benchmark IS available
// and is reported separately, because that one is honestly computable.
//
// ─── The decomposition ────────────────────────────────────────
//
// For each holding, over each day, with w the weight at yesterday's close and
// r the return today:
//
//   contribution      = w x r                     (what it added to the total)
//   baseline          = w x r_portfolio           (what it would have added
//                                                  earning the portfolio average)
//   allocation effect = w x (r_group - r_portfolio)  (its group beating the book)
//   selection effect  = w x (r_holding - r_group)    (it beating its own group)
//
// and contribution = baseline + allocation + selection, exactly, per holding
// and in total. Allocation effects sum to zero across groups and selection
// effects sum to zero within each group, which is what makes them effects
// rather than restatements of the weights.
//
// ─── Why the sums are not naive ───────────────────────────────
//
// Daily contributions are arithmetic; the total return is geometric. Adding up
// w x r across 250 days gives a number that does not equal the compounded
// return, and the gap widens with volatility. Every contribution here is
// therefore Cariño-linked — scaled by a per-day factor derived from the log
// return — so the parts sum to the compounded whole exactly rather than
// approximately. The test suite asserts that identity to 1e-9 rather than
// trusting it.
//
// ─── What the history is ──────────────────────────────────────
//
// Value series come from the same fixed-weight backfill the Portfolio page
// uses: today's share counts, priced at each day's close and FX rate. It
// answers "how would the portfolio I hold now have behaved", not "what did I
// actually earn trade by trade". Purchases and sales inside the period are not
// reflected. That is stated on every report rather than left for the reader to
// discover, and it is the reason the money-weighted return in the performance
// engine can legitimately disagree with the figure here.

import { reconstructHistoryByHolding, valuePortfolio } from './portfolio.js';
import { benchmarkReturn } from './performance.js';
import { getBars } from '../db.js';

/** Groupings the report can decompose by, and the position field each reads. */
export const GROUPINGS = {
  sector: 'sector',
  geography: 'geography',
  wrapper: 'wrapper',
  currency: 'currency',
  account: 'account',
  assetClass: 'assetClass',
};

/** Below this many days the decomposition is too short to mean anything. */
export const MIN_DAYS = 5;

const UNLABELLED = 'Unlabelled';

// ─── Cariño linking ───────────────────────────────────────────

/**
 * Cariño scaling factor for one period.
 *
 * ln(1+r)/r, with the removable singularity at r = 0 filled by its limit of 1.
 * Very small returns are also sent to 1 directly: the ratio is numerically
 * unstable near zero in floating point, and the limit is exact there anyway.
 */
export function carinoFactor(r) {
  if (!isFinite(r)) return 1;
  if (Math.abs(r) < 1e-9) return 1;
  if (r <= -1) return 1;          // total loss: linking is undefined, do not scale
  return Math.log(1 + r) / r;
}

/**
 * Per-day scaling so arithmetic contributions sum to the geometric total.
 * Each day's factor is divided by the whole period's factor.
 */
export function carinoWeights(dailyReturns, totalReturn) {
  const K = carinoFactor(totalReturn);
  return dailyReturns.map(r => (K === 0 ? 1 : carinoFactor(r) / K));
}

// ─── Value series ─────────────────────────────────────────────

/**
 * Per-holding GBP value on each date, plus the portfolio total.
 *
 * Reuses the Portfolio page's reconstruction so the two cannot disagree: if
 * this engine built its own backfill, the attribution and the equity curve
 * would drift apart and both would look authoritative.
 */
export function valueSeries(prices, { lookback = 750 } = {}) {
  const rec = reconstructHistoryByHolding(prices, lookback);
  if (!rec.series?.length || !rec.symbols?.length) {
    return { available: false, reason: rec.note ?? 'No reconstructable history', symbols: [], rows: [] };
  }

  const rows = rec.series.map(r => {
    const bySymbol = {};
    let total = 0;
    for (const s of rec.symbols) {
      const v = typeof r[s] === 'number' && isFinite(r[s]) ? r[s] : 0;
      bySymbol[s] = v;
      total += v;
    }
    return { date: r.date, bySymbol, total };
  }).filter(r => r.total > 0);

  if (rows.length < MIN_DAYS) {
    return {
      available: false,
      reason: `only ${rows.length} reconstructable days — ${MIN_DAYS} needed`,
      symbols: rec.symbols, rows: [],
    };
  }

  return {
    available: true,
    symbols: rec.symbols,
    excluded: rec.excluded ?? [],
    rows,
    from: rows[0].date,
    to: rows[rows.length - 1].date,
    days: rows.length,
  };
}

// ─── The decomposition ────────────────────────────────────────

/**
 * Where the return came from.
 *
 * `groupOf` maps a symbol to its group label; every holding lands somewhere,
 * with an explicit Unlabelled bucket rather than being dropped, because a
 * decomposition that silently omits holdings does not sum to the total and the
 * reader has no way to see that it did not.
 */
export function decompose(series, { groupOf = null } = {}) {
  if (!series?.available) {
    return { available: false, reason: series?.reason ?? 'No usable value history' };
  }

  const { rows, symbols } = series;
  const group = s => (groupOf ? (groupOf(s) ?? UNLABELLED) : UNLABELLED);

  // Daily portfolio returns, and the compounded total.
  const dailyPortfolio = [];
  for (let t = 1; t < rows.length; t++) {
    dailyPortfolio.push(rows[t].total / rows[t - 1].total - 1);
  }
  const totalReturn = rows[rows.length - 1].total / rows[0].total - 1;
  const k = carinoWeights(dailyPortfolio, totalReturn);

  const acc = {};
  for (const s of symbols) {
    acc[s] = { symbol: s, group: group(s), contribution: 0, baseline: 0, allocation: 0, selection: 0 };
  }

  for (let t = 1; t < rows.length; t++) {
    const prev = rows[t - 1], cur = rows[t];
    const rp = dailyPortfolio[t - 1];
    const scale = k[t - 1];

    // Group returns for this day, from the group's own aggregate value.
    const groupPrev = {}, groupCur = {};
    for (const s of symbols) {
      const g = acc[s].group;
      groupPrev[g] = (groupPrev[g] ?? 0) + prev.bySymbol[s];
      groupCur[g] = (groupCur[g] ?? 0) + cur.bySymbol[s];
    }
    const groupReturn = {};
    for (const g of Object.keys(groupPrev)) {
      groupReturn[g] = groupPrev[g] > 0 ? groupCur[g] / groupPrev[g] - 1 : 0;
    }

    for (const s of symbols) {
      const vPrev = prev.bySymbol[s];
      if (!(vPrev > 0)) continue;                     // not held, or unpriced, that day
      const w = vPrev / prev.total;
      const ri = cur.bySymbol[s] / vPrev - 1;
      const g = acc[s].group;
      const rg = groupReturn[g] ?? 0;

      acc[s].contribution += scale * w * ri;
      acc[s].baseline     += scale * w * rp;
      acc[s].allocation   += scale * w * (rg - rp);
      acc[s].selection    += scale * w * (ri - rg);
    }
  }

  const holdings = symbols.map(s => ({
    symbol: s,
    group: acc[s].group,
    contribution: +acc[s].contribution.toFixed(8),
    baseline: +acc[s].baseline.toFixed(8),
    allocation: +acc[s].allocation.toFixed(8),
    selection: +acc[s].selection.toFixed(8),
    // Average weight over the period, for reading the size of each effect
    // against the size of the position that produced it.
    averageWeight: +(rows.slice(0, -1)
      .reduce((sum, r) => sum + (r.total > 0 ? r.bySymbol[s] / r.total : 0), 0) / (rows.length - 1)).toFixed(6),
  })).sort((a, b) => b.contribution - a.contribution);

  return {
    available: true,
    totalReturn: +totalReturn.toFixed(8),
    holdings,
    from: series.from, to: series.to, days: series.days,
    // The identity the tests pin: parts sum to the whole, exactly.
    reconciles: Math.abs(holdings.reduce((s, h) => s + h.contribution, 0) - totalReturn) < 1e-6,
    basis:
      'Fixed-weight reconstruction: today\'s share counts priced at each day\'s '
      + 'close and FX rate. Trades inside the period are not reflected. '
      + 'Contributions are Cariño-linked so they sum to the compounded return.',
  };
}

/** Roll holding-level effects up to their groups. */
export function byGroup(decomposition) {
  if (!decomposition?.available) return { available: false, reason: decomposition?.reason };

  const g = {};
  for (const h of decomposition.holdings) {
    const cur = g[h.group] ?? {
      group: h.group, contribution: 0, baseline: 0, allocation: 0, selection: 0,
      selectionSpread: 0, averageWeight: 0, holdings: [],
    };
    cur.contribution += h.contribution;
    cur.baseline += h.baseline;
    cur.allocation += h.allocation;
    cur.selection += h.selection;
    // Selection within a group sums to zero by construction — the group return
    // IS the weighted average of its members, so nothing can beat it on net.
    // That makes the sum useless as a displayed figure and a good invariant to
    // check. The figure worth showing is how much picking moved things around
    // inside the group, which is the absolute spread.
    cur.selectionSpread += Math.abs(h.selection);
    cur.averageWeight += h.averageWeight;
    cur.holdings.push(h.symbol);
    g[h.group] = cur;
  }

  const groups = Object.values(g).map(x => ({
    ...x,
    contribution: +x.contribution.toFixed(8),
    baseline: +x.baseline.toFixed(8),
    allocation: +x.allocation.toFixed(8),
    selection: +x.selection.toFixed(8),
    // Halved so it reads as "this much moved from the laggards to the leaders"
    // rather than double-counting each transfer at both ends.
    selectionSpread: +(x.selectionSpread / 2).toFixed(8),
    averageWeight: +x.averageWeight.toFixed(6),
    holdingCount: x.holdings.length,
  })).sort((a, b) => b.contribution - a.contribution);

  return {
    available: true,
    groups,
    // Both are zero-sum by construction; reported so a reader can see the
    // decomposition holding together rather than taking it on faith.
    allocationSum: +groups.reduce((s, x) => s + x.allocation, 0).toFixed(8),
    selectionSum: +groups.reduce((s, x) => s + x.selection, 0).toFixed(8),
    basis:
      'Effects are relative to this portfolio\'s own average return, not to an index. '
      + 'Group selection sums to zero by construction — a group cannot beat its own '
      + 'weighted average — so the spread is reported instead of the sum.',
  };
}

// ─── Against a real benchmark ─────────────────────────────────

/**
 * Total-level comparison against an actual index.
 *
 * This is the part that IS honestly computable against something external, so
 * it is reported on its own rather than folded into the effects above — where
 * it would imply the sector splits were benchmark-relative too.
 */
export function versusBenchmark(decomposition, symbol = '^FTSE') {
  if (!decomposition?.available) return { available: false, reason: decomposition?.reason };

  const bars = getBars(symbol);
  if (!bars?.length) {
    return { available: false, symbol, reason: `No stored history for ${symbol}` };
  }

  // benchmarkReturn reports percentages; everything in this engine is a
  // fraction, and mixing the two would put the excess out by a factor of 100
  // while still looking like a plausible number.
  const b = benchmarkReturn(symbol, decomposition.from, decomposition.to);
  if (!b?.available || !isFinite(b.cumulativePct)) {
    return {
      available: false, symbol,
      reason: b?.reason ?? `${symbol} has no return over ${decomposition.from} to ${decomposition.to}`,
    };
  }
  const bench = b.cumulativePct / 100;

  return {
    available: true,
    symbol,
    portfolioReturn: decomposition.totalReturn,
    benchmarkReturn: +bench.toFixed(8),
    excess: +(decomposition.totalReturn - bench).toFixed(8),
    // The benchmark's own dates, which can be narrower than the portfolio's if
    // the index has fewer stored bars in the window.
    from: b.from, to: b.to, bars: b.bars,
    basis:
      `Total return against ${symbol} over the same dates. The sector and holding `
      + 'effects above are portfolio-relative and do not decompose this excess — '
      + 'that would need the index\'s own sector weights and sector returns, which '
      + 'no free source publishes as a time series.',
  };
}

// ─── The assembled report ─────────────────────────────────────

export function attributionReport(prices, {
  lookback = 750,
  grouping = 'sector',
  benchmark = '^FTSE',
} = {}) {
  const valued = valuePortfolio(prices);
  const field = GROUPINGS[grouping] ?? 'sector';
  const labels = Object.fromEntries(
    valued.positions.map(p => [p.symbol, (p[field] ?? '').toString().trim() || UNLABELLED]));
  const names = Object.fromEntries(valued.positions.map(p => [p.symbol, p.name ?? p.symbol]));

  const series = valueSeries(prices, { lookback });
  if (!series.available) {
    return {
      available: false,
      reason: series.reason,
      generatedAt: new Date().toISOString(),
    };
  }

  const dec = decompose(series, { groupOf: s => labels[s] });
  if (!dec.available) {
    return { available: false, reason: dec.reason, generatedAt: new Date().toISOString() };
  }

  const groups = byGroup(dec);
  const bench = versusBenchmark(dec, benchmark);

  const withNames = dec.holdings.map(h => ({ ...h, name: names[h.symbol] ?? h.symbol }));
  const winners = withNames.filter(h => h.contribution > 0).slice(0, 5);
  const losers = [...withNames].filter(h => h.contribution < 0)
    .sort((a, b) => a.contribution - b.contribution).slice(0, 5);

  return {
    available: true,
    generatedAt: new Date().toISOString(),
    grouping,
    totalReturn: dec.totalReturn,
    from: dec.from, to: dec.to, days: dec.days,
    holdings: withNames,
    groups: groups.groups ?? [],
    allocationSum: groups.allocationSum ?? null,
    selectionSum: groups.selectionSum ?? null,
    winners, losers,
    benchmark: bench,
    reconciles: dec.reconciles,
    excluded: series.excluded ?? [],
    basis: dec.basis,
    caveat:
      'Effects are measured against this portfolio\'s own average return. They '
      + 'are not benchmark-relative, and the allocation effect here does not mean '
      + 'the same thing as a Brinson allocation effect against an index.',
  };
}

// ─── Commentary ───────────────────────────────────────────────

/** Percent, signed, for prose. */
const pp = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;

/**
 * The facts the commentary is allowed to talk about, assembled as text.
 *
 * Built separately from the call so the prompt can be inspected and tested
 * without a network round trip, and so the model is never handed the raw
 * report to interpret as it likes — it gets the numbers this engine already
 * computed and reconciled.
 */
export function commentaryFacts(report) {
  if (!report?.available) return null;
  const lines = [];
  lines.push(`Period: ${report.from} to ${report.to} (${report.days} trading days).`);
  lines.push(`Total portfolio return over the period: ${pp(report.totalReturn)}.`);

  if (report.benchmark?.available) {
    lines.push(`Benchmark ${report.benchmark.symbol}: ${pp(report.benchmark.benchmarkReturn)}, `
      + `so the portfolio was ${pp(report.benchmark.excess)} against it.`);
  } else {
    lines.push(`No benchmark comparison available (${report.benchmark?.reason ?? 'unknown reason'}).`);
  }

  if (report.winners.length) {
    lines.push('Largest positive contributors: ' + report.winners
      .map(h => `${h.name} ${pp(h.contribution)} (average weight ${(h.averageWeight * 100).toFixed(1)}%)`)
      .join('; ') + '.');
  }
  if (report.losers.length) {
    lines.push('Largest negative contributors: ' + report.losers
      .map(h => `${h.name} ${pp(h.contribution)} (average weight ${(h.averageWeight * 100).toFixed(1)}%)`)
      .join('; ') + '.');
  }
  if (report.groups.length) {
    lines.push(`By ${report.grouping}: ` + report.groups
      .map(g => `${g.group} contributed ${pp(g.contribution)}, of which allocation ${pp(g.allocation)} and selection ${pp(g.selection)}`)
      .join('; ') + '.');
  }
  lines.push('Allocation effect means the group did better or worse than the portfolio average, '
    + 'weighted by how much was in it. Selection effect means holdings within that group beat or '
    + 'lagged the group itself. Both are measured against this portfolio, not against an index.');
  lines.push(report.basis);
  return lines.join('\n');
}

const PROMPT_HEADER = `You are writing a short note explaining where a private investor's portfolio return came from, using only the figures supplied.

Rules:
- Use only the numbers given. Do not estimate, extrapolate, or introduce any figure that is not listed.
- If the numbers show nothing notable - a small return, no dominant contributor, no meaningful spread between holdings - say exactly that. "Nothing much drove this period" is a correct and expected answer when it is true. Do not manufacture a narrative.
- Do not give advice, make predictions, or suggest trades.
- Distinguish a holding that mattered because it moved a lot from one that mattered because it was large. The average weight is given for exactly this.
- These effects are measured against the portfolio's own average, not an index. Never describe them as out- or under-performing a benchmark unless quoting the benchmark line directly.
- Three short paragraphs at most. Plain English. No headings, no bullet points, no preamble.

Figures:
`;

export function commentaryPrompt(report) {
  const facts = commentaryFacts(report);
  return facts ? PROMPT_HEADER + facts : null;
}

/**
 * Explain the attribution in prose.
 *
 * The AI function is injected so this is testable without a key or a network,
 * following the same pattern as the news scorer. With no key configured it
 * returns a declared absence rather than a canned sentence that would read
 * exactly like a real answer.
 */
export async function explain(report, { aiFn = null, hasKey = null } = {}) {
  if (!report?.available) {
    return { available: false, reason: report?.reason ?? 'No attribution to explain' };
  }

  const prompt = commentaryPrompt(report);
  if (!prompt) return { available: false, reason: 'Nothing to explain' };

  let fn = aiFn;
  if (!fn) {
    const ai = await import('../sources/ai.js');
    const keyed = hasKey ?? ai.hasGeminiKey();
    if (!keyed) {
      return {
        available: false,
        reason: 'No Gemini API key configured, so no commentary was generated.',
        promptLength: prompt.length,
      };
    }
    // ai.callAI resolves to { ok, text, message }, not a string — the aiFn
    // contract below (a string on success, a thrown error on failure) is what
    // the try/catch here and every test in this file are written against.
    // Assigning ai.callAI directly used to skip this adapter, which meant
    // String({ok:true,text:'...'}) stringified to the literal text
    // "[object Object]" and shipped as the commentary on every real call.
    fn = async (p, opts) => {
      const res = await ai.callAI(p, opts);
      if (!res.ok) throw new Error(res.message ?? res.error ?? 'AI request failed');
      return res.text;
    };
  }

  try {
    const text = await fn(prompt, { maxTokens: 700, temperature: 0.1 });
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return { available: false, reason: 'The model returned nothing.' };
    return {
      available: true,
      text: trimmed,
      generatedAt: new Date().toISOString(),
      basis: 'Written from the reconciled attribution figures only — the model was given no other data.',
    };
  } catch (e) {
    return { available: false, reason: `Commentary failed: ${e.message}` };
  }
}
