// Fill a THROWAWAY database with synthetic price history.
//
// This exists so engine work can be verified without a network connection and
// without touching real holdings. The data it produces is fabricated and must
// never reach the app you actually look at, so this script refuses to run
// unless MERIDIAN_DB points somewhere ending in .test.db — which .gitignore
// excludes.
//
//   MERIDIAN_DB=./scratch.test.db node scripts/seed-dev-db.js
//
// Series are generated from a seeded PRNG, so a given run is reproducible and
// a regression in an engine shows up as a changed number rather than noise.

import path from 'path';

const target = process.env.MERIDIAN_DB ?? '';
if (!target.endsWith('.test.db')) {
  console.error('Refusing to run: set MERIDIAN_DB to a path ending in .test.db');
  console.error('  e.g. MERIDIAN_DB=./scratch.test.db node scripts/seed-dev-db.js');
  console.error('This script writes fabricated prices and must never touch the real database.');
  process.exit(1);
}

const { saveBars, db } = await import('../server/db.js');
const { SYMBOLS } = await import('../server/config.js');

// mulberry32 — small, fast, fully deterministic from a 32-bit seed.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so shocks are normally distributed rather than uniform. */
function gauss(rand) {
  const u = Math.max(rand(), 1e-9), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const DAYS = 900;
const symbols = Object.keys(SYMBOLS);

// A shared market factor, so the generated universe has genuine cross-sectional
// correlation. Without it every breadth and correlation statistic computed
// against this data would be indistinguishable from noise, and the engines
// would appear to work while actually being tested on nothing.
const marketRand = rng(20240101);
const market = Array.from({ length: DAYS }, () => gauss(marketRand) * 0.009);

const dates = [];
for (let i = DAYS; i > 0; i--) {
  const d = new Date(Date.now() - i * 86400_000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) continue;      // weekdays only
  dates.push(d.toISOString().slice(0, 10));
}

let total = 0;
symbols.forEach((symbol, idx) => {
  const rand = rng(1000 + idx * 7919);
  const meta = SYMBOLS[symbol];

  // Rough starting levels by instrument kind, so numbers look plausible when
  // rendered and pence-vs-pounds style bugs would still be visible.
  const start = symbol.startsWith('^') ? 4000 + rand() * 12000
              : symbol.includes('=X') ? 1 + rand()
              : symbol.endsWith('.L') ? 20 + rand() * 200
              : 40 + rand() * 400;

  const beta = 0.3 + rand() * 1.4;
  const idio = 0.004 + rand() * 0.010;
  const drift = (rand() - 0.45) * 0.0004;

  let price = start;
  const bars = [];
  for (let i = 0; i < dates.length; i++) {
    const shock = drift + beta * market[i % market.length] + gauss(rand) * idio;
    price = Math.max(price * (1 + shock), 0.01);
    const high = price * (1 + Math.abs(gauss(rand)) * 0.004);
    const low = price * (1 - Math.abs(gauss(rand)) * 0.004);
    bars.push({
      date: dates[i],
      open: +(price * (1 + gauss(rand) * 0.002)).toFixed(4),
      high: +high.toFixed(4),
      low: +low.toFixed(4),
      close: +price.toFixed(4),
      adjClose: +price.toFixed(4),
      volume: Math.round(1e6 + rand() * 9e6),
    });
  }

  // rejectFatal:false — the integrity validator flags the sharp synthetic
  // shocks this generates, and it is not what is under test here.
  const r = saveBars(symbol, bars, { rejectFatal: false });
  total += r.saved;
  if (meta) process.stdout.write('.');
});

console.log(`\nSeeded ${total} synthetic bars across ${symbols.length} symbols`);
console.log(`  into ${path.resolve(target)}`);
console.log('  THIS DATA IS FABRICATED — for engine testing only.');
db.close?.();
