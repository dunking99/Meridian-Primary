// Meridian v2 — server
// Zero-dependency HTTP layer (Node's own http module) routing to the engines.
// Run: node server/index.js

import http from 'http';
import { PORT, CADENCE, CORE_SYMBOLS, SYMBOLS, SCENARIOS, WRAPPERS } from './config.js';
import { db, all, one, run, getBars, healthCheck, getSetting, setSetting, recordTicks, getSnapshots, purgeBars, allStoredSymbols } from './db.js';
import { auditStored } from './engines/integrity.js';

import * as yahoo from './sources/yahoo.js';
import { fetchFearAndGreed } from './sources/feargreed.js';
import { refreshNews, getNews, searchLiveNews, titleSignature, jaccard } from './sources/news.js';
import { scoreNewStories, scoringStats, CATEGORIES } from './engines/newsscore.js';
import { hasGeminiKey } from './sources/ai.js';
import * as edgar from './sources/edgar.js';
import { fetchFTFundNav, getCachedFTNav, isValidISIN } from './sources/ft.js';

import * as A from './engines/analytics.js';
import * as opt from './engines/optimiser.js';
import { rebalance, directContribution } from './engines/rebalance.js';
import { simulate, goalProbability } from './engines/montecarlo.js';
import { runAllScenarios, runScenario, shockTest } from './engines/stress.js';
import * as pf from './engines/portfolio.js';
import { screen, scoreSymbol, STRATEGIES as SCREEN_STRATEGIES } from './engines/screener.js';
import { backtest, walkForward, STRATEGIES as BT_STRATEGIES } from './engines/backtest.js';
import * as paper from './engines/paper.js';
import * as alerts from './engines/alerts.js';
import * as analyst from './engines/analyst.js';
import * as memory from './engines/memory.js';
import * as calendar from './engines/calendar.js';

// ─── Shared state ─────────────────────────────────────────────

const state = {
  prices: {},
  fearGreed: null,
  lastFetch: 0,
  lastNews: 0,
  lastNewsFailed: [],
  fired: [],
  status: 'starting',
  errors: [],
};

function trackedSymbols() {
  const held = all('SELECT DISTINCT symbol FROM holdings').map(r => r.symbol);
  const watched = all('SELECT DISTINCT symbol FROM watchlist').map(r => r.symbol);
  return [...new Set([...CORE_SYMBOLS, ...held, ...watched])];
}

// ─── Refresh loops ────────────────────────────────────────────

async function refreshPrices() {
  const symbols = trackedSymbols();
  const t0 = Date.now();
  const fresh = await yahoo.fetchQuotes(symbols);
  const n = Object.keys(fresh).length;

  if (n > 0) {
    state.prices = { ...state.prices, ...fresh };
    state.lastFetch = Date.now();
    recordTicks(fresh);

    const portfolio = pf.valuePortfolio(state.prices);
    const fired = alerts.evaluate(state.prices, portfolio);
    if (fired.length) {
      state.fired = [...fired, ...state.fired].slice(0, 50);
      for (const f of fired) console.log(`  ALERT  ${f.message}`);
    }
    paper.markToMarket(state.prices);
  }

  const missing = symbols.filter(s => !state.prices[s]);
  console.log(`[${new Date().toLocaleTimeString()}] prices ${n}/${symbols.length} in ${Date.now() - t0}ms` +
              (missing.length ? `  missing: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}` : ''));
  state.status = n > 0 ? 'live' : 'degraded';
}

async function refreshFearGreed() {
  const fg = await fetchFearAndGreed();
  if (fg) { state.fearGreed = fg; console.log(`  fear & greed ${fg.score} (${fg.rating})`); }
}

let newsRefreshInFlight = false;

async function refreshNewsFeed() {
  // With ~47 feeds fetched serially, a slow run can approach the 10-minute
  // cadence itself — guard against the next scheduled tick starting a second
  // pass on top of one still in progress.
  if (newsRefreshInFlight) return;
  newsRefreshInFlight = true;
  try {
    const held = all('SELECT DISTINCT symbol, name FROM holdings').map(r => ({ symbol: r.symbol, name: r.name }));
    const r = await refreshNews(held);
    state.lastNews = Date.now();
    state.lastNewsFailed = r.failed;
    console.log(`  news +${r.added}` +
                (r.duplicates ? `  (${r.duplicates} dupes)` : '') +
                (r.failed.length ? `  failed ${r.failedCount}/${r.sources}: ${r.failed.join(', ')}` : ''));

    // Score whatever arrived. Bounded per cycle and safe to fail — unscored
    // stories fall back to heuristic ranking and get picked up next time.
    if (hasGeminiKey()) {
      const universe = trackedSymbols();
      const s = await scoreNewStories(universe);
      if (s.scored || s.skipped) {
        console.log(`  news AI scored ${s.scored}` +
                    (s.skipped ? `, skipped ${s.skipped}${s.reason ? ` (${s.reason})` : ''}` : ''));
      }
    }
  } finally {
    newsRefreshInFlight = false;
  }
}

function snapshot() {
  if (!Object.keys(state.prices).length) return;
  try { pf.takeSnapshot(state.prices); } catch (e) { console.log('  snapshot failed:', e.message); }
}

// ─── Router ───────────────────────────────────────────────────

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise(resolve => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(c).toString() || '{}')); }
      catch { resolve({}); }
    });
  });
}

const routes = {

  // ── status & data ──────────────────────────────────────────
  'GET /': () => ({
    status: 'Meridian v2 proxy running', port: PORT,
    dataStatus: state.status, symbols: trackedSymbols().length,
    lastFetch: state.lastFetch, db: healthCheck(),
  }),

  'GET /health': () => ({ ...healthCheck(), status: state.status, lastFetch: state.lastFetch, errors: state.errors.slice(-5) }),

  'GET /prices': () => ({
    prices: state.prices, lastFetch: state.lastFetch,
    count: Object.keys(state.prices).length, status: state.status,
  }),

  'GET /feargreed': () => state.fearGreed ?? {},

  'GET /symbols': () => ({
    tracked: trackedSymbols(),
    core: CORE_SYMBOLS,
    meta: SYMBOLS,
    coverage: all('SELECT symbol, COUNT(*) bars, MIN(date) first, MAX(date) last FROM ohlcv GROUP BY symbol ORDER BY symbol'),
  }),

  'GET /history': q => {
    const bars = getBars(q.symbol, q.from || null, q.to || null);
    return { symbol: q.symbol, bars: bars.length, data: bars };
  },

  // Closing prices for many symbols at once, for sparklines. The Markets page
  // draws ~35 of them; one request per symbol would mean 35 round trips on
  // every page load. Only closes are returned — a sparkline needs nothing
  // else, and full OHLCV rows would bloat the payload several times over.
  'GET /history/batch': q => {
    const symbols = String(q.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 80);
    const days = Math.min(Math.max(Number(q.days) || 60, 5), 400);
    // Calendar days back, not trading days — markets are shut ~2/7 of the
    // time, so this deliberately over-reaches and lets the data decide.
    const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    // getBars only applies its date filter when BOTH bounds are given — pass
    // `from` alone and it silently returns the symbol's entire history, which
    // for a 12-year store is thousands of bars per symbol. `to` is set a day
    // ahead so a bar stamped today is never cut off by a timezone boundary.
    const to = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const series = {};
    for (const sym of symbols) {
      const closes = getBars(sym, from, to)
        .map(b => b.close)
        .filter(c => typeof c === 'number' && Number.isFinite(c));
      // A lone point can't be drawn as a line — treat it as no history.
      if (closes.length > 1) series[sym] = closes;
    }
    return { days, from, to, series };
  },

  'POST /sync': async body => {
    const symbols = body.symbols?.length ? body.symbols : trackedSymbols();
    console.log(`  syncing history for ${symbols.length} symbols…`);
    const r = await yahoo.syncAll(symbols, { years: body.years ?? 12, force: !!body.force });
    // New bars mean the derived memory is stale. Rebuilding is idempotent and
    // costs about a second, so it happens here rather than being something to
    // remember to trigger.
    const mem = memory.rebuild();
    return { ...r, memory: { observations: mem.observations, regimeDays: mem.regime?.dates ?? 0 } };
  },

  // ── memory: what changed, not what is ──────────────────────
  'GET /changes': q => memory.whatChanged({
    limit: Math.min(Number(q.limit) || 12, 40),
    zThreshold: Number(q.z) || 1.5,
  }),

  'GET /memory': () => memory.memoryStats(),
  'GET /memory/latest': q => ({
    observations: memory.latestFor(
      String(q.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 200)),
  }),
  'GET /leadership': q => memory.leadership({ window: Number(q.window) || 21 }),

  // ── calendar ───────────────────────────────────────────────
  'GET /calendar': q => calendar.buildCalendar({ days: Math.min(Number(q.days) || 120, 400) }),
  'POST /calendar/refresh': async body => {
    const symbols = [...new Set([
      ...all('SELECT DISTINCT symbol FROM holdings').map(r => r.symbol),
      ...all('SELECT DISTINCT symbol FROM watchlist').map(r => r.symbol),
    ])];
    const r = await calendar.refreshCorporateDates(symbols, { force: !!body?.force });
    return { ...r, ...calendar.buildCalendar({ days: Math.min(Number(body?.days) || 120, 400) }) };
  },
  'GET /relationships': q => memory.correlationShifts({ window: Number(q.window) || 60 }),
  'GET /memory/regime': q => ({ series: memory.regimeHistory({ days: Number(q.days) || 252 }) }),
  'GET /memory/symbol': q => ({
    symbol: q.symbol,
    series: memory.symbolHistory(q.symbol, { days: Number(q.days) || 260 }),
  }),
  'POST /memory/rebuild': body => memory.rebuild({ symbols: body?.symbols ?? null }),

  'GET /quote': async q => await yahoo.fetchSummary(q.symbol),
  'GET /search': async q => ({ query: q.q, results: await yahoo.search(q.q) }),

  'GET /integrity': () => auditStored(allStoredSymbols, getBars),

  'POST /integrity/repair': async body => {
    const audit = auditStored(allStoredSymbols, getBars);
    if (!audit.totalFlagged) return { ok: true, message: 'No corruption found. Nothing to repair.', audit };

    // Purge every flagged date, then re-fetch it. Systemic dates (affecting
    // several symbols at once) are purged across all symbols, because that
    // pattern means a write-side fault rather than isolated bad source data.
    const dates = body?.dates?.length
      ? body.dates
      : [...new Set(audit.findings.flatMap(f => f.dates))];

    let purged = 0;
    for (const d of dates) purged += purgeBars(d);

    const affected = [...new Set(audit.findings.map(f => f.symbol))];
    const resync = await yahoo.syncAll(affected, { years: 12, force: false });

    const after = auditStored(allStoredSymbols, getBars);
    return {
      ok: true,
      purgedRows: purged,
      datesRepaired: dates,
      symbolsResynced: affected.length,
      resyncFailed: resync.failed,
      before: { flagged: audit.totalFlagged, symbols: audit.symbolsAffected },
      after: { flagged: after.totalFlagged, symbols: after.symbolsAffected },
      verdict: after.totalFlagged === 0
        ? 'All corruption cleared.'
        : `${after.totalFlagged} anomalies remain — likely genuine source-data glitches rather than unit errors.`,
    };
  },


  // ── portfolio ──────────────────────────────────────────────
  'GET /portfolio': () => pf.valuePortfolio(state.prices),

  'GET /portfolio/history': q =>
    pf.reconstructHistory(state.prices, Number(q.lookback) || 750),

  'GET /portfolio/history/holdings': q =>
    pf.reconstructHistoryByHolding(state.prices, Number(q.lookback) || 750),

  'GET /portfolio/snapshots': () => ({ snapshots: getSnapshots() }),

  'GET /holdings': () => {
    const rows = all('SELECT * FROM holdings ORDER BY symbol');
    return {
      holdings: rows,
      count: rows.length,
      coverage: rows.map(h => {
        const c = one('SELECT COUNT(*) n, MIN(date) first, MAX(date) last FROM ohlcv WHERE symbol = ?', h.symbol);
        return {
          symbol: h.symbol,
          bars: c?.n ?? 0,
          first: c?.first ?? null,
          last: c?.last ?? null,
          analysable: (c?.n ?? 0) >= 30,
        };
      }),
    };
  },

  'POST /holdings': async body => {
    if (!body.symbol) return { error: 'symbol is required.' };
    const symbol = String(body.symbol).toUpperCase().trim();
    if (body.isin) {
      body.isin = String(body.isin).trim().toUpperCase();
      if (!isValidISIN(body.isin)) {
        return { error: `"${body.isin}" is not a valid ISIN — expected exactly 12 characters (e.g. GB00BN08ZR66). Don't include a Yahoo-style suffix like ".L".` };
      }
    }

    // Duplicate protection. The original blind INSERT let the same holding be
    // added repeatedly, which produced 15 rows for 5 positions and silently
    // tripled portfolio weights. Same symbol in the same account and wrapper is
    // now treated as an update, not a second position.
    const existing = one(
      'SELECT * FROM holdings WHERE symbol = ? AND account = ? AND wrapper = ?',
      symbol, body.account ?? 'Main', body.wrapper ?? 'ISA'
    );

    if (existing && !body.allowDuplicate) {
      run(`UPDATE holdings SET qty = ?, avg_price = ?, sector = ?, geography = ?,
           asset_class = ?, target_pct = ?, thesis = ?, name = ?, link = ?, isin = ?, exchange = ? WHERE id = ?`,
          body.qty ?? existing.qty, body.avgPrice ?? existing.avg_price,
          body.sector ?? existing.sector, body.geography ?? existing.geography,
          body.assetClass ?? existing.asset_class, body.targetPct ?? existing.target_pct,
          body.thesis ?? existing.thesis, body.name ?? existing.name,
          body.link ?? existing.link, body.isin ?? existing.isin,
          body.exchange ?? existing.exchange, existing.id);
      return {
        ok: true, action: 'updated', id: existing.id,
        message: `${symbol} already existed in ${existing.wrapper}/${existing.account} — updated rather than duplicated.`,
        holdings: pf.listHoldings(),
      };
    }

    const { lastInsertRowid } = run(`INSERT INTO holdings (symbol, name, qty, avg_price, currency, sector, geography,
         asset_class, account, wrapper, acc_dist, link, target_pct, thesis, isin, exchange, added_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        symbol, body.name ?? null, body.qty ?? 0, body.avgPrice ?? 0,
        body.currency ?? 'GBP', body.sector ?? null, body.geography ?? null,
        body.assetClass ?? 'Equity', body.account ?? 'Main', body.wrapper ?? 'ISA',
        body.accDist ?? null, body.link ?? null, body.targetPct ?? null,
        body.thesis ?? null, body.isin ?? null, body.exchange ?? null, Date.now());

    // A raw ticker like "0P0000WN7J.L" means nothing to a human — resolve its
    // real name and listing venue from Yahoo unless the caller already
    // supplied one, same "fill in what the user didn't have to type" spirit
    // as the auto-sync below.
    if (!body.name) {
      const resolved = await yahoo.resolveNameAndExchange(symbol);
      if (resolved.name || resolved.exchange) {
        run('UPDATE holdings SET name = COALESCE(?, name), exchange = COALESCE(?, exchange) WHERE id = ?',
            resolved.name ?? null, resolved.exchange ?? null, lastInsertRowid);
      }
    }

    // Auto-sync history if we have none. Without this a new holding shows a
    // live price but is invisible to Risk, Optimiser and Backtest until a
    // manual sync is run — a gap that made "add a holding and it just works"
    // untrue in practice.
    const cov = one('SELECT COUNT(*) n FROM ohlcv WHERE symbol = ?', symbol);
    let sync = null;
    if ((cov?.n ?? 0) < 30) {
      console.log(`  new symbol ${symbol}: fetching history…`);
      sync = await yahoo.syncHistory(symbol, { years: 12 });
      if (sync.error) {
        console.log(`  ⚠ ${symbol}: history fetch failed — ${sync.error}`);
      } else {
        console.log(`  ${symbol}: ${sync.added} bars stored${sync.rejected ? `, ${sync.rejected} rejected` : ''}`);
      }
      await refreshPrices();
    }

    // Yahoo has no coverage for some HL "Class S" funds. If an ISIN was
    // given, prime the FT fallback cache now so the holding has a price
    // immediately rather than waiting on a later manual /fund-nav call.
    let ftNav = null;
    if (body.isin && sync?.error) {
      console.log(`  ${symbol}: no Yahoo history — trying FT fallback for ${body.isin}…`);
      ftNav = await fetchFTFundNav(body.isin, body.currency ?? 'GBP');
      if (ftNav?.error) console.log(`  ⚠ FT fallback failed: ${ftNav.error}`);
      else console.log(`  ${symbol}: FT fallback price £${ftNav.price}`);
    }

    return {
      ok: true, action: 'created', symbol,
      historySynced: sync ? { bars: sync.added ?? 0, rejected: sync.rejected ?? 0, error: sync.error ?? null } : 'already had history',
      ftFallback: ftNav,
      holdings: pf.listHoldings(),
    };
  },

  'PUT /holdings': body => {
    if (body.isin) {
      body.isin = String(body.isin).trim().toUpperCase();
      if (!isValidISIN(body.isin)) {
        return { error: `"${body.isin}" is not a valid ISIN — expected exactly 12 characters (e.g. GB00BN08ZR66). Don't include a Yahoo-style suffix like ".L".` };
      }
    }
    const fields = { qty: 'qty', avgPrice: 'avg_price', sector: 'sector', geography: 'geography',
                     assetClass: 'asset_class', account: 'account', wrapper: 'wrapper',
                     targetPct: 'target_pct', thesis: 'thesis', name: 'name', link: 'link', isin: 'isin',
                     exchange: 'exchange' };
    for (const [k, col] of Object.entries(fields)) {
      if (body[k] !== undefined) run(`UPDATE holdings SET ${col} = ? WHERE id = ?`, body[k], body.id);
    }
    return { ok: true, holdings: pf.listHoldings() };
  },

  'DELETE /holdings': q => { run('DELETE FROM holdings WHERE id = ?', Number(q.id)); return { ok: true }; },

  // Backfills name + exchange for existing holdings — the same lookup a new
  // holding gets automatically on POST /holdings, run retroactively. Scope
  // with body.symbols to target specific rows (e.g. after fixing bad data);
  // omit it to sweep everything with a missing name; body.force also
  // re-resolves rows that already have a name, e.g. after a corporate rename.
  'POST /holdings/refresh-names': async body => {
    const targets = body?.symbols?.length
      ? all(`SELECT DISTINCT symbol FROM holdings WHERE symbol IN (${body.symbols.map(() => '?').join(',')})`, ...body.symbols.map(s => String(s).toUpperCase()))
      : body?.force
        ? all('SELECT DISTINCT symbol FROM holdings')
        : all('SELECT DISTINCT symbol FROM holdings WHERE name IS NULL OR exchange IS NULL');
    const symbols = targets.map(r => r.symbol);
    if (!symbols.length) return { ok: true, resolved: 0, message: 'Nothing to resolve.' };

    const resolved = await yahoo.resolveNamesAndExchanges(symbols);
    let updated = 0;
    const failed = [];
    for (const symbol of symbols) {
      const r = resolved[symbol];
      if (!r || (!r.name && !r.exchange)) { failed.push(symbol); continue; }
      run('UPDATE holdings SET name = COALESCE(?, name), exchange = COALESCE(?, exchange) WHERE symbol = ?',
          r.name ?? null, r.exchange ?? null, symbol);
      updated++;
    }
    return { ok: true, resolved: updated, failed, holdings: pf.listHoldings() };
  },

  'POST /cash': body => {
    run(`INSERT INTO cash (account, wrapper, currency, amount, updated_at) VALUES (?,?,?,?,?)`,
        body.account ?? 'Main', body.wrapper ?? 'ISA', body.currency ?? 'GBP', body.amount ?? 0, Date.now());
    return { ok: true, cash: pf.listCash() };
  },

  'PUT /cash': body => {
    const cols = { account: 'account', wrapper: 'wrapper', currency: 'currency', amount: 'amount' };
    for (const [k, col] of Object.entries(cols)) {
      if (body[k] !== undefined) run(`UPDATE cash SET ${col} = ? WHERE id = ?`, body[k], body.id);
    }
    run('UPDATE cash SET updated_at = ? WHERE id = ?', Date.now(), body.id);
    return { ok: true, cash: pf.listCash() };
  },

  'DELETE /cash': q => { run('DELETE FROM cash WHERE id = ?', Number(q.id)); return { ok: true }; },

  'POST /transactions': body => {
    run(`INSERT INTO transactions (symbol, date, side, qty, price, fees, currency, account, wrapper, note)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        body.symbol, body.date, body.side, body.qty, body.price, body.fees ?? 0,
        body.currency ?? 'GBP', body.account ?? 'Main', body.wrapper ?? 'ISA', body.note ?? null);
    return { ok: true };
  },

  'GET /transactions': () => ({ transactions: all('SELECT * FROM transactions ORDER BY date DESC') }),

  // ── risk & analytics ───────────────────────────────────────
  'GET /risk': q => analyst.riskProfile(state.prices, {
    confidence: Number(q.confidence) || 0.95,
    lookback: Number(q.lookback) || 750,
  }),

  'GET /regime': () => analyst.computeRegime(state.prices),

  'GET /correlations': q => analyst.correlationWatch(state.prices, { window: Number(q.window) || 60 }),

  'GET /stress': () => {
    const v = pf.valuePortfolio(state.prices);
    const positions = v.positions.filter(p => p.value > 0).map(p => ({ symbol: p.symbol, value: p.value }));
    if (!positions.length) return { error: 'No holdings to stress test.' };
    return runAllScenarios(positions, getBars);
  },

  'POST /stress/shock': body => {
    const v = pf.valuePortfolio(state.prices);
    const positions = v.positions.filter(p => p.value > 0).map(p => ({ symbol: p.symbol, value: p.value }));
    return { shocks: shockTest(positions, body.shocks ?? [-0.3, -0.2, -0.1, -0.05, 0.05, 0.1], getBars) };
  },

  'GET /scenarios': () => ({ scenarios: SCENARIOS }),

  // ── optimisation & planning ────────────────────────────────
  'POST /optimise': body => {
    const symbols = body.symbols?.length
      ? body.symbols
      : pf.listHoldings().map(h => h.symbol);
    const series = pf.holdingReturnSeries([...new Set(symbols)], body.lookback ?? 750);
    return opt.optimise(series, {
      method: body.method ?? 'maxSharpe',
      maxWeight: body.maxWeight ?? 0.35,
      minWeight: body.minWeight ?? 0,
      rf: body.riskFree ?? 0.04,
      shrinkage: body.shrinkage ?? 0.2,
      expectedReturns: body.expectedReturns ?? null,
    });
  },

  'POST /frontier': body => {
    const symbols = body.symbols?.length ? body.symbols : pf.listHoldings().map(h => h.symbol);
    const series = pf.holdingReturnSeries([...new Set(symbols)], body.lookback ?? 750);
    return opt.efficientFrontier(series, {
      points: body.points ?? 25, maxWeight: body.maxWeight ?? 0.35,
      shrinkage: body.shrinkage ?? 0.2, rf: body.riskFree ?? 0.04,
    });
  },

  'POST /rebalance': body => {
    const v = pf.valuePortfolio(state.prices);
    const holdings = v.positions.filter(p => p.hasPrice).map(p => ({
      symbol: p.symbol, qty: p.qty, price: p.price, avgPrice: p.avgPrice,
      wrapper: p.wrapper, account: p.account, currency: p.currency,
    }));
    const targets = body.targets ?? Object.fromEntries(
      v.positions.filter(p => p.targetPct != null).map(p => [p.symbol, p.targetPct / 100]));
    return rebalance(holdings, targets, {
      contribution: body.contribution ?? 0,
      cash: body.useCash === false ? 0 : v.cash,
      tolerance: body.tolerance ?? 0.02,
      minTradeValue: body.minTradeValue ?? 50,
      cgtBand: body.cgtBand ?? 'higher',
      cgtUsed: body.cgtUsed ?? 0,
      allowSelling: body.allowSelling !== false,
      dealingCharge: body.dealingCharge ?? 0,
    });
  },

  'POST /contribute': body => {
    const v = pf.valuePortfolio(state.prices);
    const holdings = v.positions.filter(p => p.hasPrice).map(p => ({
      symbol: p.symbol, qty: p.qty, price: p.price, avgPrice: p.avgPrice,
      wrapper: p.wrapper, account: p.account,
    }));
    const targets = body.targets ?? Object.fromEntries(
      v.positions.filter(p => p.targetPct != null).map(p => [p.symbol, p.targetPct / 100]));
    return directContribution(holdings, targets, body.amount ?? 0, {});
  },

  'POST /montecarlo': body => {
    let returns = null;
    if (body.usePortfolioHistory !== false) {
      const hist = pf.reconstructHistory(state.prices, 1500);
      if (hist.series.length > 100) returns = A.toReturns(hist.series.map(s => s.value));
    }
    return simulate({
      initial: body.initial ?? pf.valuePortfolio(state.prices).total,
      monthly: body.monthly ?? 0,
      years: body.years ?? 20,
      returns, mode: body.mode ?? (returns ? 'blockBootstrap' : 'normal'),
      expectedReturn: body.expectedReturn ?? null,
      volatility: body.volatility ?? null,
      paths: Math.min(body.paths ?? 5000, 20000),
      inflation: body.inflation ?? 0.025,
      fees: body.fees ?? 0,
      seed: body.seed ?? 12345,
    });
  },

  'POST /goal': body => goalProbability({
    target: body.target ?? 100000,
    initial: body.initial ?? pf.valuePortfolio(state.prices).total,
    monthly: body.monthly ?? 0, years: body.years ?? 20,
    expectedReturn: body.expectedReturn ?? 0.07, volatility: body.volatility ?? 0.15,
    mode: 'normal', paths: 4000,
  }),

  // ── screener & backtest ────────────────────────────────────
  'GET /screener/strategies': () => ({ screener: SCREEN_STRATEGIES, backtest: BT_STRATEGIES }),

  'POST /screen': body => {
    const universe = body.symbols?.length ? body.symbols : trackedSymbols();
    return screen(universe, {
      strategy: body.strategy ?? 'balanced',
      minScore: body.minScore ?? 0,
      limit: body.limit ?? 50,
    });
  },

  'GET /score': q => scoreSymbol(q.symbol, { strategy: q.strategy ?? 'balanced' })
                     ?? { error: `Not enough stored history for ${q.symbol}. Run POST /sync.` },

  'POST /backtest': body => backtest(body.symbol, {
    strategy: body.strategy ?? 'maCross', params: body.params ?? {},
    initial: body.initial ?? 10000, commission: body.commission ?? 0,
    slippageBps: body.slippageBps ?? 5, from: body.from ?? null, to: body.to ?? null,
  }),

  'POST /walkforward': body => walkForward(body.symbol, {
    strategy: body.strategy ?? 'maCross', folds: body.folds ?? 5,
    initial: body.initial ?? 10000,
  }),

  // ── alerts ─────────────────────────────────────────────────
  'GET /alerts': q => ({
    alerts: alerts.listAlerts(q.status ?? null),
    progress: alerts.alertProgress(state.prices),
    recentlyFired: state.fired.slice(0, 20),
    kinds: alerts.ALERT_KINDS,
  }),
  'POST /alerts': body => alerts.createAlert(body),
  'PUT /alerts': body => alerts.updateAlert(body.id, body.status),
  'DELETE /alerts': q => { alerts.deleteAlert(Number(q.id)); return { ok: true }; },

  // ── watchlist ──────────────────────────────────────────────
  'GET /watchlist': () => ({ watchlist: all('SELECT * FROM watchlist ORDER BY tier, symbol') }),
  'POST /watchlist': body => {
    run(`INSERT OR REPLACE INTO watchlist (symbol, tier, note, target, added_at) VALUES (?,?,?,?,?)`,
        body.symbol, body.tier ?? 3, body.note ?? null, body.target ?? null, Date.now());
    return { ok: true, watchlist: all('SELECT * FROM watchlist ORDER BY tier, symbol') };
  },
  'DELETE /watchlist': q => { run('DELETE FROM watchlist WHERE id = ?', Number(q.id)); return { ok: true }; },

  // ── paper trading ──────────────────────────────────────────
  'GET /paper': () => paper.performance(state.prices),
  'POST /paper': body => paper.openTrade(body),
  'PUT /paper': body => paper.closeTrade(body.id, body.exitPrice ?? state.prices[body.symbol]?.price),
  'DELETE /paper': q => { paper.deleteTrade(Number(q.id)); return { ok: true }; },

  // ── news ───────────────────────────────────────────────────
  'GET /news': q => {
    const held = all('SELECT DISTINCT symbol FROM holdings').map(r => r.symbol);
    const watched = all('SELECT DISTINCT symbol FROM watchlist').map(r => r.symbol);
    return {
      news: getNews({
        limit: Number(q.limit) || 60,
        symbol: q.symbol || null,
        source: q.source || null,
        since: q.since ? Number(q.since) : null,
        sort: q.sort === 'newest' ? 'newest' : 'smart',
        minRelevance: Number(q.minRelevance) || 0,
        category: q.category || null,
        includeDupes: q.includeDupes === '1',
        held, watched,
      }),
      lastRefresh: state.lastNews,
      failedFeeds: state.lastNewsFailed,
      categories: CATEGORIES,
      ai: { enabled: hasGeminiKey(), ...scoringStats() },
    };
  },
  'POST /news/refresh': async () => await refreshNewsFeed() ?? { ok: true },

  // Research page: news for one arbitrary ticker. `symbol` filters the
  // standing tagged feed (only hits if it's in SYMBOLS/holdings/watchlist);
  // `query` (defaults to symbol) additionally runs a live per-ticker search so
  // an untracked name still returns something. Cross-source duplicates are
  // dropped with the same title-similarity check the ingest pipeline uses,
  // just at a looser threshold since a wire headline and an aggregator's
  // rendering of the same story are worded less identically than two RSS
  // feeds carrying the same wire copy.
  'GET /research/news': async q => {
    const symbol = q.symbol ? String(q.symbol).toUpperCase().trim() : null;
    const queryText = String(q.query ?? symbol ?? '').trim();
    const limit = Math.min(Number(q.limit) || 30, 60);

    const held = all('SELECT DISTINCT symbol FROM holdings').map(r => r.symbol);
    const watched = all('SELECT DISTINCT symbol FROM watchlist').map(r => r.symbol);
    const feed = symbol ? getNews({ symbol, limit: 30, sort: 'smart', held, watched }) : [];

    let live = [];
    if (queryText) {
      const raw = await searchLiveNews(queryText, { limit: 20 });
      const feedSigs = feed.map(f => titleSignature(f.title));
      live = raw.filter(l => {
        const sig = titleSignature(l.title);
        return !feedSigs.some(fs => jaccard(sig, fs) >= 0.5);
      });
    }

    const combined = [...feed.map(f => ({ ...f, live: false })), ...live]
      .sort((a, b) => (b.published ?? 0) - (a.published ?? 0))
      .slice(0, limit);

    return { symbol, query: queryText, feedCount: feed.length, liveCount: live.length, news: combined };
  },

  // Score on demand — lets the user fill in a backlog without waiting for the
  // next 10-minute cycle (e.g. right after first pasting their API key).
  'POST /news/score': async body => {
    if (!hasGeminiKey()) return { ok: false, error: 'No Gemini API key set. Add one in Settings.' };
    const r = await scoreNewStories(trackedSymbols(), {
      maxPerCycle: Math.min(Number(body?.limit) || 40, 120),
    });
    return { ok: true, ...r, ...scoringStats() };
  },

  // The Gemini key lives in the browser's localStorage, but scoring runs on
  // the refresh loop with no browser attached — the frontend pushes it here
  // so the backend can score unattended.
  'GET /settings/ai': () => ({ enabled: hasGeminiKey(), ...scoringStats() }),
  'POST /settings/ai': body => {
    const key = String(body?.key ?? '').trim();
    setSetting('gemini_key', key);
    return { ok: true, enabled: key.length > 0 };
  },

  // ── SEC EDGAR ──────────────────────────────────────────────
  'GET /insiders': async q => {
    const cached = edgar.getInsiders(q.symbol);
    if (cached.length && !q.refresh) return { symbol: q.symbol, filings: cached, cached: true };
    const r = await edgar.syncInsiders(q.symbol);
    return { ...r, filings: edgar.getInsiders(q.symbol) };
  },
  'GET /filings': async q => await edgar.fetchFilings(q.symbol, { type: q.type ?? '4', limit: 25 }),

  // ── FT fund NAV fallback (for funds Yahoo has no data for) ──
  'GET /fund-nav': async q => {
    if (!q.isin) return { error: 'isin is required' };
    const cleanIsin = q.isin.trim().toUpperCase();
    if (!isValidISIN(cleanIsin)) {
      return { error: `"${q.isin}" is not a valid ISIN — expected 12 characters (e.g. GB00BN08ZR66), not a Yahoo-style ticker.` };
    }
    const cached = getCachedFTNav(cleanIsin);
    if (cached && !q.refresh) return cached;
    return await fetchFTFundNav(cleanIsin, q.currency || 'GBP');
  },

  // ── AI analyst ─────────────────────────────────────────────
  'GET /brief': q => ({
    brief: analyst.buildBrief(state.prices, { includeScreen: q.screen !== 'false' }),
    prompt: analyst.briefPrompt(q.kind ?? 'daily'),
  }),

  'GET /ai/notes': () => ({ notes: all('SELECT * FROM ai_notes ORDER BY ts DESC LIMIT 50') }),
  'POST /ai/notes': body => {
    run('INSERT INTO ai_notes (ts, kind, subject, body, context) VALUES (?,?,?,?,?)',
        Date.now(), body.kind ?? 'note', body.subject ?? null, body.body,
        body.context ? JSON.stringify(body.context) : null);
    return { ok: true };
  },

  // ── settings ───────────────────────────────────────────────
  'GET /settings': () => ({
    settings: Object.fromEntries(all('SELECT key, value FROM settings').map(r => {
      try { return [r.key, JSON.parse(r.value)]; } catch { return [r.key, r.value]; }
    })),
    wrappers: WRAPPERS,
  }),
  'POST /settings': body => {
    for (const [k, v] of Object.entries(body)) setSetting(k, v);
    return { ok: true };
  },
};

// ─── Server ───────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];

  if (!handler) {
    return json(res, 404, {
      error: `No route ${key}`,
      available: Object.keys(routes).sort(),
    });
  }

  try {
    const query = Object.fromEntries(url.searchParams);
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : null;
    const result = await handler(body ?? query, query);
    json(res, 200, result ?? {});
  } catch (e) {
    state.errors.push({ at: Date.now(), route: key, message: e.message });
    console.log(`  ERROR ${key}: ${e.message}`);
    json(res, 500, { error: e.message, route: key });
  }
});

// ─── Boot ─────────────────────────────────────────────────────

(async () => {
  console.log('\n  MERIDIAN v2');
  console.log('  ───────────────────────────────────────────');
  const h = healthCheck();
  console.log(`  database   ${h.bars} bars across ${h.symbols} symbols, ${h.holdings} holdings`);
  console.log(`  symbols    ${trackedSymbols().length} tracked`);

  // Derived memory is rebuilt from stored bars on every boot. It is idempotent
  // and takes about a second, which buys the guarantee that "what changed"
  // never reports against a stale or half-built history.
  if (h.bars > 0) {
    const t0 = Date.now();
    try {
      const mem = memory.rebuild();
      console.log(`  memory     ${mem.observations} observations, ${mem.regime?.dates ?? 0} regime days in ${Date.now() - t0}ms`);
    } catch (e) {
      console.log(`  memory     rebuild failed: ${e.message}`);
    }
  }

  await refreshPrices();
  await refreshFearGreed();
  refreshNewsFeed().catch(() => {});

  if (h.bars === 0) {
    console.log('\n  No price history stored yet.');
    console.log('  Run this once to backfill (takes a few minutes):');
    console.log('    curl -X POST http://localhost:3001/sync\n');
  }

  setInterval(refreshPrices, CADENCE.prices);
  setInterval(refreshFearGreed, CADENCE.feargreed);
  setInterval(() => refreshNewsFeed().catch(() => {}), CADENCE.news);
  setInterval(snapshot, CADENCE.snapshot);

  server.listen(PORT, () => {
    console.log(`  listening  http://localhost:${PORT}`);
    console.log(`  routes     ${Object.keys(routes).length}\n`);
  });
})();
