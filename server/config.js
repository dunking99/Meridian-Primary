// Meridian v2 — central configuration
// Everything that used to be scattered across proxy.js and App.jsx lives here.

export const PORT = 3001;
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MERIDIAN_DB lets a throwaway database be pointed at for testing, so engine
// work never has to be tried out against the real holdings.
export const DB_PATH = process.env.MERIDIAN_DB
  ? path.resolve(process.env.MERIDIAN_DB)
  : path.join(__dirname, '..', 'meridian.db');

// Poll cadences (ms)
export const CADENCE = {
  prices:    60_000,
  feargreed: 300_000,
  news:      600_000,
  edgar:     3_600_000,
  snapshot:  900_000,   // portfolio snapshot every 15 min while running
};

// ─── Symbol universe ──────────────────────────────────────────
// `decimals` controls display precision. `ccy` is the nominal quote currency.
//
// Pence-vs-pounds is deliberately NOT declared here. Hardcoding that per
// symbol caused a 100x pricing bug: Yahoo's convention varies by ticker and
// changes over time, so a static table is a guess that eventually goes stale.
// sources/yahoo.js reads the live `currency` field on each quote instead.

export const SYMBOLS = {
  // US indices
  '^GSPC':     { decimals: 2, ccy: 'USD', group: 'usIndices',  name: 'S&P 500' },
  '^IXIC':     { decimals: 2, ccy: 'USD', group: 'usIndices',  name: 'NASDAQ Composite' },
  '^DJI':      { decimals: 2, ccy: 'USD', group: 'usIndices',  name: 'Dow Jones' },
  '^RUT':      { decimals: 2, ccy: 'USD', group: 'usIndices',  name: 'Russell 2000' },

  // International indices
  '^FTSE':     { decimals: 2, ccy: 'GBP', group: 'intIndices', name: 'FTSE 100' },
  '^STOXX50E': { decimals: 2, ccy: 'EUR', group: 'intIndices', name: 'EuroStoxx 50' },
  '^GDAXI':    { decimals: 2, ccy: 'EUR', group: 'intIndices', name: 'DAX' },
  '^N225':     { decimals: 2, ccy: 'JPY', group: 'intIndices', name: 'Nikkei 225' },
  'EEM':       { decimals: 2, ccy: 'USD', group: 'intIndices', name: 'MSCI EM' },

  // Volatility & rates
  '^VIX':      { decimals: 2, ccy: 'USD', group: 'volatility', name: 'VIX', inverted: true },
  '^TNX':      { decimals: 3, ccy: 'USD', group: 'bonds',      name: 'US 10Y' },
  '^IRX':      { decimals: 3, ccy: 'USD', group: 'bonds',      name: 'US 3M' },
  '^FVX':      { decimals: 3, ccy: 'USD', group: 'bonds',      name: 'US 5Y' },
  'DX-Y.NYB':  { decimals: 2, ccy: 'USD', group: 'fx',         name: 'Dollar Index' },

  // Commodities
  'GC=F':      { decimals: 2, ccy: 'USD', group: 'commodities', name: 'Gold' },
  'SI=F':      { decimals: 2, ccy: 'USD', group: 'commodities', name: 'Silver' },
  'CL=F':      { decimals: 2, ccy: 'USD', group: 'commodities', name: 'WTI Crude' },
  'BZ=F':      { decimals: 2, ccy: 'USD', group: 'commodities', name: 'Brent Crude' },
  'NG=F':      { decimals: 3, ccy: 'USD', group: 'commodities', name: 'Natural Gas' },
  'HG=F':      { decimals: 3, ccy: 'USD', group: 'commodities', name: 'Copper' },

  // FX
  'GBPUSD=X':  { decimals: 4, ccy: 'USD', group: 'fx', name: 'GBP/USD' },
  'EURUSD=X':  { decimals: 4, ccy: 'USD', group: 'fx', name: 'EUR/USD' },
  'USDJPY=X':  { decimals: 2, ccy: 'JPY', group: 'fx', name: 'USD/JPY' },
  'GBPEUR=X':  { decimals: 4, ccy: 'EUR', group: 'fx', name: 'GBP/EUR' },
  // The Markets FX board showed these three as hardcoded numbers because they
  // had no symbol to price from. Tracking them makes that board fully live and
  // widens the currency-strength read beyond USD/EUR/GBP/JPY.
  'AUDUSD=X':  { decimals: 4, ccy: 'USD', group: 'fx', name: 'AUD/USD' },
  'USDCAD=X':  { decimals: 4, ccy: 'CAD', group: 'fx', name: 'USD/CAD' },
  'USDCHF=X':  { decimals: 4, ccy: 'CHF', group: 'fx', name: 'USD/CHF' },

  // US sector ETFs (heatmap + factor work)
  'XLK':  { decimals: 2, ccy: 'USD', group: 'sectors', name: 'Technology' },
  'XLF':  { decimals: 2, ccy: 'USD', group: 'sectors', name: 'Financials' },
  'XLV':  { decimals: 2, ccy: 'USD', group: 'sectors', name: 'Health Care' },
  'XLE':  { decimals: 2, ccy: 'USD', group: 'sectors', name: 'Energy' },
  'XLI':  { decimals: 2, ccy: 'USD', group: 'sectors', name: 'Industrials' },
  'XLY':  { decimals: 2, ccy: 'USD', group: 'sectors', name: 'Cons. Discretionary' },
  'XLP':  { decimals: 2, ccy: 'USD', group: 'sectors', name: 'Cons. Staples' },
  'XLU':  { decimals: 2, ccy: 'USD', group: 'sectors', name: 'Utilities' },
  'XLRE': { decimals: 2, ccy: 'USD', group: 'sectors', name: 'Real Estate' },
  'XLB':  { decimals: 2, ccy: 'USD', group: 'sectors', name: 'Materials' },
  'XLC':  { decimals: 2, ccy: 'USD', group: 'sectors', name: 'Communications' },

  // UK-listed ETFs — the portfolio universe. All quote in GBp on Yahoo.
  'VUSA.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'Vanguard S&P 500' },
  'VDPG.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'Vanguard Dev. World' },
  'VERG.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'Vanguard FTSE Dev Europe' },
  'VERX.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'Vanguard Europe ex-UK' },
  'VAPX.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'Vanguard Asia Pac ex-Japan' },
  'SWDA.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares MSCI World' },
  'IWDA.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares Core MSCI World' },
  'FTAL.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares FTSE All-Share' },
  'ISF.L':  { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares FTSE 100' },
  'IEUX.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares MSCI Europe ex-UK' },
  'IPXJ.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares Pacific ex-Japan' },
  'IGLN.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares Physical Gold' },
  'SGLN.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares Physical Gold ETC' },
  'SEMI.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares Global Semiconductors' },
  'DFND.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares Aerospace & Defence' },
  'SJPA.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares Core MSCI Japan' },
  'IIND.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares MSCI India' },
  'EXCS.L': { decimals: 2, ccy: 'GBP', group: 'ukEtfs', name: 'iShares EM ex-China' },
};

export const CORE_SYMBOLS = Object.keys(SYMBOLS);

// Benchmark used for beta / relative performance
export const BENCHMARK = '^GSPC';
export const GBP_BENCHMARK = '^FTSE';

// ─── Risk model factor proxies ────────────────────────────────
// Used by stress testing and factor decomposition. Each factor maps to a
// tradeable proxy so exposures can be estimated by regression on real data.
export const FACTORS = {
  usEquity:    '^GSPC',
  intlEquity:  '^STOXX50E',
  emEquity:    'EEM',
  ukEquity:    '^FTSE',
  rates:       '^TNX',
  dollar:      'DX-Y.NYB',
  gold:        'GC=F',
  oil:         'CL=F',
  volatility:  '^VIX',
};

// ─── Historical stress scenarios ──────────────────────────────
// Real date windows replayed against current holdings using each holding's
// own history where available, falling back to factor proxies.
export const SCENARIOS = [
  { id: 'covid2020',  label: 'COVID crash',        from: '2020-02-19', to: '2020-03-23',
    note: 'Fastest 30% drawdown in S&P history. Correlations went to 1.' },
  { id: 'rates2022',  label: '2022 rate shock',    from: '2022-01-03', to: '2022-10-12',
    note: 'Stocks and bonds fell together. Traditional 60/40 failed.' },
  { id: 'gfc2008',    label: 'GFC',                from: '2007-10-09', to: '2009-03-09',
    note: 'Deepest post-war drawdown. Recovery took 4 years.' },
  { id: 'q4_2018',    label: 'Q4 2018 selloff',    from: '2018-09-20', to: '2018-12-24',
    note: 'Fed tightening into slowing growth. Sharp but short.' },
  { id: 'eurocrisis', label: 'Euro crisis',        from: '2011-07-07', to: '2011-10-03',
    note: 'European sovereign stress. UK and EU equity hit hardest.' },
  { id: 'aug2024',    label: 'Yen carry unwind',   from: '2024-07-16', to: '2024-08-05',
    note: 'Violent, brief. Punished momentum and crowded longs.' },
];

// ─── News sources ─────────────────────────────────────────────
// Expanded from the original 8 after a research pass (not a live fetch-test —
// this environment's network policy blocks arbitrary outbound domains, so
// every URL below is reasoned from each outlet's known RSS history, not
// verified). Where an outlet publishes both a whole-site feed and a
// markets/business-only one, both are included — the whole-site feed as the
// primary entry, the section feed as a deliberate add-on, not a substitute.
//
// Left out entirely, with reasons: Reuters (feeds.reuters.com was shut down
// company-wide around 2020 — this is almost certainly why it already failed
// intermittently before this list existed), Bloomberg and The Times (neither
// has run public RSS in years), CFR and the pre-expansion ECB URL (both
// pointed at HTML landing pages, not real feed files — ECB's corrected below),
// Foreign Affairs/WSJ/The Economist (paywalled enough that RSS is unlikely to
// carry real content), Axios and WTO (no confidently-real endpoint found),
// AnandTech (stopped publishing in 2022 — a working feed would still be
// empty), and the AP entry (only reachable via a third-party public RSSHub
// proxy, not AP directly — too fragile to depend on).
//
// A bad URL here is inert, not fatal: refreshNews() logs and skips per-feed
// failures already, and the News page surfaces them via `failedFeeds`.
export const RSS_FEEDS = [
  // ─── Core financial press ───────────────────────────────────────────────
  { id: 'ft-home',       source: 'FT',              url: 'https://www.ft.com/?format=rss',                             tags: ['markets', 'international'], weight: 1.15 },
  { id: 'ft-markets',    source: 'FT',              url: 'https://www.ft.com/markets?format=rss',                      tags: ['markets'], weight: 1.2 },
  { id: 'bbc-home',      source: 'BBC',             url: 'https://feeds.bbci.co.uk/news/rss.xml',                      tags: ['uk', 'international'], weight: 0.8 },
  { id: 'bbc-biz',       source: 'BBC',             url: 'https://feeds.bbci.co.uk/news/business/rss.xml',             tags: ['markets', 'uk'], weight: 1.05 },
  { id: 'bbc-world',     source: 'BBC',             url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                tags: ['geopolitics'], weight: 0.85 },
  { id: 'guardian-home', source: 'Guardian',        url: 'https://www.theguardian.com/uk/rss',                         tags: ['uk', 'international'], weight: 0.75 },
  { id: 'guardian-biz',  source: 'Guardian',        url: 'https://www.theguardian.com/uk/business/rss',                tags: ['uk'], weight: 1.0 },
  { id: 'cnbc-mkt',      source: 'CNBC',            url: 'https://search.cnbc.com/rs/search/combinedcstream.htm?partnerId=2000&id=10000664', tags: ['markets', 'us'], weight: 1.15 },
  { id: 'yahoo-fin',     source: 'Yahoo Finance',   url: 'https://finance.yahoo.com/news/rssindex',                    tags: ['markets'], weight: 1.1 },
  { id: 'seeking-mkt',   source: 'Seeking Alpha',   url: 'https://seekingalpha.com/market_currents.xml',               tags: ['markets'], weight: 1.1 },
  { id: 'boe',           source: 'Bank of England', url: 'https://www.bankofengland.co.uk/rss/news',                   tags: ['uk', 'centralbank'], weight: 1.2 },

  // ─── General / international press ──────────────────────────────────────
  { id: 'nyt-home',        source: 'NYT',        url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', tags: ['us', 'international'], weight: 0.8 },
  { id: 'nyt-business',    source: 'NYT',        url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', tags: ['markets', 'us'], weight: 1.05 },
  { id: 'nyt-economy',     source: 'NYT',        url: 'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml',  tags: ['markets', 'us'], weight: 1.1 },
  { id: 'politico-pol',    source: 'Politico',   url: 'https://rss.politico.com/politics-news.xml',                tags: ['politics', 'us'], weight: 0.8 },
  { id: 'politico-eco',    source: 'Politico',   url: 'https://rss.politico.com/economy.xml',                      tags: ['politics', 'us'], weight: 0.95 },
  { id: 'telegraph-home',  source: 'Telegraph',  url: 'https://www.telegraph.co.uk/rss.xml',                       tags: ['uk', 'international'], weight: 0.75 },
  { id: 'telegraph-biz',   source: 'Telegraph',  url: 'https://www.telegraph.co.uk/business/rss.xml',              tags: ['uk', 'markets'], weight: 1.0 },
  { id: 'independent-home', source: 'Independent', url: 'https://www.independent.co.uk/rss',                       tags: ['uk', 'international'], weight: 0.7 },
  { id: 'independent-biz', source: 'Independent', url: 'https://www.independent.co.uk/news/business/rss',          tags: ['uk', 'markets'], weight: 0.95 },

  // ─── Central banks ───────────────────────────────────────────────────────
  { id: 'fed-press',   source: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', tags: ['centralbank', 'us'], weight: 1.25 },
  // Corrected from an earlier draft that pointed at .../rss/press.html — that
  // path is an HTML index of feed links, not a feed file itself.
  { id: 'ecb-press',   source: 'ECB',             url: 'https://www.ecb.europa.eu/rss/press.xml',             tags: ['centralbank', 'europe'], weight: 1.2 },
  { id: 'boj-press',   source: 'Bank of Japan',   url: 'https://www.boj.or.jp/en/rss/whatsnew.xml',           tags: ['centralbank', 'japan'], weight: 1.15 },
  { id: 'imf-news',    source: 'IMF',             url: 'https://www.imf.org/en/News/RSS?Language=ENG',        tags: ['centralbank', 'international'], weight: 1.05 },
  { id: 'worldbank',   source: 'World Bank',      url: 'https://www.worldbank.org/en/news/all.rss',           tags: ['centralbank', 'international'], weight: 0.95 },
  { id: 'bis-press',   source: 'BIS',             url: 'https://www.bis.org/doclist/press_releases.rss',      tags: ['centralbank', 'international'], weight: 1.05 },

  // ─── UK government / policy ─────────────────────────────────────────────
  { id: 'hmtreasury',   source: 'HM Treasury',    url: 'https://www.gov.uk/government/organisations/hm-treasury.atom', tags: ['politics', 'uk'], weight: 1.15 },
  { id: 'uk-govt-news', source: 'UK Government',  url: 'https://www.gov.uk/search/news-and-communications.atom',       tags: ['politics', 'uk'], weight: 0.75 },
  { id: 'ons-releases', source: 'ONS',            url: 'https://www.ons.gov.uk/releases/rss',                          tags: ['uk', 'economic-data'], weight: 1.2 },
  { id: 'ustr',         source: 'USTR',           url: 'https://ustr.gov/rss/press-releases',                          tags: ['trade', 'us'], weight: 1.0 },

  // ─── Geopolitics ─────────────────────────────────────────────────────────
  { id: 'aljazeera', source: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', tags: ['geopolitics', 'middleeast'], weight: 0.7 },

  // ─── Trade / supply chain / shipping ────────────────────────────────────
  { id: 'splash247',    source: 'Splash 247',   url: 'https://splash247.com/feed/',        tags: ['shipping', 'supplychain'], weight: 0.9 },
  { id: 'freightwaves', source: 'FreightWaves', url: 'https://www.freightwaves.com/feed',  tags: ['supplychain', 'us'], weight: 0.9 },

  // ─── Sector-specific ─────────────────────────────────────────────────────
  { id: 'oilprice',     source: 'OilPrice.com',    url: 'https://oilprice.com/rss/main',           tags: ['energy', 'commodities'], weight: 1.05 },
  { id: 'mining-com',   source: 'Mining.com',      url: 'https://www.mining.com/feed/',            tags: ['commodities', 'gold'], weight: 1.0 },
  { id: 'kitco',        source: 'Kitco',           url: 'https://www.kitco.com/rss/KitcoNews.xml', tags: ['gold', 'commodities'], weight: 1.0 },
  { id: 'semiengineer', source: 'SemiEngineering', url: 'https://semiengineering.com/feed/',       tags: ['tech', 'semiconductors'], weight: 1.0 },

  // ─── UK passive/index-investing specific ────────────────────────────────
  { id: 'monevator', source: 'Monevator', url: 'https://monevator.com/feed/', tags: ['uk', 'indexinvesting'], weight: 0.9 },

  // ─── Independent macro/analyst commentary ───────────────────────────────
  { id: 'zerohedge',      source: 'ZeroHedge',           url: 'https://feeds.feedburner.com/zerohedge/feed',               tags: ['markets', 'contrarian'], weight: 0.8 },
  { id: 'calculatedrisk', source: 'Calculated Risk',     url: 'https://www.calculatedriskblog.com/feeds/posts/default',    tags: ['markets', 'us', 'economic-data'], weight: 1.05 },
  { id: 'marginalrev',    source: 'Marginal Revolution', url: 'https://marginalrevolution.com/feed',                       tags: ['macro', 'economics'], weight: 0.9 },

  // ─── Crypto ──────────────────────────────────────────────────────────────
  { id: 'coindesk',      source: 'CoinDesk',      url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', tags: ['crypto'], weight: 0.95 },
  { id: 'cointelegraph', source: 'Cointelegraph', url: 'https://cointelegraph.com/rss',                    tags: ['crypto'], weight: 0.9 },

  // ─── Central European press (Eurozone exposure via VERG.L) ──────────────
  { id: 'euractiv',    source: 'Euractiv',    url: 'https://www.euractiv.com/feed/', tags: ['europe', 'politics'], weight: 0.85 },
  { id: 'politico-eu', source: 'Politico EU', url: 'https://www.politico.eu/feed/',  tags: ['europe', 'politics'], weight: 0.85 },

  // ─── Japan / Asia-Pacific (given IPXJ-style exposure themes) ────────────
  { id: 'nikkei-asia',   source: 'Nikkei Asia', url: 'https://asia.nikkei.com/rss/feed/nar', tags: ['japan', 'asia'], weight: 0.8 },
  { id: 'scmp-business', source: 'SCMP',        url: 'https://www.scmp.com/rss/91/feed',     tags: ['asia', 'china'], weight: 0.75 },
];

// Tax wrappers — drives rebalancing logic
export const WRAPPERS = {
  ISA:     { label: 'Stocks & Shares ISA', cgt: false, dividendTax: false, annualLimit: 20000 },
  SIPP:    { label: 'SIPP',                cgt: false, dividendTax: false, annualLimit: 60000 },
  GIA:     { label: 'General Investment',  cgt: true,  dividendTax: true,  annualLimit: null },
};

// UK CGT allowance (2026/27) — used by the rebalancer to flag taxable events
export const CGT_ALLOWANCE = 3000;
export const CGT_RATE_BASIC = 0.18;
export const CGT_RATE_HIGHER = 0.24;
export const DIVIDEND_ALLOWANCE = 500;

export const TRADING_DAYS = 252;
