// Meridian — portfolio rebuild pipeline
//
// The orchestrator. Runs the stages in order, keeps every stage's working, and
// assembles one report.
//
// What this answers, which nothing else in Meridian did: given this mandate
// and everything the app knows, what portfolio should exist — not "how do I
// nudge the current one back to its targets" (rebalance.js) and not "where
// does this spare cash go" (allocate.js). Current holdings get no special
// standing here beyond being assessed like everything else; a holding that
// cannot justify its place is proposed for sale, and something never owned
// can be proposed for purchase.
//
// Stages:
//   A  exposure   what is actually owned, and where it is owned twice
//   B  mandate    what "better" means, in numbers
//   C  universe   everything investable and analysable
//   D  regime     market context, used only to scale trust in timing
//   E-G diligence evidence per candidate, and a verdict with reasons
//   H  construct  weights, constraints, and the trade list
//
// The report is advisory. It generates a trade list; it never places a trade,
// modifies a holding, or writes to the portfolio. Nothing in this pipeline
// models tax.

import { db, all, run, getBars } from '../../db.js';
import { runAllScenarios } from '../stress.js';
import * as pf from '../portfolio.js';
import * as exposure from './exposure.js';
import * as mandateModel from './mandate.js';
import * as universe from './universe.js';
import * as regimeModel from './regime.js';
import * as diligence from './diligence.js';
import * as construct from './construct.js';

db.exec(`
CREATE TABLE IF NOT EXISTS rebuild_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  mandate_json TEXT NOT NULL,
  report_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rebuild_runs_created ON rebuild_runs(created_at DESC);
`);

export function saveRun(mandate, report) {
  run('INSERT INTO rebuild_runs (created_at, mandate_json, report_json) VALUES (?,?,?)',
      Date.now(), JSON.stringify(mandate), JSON.stringify(report));
}

export function listRuns(limit = 20) {
  return all('SELECT id, created_at, mandate_json FROM rebuild_runs ORDER BY created_at DESC LIMIT ?', limit)
    .map(r => ({ id: r.id, createdAt: r.created_at, mandate: JSON.parse(r.mandate_json) }));
}

export function getRun(id) {
  const r = all('SELECT * FROM rebuild_runs WHERE id = ?', id)[0];
  if (!r) return null;
  return {
    id: r.id, createdAt: r.created_at,
    mandate: JSON.parse(r.mandate_json),
    report: JSON.parse(r.report_json),
  };
}

/**
 * Replay the stored stress scenarios against a proposed set of weights, so the
 * proposal can be compared with the current portfolio on the same windows
 * rather than asserted to be safer.
 */
function stressProposed(targetWeights, investableValue) {
  const positions = Object.entries(targetWeights)
    .filter(([, w]) => w > 0)
    .map(([symbol, w]) => ({ symbol, value: investableValue * w }));
  if (!positions.length) return null;
  return runAllScenarios(positions, getBars);
}

/**
 * @param {Object} prices    live price cache
 * @param {Object} opts      { mandate?, strategy?, includeTracked?, includeWatchlist?, extraSymbols?, minTradeValue?, save? }
 */
export function runRebuild(prices, opts = {}) {
  const started = Date.now();
  const mandate = opts.mandate ?? mandateModel.loadMandate();

  // ── Current state ──
  const valuation = pf.valuePortfolio(prices ?? {});
  const positions = valuation.positions;
  const priced = positions.filter(p => (p.value ?? 0) > 0);
  const total = valuation.total;

  if (!priced.length && !valuation.cash) {
    return {
      ok: false,
      stage: 'portfolio',
      error: 'No priced holdings and no cash — there is nothing to rebuild.',
      mandate,
    };
  }

  // ── Stage A: exposure teardown ──
  const teardown = exposure.teardown(priced);

  // ── Stage D: regime (read before diligence, which consumes it) ──
  const regime = regimeModel.readRegime(prices, mandate);

  // ── Stage C: universe ──
  const scan = universe.assembleUniverse({
    holdingsSymbols: positions.map(p => p.symbol),
    includeWatchlist: opts.includeWatchlist !== false,
    includeTracked: opts.includeTracked !== false,
    extra: opts.extraSymbols ?? [],
    exclude: mandate.excludeSymbols,
  });

  // ── Stages E-G: diligence ──
  const currentWeights = Object.fromEntries(priced.map(p => [p.symbol, p.weight / 100]));
  const assessments = scan.candidates.map(c => diligence.assess(c, {
    mandate, regime,
    strategy: opts.strategy ?? 'balanced',
    currentWeight: (currentWeights[c.symbol] ?? 0) * 100,
  }));

  const included = assessments.filter(a => a.verdict === 'included');
  const excluded = assessments.filter(a => a.verdict !== 'included');

  // ── Stage H: reconstruction ──
  const compositions = exposure.listCompositions(scan.candidates.map(c => c.symbol));
  const redundancy = construct.resolveRedundancy(included, { compositions });

  const seriesSymbols = [...new Set([
    ...redundancy.survivors.map(s => s.symbol),
    ...priced.map(p => p.symbol),
  ])];
  const series = pf.holdingReturnSeries(seriesSymbols, mandate.lookbackDays);

  const built = construct.construct({
    survivors: redundancy.survivors,
    series, mandate, positions: priced, total,
    prices: prices ?? {},
    minTradeValue: opts.minTradeValue ?? 50,
  });

  // ── Stress comparison ──
  let stress = null;
  if (built.ok) {
    const investable = total * (1 - mandate.cashBufferPct / 100);
    const currentStress = priced.length
      ? runAllScenarios(priced.map(p => ({ symbol: p.symbol, value: p.value })), getBars)
      : null;
    const proposedStress = stressProposed(built.targetWeights, investable);
    stress = {
      current: currentStress,
      proposed: proposedStress,
      comparison: (currentStress?.worstCase && proposedStress?.worstCase) ? {
        worstCaseCurrentPct: currentStress.worstCase.loss,
        worstCaseProposedPct: proposedStress.worstCase.loss,
        differencePct: +(proposedStress.worstCase.loss - currentStress.worstCase.loss).toFixed(2),
        scenario: proposedStress.worstCase.scenario,
      } : null,
      note: 'Replayed against each holding\'s own history where it exists in the window, and estimated by beta against a benchmark where it does not. Historical windows describe what happened then, not what will happen next.',
    };
  }

  const report = {
    ok: built.ok,
    generatedAt: started,
    elapsedMs: Date.now() - started,
    mandate,
    portfolio: {
      total: valuation.total,
      invested: valuation.invested,
      cash: valuation.cash,
      positions: priced.map(p => ({
        symbol: p.symbol, name: p.name, value: p.value, weight: p.weight,
        sector: p.sector, price: p.price, qty: p.qty,
      })),
      missingPrices: valuation.missingPrices,
    },
    stages: {
      exposure: teardown,
      regime,
      universe: { ...scan, candidates: undefined, counts: scan.counts, skipped: scan.skipped },
      diligence: {
        assessed: assessments.length,
        included: included.length,
        excluded: excluded.length,
        candidates: assessments,
        excludedReasons: summariseExclusions(excluded),
      },
      redundancy: {
        survivors: redundancy.survivors.map(s => s.symbol),
        dropped: redundancy.dropped,
        groups: redundancy.groups,
      },
      construction: built,
    },
    stress,
    // Everything the report could not see, in one place, so a thin run is
    // obvious at a glance rather than only to someone reading every stage.
    dataGaps: collectGaps({ teardown, scan, assessments, built, regime, valuation }),
  };

  if (opts.save !== false) saveRun(mandate, report);
  return report;
}

function summariseExclusions(excluded) {
  const by = {};
  for (const e of excluded) {
    (by[e.reasonCode] ??= { code: e.reasonCode, count: 0, symbols: [] });
    by[e.reasonCode].count++;
    by[e.reasonCode].symbols.push(e.symbol);
  }
  return Object.values(by).sort((a, b) => b.count - a.count);
}

function collectGaps({ teardown, scan, assessments, built, regime, valuation }) {
  const gaps = [];

  if (teardown.coverage.note) {
    gaps.push({ stage: 'exposure', issue: teardown.coverage.note });
  }
  if (teardown.redundancy.unassessable.length) {
    gaps.push({
      stage: 'exposure',
      issue: `${teardown.redundancy.unassessable.length} holding pairs could not be compared for overlap at all.`,
      detail: teardown.redundancy.unassessable.map(p => p.join(' / ')),
    });
  }
  if (valuation.missingPrices?.length) {
    gaps.push({
      stage: 'portfolio',
      issue: `No live price for ${valuation.missingPrices.join(', ')} — excluded from every calculation here.`,
    });
  }
  if (!regime.available) {
    gaps.push({ stage: 'regime', issue: regime.explain });
  }
  if (scan.skipped.length) {
    const noHistory = scan.skipped.filter(s => s.reasons.some(r => r.includes('stored bars')));
    if (noHistory.length) {
      gaps.push({
        stage: 'universe',
        issue: `${noHistory.length} otherwise-investable symbols were skipped for want of stored history. A history sync would widen the search.`,
        detail: noHistory.map(s => s.symbol),
      });
    }
  }
  const thin = assessments.filter(a => a.evidence != null && a.evidence < 0.5);
  if (thin.length) {
    gaps.push({
      stage: 'diligence',
      issue: `${thin.length} candidates were judged on under half their intended evidence.`,
      detail: thin.map(a => `${a.symbol} (${(a.evidence * 100).toFixed(0)}%)`),
    });
  }
  const noNews = assessments.filter(a => !a.news.available).length;
  if (noNews === assessments.length && assessments.length) {
    gaps.push({
      stage: 'diligence',
      issue: 'No stored news mentions any candidate, so the news gate ran on nothing and vetoed nothing.',
    });
  }
  if (built.ok && built.withoutHistory?.length) {
    gaps.push({
      stage: 'construction',
      issue: `${built.withoutHistory.join(', ')} passed diligence but has no usable return series, so it could not be sized and is absent from the proposal.`,
    });
  }
  if (built.ok && built.constraints.breaches.length) {
    gaps.push({
      stage: 'construction',
      issue: 'Some mandate caps could not be satisfied.',
      detail: built.constraints.breaches.map(b =>
        b.kind === 'position'
          ? `${b.symbol} at ${b.weightPct}% against a ${b.capPct}% cap`
          : `${b.sector} at ${b.weightPct}% against a ${b.capPct}% cap`),
    });
  }

  return gaps;
}

export { mandateModel as mandate, exposure, universe, regimeModel as regime, diligence, construct };
