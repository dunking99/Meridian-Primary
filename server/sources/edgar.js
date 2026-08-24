// Meridian v2 — SEC EDGAR insider transactions (Form 4)
// Free and structured. SEC requires a descriptive User-Agent with contact info;
// requests without one are rate-limited or blocked.

import https from 'https';
import { run, all, one, getSetting } from '../db.js';

const UA = () => getSetting('edgarUserAgent', 'Meridian Personal Dashboard (contact@example.com)');

function getJson(path) {
  return new Promise(resolve => {
    https.get({
      hostname: 'data.sec.gov', path,
      headers: { 'User-Agent': UA(), 'Accept': 'application/json' },
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(c).toString())); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

let tickerMap = null;
async function loadTickerMap() {
  if (tickerMap) return tickerMap;
  const data = await new Promise(resolve => {
    https.get({ hostname: 'www.sec.gov', path: '/files/company_tickers.json',
                headers: { 'User-Agent': UA() } }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
  if (!data) return null;
  tickerMap = {};
  for (const v of Object.values(data)) {
    tickerMap[v.ticker] = String(v.cik_str).padStart(10, '0');
  }
  return tickerMap;
}

/** Recent filings of a given type for a US-listed ticker. */
export async function fetchFilings(ticker, { type = '4', limit = 25 } = {}) {
  const map = await loadTickerMap();
  const cik = map?.[ticker.toUpperCase()];
  if (!cik) return { ticker, error: 'Not a US-listed ticker in the SEC index.' };

  const data = await getJson(`/submissions/CIK${cik}.json`);
  const recent = data?.filings?.recent;
  if (!recent) return { ticker, error: 'No filings returned.' };

  const out = [];
  for (let i = 0; i < recent.form.length && out.length < limit; i++) {
    if (type && recent.form[i] !== type) continue;
    out.push({
      form: recent.form[i],
      date: recent.filingDate[i],
      accession: recent.accessionNumber[i],
      primaryDoc: recent.primaryDocument[i],
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${recent.accessionNumber[i].replace(/-/g, '')}/${recent.primaryDocument[i]}`,
    });
  }
  return { ticker, cik, company: data.name, filings: out };
}

/** Cache insider filings for a symbol. Returns what is stored. */
export async function syncInsiders(ticker) {
  const res = await fetchFilings(ticker, { type: '4', limit: 30 });
  if (res.error) return res;
  let added = 0;
  for (const f of res.filings) {
    if (one('SELECT id FROM insiders WHERE accession = ?', f.accession)) continue;
    try {
      run(`INSERT INTO insiders (symbol, accession, filer, role, date, tx_type, shares, price, value, url, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          ticker.toUpperCase(), f.accession, res.company, null, f.date, 'Form 4',
          null, null, null, f.url, Date.now());
      added++;
    } catch { /* race */ }
  }
  return { ticker, company: res.company, added, total: res.filings.length };
}

export function getInsiders(symbol, limit = 30) {
  return all('SELECT * FROM insiders WHERE symbol = ? ORDER BY date DESC LIMIT ?',
             symbol.toUpperCase(), limit);
}

/** Full-text filing search across EDGAR. */
export async function searchFilings(query, { forms = '8-K,10-K,10-Q', limit = 20 } = {}) {
  const path = `/search-index?q=${encodeURIComponent(query)}&forms=${encodeURIComponent(forms)}`;
  const data = await getJson(path);
  if (!data) return { query, results: [], note: 'EDGAR full-text search unavailable.' };
  return { query, results: (data.hits?.hits ?? []).slice(0, limit) };
}
