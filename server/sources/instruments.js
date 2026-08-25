// Meridian — instrument typing.
//
// The codebase assumed every symbol was a US common stock. Nothing anywhere
// recorded what kind of thing a ticker referred to, so the Research page asked
// for a P/E ratio, a market cap, a beta and an expense ratio no matter what it
// was looking at. For ^GSPC, GBPUSD=X or GC=F most of those are not missing
// data — they are questions that do not apply, and rendering them as empty
// fields told the user their data was broken when it was not.
//
// This is the single place that decides what a symbol is, and what can
// meaningfully be asked about it.

/**
 * Field sets per instrument type.
 *
 * `stats` lists the key figures worth showing. `absent` explains the fields a
 * type structurally lacks, so the UI can say "indices do not have a P/E"
 * rather than showing a blank box. `analyst` and `filings` gate whole
 * features: price targets are meaningless for a currency pair, and SEC filings
 * exist only for US registrants.
 */
export const INSTRUMENT_TYPES = {
  equity: {
    label: 'Equity',
    stats: ['marketCap', 'pe', 'forwardPe', 'dividendYield', 'beta', 'range52', 'avgVolume', 'sharesOutstanding'],
    analyst: true, filings: 'us-only', fundamentals: true,
    absent: {},
  },
  etf: {
    label: 'ETF',
    // An ETF's expense ratio and holdings matter far more than a blended P/E,
    // and market cap is really assets under management.
    stats: ['expenseRatio', 'dividendYield', 'beta', 'range52', 'avgVolume', 'marketCap'],
    analyst: false, filings: false, fundamentals: true,
    absent: {
      pe: 'An ETF has no single P/E — it holds many companies.',
      forwardPe: 'An ETF has no single forward P/E.',
      analyst: 'Analysts publish targets on companies, not on funds.',
    },
  },
  fund: {
    label: 'Fund',
    // OEICs and unit trusts (Yahoo 0P… tickers) publish a daily NAV and little
    // else — no intraday volume, no market cap, often no beta.
    stats: ['expenseRatio', 'dividendYield', 'range52'],
    analyst: false, filings: false, fundamentals: true,
    absent: {
      pe: 'A fund has no single P/E.',
      marketCap: 'A fund is priced at NAV, not market capitalisation.',
      avgVolume: 'Funds are dealt at NAV and do not report exchange volume.',
      analyst: 'Analysts publish targets on companies, not on funds.',
    },
  },
  index: {
    label: 'Index',
    // An index is a calculated level. It has a range and history and nothing else.
    stats: ['range52'],
    analyst: false, filings: false, fundamentals: false,
    absent: {
      pe: 'An index is a calculated level and carries no company financials.',
      marketCap: 'An index has no market capitalisation.',
      dividendYield: 'An index level carries no dividend yield.',
      beta: 'An index is the benchmark — beta against itself is 1 by definition.',
      avgVolume: 'An index has no volume of its own.',
      expenseRatio: 'An index is not a product and has no fee.',
      analyst: 'Analysts do not publish price targets on index levels.',
    },
  },
  fx: {
    label: 'FX pair',
    stats: ['range52'],
    analyst: false, filings: false, fundamentals: false,
    absent: {
      pe: 'A currency pair has no earnings.',
      marketCap: 'A currency pair has no market capitalisation.',
      dividendYield: 'A currency pair pays no dividend.',
      beta: 'Beta is not defined for a currency pair here.',
      expenseRatio: 'A currency pair is not a product and has no fee.',
      analyst: 'Analysts do not publish equity-style price targets on FX.',
    },
  },
  future: {
    label: 'Future',
    stats: ['range52', 'avgVolume'],
    analyst: false, filings: false, fundamentals: false,
    absent: {
      pe: 'A futures contract has no earnings.',
      marketCap: 'A futures contract has no market capitalisation.',
      dividendYield: 'A futures contract pays no dividend.',
      expenseRatio: 'A futures contract is not a fund and has no fee.',
      analyst: 'Analysts do not publish equity-style price targets on futures.',
    },
  },
  yield: {
    label: 'Yield',
    // ^TNX and friends quote a percentage, not a price. Treating them as
    // prices is how a 4.3% yield ends up formatted as £4.30.
    stats: ['range52'],
    analyst: false, filings: false, fundamentals: false, isRate: true,
    absent: {
      pe: 'A yield is a rate, not a security.',
      marketCap: 'A yield has no market capitalisation.',
      dividendYield: 'This figure is itself a yield.',
      beta: 'Beta is not defined for a rate here.',
      expenseRatio: 'A yield is not a product and has no fee.',
      analyst: 'Analysts do not publish price targets on yields.',
    },
  },
  crypto: {
    label: 'Crypto',
    stats: ['marketCap', 'range52', 'avgVolume'],
    analyst: false, filings: false, fundamentals: false,
    absent: {
      pe: 'A cryptocurrency has no earnings.',
      dividendYield: 'A cryptocurrency pays no dividend.',
      expenseRatio: 'A cryptocurrency is not a fund and has no fee.',
      analyst: 'Analysts do not publish equity-style price targets here.',
    },
  },
  unknown: {
    label: 'Unknown',
    // Show everything and let the data decide — better than hiding a real
    // figure because the type could not be established.
    stats: ['marketCap', 'pe', 'forwardPe', 'dividendYield', 'beta', 'range52', 'avgVolume', 'expenseRatio'],
    analyst: true, filings: 'us-only', fundamentals: true,
    absent: {},
  },
};

import { SYMBOLS } from '../config.js';

// Yahoo's own quoteType, where it is available, is the most reliable signal.
const BY_QUOTE_TYPE = {
  EQUITY: 'equity',
  ETF: 'etf',
  MUTUALFUND: 'fund',
  INDEX: 'index',
  CURRENCY: 'fx',
  FUTURE: 'future',
  CRYPTOCURRENCY: 'crypto',
};

// US yield tickers quote a rate rather than a level, and must not be treated
// as index prices even though they carry the ^ prefix.
const RATE_SYMBOLS = new Set(['^TNX', '^IRX', '^FVX', '^TYX']);

// The tracked universe in config.js already groups its symbols, and that
// grouping is a reliable type signal for exactly the instruments where the
// ticker shape gives nothing away — VUSA.L and XLK look like ordinary equities
// from their tickers alone. This matters offline and on first load, before any
// quote has come back to supply a quoteType.
const BY_CONFIG_GROUP = {
  usIndices: 'index', intIndices: 'index', volatility: 'index',
  bonds: 'yield', fx: 'fx', commodities: 'future',
  sectors: 'etf', ukEtfs: 'etf',
};

/**
 * Work out what a symbol is.
 *
 * `quoteType` (from a Yahoo quote or quoteSummary) is trusted first when
 * present; otherwise the ticker's own shape decides, which is reliable because
 * Yahoo's suffix conventions are consistent. Returns the type descriptor
 * merged with its id so callers need only one object.
 */
export function classify(symbol, quoteType = null) {
  const s = String(symbol || '').toUpperCase();
  let id;

  if (RATE_SYMBOLS.has(s)) {
    id = 'yield';
  } else if (quoteType && BY_QUOTE_TYPE[quoteType]) {
    id = BY_QUOTE_TYPE[quoteType];
  } else if (s.startsWith('^')) {
    id = 'index';
  } else if (s.endsWith('=X')) {
    id = 'fx';
  } else if (s.endsWith('=F')) {
    id = 'future';
  } else if (/-(USD|GBP|EUR)$/.test(s)) {
    id = 'crypto';
  } else if (/^0P[0-9A-Z]{8}/.test(s)) {
    // Yahoo's identifier space for OEICs and unit trusts — the share classes
    // held in a UK ISA. Not an exchange-traded instrument at all.
    id = 'fund';
  } else if (s === 'DX-Y.NYB') {
    id = 'index';
  } else if (BY_CONFIG_GROUP[SYMBOLS[s]?.group]) {
    id = BY_CONFIG_GROUP[SYMBOLS[s].group];
  } else {
    // Deliberately not defaulted to 'equity'. Guessing equity is exactly the
    // assumption this module exists to remove, and 'unknown' shows every field
    // rather than hiding a real one.
    id = 'unknown';
  }

  return { type: id, ...INSTRUMENT_TYPES[id] };
}

/** Whether a given stat is worth asking about for this symbol. */
export function applies(symbol, stat, quoteType = null) {
  return classify(symbol, quoteType).stats.includes(stat);
}
