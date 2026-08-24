// One-off history backfill. Run: npm run sync
// Downloads ~12 years of daily bars for every tracked symbol into meridian.db.
import { CORE_SYMBOLS } from '../server/config.js';
import { all, healthCheck } from '../server/db.js';
import { syncAll } from '../server/sources/yahoo.js';

const held = all('SELECT DISTINCT symbol FROM holdings').map(r => r.symbol);
const watched = all('SELECT DISTINCT symbol FROM watchlist').map(r => r.symbol);
const symbols = [...new Set([...CORE_SYMBOLS, ...held, ...watched])];

console.log(`Syncing ${symbols.length} symbols. This takes a few minutes on first run.\n`);
const t0 = Date.now();
const r = await syncAll(symbols, { years: 12, force: process.argv.includes('--force') });

console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`  synced ${r.synced}/${symbols.length}`);
if (r.failed.length) {
  console.log('  failed:');
  for (const f of r.failed) console.log(`    ${f.symbol}: ${f.error}`);
}
console.log('\nDatabase now holds:', healthCheck());
