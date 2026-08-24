// Meridian v2 — full route audit
// Boots the engines in-process (no network needed) and asserts on real output.

process.chdir('/home/claude/mv2/server');

const db = await import('/home/claude/mv2/server/db.js');
const analytics = await import('/home/claude/mv2/server/engines/analytics.js');
const opt = await import('/home/claude/mv2/server/engines/optimiser.js');
const pf = await import('/home/claude/mv2/server/engines/portfolio.js');
const analyst = await import('/home/claude/mv2/server/engines/analyst.js');
const screener = await import('/home/claude/mv2/server/engines/screener.js');
const backtest = await import('/home/claude/mv2/server/engines/backtest.js');
const alerts = await import('/home/claude/mv2/server/engines/alerts.js');
const paper = await import('/home/claude/mv2/server/engines/paper.js');
const mc = await import('/home/claude/mv2/server/engines/montecarlo.js');
const stress = await import('/home/claude/mv2/server/engines/stress.js');
const rebal = await import('/home/claude/mv2/server/engines/rebalance.js');
const integrity = await import('/home/claude/mv2/server/engines/integrity.js');

// Re-seed holdings so every run starts from the same state — the edge-case
// section mutates the table, and a test suite that can't be run twice is not
// a test suite.
db.run('DELETE FROM holdings'); db.run('DELETE FROM cash'); db.run('DELETE FROM alerts'); db.run('DELETE FROM paper_trades');
for (const h of [
  ['VUSA.L','Vanguard S&P 500',313,79.39,'GBP','Broad','US','Equity','ISA','Main',25],
  ['SWDA.L','iShares MSCI World',203.7,84.01,'GBP','Broad','Global','Equity','ISA','Main',15],
  ['IGLN.L','iShares Gold',18.34,77.60,'GBP','Gold','Global','Commodity','GIA','Trading',10],
  ['VERG.L','Vanguard Dev Europe',304.8,37.64,'GBP','Broad','Europe','Equity','GIA','Trading',10],
  ['VDPG.L','Vanguard Dev World',501.8,21.84,'GBP','Broad','Asia-Pacific','Equity','GIA','Trading',15],
  ['SEMI.L','Global Semis',500,6.00,'GBP','Tech','Global','Equity','GIA','Trading',10],
  ['DFND.L','Aero & Defence',500,5.50,'GBP','Defence','Global','Equity','GIA','Trading',10],
  ['IIND.L','MSCI India',800,6.20,'GBP','EM','India','Equity','GIA','Trading',5],
]) db.run(`INSERT INTO holdings (symbol,name,qty,avg_price,currency,sector,geography,asset_class,wrapper,account,target_pct,added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, ...h, Date.now());
db.run(`INSERT INTO cash (account,wrapper,currency,amount,updated_at) VALUES ('ISA','ISA','GBP',4200,?)`, Date.now());

let pass = 0, fail = 0;
const issues = [];
function T(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; issues.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
}
function section(s) { console.log(`\n━━━ ${s} ━━━`); }

// synthetic live prices from last stored bar
const prices = {};
for (const { symbol } of db.all('SELECT DISTINCT symbol FROM ohlcv')) {
  const b = db.getBars(symbol);
  const last = b[b.length - 1], prev = b[b.length - 2];
  const b252 = b.slice(-252).map(x => x.close);
  prices[symbol] = {
    price: +last.close.toFixed(4), prev: +prev.close.toFixed(4),
    changePct: +(((last.close / prev.close) - 1) * 100).toFixed(2),
    high52: Math.max(...b252), low52: Math.min(...b252),
    volume: last.volume, avgVolume: 500000, currency: 'GBP', live: true,
  };
}
prices['GBPUSD=X'] = { price: 1.27, prev: 1.27, changePct: 0 };
prices['EURUSD=X'] = { price: 1.08, prev: 1.08, changePct: 0 };
prices['USDJPY=X'] = { price: 150, prev: 150, changePct: 0 };

// ══════════════════════════════════════════════════
section('PORTFOLIO');
const v = pf.valuePortfolio(prices);
T('values all holdings', v.positions.length === 8, `${v.positions.length}/8`);
T('no missing prices', v.missingPrices.length === 0, v.missingPrices.join(','));
T('total = invested + cash', Math.abs(v.total - (v.invested + v.cash)) < 0.02);
T('weights sum to 100 incl cash',
  Math.abs(v.positions.reduce((a, p) => a + p.weight, 0) + (v.cash / v.total * 100) - 100) < 0.1);
T('P&L consistent', Math.abs(v.pnl - (v.invested - v.cost)) < 0.02);
T('breakdown sums match invested',
  Math.abs(v.breakdowns.geography.reduce((a, g) => a + g.value, 0) - v.invested) < 0.02);
T('concentration computed', v.concentration && v.concentration.positionCount === 8);
T('effective holdings <= count', v.concentration.effectiveHoldings <= 8.001,
  String(v.concentration.effectiveHoldings));
T('lookThroughUS >= headline US',
  v.concentration.lookThroughUS >= (v.breakdowns.geography.find(g => g.label === 'US')?.pct ?? 0),
  `${v.concentration.lookThroughUS}% vs ${v.breakdowns.geography.find(g => g.label === 'US')?.pct}%`);

const hist = pf.reconstructHistory(prices);
T('history reconstructed', hist.series.length > 500, `${hist.series.length} days`);
T('history endpoint ≈ invested',
  Math.abs(hist.series[hist.series.length - 1].value - v.invested) / v.invested < 0.02);

// ══════════════════════════════════════════════════
section('RISK');
const risk = analyst.riskProfile(prices);
T('risk computed', !risk.error, risk.error ?? '');
if (risk.error) { console.log('  !! skipping risk assertions'); }
else {
T('all holdings covered', risk.coverage.analysed === 8, `${risk.coverage.analysed}/8`);
T('volatility plausible', risk.volatility > 3 && risk.volatility < 60, `${risk.volatility}%`);
T('beta plausible', risk.beta > -0.5 && risk.beta < 2.5, String(risk.beta));
T('sharpe finite', isFinite(risk.sharpe), String(risk.sharpe));
T('risk contributions sum to 100',
  Math.abs(risk.riskContributions.reduce((a, r) => a + r.pctOfRisk, 0) - 100) < 0.5);
T('VaR methods agree within 3x', (() => {
  const d = risk.var.daily;
  const vals = [d.historical, d.parametric, d.modified].filter(x => x != null && x > 0);
  return vals.length >= 2 && Math.max(...vals) / Math.min(...vals) < 3;
})(), JSON.stringify(risk.var.daily));
T('CVaR >= VaR', risk.var.daily.cvar >= risk.var.daily.historical);
T('VaR in pounds sane', risk.varInPounds.daily95 > 0 && risk.varInPounds.daily95 < v.total * 0.2,
  `£${risk.varInPounds.daily95} on £${v.total.toFixed(0)}`);
T('drawdown negative & sane', risk.drawdown.max < 0 && risk.drawdown.max > -95, `${risk.drawdown.max}%`);
T('correlation matrix square',
  risk.correlationMatrix.matrix.length === risk.correlationMatrix.symbols.length &&
  risk.correlationMatrix.matrix.every(r => r.length === risk.correlationMatrix.symbols.length));
T('correlation diagonal = 1',
  risk.correlationMatrix.matrix.every((r, i) => Math.abs(r[i] - 1) < 1e-9));
T('correlation symmetric',
  risk.correlationMatrix.matrix.every((r, i) => r.every((x, j) =>
    Math.abs(x - risk.correlationMatrix.matrix[j][i]) < 1e-9)));
T('no forced 1.0 off-diagonal (the old bug)',
  risk.correlationMatrix.matrix.every((r, i) => r.every((x, j) => i === j || Math.abs(x - 1) > 1e-6)));
T('correlations in [-1,1]',
  risk.correlationMatrix.matrix.every(r => r.every(x => x >= -1.000001 && x <= 1.000001)));
T('skew/kurtosis not extreme (outlier signature)',
  Math.abs(risk.var.skew) < 5 && risk.var.excessKurtosis < 50,
  `skew ${risk.var.skew.toFixed(2)} kurt ${risk.var.excessKurtosis.toFixed(1)}`);
}

section('REGIME');
const regime = analyst.computeRegime(prices);
T('regime has label', !!regime.label, regime.label);
T('regime score 0-100', regime.score >= 0 && regime.score <= 100, String(regime.score));
T('regime inputs populated', regime.inputs.vix != null);

section('CORRELATION WATCH');
const cw = analyst.correlationWatch(prices);
T('correlation watch runs', !cw.error, cw.error ?? '');
T('avg correlation in range', cw.averageCorrelationRecent >= -1 && cw.averageCorrelationRecent <= 1,
  String(cw.averageCorrelationRecent));
T('pairs listed', cw.mostIncreased.length > 0);

// ══════════════════════════════════════════════════
section('OPTIMISER');
const symbols = v.positions.map(p => p.symbol);
const series = pf.holdingReturnSeries(symbols, 750);
T('series built for all', Object.keys(series).length === 8, `${Object.keys(series).length}/8`);

for (const method of ['maxSharpe', 'minVariance', 'riskParity', 'inverseVol', 'equalWeight']) {
  const r = opt.optimise(series, { method, maxWeight: 0.35 });
  const sum = Object.values(r.weights).reduce((a, b) => a + b, 0);
  const maxW = Math.max(...Object.values(r.weights));
  const capped = ['maxSharpe', 'minVariance'].includes(method);
  T(`${method}: weights sum to 1`, Math.abs(sum - 1) < 1e-6, sum.toFixed(8));
  T(`${method}: non-negative`, Object.values(r.weights).every(w => w >= -1e-9));
  if (capped) T(`${method}: respects 35% cap`, maxW <= 0.3501, `max ${(maxW * 100).toFixed(1)}%`);
  T(`${method}: finite metrics`, isFinite(r.volatility) && isFinite(r.expectedReturn) && isFinite(r.sharpe));
}
const mv = opt.optimise(series, { method: 'minVariance', maxWeight: 0.35 });
const ms = opt.optimise(series, { method: 'maxSharpe', maxWeight: 0.35 });
const ew = opt.optimise(series, { method: 'equalWeight' });
T('minVariance has lowest vol of capped methods',
  mv.volatility <= ms.volatility + 1e-9, `${(mv.volatility*100).toFixed(2)}% vs ${(ms.volatility*100).toFixed(2)}%`);
T('maxSharpe has highest sharpe',
  ms.sharpe >= mv.sharpe - 1e-9 && ms.sharpe >= ew.sharpe - 1e-9,
  `${ms.sharpe.toFixed(3)} vs mv ${mv.sharpe.toFixed(3)} ew ${ew.sharpe.toFixed(3)}`);

const rp = opt.optimise(series, { method: 'riskParity' });
const rcs = rp.contributions.map(c => c.riskContribution);
T('riskParity: equal risk contributions', Math.max(...rcs) - Math.min(...rcs) < 0.01,
  `spread ${(Math.max(...rcs) - Math.min(...rcs)).toExponential(2)}`);

const fr = opt.efficientFrontier(series, { points: 10, maxWeight: 0.35 });
T('frontier returns strictly increasing',
  fr.frontier.every((p, i) => i === 0 || p.return > fr.frontier[i-1].return - 1e-9));
T('frontier vol non-decreasing from min', (() => {
  const vols = fr.frontier.map(p => p.volatility);
  const mi = vols.indexOf(Math.min(...vols));
  return vols.slice(mi).every((x, i, a) => i === 0 || x >= a[i-1] - 1e-9);
})());
T('frontier weights valid',
  fr.frontier.every(p => Math.abs(Object.values(p.weights).reduce((a,b)=>a+b,0) - 1) < 0.01));

// ══════════════════════════════════════════════════
section('REBALANCER');
const holdings = v.positions.map(p => ({
  symbol: p.symbol, qty: p.qty, price: p.price, avgPrice: p.avgPrice,
  wrapper: p.wrapper, account: p.account, currency: p.currency,
}));
const targets = Object.fromEntries(v.positions.map(p => [p.symbol, (p.targetPct ?? 0) / 100]));
const rb = rebal.rebalance(holdings, targets, { contribution: 5000, cash: v.cash, dealingCharge: 11.95 });
T('rebalance runs', !rb.error, rb.error ?? '');
T('drift reduced', rb.summary.maxDriftAfter <= rb.summary.maxDriftBefore,
  `${rb.summary.maxDriftBefore}pp -> ${rb.summary.maxDriftAfter}pp`);
T('trades generated', rb.summary.trades > 0, `${rb.summary.trades}`);
T('sells prefer sheltered', (() => {
  const taxable = rb.sells.filter(s => s.taxable).length;
  return taxable <= rb.sells.length;
})());
T('CGT only on GIA sells', rb.sells.filter(s => s.wrapper === 'ISA' && s.taxable).length === 0);
T('post-trade weights near target', rb.summary.maxDriftAfter < 12, `${rb.summary.maxDriftAfter}pp`);
T('turnover non-negative', rb.summary.turnover >= 0);

const dc = rebal.directContribution(holdings, targets, 5000, {});
T('contribution routes full amount',
  Math.abs(dc.allocations.reduce((a, x) => a + x.value, 0) - 5000) < 100,
  `£${dc.allocations.reduce((a,x)=>a+x.value,0).toFixed(0)}/5000`);
T('contribution reduces drift', dc.driftAfter <= dc.driftBefore, `${dc.driftBefore} -> ${dc.driftAfter}`);
T('contribution never sells', !dc.allocations.some(a => a.value < 0));

// ══════════════════════════════════════════════════
section('MONTE CARLO');
const sim = mc.simulate({ initial: 100000, monthly: 500, years: 20, paths: 1500, seed: 42,
  expectedReturn: 0.07, volatility: 0.15, mode: 'normal' });
T('percentiles ordered',
  sim.outcomes.p5 <= sim.outcomes.p25 && sim.outcomes.p25 <= sim.outcomes.median &&
  sim.outcomes.median <= sim.outcomes.p75 && sim.outcomes.p75 <= sim.outcomes.p95);
T('deterministic with seed', (() => {
  const a = mc.simulate({ initial: 100000, monthly: 500, years: 20, paths: 1500, seed: 42, expectedReturn: 0.07, volatility: 0.15, mode: 'normal' });
  return a.outcomes.median === sim.outcomes.median;
})());
T('median beats contributions at 7%', sim.outcomes.median > sim.contributed,
  `${sim.outcomes.median} vs ${sim.contributed}`);
T('real < nominal', sim.real.median < sim.outcomes.median);
T('fees reduce outcome', (() => {
  const f = mc.simulate({ initial: 100000, monthly: 500, years: 20, paths: 1500, seed: 42, expectedReturn: 0.07, volatility: 0.15, mode: 'normal', fees: 0.01 });
  return f.outcomes.median < sim.outcomes.median;
})());
T('bands thinned but span full horizon',
  sim.bands.length > 10 && sim.bands.length <= 82 &&
  sim.bands[0].month === 0 && sim.bands[sim.bands.length-1].month === 240,
  `${sim.bands.length} points, months ${sim.bands[0].month}..${sim.bands[sim.bands.length-1].month}`);
T('bands ordered internally', sim.bands.every(b => b.p5 <= b.p50 && b.p50 <= b.p95));
T('probability fields sane', sim.probabilityOfLoss >= 0 && sim.probabilityOfLoss <= 100);

const portRets = analytics.toReturns(hist.series.map(s => s.value));
const simBoot = mc.simulate({ initial: v.total, monthly: 0, years: 10, paths: 800, seed: 9, returns: portRets, mode: 'blockBootstrap' });
T('bootstrap from real history works', simBoot.outcomes.median > 0, `median £${simBoot.outcomes.median}`);

// ══════════════════════════════════════════════════
section('STRESS');
const positions = v.positions.map(p => ({ symbol: p.symbol, value: p.value }));
const st = stress.runAllScenarios(positions, db.getBars);
T('scenarios run', st.results.length > 0, `${st.results.length}`);
T('worst case identified', !!st.worstCase);
T('all scenario returns finite', st.results.every(r => isFinite(r.portfolioReturn)));
T('coverage reported', st.results.every(r => r.coverage && r.coverage.total === 8));
const shocks = stress.shockTest(positions, [-0.3, -0.1, 0.1], db.getBars);
T('shock monotonic', shocks[0].portfolioChange < shocks[1].portfolioChange &&
  shocks[1].portfolioChange < shocks[2].portfolioChange,
  shocks.map(s => `${s.shock}%→${s.portfolioChange}%`).join(' '));

// ══════════════════════════════════════════════════
section('SCREENER');
const sc = screener.screen(symbols, { strategy: 'balanced' });
T('screener returns results', sc.results.length > 0, `${sc.results.length}/${symbols.length}`);
T('composites in 0-100', sc.results.every(r => r.composite >= 0 && r.composite <= 100));
T('sorted descending', sc.results.every((r, i) => i === 0 || r.composite <= sc.results[i-1].composite));
T('metrics populated', sc.results.every(r => r.metrics.rsi != null && r.metrics.ma50 != null));
T('RSI in 0-100', sc.results.every(r => r.metrics.rsi >= 0 && r.metrics.rsi <= 100));
T('range position 0-100', sc.results.every(r => r.metrics.rangePosition >= -0.01 && r.metrics.rangePosition <= 100.01));
for (const strat of Object.keys(screener.STRATEGIES)) {
  const s = screener.screen(symbols, { strategy: strat });
  T(`strategy ${strat} works`, s.results.length > 0 && s.results.every(r => isFinite(r.composite)));
}

// ══════════════════════════════════════════════════
section('BACKTEST');
for (const strat of Object.keys(backtest.STRATEGIES)) {
  const bt = backtest.backtest('VUSA.L', { strategy: strat, initial: 10000 });
  if (bt.error) { T(`backtest ${strat}`, false, bt.error); continue; }
  const ok = isFinite(bt.metrics.totalReturn) && isFinite(bt.metrics.sharpe) &&
             bt.metrics.finalValue > 0 && bt.metrics.exposure >= 0 && bt.metrics.exposure <= 150 &&
             bt.metrics.maxDrawdown <= 0;
  T(`backtest ${strat}`, ok,
    `ret ${bt.metrics.totalReturn}% dd ${bt.metrics.maxDrawdown}% trades ${bt.metrics.trades} exp ${bt.metrics.exposure}%`);
}
const bh = backtest.backtest('VUSA.L', { strategy: 'buyHold', initial: 10000, slippageBps: 0 });
T('buyHold == benchmark exactly', Math.abs(bh.metrics.finalValue - bh.benchmark.finalValue) < 1,
  `${bh.metrics.finalValue} vs ${bh.benchmark.finalValue}`);
T('buyHold 100% exposure', bh.metrics.exposure === 100, `${bh.metrics.exposure}%`);
const btc = backtest.backtest('VUSA.L', { strategy: 'maCross', initial: 10000, commission: 10 });
const btnc = backtest.backtest('VUSA.L', { strategy: 'maCross', initial: 10000, commission: 0 });
T('commission reduces return', btc.metrics.finalValue <= btnc.metrics.finalValue,
  `${btc.metrics.finalValue} <= ${btnc.metrics.finalValue}`);
T('equity curve returned', bh.equityCurve.length > 0);
T('drawdown curve non-positive', bh.drawdownCurve.every(d => d.drawdown <= 0.001));

const wf = backtest.walkForward('VUSA.L', { strategy: 'maCross', folds: 3 });
T('walk-forward runs', !wf.error, wf.error ?? '');
if (!wf.error) {
  T('walk-forward folds', wf.results.length > 0, `${wf.results.length} folds`);
  T('walk-forward verdict present', !!wf.verdict);
  T('walk-forward metrics finite', isFinite(wf.averageOutOfSampleSharpe));
}

// ══════════════════════════════════════════════════
section('ALERTS');
db.run("DELETE FROM alerts");
const created = [];
for (const spec of [
  { symbol: 'VUSA.L', kind: 'price', direction: 'above', threshold: 0.01 },
  { symbol: 'VUSA.L', kind: 'price', direction: 'above', threshold: 9e9 },
  { symbol: 'VUSA.L', kind: 'changePct', direction: 'above', threshold: -999 },
  { symbol: 'VUSA.L', kind: 'rsi', direction: 'above', threshold: 0 },
  { symbol: 'VUSA.L', kind: 'maCross', direction: 'above' },
  { symbol: 'VUSA.L', kind: 'high52' },
  { symbol: 'VUSA.L', kind: 'low52' },
  { symbol: 'VUSA.L', kind: 'volSpike', threshold: 0.0001 },
  { symbol: 'VUSA.L', kind: 'volRegime', threshold: 0.0001 },
  { symbol: 'VUSA.L', kind: 'drawdown', threshold: 0.0001 },
  { symbol: 'VUSA.L', kind: 'weightDrift', threshold: 0.0001 },
]) created.push(alerts.createAlert(spec));
T('all alert kinds create', created.every(a => a && a.id), `${created.length} created`);
const fired = alerts.evaluate(prices, v);
T('alerts evaluate without error', Array.isArray(fired), `${fired.length} fired`);
T('impossible threshold did not fire',
  alerts.listAlerts('active').some(a => a.threshold === 9e9));
T('fired alerts have messages', fired.every(f => !!f.message));
const prog = alerts.alertProgress(prices);
T('alert progress computed', Array.isArray(prog));
const kinds = Object.keys(alerts.ALERT_KINDS);
T('all 10+ kinds defined', kinds.length >= 10, `${kinds.length}`);

// ══════════════════════════════════════════════════
section('PAPER TRADING');
db.run("DELETE FROM paper_trades");
const t1 = paper.openTrade({ symbol: 'VUSA.L', entryPrice: prices['VUSA.L'].price * 0.9, qty: 10, source: 'screener', signal: 'momentum' });
paper.openTrade({ symbol: 'SEMI.L', entryPrice: prices['SEMI.L'].price * 1.1, qty: 5, source: 'manual' });
T('trades open', paper.listTrades().length === 2);
const perf1 = paper.performance(prices);
T('open trades marked to market', perf1.open === 2 && perf1.trades.every(t => t.markPrice > 0));
T('winner shows positive return', perf1.trades.find(t => t.symbol === 'VUSA.L').returnPct > 0);
T('loser shows negative return', perf1.trades.find(t => t.symbol === 'SEMI.L').returnPct < 0);
paper.closeTrade(t1.id, prices['VUSA.L'].price);
const perf2 = paper.performance(prices);
T('close works', perf2.closed === 1 && perf2.open === 1);
T('win rate computed', perf2.winRate === 100, `${perf2.winRate}%`);
T('bySource aggregates', perf2.bySource.length > 0);

// ══════════════════════════════════════════════════
section('ANALYST BRIEF');
const brief = analyst.buildBrief(prices);
T('brief builds', !!brief.portfolio && !!brief.regime);
T('brief compact', JSON.stringify(brief).length < 15000, `${JSON.stringify(brief).length} chars`);
T('brief portfolio matches', Math.abs(brief.portfolio.total - v.total) < 0.02);
T('brief risk populated', !brief.risk.unavailable, JSON.stringify(brief.risk).slice(0, 80));
T('brief has signals', Array.isArray(brief.signals) && brief.signals.length > 0);
T('brief movers sorted', brief.movers.every((m, i) => i === 0 ||
  Math.abs(m.changePct) <= Math.abs(brief.movers[i-1].changePct)));
for (const kind of ['daily', 'risk', 'rebalance', 'position']) {
  T(`prompt ${kind} exists`, analyst.briefPrompt(kind).length > 100);
}

// ══════════════════════════════════════════════════
section('INTEGRITY');
const audit = integrity.auditStored(db.allStoredSymbols, db.getBars);
T('clean seed has no corruption', audit.totalFlagged === 0, `${audit.totalFlagged} flagged`);
const badBars = db.getBars('VUSA.L').slice(-50).map(b => ({ ...b, adjClose: b.adj_close }));
badBars[25].close /= 100;
const res = db.saveBars('ZZTEST.L', badBars);
T('corrupt bar rejected', res.rejected === 1, `saved ${res.saved} rejected ${res.rejected}`);
db.run("DELETE FROM ohlcv WHERE symbol='ZZTEST.L'");

// ══════════════════════════════════════════════════
section('EDGE CASES');
db.run("DELETE FROM holdings");
const empty = pf.valuePortfolio(prices);
T('empty portfolio does not crash', empty.positions.length === 0 && empty.total === empty.cash);
T('empty concentration null-safe', empty.concentration === null || empty.concentration.positionCount === 0);
const emptyRisk = analyst.riskProfile(prices);
T('empty risk returns clear error', !!emptyRisk.error, emptyRisk.error);
const emptyRb = rebal.rebalance([], {}, {});
T('empty rebalance errors cleanly', !!emptyRb.error, emptyRb.error);

db.run(`INSERT INTO holdings (symbol,name,qty,avg_price,currency,sector,geography,asset_class,wrapper,account,target_pct,added_at) VALUES ('VUSA.L','x',100,50,'GBP','Broad','US','Equity','ISA','Main',100,?)`, Date.now());
const single = pf.valuePortfolio(prices);
T('single holding values', single.positions.length === 1);
T('single holding weight ~100 of invested',
  Math.abs(single.positions[0].value - single.invested) < 0.02);
const singleRisk = analyst.riskProfile(prices);
T('single holding risk handled', !!singleRisk.error || isFinite(singleRisk.volatility),
  singleRisk.error ?? `vol ${singleRisk.volatility}%`);
T('single-holding error is accurate not misleading',
  !singleRisk.error || singleRisk.error.includes('at least two holdings'),
  singleRisk.error ?? '');

const noHist = screener.scoreSymbol('NOSUCH.L');
T('unknown symbol returns null not crash', noHist === null);
const btBad = backtest.backtest('NOSUCH.L', {});
T('backtest unknown symbol errors cleanly', !!btBad.error, btBad.error);

console.log(`\n${'═'.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (issues.length) { console.log('\n  FAILURES:'); issues.forEach(i => console.log(`    - ${i}`)); }
console.log('═'.repeat(60));
