// Meridian — manual/scraped fund pricing
//
// Some holdings (UK OEIC/unit trust funds bought via Hargreaves Lansdown) either
// aren't on Yahoo Finance at all, or Yahoo's coverage of them is wrong/stale
// (wrong price, frozen date). These funds are genuinely priced once per day at
// a single valuation point — there is no intraday "live" price for them
// anywhere, from any source — so this module fetches once per day and caches.
//
// Two sources, both free, no API key:
//   - "blackrock": BlackRock/iShares fund pages. One page lists every share
//     class of that fund family in one pricing table, so we fetch the page
//     once and pick out the row matching the ISIN we actually hold.
//   - "fidelity": Fidelity's factsheet platform, which — despite the domain —
//     hosts data for many third-party UK funds too, keyed by ISIN.
//
// IMPORTANT — untested against live HTML: I built this from the rendered
// page content I could see, not by inspecting raw HTML/DOM in a browser. The
// regexes below are written to be reasonably tolerant of exact markup
// changes, but the very first real run against these live pages is the real
// test. If a fetch returns null instead of a number, log the raw HTML around
// the ISIN and adjust the regex — don't assume the approach itself is wrong.

const UK_TZ = 'Europe/London';

// ─── Registry: which funds this module knows how to fetch ────────────────
// Add a new fund here — nothing else needs to change to support it.
export const MANUAL_FUNDS = {
  'GB00BJS8SJ34': {
    name: 'Fidelity Index World P Acc',
    source: 'fidelity',
    slug: 'fidelity-index-world-fund-p-acc',
  },
  'GB00BN08ZQ59': {
    name: 'iShares Pacific ex Japan Equity Index Class S Acc',
    source: 'blackrock',
    // Any product ID belonging to the same fund family works here — the
    // page lists every share class's NAV, we just look up our ISIN's row.
    pageProductId: '337780',
  },
  'GB00BN08ZR66': {
    name: 'iShares UK Equity Index Class S Acc',
    source: 'blackrock',
    pageProductId: '339785',
  },
};

export function isManualFund(isin) {
  return Object.prototype.hasOwnProperty.call(MANUAL_FUNDS, isin);
}

// ─── Fetch helpers ─────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      // A plain UA string; some sites serve a stripped-down page to obvious
      // script clients. If this starts getting blocked, this is the first
      // thing to revisit.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Meridian/1.0',
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}) for ${url}`);
  }
  return res.text();
}

// BlackRock's "Pricing & Exchange" table lists rows like:
//   Class S | GBP | 1.64 | 0.00 | -0.17 | 21/Aug/2026 | 1.67 | 1.36 | GB00BN08ZR66
// We don't rely on exact column tags — we anchor on the ISIN appearing in the
// row and pull the nearby numbers out of the same table row's text.
function parseBlackRockRow(html, isin) {
  // Grab a window of HTML around the ISIN's table cell, then strip tags to
  // get plain text we can pull numbers from — resilient to the surrounding
  // markup changing (extra classes, wrapper divs) since we're not depending
  // on a specific selector path.
  const isinIndex = html.indexOf(isin);
  if (isinIndex === -1) return null;

  // Look backwards for the start of the enclosing <tr>...</tr>
  const rowStart = html.lastIndexOf('<tr', isinIndex);
  const rowEnd = html.indexOf('</tr>', isinIndex);
  if (rowStart === -1 || rowEnd === -1) return null;

  const rowHtml = html.slice(rowStart, rowEnd);
  const rowText = rowHtml
    .replace(/<[^>]+>/g, ' ')   // strip tags
    .replace(/\s+/g, ' ')
    .trim();

  // Expect something like: "Class S GBP 1.64 0.00 -0.17 21/Aug/2026 1.67 1.36 GB00BN08ZR66"
  const dateMatch = rowText.match(/(\d{1,2}\/[A-Za-z]{3}\/\d{4})/);
  const numbers = rowText.match(/-?\d+\.\d+/g) || [];
  if (numbers.length < 3) return null;

  const [nav, change, changePct] = numbers;
  return {
    price: parseFloat(nav),
    change: parseFloat(change),
    changePct: parseFloat(changePct),
    asOf: dateMatch ? dateMatch[1] : null,
    currency: 'GBP',
    raw: rowText,
  };
}

async function fetchBlackRockNAV(isin, pageProductId) {
  const url = `https://www.blackrock.com/uk/individual/products/${pageProductId}/`;
  const html = await fetchText(url);
  const parsed = parseBlackRockRow(html, isin);
  if (!parsed) {
    throw new Error(`Could not find ISIN ${isin} in BlackRock page ${url}`);
  }
  return parsed;
}

// Fidelity's factsheet key-statistics page has a "Last buy/sell price"
// figure in pence, and a "Prices updated as at DATE" line.
function parseFidelityPage(html) {
  const priceMatch = html.match(/Last buy\/sell price[^0-9]*(\d+\.\d+)p/i);
  const changeMatch = html.match(/Change[^0-9\-]*(-?\d+\.\d+)p\s*\(([-\d.]+)%\)/i);
  const dateMatch = html.match(/Prices updated as at\s*(\d{1,2}\s+\w+\s+\d{4})/i);

  if (!priceMatch) return null;

  return {
    // Fidelity quotes in pence (GBX) — normalise to pounds, same convention
    // used everywhere else in Meridian (see yahoo.js normaliseByCurrency).
    price: parseFloat(priceMatch[1]) / 100,
    change: changeMatch ? parseFloat(changeMatch[1]) / 100 : null,
    changePct: changeMatch ? parseFloat(changeMatch[2]) : null,
    asOf: dateMatch ? dateMatch[1] : null,
    currency: 'GBP',
  };
}

async function fetchFidelityNAV(isin, slug) {
  const url = `https://www.fidelity.co.uk/factsheet-data/factsheet/${isin}-${slug}/key-statistics`;
  const html = await fetchText(url);
  const parsed = parseFidelityPage(html);
  if (!parsed) {
    throw new Error(`Could not parse Fidelity page for ${isin} at ${url}`);
  }
  return parsed;
}

// ─── Public entry point ────────────────────────────────────────────────────

/** Fetch the current NAV for a manually-tracked fund. Throws on failure —
 *  callers should catch and fall back to the last cached price rather than
 *  letting one bad fetch take down the whole portfolio valuation. */
export async function fetchManualFundNAV(isin) {
  const fund = MANUAL_FUNDS[isin];
  if (!fund) throw new Error(`Unknown manual fund ISIN: ${isin}`);

  if (fund.source === 'blackrock') {
    return fetchManualFundNAV._blackrock(isin, fund.pageProductId);
  }
  if (fund.source === 'fidelity') {
    return fetchManualFundNAV._fidelity(isin, fund.slug);
  }
  throw new Error(`Unknown fund source: ${fund.source}`);
}
// Exposed for testing individually without going through the registry.
fetchManualFundNAV._blackrock = fetchBlackRockNAV;
fetchManualFundNAV._fidelity = fetchFidelityNAV;

/** UK-calendar-day check: has this ISIN already been fetched today?
 *  `lastFetchedISO` is whatever was stored last time (an ISO timestamp). */
export function needsRefetch(lastFetchedISO) {
  if (!lastFetchedISO) return true;
  const last = new Date(lastFetchedISO);
  const now = new Date();
  const fmt = d => d.toLocaleDateString('en-GB', { timeZone: UK_TZ });
  return fmt(last) !== fmt(now);
}
