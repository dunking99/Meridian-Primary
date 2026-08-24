// Meridian v2 — FT fund NAV fallback scraper
// Used only when Yahoo has no data for a fund's exact share class (e.g. some
// HL "Class S" institutional-pricing funds). Scrapes FT's public tearsheet —
// no login required for these fields, but this is inherently more fragile
// than the Yahoo integration: FT can change this markup with no warning.
// Never treat this as a primary source, and never use it for history — FT's
// tearsheet gives today's snapshot only, not a backfillable time series.

import https from 'https';
import { saveFundNav, getFundNav } from '../db.js';

function fetchHtml(url, redirects = 3) {
  return new Promise(resolve => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname, path: u.pathname + u.search, port: u.port || undefined,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Meridian/2.0)',
        'Accept': 'text/html',
      },
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchHtml(new URL(res.headers.location, url).href, redirects - 1));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ ok: res.statusCode === 200, body: Buffer.concat(chunks).toString() }));
    }).on('error', () => resolve({ ok: false, body: '' }));
  });
}

const stripTags = s => (s ?? '').replace(/<[^>]+>/g, '').trim();

/** A real ISIN is exactly 12 characters: 2-letter country code, 9 alphanumeric,
 *  1 numeric check digit. Rejects Yahoo-style tickers like "GB00BJS8SJ34.L"
 *  before they ever reach FT — sending a malformed symbol is how this scraper
 *  previously returned a different fund's price without any error. */
export function isValidISIN(isin) {
  return typeof isin === 'string' && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin.trim().toUpperCase());
}

/** Parse the quote-bar label/value pairs out of an FT fund tearsheet page.
 *  Exported standalone so it can be unit-tested against a saved HTML sample
 *  without hitting the network. */
export function parseFTTearsheet(html) {
  const nameMatch = html.match(/<h1 class="mod-tearsheet-overview__header__name mod-tearsheet-overview__header__name--large">([^<]+)<\/h1>/);
  // The page's own header states which instrument it's actually showing —
  // e.g. <div class="...__header__symbol"><span>GB00BN08ZR66:GBP</span></div>.
  // Capturing this lets the caller verify FT served the fund that was asked
  // for, rather than trusting page structure alone (which a redirect or a
  // fallback/default page could satisfy with someone else's data).
  const symbolMatch = html.match(/mod-tearsheet-overview__header__symbol"><span>([^<]+)<\/span>/);
  const barMatch = html.match(/<ul class="mod-tearsheet-overview__quote__bar">([\s\S]*?)<\/ul>/);
  if (!barMatch) return null;

  const items = barMatch[1].match(/<li>[\s\S]*?<\/li>/g) ?? [];
  const fields = {};
  for (const li of items) {
    const label = li.match(/class="mod-ui-data-list__label"[^>]*>([^<]+)</);
    if (!label) continue;
    const marker = 'class="mod-ui-data-list__value">';
    const valueIdx = li.indexOf(marker);
    if (valueIdx === -1) continue;
    // Slice to end of the <li> rather than to the next </span>, since the
    // change fields wrap their text in an extra nested <span> for colour —
    // stripping all tags from here to the end is robust to that nesting.
    const valueHtml = li.slice(valueIdx + marker.length);
    fields[label[1].trim()] = stripTags(valueHtml);
  }

  const priceKey = Object.keys(fields).find(k => k.startsWith('Price'));
  if (!priceKey) return null;
  const price = parseFloat(fields[priceKey].replace(/,/g, ''));
  if (!isFinite(price)) return null;

  const currencyMatch = priceKey.match(/\(([A-Z]{3})\)/);
  const changeKey = Object.keys(fields).find(k => k.startsWith("Today's Change") || k.startsWith('Change'));
  let change = null, changePct = null;
  if (changeKey) {
    const m = fields[changeKey].match(/(-?[\d.,]+)\s*\/\s*(-?[\d.,]+)%/);
    if (m) { change = parseFloat(m[1].replace(/,/g, '')); changePct = parseFloat(m[2]); }
  }

  const disclaimer = html.match(/mod-disclaimer">([^<]*)</);
  const asOfMatch = disclaimer?.[1]?.match(/as of ([^<.]+)\.?/);

  return {
    name: nameMatch ? stripTags(nameMatch[1]) : null,
    matchedSymbol: symbolMatch ? symbolMatch[1].trim() : null,
    price,
    change,
    changePct,
    currency: currencyMatch ? currencyMatch[1] : 'GBP',
    asOf: asOfMatch ? asOfMatch[1].trim() : null,
  };
}

/** Fetch and cache a fund's price from FT by ISIN. Fallback only — call this
 *  for a symbol only after confirming Yahoo has no usable data for it. */
export async function fetchFTFundNav(isin, currency = 'GBP') {
  const cleanIsin = (isin ?? '').trim().toUpperCase();
  if (!isValidISIN(cleanIsin)) {
    return { error: `"${isin}" is not a valid ISIN — expected 12 characters (e.g. GB00BN08ZR66), not a Yahoo-style ticker.` };
  }

  const url = `https://markets.ft.com/data/funds/tearsheet/summary?s=${encodeURIComponent(cleanIsin)}:${currency}`;
  const res = await fetchHtml(url);
  if (!res.ok || !res.body) return { error: 'FT page unreachable' };

  const parsed = parseFTTearsheet(res.body);
  if (!parsed) return { error: 'Could not parse FT tearsheet — page layout may have changed' };

  // Refuse to trust the price unless the page's own header confirms it's
  // actually showing the ISIN we asked for. This is the check that would
  // have caught the earlier bug: a malformed or redirected request silently
  // returning a different fund's data with no error.
  const matchedIsin = parsed.matchedSymbol?.split(':')[0]?.trim().toUpperCase();
  if (!matchedIsin || matchedIsin !== cleanIsin) {
    return { error: `FT returned data for "${parsed.matchedSymbol ?? 'an unknown symbol'}", not the requested ${cleanIsin} — refusing to use it. The fund may not exist on FT, or the page layout changed.` };
  }

  saveFundNav({ isin: cleanIsin, ...parsed });
  return { isin: cleanIsin, ...parsed, source: 'ft', fetchedAt: Date.now() };
}

/** Cached NAV for an ISIN, without re-fetching. Returns null if never synced. */
export function getCachedFTNav(isin) {
  const row = getFundNav(isin);
  if (!row) return null;
  return {
    isin: row.isin, name: row.name, price: row.price, change: row.change,
    changePct: row.change_pct, currency: row.currency, asOf: row.as_of,
    fetchedAt: row.fetched_at, source: 'ft',
  };
}
