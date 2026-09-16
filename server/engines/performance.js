// Meridian — real performance measurement
//
// The Portfolio page has shown a "reconstructed return" with an honest caveat
// attached: it holds current weights fixed and replays them over stored bars,
// which answers "how would this book have done" and not "how did I do". The
// difference is not academic. Buy heavily into something just before it falls
// and the reconstruction never sees it, because it does not know when the
// money arrived.
//
// Knowing when the money arrived is the whole problem, and it needs a fact the
// database did not hold. `transactions` records buys and sells — but those are
// internal: a buy moves value from cash into a security without changing what
// the portfolio is worth. The flows that matter for measuring a return are the
// ones that cross the boundary: money you put in, and money you took out.
//
// So this engine ships with a ledger for exactly those, and computes the two
// returns that matter, which answer different questions and routinely
// disagree:
//
//   Money-weighted (IRR)  — what YOUR money earned. Sensitive to when you
//                           added and removed it, so it credits and blames
//                           your timing. This is the honest answer to "how am
//                           I doing".
//   Time-weighted  (TWR)  — what the STRATEGY earned, with the effect of
//                           deposit timing removed. This is the number that
//                           is comparable to an index, because an index has
//                           no deposits.
//
// A portfolio that returned 20% while most of the money arrived at the top can
// show a strong TWR and a poor IRR at the same time. Both are correct. Showing
// only one is how a tool flatters its user.
//
// Neither is computed from an assumption. Where the ledger cannot support a
// figure, the figure is refused and the reason is stated.

import { all, one, run, db, getBars } from '../db.js';
import { GBP_BENCHMARK } from '../config.js';

db.exec(`
-- External cash flows only: money entering or leaving the portfolio as a
-- whole. A buy is not a flow (it moves value between cash and a security);
-- a deposit is. Conflating the two is the single most common way a
-- retail-facing IRR ends up wrong.
CREATE TABLE IF NOT EXISTS cash_flows (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  date     TEXT NOT NULL,
  amount   REAL NOT NULL,           -- positive = paid in, negative = taken out
  currency TEXT NOT NULL DEFAULT 'GBP',
  account  TEXT DEFAULT 'Main',
  kind     TEXT NOT NULL DEFAULT 'deposit',
  note     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_flows_date ON cash_flows(date);
`);

const DAY = 86400_000;
const iso = d => new Date(d).toISOString().slice(0, 10);
const parseDate = s => Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`);

// ─── Ledger ───────────────────────────────────────────────────

export function listFlows() {
  return all('SELECT * FROM cash_flows ORDER BY date DESC, id DESC');
}

export function addFlow({ date, amount, currency = 'GBP', account = 'Main', kind = 'deposit', note = null }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt === 0) throw new Error('A cash flow needs a non-zero amount.');
  if (!Number.isFinite(parseDate(date))) throw new Error('A cash flow needs a valid date (YYYY-MM-DD).');

  // Sign is derived from the kind rather than trusted from the caller, so a
  // withdrawal typed as a positive number cannot silently become a deposit and
  // flatter the return.
  const signed = kind === 'withdrawal' ? -Math.abs(amt) : Math.abs(amt);
  run(`INSERT INTO cash_flows (date, amount, currency, account, kind, note, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      iso(parseDate(date)), signed, currency, account, kind, note, Date.now());
  return one('SELECT * FROM cash_flows ORDER BY id DESC LIMIT 1');
}

export function deleteFlow(id) { run('DELETE FROM cash_flows WHERE id = ?', id); return { ok: true }; }

// ─── XIRR ─────────────────────────────────────────────────────

/**
 * Net present value of dated flows at an annual rate.
 *
 * Act/365 rather than even periods, because real contributions do not land on
 * neat month boundaries and rounding them to periods is a silent error in the
 * direction of whatever schedule you assumed.
 */
function npv(rate, flows, t0) {
  let sum = 0;
  for (const f of flows) {
    const years = (f.when - t0) / (365 * DAY);
    // A rate at or below -100% makes the discount factor undefined or
    // negative; the caller's bracket keeps us away from it, and this guard
    // stops a pathological input producing a confident nonsense number.
    const base = 1 + rate;
    if (base <= 0) return NaN;
    sum += f.amount / Math.pow(base, years);
  }
  return sum;
}

/**
 * Internal rate of return on irregularly dated flows.
 *
 * Bisection rather than Newton-Raphson. Newton converges faster but can walk
 * off to a nonsense root on the flow schedules real portfolios produce — a
 * large late withdrawal, or several sign changes — and a wrong IRR presented
 * confidently is worse than a refused one. Bisection needs a bracket, cannot
 * leave it, and either finds the root inside it or reports that it could not.
 */
export function xirr(flows, { lo = -0.9999, hi = 100, tol = 1e-7, maxIter = 300 } = {}) {
  if (!flows || flows.length < 2) {
    return { available: false, reason: 'At least two dated flows are needed to compute a rate of return.' };
  }
  const hasIn = flows.some(f => f.amount > 0);
  const hasOut = flows.some(f => f.amount < 0);
  if (!hasIn || !hasOut) {
    return {
      available: false,
      reason: 'A rate of return needs both money in and money out — the final value counts as money out. '
        + 'With flows in only one direction there is no rate that makes them balance.',
    };
  }

  const t0 = Math.min(...flows.map(f => f.when));
  let fLo = npv(lo, flows, t0), fHi = npv(hi, flows, t0);
  if (!isFinite(fLo) || !isFinite(fHi)) {
    return { available: false, reason: 'The flow schedule produced an undefined present value.' };
  }
  if (fLo * fHi > 0) {
    // No sign change across the bracket means no root inside it. Saying so is
    // the honest outcome; returning an endpoint would be inventing an answer.
    return {
      available: false,
      reason: 'No rate of return exists for this flow schedule within a plausible range '
        + '(-99.99% to +10,000% a year). This usually means a flow is mis-signed.',
    };
  }

  let rate = 0;
  for (let i = 0; i < maxIter; i++) {
    rate = (lo + hi) / 2;
    const f = npv(rate, flows, t0);
    if (!isFinite(f)) return { available: false, reason: 'The solver hit an undefined value.' };
    if (Math.abs(f) < tol || (hi - lo) / 2 < tol) break;
    if (f * fLo < 0) { hi = rate; } else { lo = rate; fLo = f; }
  }

  return { available: true, rate, annualisedPct: +(rate * 100).toFixed(2) };
}

// ─── Money-weighted return ────────────────────────────────────

/**
 * IRR over the ledger, with the portfolio's present value as the closing flow.
 *
 * The closing value is negative by convention: it is what you would take out
 * if you liquidated today, and the rate is whatever makes the deposits and
 * that terminal value balance.
 */
export function moneyWeighted(currentValue, { flows = null, asOf = Date.now() } = {}) {
  const ledger = flows ?? listFlows();
  if (!ledger.length) {
    return {
      available: false,
      reason: 'No cash flows recorded. A money-weighted return is a question about when your money '
        + 'arrived, so it cannot be computed without dated deposits and withdrawals — and guessing '
        + 'them from holdings would be inventing the answer.',
      flowCount: 0,
    };
  }
  if (!(currentValue > 0)) {
    return { available: false, reason: 'The portfolio has no current value to measure against.', flowCount: ledger.length };
  }

  const dated = ledger
    .map(f => ({ when: parseDate(f.date), amount: f.amount }))
    .filter(f => Number.isFinite(f.when))
    .sort((a, b) => a.when - b.when);

  if (!dated.length) {
    return { available: false, reason: 'No cash flow had a usable date.', flowCount: ledger.length };
  }

  const first = dated[0].when;
  const years = (asOf - first) / (365 * DAY);
  if (years <= 0.02) {
    // Under about a week, annualising turns a rounding difference into a
    // headline percentage. The figure is real but the annualisation is not.
    return {
      available: false,
      reason: `Only ${Math.max(0, Math.round(years * 365))} days of history since the first cash flow — `
        + 'too short to annualise without turning noise into a headline number.',
      flowCount: ledger.length,
    };
  }

  // Deposits are money leaving your pocket into the portfolio, so from the
  // portfolio's perspective they are negative flows; the terminal value is the
  // positive one. Getting this sign convention backwards silently negates the
  // whole result, which is why it is written out rather than inlined.
  const solverFlows = [
    ...dated.map(f => ({ when: f.when, amount: -f.amount })),
    { when: asOf, amount: currentValue },
  ];

  const solved = xirr(solverFlows);
  if (!solved.available) return { ...solved, flowCount: ledger.length };

  const netIn = dated.reduce((a, f) => a + f.amount, 0);
  return {
    available: true,
    annualisedPct: solved.annualisedPct,
    // Simple gain over net contributions, for readers to whom a rate means
    // less than "I put in X and have Y".
    netContributed: +netIn.toFixed(2),
    currentValue: +currentValue.toFixed(2),
    absoluteGain: +(currentValue - netIn).toFixed(2),
    absoluteGainPct: netIn > 0 ? +(((currentValue / netIn) - 1) * 100).toFixed(2) : null,
    firstFlow: iso(first),
    years: +years.toFixed(2),
    flowCount: ledger.length,
    method: 'XIRR on dated external cash flows, act/365, solved by bisection.',
    meaning: 'What your money actually earned, including the effect of when you added or removed it.',
  };
}

// ─── Time-weighted return ─────────────────────────────────────

/**
 * TWR from stored snapshots, with external flows removed at their dates.
 *
 * The portfolio is chain-linked across sub-periods split at every cash flow,
 * so a deposit does not read as a gain. This is the number that can be put
 * beside an index, because an index has no deposits.
 *
 * Snapshots are taken while the app runs, so coverage is uneven by nature —
 * days the machine was off are simply absent. That is reported rather than
 * interpolated: inventing a valuation for a day nobody observed would be
 * exactly the fabrication this project exists to avoid.
 */
export function timeWeighted(snapshots, { flows = null } = {}) {
  const rows = (snapshots ?? [])
    .filter(s => s.date && Number.isFinite(s.total_gbp ?? s.total))
    .map(s => ({ date: s.date, total: s.total_gbp ?? s.total }))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (rows.length < 2) {
    return {
      available: false,
      reason: `Only ${rows.length} portfolio snapshot${rows.length === 1 ? '' : 's'} stored. `
        + 'A time-weighted return needs at least two valuations to link a return between.',
      snapshots: rows.length,
    };
  }

  const ledger = flows ?? listFlows();
  // Flows summed per day: several deposits on one date affect that day's
  // linking once, not once each.
  const flowByDate = new Map();
  for (const f of ledger) {
    const d = iso(parseDate(f.date));
    flowByDate.set(d, (flowByDate.get(d) ?? 0) + f.amount);
  }

  const links = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    const flow = flowByDate.get(cur.date) ?? 0;

    // The flow is treated as arriving at the start of the period, which is the
    // convention that keeps a same-day deposit out of the numerator. With
    // daily snapshots the alternative conventions differ by a rounding error;
    // with sparse ones this is the conservative choice.
    const base = prev.total + flow;
    if (!(base > 0)) continue;             // a period starting from nothing has no return to link
    links.push({ date: cur.date, r: cur.total / base - 1, flow });
  }

  if (!links.length) {
    return { available: false, reason: 'No usable sub-period between snapshots.', snapshots: rows.length };
  }

  const cumulative = links.reduce((acc, l) => acc * (1 + l.r), 1) - 1;
  const spanDays = (parseDate(rows[rows.length - 1].date) - parseDate(rows[0].date)) / DAY;
  const years = spanDays / 365;
  const annualised = years >= 0.08 && cumulative > -1
    ? Math.pow(1 + cumulative, 1 / years) - 1
    : null;

  // Snapshots exist only for days the app ran, so a span of 200 days with 40
  // snapshots is a real and reportable gap rather than a smooth series.
  const coverage = spanDays > 0 ? +(rows.length / (spanDays + 1) * 100).toFixed(1) : 100;

  return {
    available: true,
    cumulativePct: +(cumulative * 100).toFixed(2),
    annualisedPct: annualised == null ? null : +(annualised * 100).toFixed(2),
    annualisedNote: annualised == null
      ? 'Span too short to annualise — the cumulative figure is the honest one.' : null,
    from: rows[0].date,
    to: rows[rows.length - 1].date,
    spanDays: Math.round(spanDays),
    snapshots: rows.length,
    periods: links.length,
    flowsRemoved: links.filter(l => l.flow !== 0).length,
    coveragePct: coverage,
    coverageNote: coverage < 60
      ? `Snapshots cover ${coverage}% of the days in this span — they are only taken while the app is `
        + 'running, so gaps are days the machine was off, not days with no movement.'
      : null,
    method: 'Chain-linked sub-period returns from stored snapshots, with external cash flows removed.',
    meaning: 'What the strategy earned, with the effect of when you added money stripped out. '
      + 'This is the figure comparable to an index.',
  };
}

// ─── Benchmark ────────────────────────────────────────────────

/** The benchmark's own return over exactly the same dates, for comparison. */
export function benchmarkReturn(symbol, from, to) {
  const bars = getBars(symbol);
  if (!bars.length) {
    return { available: false, symbol, reason: `No stored history for ${symbol}.` };
  }
  const inRange = bars
    .filter(b => b.date >= from && b.date <= to)
    .map(b => ({ date: b.date, close: b.adj_close ?? b.close }))
    .filter(b => Number.isFinite(b.close));

  if (inRange.length < 2) {
    return {
      available: false, symbol,
      reason: `Only ${inRange.length} stored bar${inRange.length === 1 ? '' : 's'} for ${symbol} between `
        + `${from} and ${to} — not enough to measure the same period.`,
    };
  }

  const first = inRange[0], last = inRange[inRange.length - 1];
  const cumulative = last.close / first.close - 1;
  const years = (parseDate(last.date) - parseDate(first.date)) / (365 * DAY);
  return {
    available: true, symbol,
    cumulativePct: +(cumulative * 100).toFixed(2),
    annualisedPct: years >= 0.08 ? +((Math.pow(1 + cumulative, 1 / years) - 1) * 100).toFixed(2) : null,
    from: first.date, to: last.date, bars: inRange.length,
    source: 'Stored daily bars, adjusted close where available.',
  };
}

// ─── The read ─────────────────────────────────────────────────

export function performanceReport(currentValue, snapshots, {
  benchmark = GBP_BENCHMARK, asOf = Date.now(),
} = {}) {
  const flows = listFlows();
  const mwr = moneyWeighted(currentValue, { flows, asOf });
  const twr = timeWeighted(snapshots, { flows });

  const bench = twr.available
    ? benchmarkReturn(benchmark, twr.from, twr.to)
    : { available: false, symbol: benchmark, reason: 'No measurable portfolio period to compare against.' };

  // The gap between the two returns IS the timing effect, and it is the most
  // useful thing on this page: it is the only number that says whether when
  // you bought helped or hurt, separately from what you bought.
  let timing = null;
  if (mwr.available && twr.available && twr.annualisedPct != null) {
    const gap = mwr.annualisedPct - twr.annualisedPct;
    timing = {
      gapPct: +gap.toFixed(2),
      verdict: Math.abs(gap) < 0.5
        ? 'Your contribution timing made no material difference.'
        : gap > 0
          ? 'Your money was, on balance, in the market at better moments than a flat schedule would have been.'
          : 'Your money arrived at worse moments than a flat schedule would have — the strategy did better than you did from it.',
      explain: 'The gap between the money-weighted and time-weighted returns is the effect of when '
        + 'money was added or removed, with what was held stripped out.',
    };
  }

  let versusBenchmark = null;
  if (twr.available && bench.available && twr.annualisedPct != null && bench.annualisedPct != null) {
    versusBenchmark = {
      symbol: bench.symbol,
      portfolioPct: twr.annualisedPct,
      benchmarkPct: bench.annualisedPct,
      differencePct: +(twr.annualisedPct - bench.annualisedPct).toFixed(2),
      // Compared time-weighted, never money-weighted: an index has no
      // deposits, so putting an IRR beside it compares two different things.
      note: 'Compared time-weighted, since the benchmark has no cash flows of its own.',
    };
  }

  return {
    asOf,
    moneyWeighted: mwr,
    timeWeighted: twr,
    benchmark: bench,
    timing,
    versusBenchmark,
    flows: flows.slice(0, 200),
    flowSummary: {
      count: flows.length,
      deposited: +flows.filter(f => f.amount > 0).reduce((a, f) => a + f.amount, 0).toFixed(2),
      withdrawn: +Math.abs(flows.filter(f => f.amount < 0).reduce((a, f) => a + f.amount, 0)).toFixed(2),
      first: flows.length ? flows[flows.length - 1].date : null,
      last: flows.length ? flows[0].date : null,
    },
    coverage: 'Money-weighted return comes from the cash-flow ledger you maintain; time-weighted return '
      + 'from snapshots taken while the app runs. Neither is inferred from holdings — where the data '
      + 'cannot support a figure, it is refused rather than estimated.',
  };
}
