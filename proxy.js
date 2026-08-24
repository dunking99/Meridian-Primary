// Meridian Price Proxy — yahoo-finance2 + CNN Fear & Greed
// Run: node proxy.js  (from C:\meridian)

import http from 'http';
import https from 'https';
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance();
const PORT = 3001;

// All symbols the app references, with decimal precision
const SYMBOLS = {
  // US Indices
  '^GSPC':     { decimals: 2 },
  '^IXIC':     { decimals: 2 },
  'VUSA.L':    { decimals: 2 },
  // International
  '^FTSE':     { decimals: 2 },
  '^STOXX50E': { decimals: 2 },
  'VDPG.L':   { decimals: 2 },
  'EEM':       { decimals: 2 },
  // Volatility
  '^VIX':      { decimals: 2 },
  // Gold
  'GC=F':      { decimals: 2 },
  'SGLN.L':    { decimals: 2 },
  // Energy
  'CL=F':      { decimals: 2 },
  'BZ=F':      { decimals: 2 },
  'NG=F':      { decimals: 3 },
  // Forex
  'GBPUSD=X':  { decimals: 4 },
  'EURUSD=X':  { decimals: 4 },
  // Bonds
  '^TNX':      { decimals: 3 },
  '^IRX':      { decimals: 3 },
  // Dollar & JPY
  'DX-Y.NYB':  { decimals: 2 },
  'USDJPY=X':  { decimals: 2 },
  // Sector ETFs
  'XLK':       { decimals: 2 },
  'XLF':       { decimals: 2 },
  'XLV':       { decimals: 2 },
  'XLE':       { decimals: 2 },
  'XLI':       { decimals: 2 },
  'XLY':       { decimals: 2 },
  'XLP':       { decimals: 2 },
  'XLU':       { decimals: 2 },
  'XLRE':      { decimals: 2 },
  'XLB':       { decimals: 2 },
  'XLC':       { decimals: 2 },
};

// ─── Prices ───────────────────────────────────────────────────

async function fetchAllPrices() {
  const syms = Object.keys(SYMBOLS);
  const results = {};

  try {
    const quotes = await yf.quote(syms);
    const arr = Array.isArray(quotes) ? quotes : [quotes];

    for (const q of arr) {
      if (!q || !q.symbol) continue;

      // Match back to our symbol key (yahoo may return slightly different casing)
      const key = syms.find(s => s.toUpperCase() === q.symbol.toUpperCase()) || q.symbol;
      if (!SYMBOLS[key]) continue;

      const price = q.regularMarketPrice ?? q.ask ?? q.bid;
      const prev  = q.regularMarketPreviousClose ?? price;
      if (!price || isNaN(price)) {
        console.log(`  ✗ ${key}: no price`);
        continue;
      }

      const change    = price - prev;
      const changePct = prev ? (change / prev) * 100 : 0;
      const d         = SYMBOLS[key].decimals;

      results[key] = {
        price:        +price.toFixed(d),
        prev:         +prev.toFixed(d),
        change:       +change.toFixed(d),
        changePct:    +changePct.toFixed(2),
        weekChangePct: null,
        live:         true,
      };
    }
  } catch (e) {
    console.log('  Quote batch error:', e.message);
  }

  return results;
}

async function fetchWeeklyChanges(results) {
  // Fetch 7-day history for each symbol that got a price
  const syms = Object.keys(results);
  for (const sym of syms) {
    try {
      const now   = new Date();
      const week  = new Date(now - 7 * 24 * 60 * 60 * 1000);
      const now2 = new Date();
      const hist  = await yf.historical(sym, { period1: week, period2: now2, interval: "1d" });
      if (!hist || hist.length < 2) continue;
      const oldest = hist[0].close;
      const curr   = results[sym].price;
      if (oldest) {
        results[sym].weekChangePct = +((curr - oldest) / oldest * 100).toFixed(2);
      }
    } catch {
      // silently skip — weekly is non-critical
    }
  }
  return results;
}

// ─── Fear & Greed ─────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        ...headers,
      },
    };
    https.get(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch {
          resolve({ ok: false, raw: Buffer.concat(chunks).toString().slice(0, 300) });
        }
      });
    }).on('error', e => resolve({ ok: false, error: e.message }));
  });
}

async function fetchFearAndGreed() {
  const res = await httpsGet('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    Origin:  'https://edition.cnn.com',
    Referer: 'https://edition.cnn.com/markets/fear-and-greed',
  });
  if (!res.ok) { console.log('  Fear & Greed failed'); return null; }
  try {
    const fg   = res.data?.fear_and_greed;
    const hist = res.data?.fear_and_greed_historical?.data || [];
    return {
      score:     Math.round(fg.score),
      rating:    fg.rating.replace(/_/g, ' ').toUpperCase(),
      prevClose: Math.round(fg.previous_close),
      weekAgo:   hist.length >= 5  ? Math.round(hist[hist.length - 5]?.y)  : null,
      monthAgo:  hist.length >= 21 ? Math.round(hist[hist.length - 21]?.y) : null,
    };
  } catch (e) { console.log('  Fear & Greed parse error:', e.message); return null; }
}

// ─── Cache & refresh loops ────────────────────────────────────

let cachedPrices    = {};
let cachedFearGreed = null;
let lastFetch       = 0;

async function refreshPrices() {
  console.log(`\n[${new Date().toLocaleTimeString()}] Fetching prices...`);
  let results = await fetchAllPrices();
  const count = Object.keys(results).length;
  const total = Object.keys(SYMBOLS).length;
  console.log(`  Quotes: ${count}/${total}`);

  if (count > 0) {
    const sample = Object.entries(results).slice(0, 4)
      .map(([k, v]) => `${k}=${v.price}(${v.changePct >= 0 ? '+' : ''}${v.changePct}%)`)
      .join('  ');
    console.log('  ' + sample);
    console.log('  Fetching weekly changes...');
    results = await fetchWeeklyChanges(results);
    const wCount = Object.values(results).filter(v => v.weekChangePct !== null).length;
    console.log(`  Weekly % added for ${wCount} symbols`);
    cachedPrices = results;
  }
  lastFetch = Date.now();
}

async function refreshFearAndGreed() {
  console.log(`[${new Date().toLocaleTimeString()}] Fetching Fear & Greed...`);
  const fg = await fetchFearAndGreed();
  if (fg) { cachedFearGreed = fg; console.log(`  Score: ${fg.score} — ${fg.rating}`); }
}

(async () => {
  console.log('\n✓ Meridian price proxy starting...');
  console.log(`  Symbols: ${Object.keys(SYMBOLS).length} | yahoo-finance2 | Fear & Greed: CNN`);
  console.log('  Keep this window open while using Meridian\n');

  await refreshPrices();
  await refreshFearAndGreed();

  setInterval(refreshPrices,       60_000);
  setInterval(refreshFearAndGreed, 300_000);
})();

// ─── HTTP server ──────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/prices') {
    res.writeHead(200);
    res.end(JSON.stringify({ prices: cachedPrices, lastFetch, count: Object.keys(cachedPrices).length }));
  } else if (req.url === '/feargreed') {
    res.writeHead(200);
    res.end(JSON.stringify(cachedFearGreed || {}));
  } else {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'Meridian proxy running', port: PORT, symbols: Object.keys(SYMBOLS).length }));
  }
});

server.listen(PORT, () => {
  console.log(`\n✓ Listening on http://localhost:${PORT}\n`);
});
