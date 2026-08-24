import React, { useState, useEffect, useCallback, useRef } from "react";
import { AreaChart, Area, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { fetchLivePrices, fetchFearAndGreed, FALLBACK_PRICES } from "./prices.js";
import { GEMINI_API_KEY, GEMINI_MODEL } from "./config.js";

// ============================================================
// SHARED AI HELPER  (Google Gemini, free tier)
// All AI features route through this single function.
// Reads the key saved in Settings (localStorage) first, then .env.
// To change model, edit GEMINI_MODEL in config.js.
// ============================================================
function getGeminiKey() {
  try { return localStorage.getItem("meridian_gemini_key") || GEMINI_API_KEY || ""; }
  catch { return GEMINI_API_KEY || ""; }
}

// News relevance scoring happens server-side on the refresh loop, so the
// backend needs its own copy of the key. Best-effort and silent: if the
// server isn't up, the frontend's own AI features still work fine.
async function pushKeyToServer(key) {
  try {
    await fetch(`${API}/settings/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key ?? "" }),
    });
  } catch { /* server not running — nothing to do */ }
}

/** Sync an existing browser key to the backend if the backend has none. */
async function syncKeyToServerIfNeeded() {
  const key = getGeminiKey();
  if (!key) return;
  try {
    const res = await fetch(`${API}/settings/ai`);
    const data = await res.json();
    if (!data.enabled) await pushKeyToServer(key);
  } catch { /* server not running */ }
}

async function callAI(prompt, maxTokens = 600) {
  const key = getGeminiKey();
  if (!key) {
    return { ok: false, text: "No Gemini API key set. Add your free key in Settings (or .env) to enable AI features. Get one at aistudio.google.com." };
  }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
        }),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, text: `AI request failed (${res.status}). ${detail.slice(0, 140)}` };
    }
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    return text ? { ok: true, text } : { ok: false, text: "AI returned an empty response — try again." };
  } catch {
    return { ok: false, text: "AI service unreachable. Check your connection and key in Settings." };
  }
}

// ============================================================
// LIVE MARKET REGIME  (derived from VIX + S&P momentum)
// Degrades gracefully: partial data lowers confidence,
// no data returns a neutral "awaiting data" state.
// ============================================================
function computeRegime(prices) {
  const vix = prices?.["^VIX"]?.price;
  const spx = prices?.["^GSPC"];
  const spxDay = spx?.changePct;
  const spxWeek = spx?.weekChangePct;

  if (vix == null && spxDay == null) {
    return { label: "AWAITING DATA", color: "#7a8ba0", confidence: 0,
      rationale: "Live market data not yet loaded — start the price proxy to populate.",
      subLabel: "No Signal" };
  }

  let score = 0;
  const notes = [];

  if (vix != null) {
    if (vix < 14)      { score += 2; notes.push(`VIX ${vix.toFixed(1)} (calm)`); }
    else if (vix < 18) { score += 1; notes.push(`VIX ${vix.toFixed(1)} (normal)`); }
    else if (vix < 24) { score -= 1; notes.push(`VIX ${vix.toFixed(1)} (elevated)`); }
    else               { score -= 2; notes.push(`VIX ${vix.toFixed(1)} (stressed)`); }
  }

  if (spxWeek != null) {
    const s = (spxWeek >= 0 ? "+" : "") + spxWeek.toFixed(1);
    if (spxWeek > 1.5)       { score += 2; notes.push(`S&P ${s}% on week`); }
    else if (spxWeek > 0)    { score += 1; notes.push(`S&P ${s}% on week`); }
    else if (spxWeek > -1.5) { score -= 1; notes.push(`S&P ${s}% on week`); }
    else                     { score -= 2; notes.push(`S&P ${s}% on week`); }
  } else if (spxDay != null) {
    const s = (spxDay >= 0 ? "+" : "") + spxDay.toFixed(1);
    if (spxDay >= 0) { score += 1; notes.push(`S&P ${s}% today`); }
    else             { score -= 1; notes.push(`S&P ${s}% today`); }
  }

  let label, color, subLabel;
  if (score >= 3)       { label = "RISK-ON / TRENDING";   color = "#00d4aa"; subLabel = "Constructive Tape"; }
  else if (score >= 1)  { label = "MILDLY RISK-ON";       color = "#4ade80"; subLabel = "Grinding Higher"; }
  else if (score >= -1) { label = "CHOPPY / MIXED";       color = "#fbbf24"; subLabel = "No Clear Edge"; }
  else if (score >= -3) { label = "RISK-OFF / DEFENSIVE"; color = "#f87171"; subLabel = "Caution Warranted"; }
  else                  { label = "RISK-OFF / STRESSED";  color = "#ff4757"; subLabel = "Elevated Stress"; }

  const signals = (vix != null ? 1 : 0) + ((spxWeek != null || spxDay != null) ? 1 : 0);
  const confidence = Math.min(88, 40 + Math.abs(score) * 10 + signals * 4);
  const live = spx?.live || prices?.["^VIX"]?.live;
  const rationale = notes.join(", ") + (live ? "" : " (fallback data)");

  return { label, color, confidence, rationale, subLabel };
}


// ============================================================
// SHARED DATA ENGINE & CONSTANTS
// ============================================================

const POLL_INTERVAL = 60000;

const TICKERS = {
  usIndices:  ["^GSPC", "^IXIC", "VUSA.L"],
  intIndices: ["^FTSE", "^STOXX50E", "VDPG.L", "EEM"],
  volatility: ["^VIX"],
  gold:       ["GC=F", "SGLN.L"],
  energy:     ["CL=F", "BZ=F", "NG=F"],
  forex:      ["GBPUSD=X", "EURUSD=X"],
};

const ALL_SYMBOLS = [
  ...TICKERS.usIndices,
  ...TICKERS.intIndices,
  ...TICKERS.volatility,
  ...TICKERS.gold,
  ...TICKERS.energy,
  ...TICKERS.forex,
];

const DISPLAY_NAMES = {
  "^GSPC": "S&P 500", "^IXIC": "NASDAQ Comp.", "VUSA.L": "VUSA (Vanguard S&P)",
  "^FTSE": "FTSE 100", "^STOXX50E": "EuroStoxx 50", "VDPG.L": "Asia Pac ex-JP", "EEM": "Emerging Mkts",
  "^VIX": "VIX",
  "GC=F": "Gold", "SGLN.L": "iShares Gold (SGLN)",
  "CL=F": "WTI Crude", "BZ=F": "Brent", "NG=F": "Nat Gas",
  "GBPUSD=X": "GBP/USD", "EURUSD=X": "EUR/USD",
};

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: "⬡" },
  { id: "risk", label: "Risk", icon: "◉" },
  { id: "macro", label: "Macro", icon: "◈" },
  { id: "research", label: "Research", icon: "◎" },
  { id: "portfolio", label: "Portfolio", icon: "◰" },
  { id: "watchlist", label: "Watchlist", icon: "◫" },
  { id: "screener", label: "Screener", icon: "▦" },
  { id: "forex", label: "FX & Commod.", icon: "◬" },
  { id: "calendar", label: "Calendar", icon: "▣" },
  { id: "news", label: "News", icon: "◉" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

function applyDrift(price, symbol) {
  const v = { "^VIX": 0.004, "NG=F": 0.003, "CL=F": 0.002, "BZ=F": 0.002 }[symbol] || 0.0008;
  return +(price * (1 + (Math.random() - 0.5) * v)).toFixed(
    symbol.includes("=X") ? 4 : (symbol === "^TNX" || symbol === "^IRX") ? 3 : 2
  );
}

const MOCK_MOVERS = [
  { symbol: "NVDA", name: "NVIDIA Corp", change: 4.82, changeAmt: 42.18, price: 914.30, volume: "89.2M", reason: "AI chip demand upgrade" },
  { symbol: "TSLA", name: "Tesla Inc", change: -3.21, changeAmt: -6.84, price: 206.15, volume: "112.4M", reason: "Delivery miss concerns" },
  { symbol: "META", name: "Meta Platforms", change: 2.94, changeAmt: 15.22, price: 533.18, volume: "22.1M", reason: "Ad revenue beats" },
  { symbol: "AAPL", name: "Apple Inc", change: -1.18, changeAmt: -2.14, price: 179.44, volume: "45.7M", reason: "iPhone demand weakness" },
  { symbol: "AMD", name: "Advanced Micro", change: 3.67, changeAmt: 7.92, price: 223.84, volume: "38.9M", reason: "Data center expansion" },
  { symbol: "AMZN", name: "Amazon.com", change: 1.89, changeAmt: 3.62, price: 195.22, volume: "28.3M", reason: "AWS growth outlook" },
];

const MOCK_CATALYSTS = [
  { time: "08:30", type: "macro", importance: "high", title: "Non-Farm Payrolls", detail: "Est: 185K | Prev: 199K", assets: ["USD", "SPY", "Gold"] },
  { time: "10:00", type: "macro", importance: "high", title: "ISM Manufacturing PMI", detail: "Est: 48.4 | Prev: 47.8", assets: ["USD", "IWM"] },
  { time: "14:00", type: "fed", importance: "high", title: "Fed Governor Waller speaks", detail: "Monetary policy outlook", assets: ["USD", "Yields", "SPY"] },
  { time: "After Close", type: "earnings", importance: "medium", title: "COST Earnings", detail: "EPS Est: $3.71", assets: ["COST", "XRT"] },
  { time: "After Close", type: "earnings", importance: "medium", title: "LULU Earnings", detail: "EPS Est: $4.25", assets: ["LULU", "XLY"] },
];

const PORTFOLIO_ALERTS = [
  { symbol: "NVDA", type: "news", message: "Breaking: AI chip export restrictions eased — direct catalyst", severity: "high" },
  { symbol: "GLD", type: "level", message: "Approaching 52-week high resistance at $185.40", severity: "medium" },
  { symbol: "AAPL", type: "earnings", message: "Earnings in 6 days — implied move ±4.2%", severity: "medium" },
  { symbol: "TSLA", type: "concentration", message: "Position now 18.4% of portfolio — above 15% threshold", severity: "high" },
];

const REGIME_INDICATORS = {
  label: "RISK-ON / TRENDING",
  color: "#00d4aa",
  confidence: 72,
  rationale: "Breadth expanding, VIX compressing, momentum leadership intact",
  subLabel: "Earnings-Heavy Week",
};

// ── MACRO PAGE DATA ──────────────────────────────────────────
const MACRO_CALENDAR_EVENTS = [
  { date: "Mar 12", time: "08:30", event: "CPI (YoY)", importance: "high", est: "3.1%", prev: "3.2%", assets: ["USD","SPY","Gold","Bonds"] },
  { date: "Mar 14", time: "08:30", event: "PPI (MoM)", importance: "high", est: "0.3%", prev: "0.3%", assets: ["USD","Bonds"] },
  { date: "Mar 15", time: "08:30", event: "Retail Sales", importance: "medium", est: "0.6%", prev: "-0.8%", assets: ["USD","XRT","SPY"] },
  { date: "Mar 19", time: "14:00", event: "FOMC Decision", importance: "high", est: "No Change", prev: "5.25-5.50%", assets: ["USD","SPY","Gold","Bonds","All"] },
  { date: "Mar 20", time: "08:30", event: "Non-Farm Payrolls", importance: "high", est: "185K", prev: "199K", assets: ["USD","SPY","Gold"] },
  { date: "Mar 22", time: "10:00", event: "ISM Manufacturing", importance: "medium", est: "48.4", prev: "47.8", assets: ["USD","IWM"] },
  { date: "Mar 28", time: "08:30", event: "PCE Price Index", importance: "high", est: "2.5%", prev: "2.4%", assets: ["USD","SPY","Bonds","Gold"] },
];

const BREADTH_DATA = {
  above200dma: 68.4,
  above50dma: 54.2,
  above20dma: 48.8,
  advDecLine: "+842",
  new52wHigh: 87,
  new52wLow: 23,
  bullBearSpread: "+12.4%",
  sectors: [
    { name: "Tech", above50: 71, momentum: "strong" },
    { name: "Energy", above50: 44, momentum: "weak" },
    { name: "Financials", above50: 62, momentum: "neutral" },
    { name: "Healthcare", above50: 55, momentum: "neutral" },
    { name: "Consumer Disc", above50: 58, momentum: "improving" },
    { name: "Industrials", above50: 60, momentum: "improving" },
  ],
};

const CROSS_ASSET_DATA = [
  { name: "S&P 500", symbol: "SPY", category: "equity", weekChg: 1.42, monthChg: 3.81 },
  { name: "US 10Y Bond", symbol: "^TNX", category: "bonds", weekChg: -0.82, monthChg: -1.24 },
  { name: "DXY Dollar", symbol: "DX-Y.NYB", category: "dollar", weekChg: 0.34, monthChg: 0.88 },
  { name: "Gold", symbol: "GC=F", category: "gold", weekChg: -0.54, monthChg: 2.12 },
  { name: "WTI Oil", symbol: "CL=F", category: "oil", weekChg: 1.18, monthChg: 4.22 },
  { name: "NASDAQ 100", symbol: "QQQ", category: "equity", weekChg: 1.84, monthChg: 4.92 },
];

const REGIME_MATRIX = {
  current: "TRENDING / RISK-ON",
  trending: true,
  highVol: false,
  growthLed: true,
  dollarUp: true,
  confidence: 72,
  historical: "Late 2023 post-Fed pivot phase",
  strategies: [
    { label: "Momentum continuation", works: true },
    { label: "Breakout plays", works: true },
    { label: "Mean reversion shorts", works: false },
    { label: "Defensive rotation", works: false },
    { label: "Growth over Value", works: true },
    { label: "Rate-sensitive longs", works: false },
  ],
  avoid: ["Fighting the trend", "Aggressive hedging", "Duration longs", "Deep value names"],
};

// ── PORTFOLIO PAGE DATA ───────────────────────────────────────
const INITIAL_HOLDINGS = [
  {
    id: 1, symbol: "NVDA", name: "NVIDIA Corp", type: "stock",
    shares: 15, avgCost: 612.40, currentPrice: 914.30,
    sector: "Technology", marketCap: "Large", geography: "US",
    factor: "Growth/Momentum", beta: 1.82,
    thesis: "AI infrastructure supercycle — data center GPU demand secular tailwind",
    catalyst: "Blackwell ramp + sovereign AI deals Q2",
    invalidation: "Close below $820 — 200DMA break on volume",
    timeHorizon: "Medium swing (3-6 months)",
    nextEvent: "Earnings Apr 24",
    thesisStatus: "intact",
    brokerUrl: null,
  },
  {
    id: 2, symbol: "TSLA", name: "Tesla Inc", type: "stock",
    shares: 40, avgCost: 248.60, currentPrice: 206.15,
    sector: "Consumer Disc", marketCap: "Large", geography: "US",
    factor: "Growth/Momentum", beta: 2.14,
    thesis: "FSD monetisation + energy storage inflection",
    catalyst: "Robotaxi launch date confirmation",
    invalidation: "Q2 delivery miss below 380K",
    timeHorizon: "Long term (12+ months)",
    nextEvent: "Delivery data Apr 2",
    thesisStatus: "weakening",
    brokerUrl: null,
  },
  {
    id: 3, symbol: "GLD", name: "SPDR Gold ETF", type: "etf",
    shares: 60, avgCost: 178.20, currentPrice: 185.40,
    sector: "Commodities", marketCap: "N/A", geography: "Global",
    factor: "Defensive/Macro", beta: 0.08,
    thesis: "Hedge against rate cut delay + geopolitical risk premium",
    catalyst: "Fed dovish pivot / geopolitical escalation",
    invalidation: "DXY breaks above 107 sustained",
    timeHorizon: "Long term hedge",
    nextEvent: "PCE data Mar 28",
    thesisStatus: "intact",
    brokerUrl: null,
  },
  {
    id: 4, symbol: "META", name: "Meta Platforms", type: "stock",
    shares: 12, avgCost: 384.20, currentPrice: 533.18,
    sector: "Technology", marketCap: "Large", geography: "US",
    factor: "Growth", beta: 1.24,
    thesis: "Ad market recovery + AI-driven engagement monetisation",
    catalyst: "Llama / AI ad tools rollout",
    invalidation: "Ad revenue growth slows below 15% YoY",
    timeHorizon: "Medium swing (3-6 months)",
    nextEvent: "Earnings Apr 30",
    thesisStatus: "intact",
    brokerUrl: null,
  },
  {
    id: 5, symbol: "ISGLD", name: "iShares Physical Gold ETC", type: "etc",
    shares: 200, avgCost: 28.40, currentPrice: 30.82,
    sector: "Commodities", marketCap: "N/A", geography: "Global",
    factor: "Defensive/Macro", beta: 0.07,
    thesis: "Physical gold exposure, GBP-hedged, HL-held position",
    catalyst: "Dollar weakness + central bank buying",
    invalidation: "Gold spot breaks below $2100",
    timeHorizon: "Long term",
    nextEvent: "PCE data Mar 28",
    thesisStatus: "intact",
    brokerUrl: "https://www.hl.co.uk/shares/shares-search-results/i/ishares-physical-metals-physical-gold-etc",
  },
];

const CORRELATION_CLUSTERS = [
  { group: "AI/Tech Beta", members: ["NVDA", "META", "AMD"], correlation: 0.82, color: "#3d8bff" },
  { group: "Gold/Macro Hedge", members: ["GLD", "ISGLD"], correlation: 0.96, color: "#ffa502" },
  { group: "Consumer/Discretionary", members: ["TSLA"], correlation: null, color: "#a855f7" },
];

// ============================================================
// UTILITY HOOKS & HELPERS
// ============================================================

function useMarketData() {
  const [prices, setPrices] = useState(() => {
    const init = {};
    ALL_SYMBOLS.forEach(s => {
      init[s] = { price: FALLBACK_PRICES[s] || 100, prev: FALLBACK_PRICES[s] || 100, change: 0, changePct: 0, live: false };
    });
    return init;
  });
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [pulseCount, setPulseCount] = useState(0);
  const [dataSource, setDataSource] = useState("loading"); // "live" | "fallback" | "loading"
  const liveRef = useRef({});

  const fetchAndApply = useCallback(async () => {
    const live = await fetchLivePrices();
    const gotSome = live && Object.keys(live).length > 0;
    if (gotSome) {
      liveRef.current = live;
      setDataSource("live");
    } else if (dataSource === "loading") {
      setDataSource("fallback");
    }
    setPrices(prev => {
      const next = { ...prev };
      ALL_SYMBOLS.forEach(s => {
        if (live && live[s]?.price) {
          const newPrice = live[s].price;
          const oldPrice = prev[s].price || FALLBACK_PRICES[s] || newPrice;
          const change = +(newPrice - oldPrice).toFixed(4);
          const changePct = oldPrice ? +((change / oldPrice) * 100).toFixed(2) : 0;
          next[s] = { price: newPrice, prev: oldPrice, change, changePct, live: true, weekChangePct: live[s].weekChangePct ?? null };
        } else if (liveRef.current[s]?.price) {
          const drifted = applyDrift(prev[s].price, s);
          next[s] = { ...prev[s], price: drifted, live: true };
        } else {
          const drifted = applyDrift(prev[s].price, s);
          next[s] = { ...prev[s], price: drifted, live: false };
        }
      });
      return next;
    });
    setLastUpdate(new Date());
    setPulseCount(c => c + 1);
  }, []);

  useEffect(() => {
    fetchAndApply();
    const interval = setInterval(fetchAndApply, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchAndApply]);

  return { prices, lastUpdate, pulseCount, poll: fetchAndApply, dataSource };
}

function formatPrice(price, symbol) {
  if (!price) return "—";
  if (symbol?.includes("=X")) return price.toFixed(4);
  if (symbol === "^IRX" || symbol === "^TNX") return price.toFixed(3) + "%";
  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatChange(pct) {
  if (pct === undefined || pct === null) return "—";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

// ============================================================
// AI BRIEF ENGINE
// ============================================================

async function fetchAIMacro(prices, setAiMacro, setAiMacroLoading) {
  setAiMacroLoading(true);
  const vix = prices["^VIX"]?.price?.toFixed(2) || "16.82";
  const tnx = prices["^TNX"]?.price?.toFixed(3) || "4.312";
  const irx = prices["^IRX"]?.price?.toFixed(3) || "5.024";
  const dxy = prices["DX-Y.NYB"]?.price?.toFixed(2) || "104.22";
  const gold = prices["GC=F"]?.price?.toFixed(0) || "2318";
  const oil = prices["CL=F"]?.price?.toFixed(2) || "82.14";

  const prompt = `You are a macro strategist at a top hedge fund. Current market data: VIX=${vix}, 10Y Yield=${tnx}%, 2Y Yield=${irx}%, DXY=${dxy}, Gold=$${gold}, WTI Oil=$${oil}. Yield curve is inverted (2Y > 10Y).

Answer these four questions in plain, direct language. No bullet points, no markdown. Write each answer as a short paragraph labeled clearly:

REGIME: What macro regime are we currently in? Be specific.
STRATEGIES: What 2-3 trading strategies work best in this environment and why?
AVOID: What should traders stop doing right now, and why is it dangerous?
SENSITIVITY: What is the market most sensitive to this week?

Be opinionated. Be specific. No generic answers.`;

  const { text } = await callAI(prompt, 1000);
  setAiMacro(text);
  setAiMacroLoading(false);
}

async function fetchAIPortfolio(holdings, setAiPortfolio, setAiPortfolioLoading) {
  setAiPortfolioLoading(true);
  const summary = holdings.map(h => {
    const pl = ((h.currentPrice - h.avgCost) / h.avgCost * 100).toFixed(1);
    return `${h.symbol} (${h.sector}, beta ${h.beta}, P&L ${pl}%, thesis: ${h.thesisStatus})`;
  }).join("; ");
  const totalValue = holdings.reduce((s, h) => s + h.shares * h.currentPrice, 0);
  const weights = holdings.map(h => `${h.symbol}: ${(h.shares * h.currentPrice / totalValue * 100).toFixed(1)}%`).join(", ");

  const prompt = `You are a portfolio risk manager reviewing a trader's book. Holdings: ${summary}. Weights: ${weights}.

Write a concise portfolio health check (3 short paragraphs) covering:
1. Concentration and correlation risk — what factor is this portfolio really exposed to?
2. The biggest single risk to the portfolio right now
3. One specific tactical recommendation

Be direct. Be specific. Call out problems clearly. Plain text only.`;

  const { text } = await callAI(prompt, 800);
  setAiPortfolio(text);
  setAiPortfolioLoading(false);
}

async function fetchAIBrief(prices, setAiBrief, setAiLoading) {
  setAiLoading(true);
  const snapshot = Object.entries(DISPLAY_NAMES).map(([sym, name]) => {
    const d = prices[sym];
    if (!d) return "";
    return `${name}: ${formatPrice(d.price, sym)} (${formatChange(d.changePct)})`;
  }).filter(Boolean).join(", ");

  const prompt = `You are a sharp, senior market analyst writing the morning brief for an intermediate-to-advanced trader. Based on this market snapshot: ${snapshot}

Write a concise, high-signal daily brief (3-4 paragraphs) that:
1. States the current market regime clearly (risk-on/off, trending/choppy, etc.)
2. Explains what changed since yesterday and why it matters
3. Identifies where the primary opportunity AND risk sits today
4. Ends with one specific tactical note

Be direct, specific, and opinionated. No fluff. No hedging for the sake of it. Write like a Bloomberg Surveillance anchor, not a chatbot. Use plain text, no markdown.`;

  const { text } = await callAI(prompt, 1000);
  setAiBrief(text);
  setAiLoading(false);
}

// ============================================================
// COMPONENTS
// ============================================================

function PulseIndicator({ pulseCount, lastUpdate, dataSource }) {
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 600);
    return () => clearTimeout(t);
  }, [pulseCount]);

  const isLive = dataSource === "live";
  const color = isLive ? "#00d4aa" : dataSource === "loading" ? "#ffa502" : "#ff4757";
  const label = isLive ? "LIVE" : dataSource === "loading" ? "FETCHING..." : "FALLBACK";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{
        width: 7, height: 7, borderRadius: "50%",
        background: pulse ? color : `${color}66`,
        boxShadow: pulse ? `0 0 8px ${color}` : "none",
        transition: "all 0.3s ease",
      }} />
      <span style={{ fontSize: 10, color: "#4a5568", fontFamily: "monospace" }}>
        {label} · {lastUpdate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>
    </div>
  );
}

function TickerTape({ prices }) {
  const items = ALL_SYMBOLS.filter(s => DISPLAY_NAMES[s]);
  return (
    <div style={{
      background: "#0a0c0f",
      borderBottom: "1px solid #1a1f2e",
      padding: "6px 0",
      overflow: "hidden",
      position: "relative",
    }}>
      <div style={{
        display: "flex",
        gap: 32,
        animation: "tape 60s linear infinite",
        width: "max-content",
      }}>
        {[...items, ...items].map((sym, i) => {
          const d = prices[sym];
          if (!d) return null;
          const up = d.changePct >= 0;
          return (
            <span key={i} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, whiteSpace: "nowrap" }}>
              <span style={{ color: "#4a6080", fontFamily: "monospace" }}>{DISPLAY_NAMES[sym]}</span>
              <span style={{ color: "#c8d6e8", fontFamily: "monospace", fontWeight: 600 }}>{formatPrice(d.price, sym)}</span>
              <span style={{ color: up ? "#00d4aa" : "#ff4757", fontFamily: "monospace" }}>{formatChange(d.changePct)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function MarketCard({ symbol, prices, size = "normal" }) {
  const d = prices[symbol];
  if (!d) return null;
  const up = d.changePct >= 0;
  const isVIX = symbol === "^VIX";
  const upColor = isVIX ? "#ff4757" : "#00d4aa";
  const downColor = isVIX ? "#00d4aa" : "#ff4757";
  const color = up ? upColor : downColor;
  const weekUp = d.weekChangePct >= 0;
  const weekColor = isVIX ? (weekUp ? "#ff4757" : "#00d4aa") : (weekUp ? "#00d4aa" : "#ff4757");

  return (
    <div style={{
      background: "#0d1117",
      border: `1px solid ${color}22`,
      borderTop: `2px solid ${color}`,
      borderRadius: 6,
      padding: size === "large" ? "14px 16px" : "10px 12px",
      minWidth: size === "large" ? 140 : 110,
      flex: 1,
      position: "relative",
      overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", top: 0, right: 0, bottom: 0,
        width: "40%",
        background: `linear-gradient(to left, ${color}08, transparent)`,
      }} />
      <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", marginBottom: 4, letterSpacing: 1 }}>
        {DISPLAY_NAMES[symbol]}
      </div>
      <div style={{ fontSize: size === "large" ? 20 : 15, fontWeight: 700, color: "#e8f0fe", fontFamily: "monospace" }}>
        {formatPrice(d.price, symbol)}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 3, alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <span style={{ fontSize: 8, color: "#3a4558", fontFamily: "monospace" }}>1D</span>
          <span style={{ fontSize: 11, color, fontFamily: "monospace" }}>{formatChange(d.changePct)}</span>
        </div>
        {d.weekChangePct !== null && d.weekChangePct !== undefined && (
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span style={{ fontSize: 8, color: "#3a4558", fontFamily: "monospace" }}>1W</span>
            <span style={{ fontSize: 11, color: weekColor, fontFamily: "monospace" }}>{formatChange(d.weekChangePct)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function FearGreedGauge({ data }) {
  if (!data || !data.score) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 120, color: "#3a4558", fontSize: 11, fontFamily: "monospace" }}>
      LOADING FEAR & GREED...
    </div>
  );

  const score = data.score;
  const rating = data.rating?.replace(/_/g, ' ').toUpperCase() || '';

  const getColor = (s) => {
    if (s <= 25) return "#ff4757";
    if (s <= 45) return "#ff7043";
    if (s <= 55) return "#ffa502";
    if (s <= 75) return "#a8e063";
    return "#00d4aa";
  };

  const color = getColor(score);

  // SVG arc gauge
  const cx = 90, cy = 85, r = 65;
  const startAngle = -210;
  const endAngle = 30;
  const totalArc = endAngle - startAngle;
  const scoreAngle = startAngle + (score / 100) * totalArc;

  const toRad = (deg) => (deg * Math.PI) / 180;
  const arcPath = (start, end, radius) => {
    const s = { x: cx + radius * Math.cos(toRad(start)), y: cy + radius * Math.sin(toRad(start)) };
    const e = { x: cx + radius * Math.cos(toRad(end)), y: cy + radius * Math.sin(toRad(end)) };
    const large = end - start > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${radius} ${radius} 0 ${large} 1 ${e.x} ${e.y}`;
  };

  const needleX = cx + (r - 10) * Math.cos(toRad(scoreAngle));
  const needleY = cy + (r - 10) * Math.sin(toRad(scoreAngle));

  const zones = [
    { label: "EXT FEAR", start: -210, end: -156, color: "#ff4757" },
    { label: "FEAR", start: -156, end: -102, color: "#ff7043" },
    { label: "NEUTRAL", start: -102, end: -70, color: "#ffa502" },
    { label: "GREED", start: -70, end: -16, color: "#a8e063" },
    { label: "EXT GREED", start: -16, end: 30, color: "#00d4aa" },
  ];

  const comparisons = [
    { label: "PREV CLOSE", value: data.prevClose },
    { label: "1 WEEK AGO", value: data.weekAgo },
    { label: "1 MONTH AGO", value: data.monthAgo },
  ].filter(c => c.value != null);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "8px 0" }}>
      <svg width={180} height={110} style={{ overflow: "visible" }}>
        {/* Background track */}
        <path d={arcPath(startAngle, endAngle, r)} fill="none" stroke="#1a2535" strokeWidth={12} strokeLinecap="round" />
        {/* Coloured zone arcs */}
        {zones.map((z, i) => (
          <path key={i} d={arcPath(z.start, z.end, r)} fill="none" stroke={z.color + "40"} strokeWidth={12} />
        ))}
        {/* Active fill up to score */}
        <path d={arcPath(startAngle, scoreAngle, r)} fill="none" stroke={color} strokeWidth={12} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${color}80)` }} />
        {/* Needle dot */}
        <circle cx={needleX} cy={needleY} r={5} fill={color} style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
        {/* Center score */}
        <text x={cx} y={cy + 8} textAnchor="middle" fill={color} fontSize={28} fontWeight={700} fontFamily="monospace">{score}</text>
        {/* Rating label */}
        <text x={cx} y={cy + 24} textAnchor="middle" fill={color + "cc"} fontSize={8} fontFamily="monospace" letterSpacing={1}>{rating}</text>
      </svg>

      {/* Comparison row */}
      {comparisons.length > 0 && (
        <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
          {comparisons.map(c => {
            const diff = score - c.value;
            const diffColor = diff > 0 ? "#00d4aa" : diff < 0 ? "#ff4757" : "#4a6080";
            return (
              <div key={c.label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 8, color: "#3a4558", fontFamily: "monospace", letterSpacing: 0.5 }}>{c.label}</div>
                <div style={{ fontSize: 11, color: "#7a8ba0", fontFamily: "monospace" }}>{c.value}</div>
                <div style={{ fontSize: 9, color: diffColor, fontFamily: "monospace" }}>{diff > 0 ? "+" : ""}{diff}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RegimeBadge({ regime }) {
  return (
    <div style={{
      background: `${regime.color}15`,
      border: `1px solid ${regime.color}40`,
      borderRadius: 6,
      padding: "10px 16px",
      display: "flex",
      alignItems: "center",
      gap: 12,
    }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: regime.color, boxShadow: `0 0 6px ${regime.color}` }} />
          <span style={{ color: regime.color, fontFamily: "monospace", fontWeight: 700, fontSize: 12, letterSpacing: 1.5 }}>
            {regime.label}
          </span>
          <span style={{
            background: `${regime.color}20`,
            color: regime.color,
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 3,
            fontFamily: "monospace",
          }}>
            {regime.confidence}% CONF
          </span>
          <span style={{
            background: "#1a2535",
            color: "#7a8ba0",
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 3,
            fontFamily: "monospace",
          }}>
            {regime.subLabel}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "#7a8ba0" }}>{regime.rationale}</div>
      </div>
    </div>
  );
}

function MoverRow({ mover, i }) {
  const up = mover.change >= 0;
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      padding: "8px 12px",
      borderBottom: "1px solid #0f1420",
      gap: 12,
      background: i % 2 === 0 ? "transparent" : "#0a0d14",
    }}>
      <div style={{ width: 52 }}>
        <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#c8d6e8", fontSize: 13 }}>{mover.symbol}</div>
        <div style={{ fontSize: 10, color: "#4a6080" }}>{mover.name}</div>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, color: "#7a8ba0" }}>{mover.reason}</div>
        <div style={{ fontSize: 10, color: "#3a4558", marginTop: 2 }}>Vol: {mover.volume}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontFamily: "monospace", color: "#c8d6e8", fontSize: 13 }}>${mover.price.toFixed(2)}</div>
        <div style={{ fontFamily: "monospace", color: up ? "#00d4aa" : "#ff4757", fontSize: 12 }}>
          {up ? "+" : ""}{mover.change.toFixed(2)}%
        </div>
      </div>
    </div>
  );
}

function CatalystRow({ catalyst }) {
  const colors = { high: "#ff4757", medium: "#ffa502", low: "#4a6080" };
  const typeColors = { macro: "#3d8bff", fed: "#a855f7", earnings: "#00d4aa" };
  const color = colors[catalyst.importance];
  const tColor = typeColors[catalyst.type] || "#4a6080";

  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      padding: "8px 12px",
      borderBottom: "1px solid #0f1420",
      gap: 10,
    }}>
      <div style={{ minWidth: 70, fontFamily: "monospace", fontSize: 11, color: "#4a6080", paddingTop: 2 }}>
        {catalyst.time}
      </div>
      <div style={{
        minWidth: 6, width: 6, height: 6, borderRadius: "50%",
        background: color, marginTop: 5, boxShadow: `0 0 4px ${color}`,
      }} />
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <span style={{
            fontSize: 9, background: `${tColor}20`, color: tColor,
            padding: "1px 5px", borderRadius: 2, fontFamily: "monospace", letterSpacing: 0.5,
          }}>
            {catalyst.type.toUpperCase()}
          </span>
          <span style={{ fontSize: 12, color: "#c8d6e8", fontWeight: 600 }}>{catalyst.title}</span>
        </div>
        <div style={{ fontSize: 11, color: "#7a8ba0" }}>{catalyst.detail}</div>
        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
          {catalyst.assets.map(a => (
            <span key={a} style={{
              fontSize: 9, background: "#1a2535", color: "#4a6080",
              padding: "1px 5px", borderRadius: 2, fontFamily: "monospace",
            }}>{a}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function AlertRow({ alert }) {
  const colors = { high: "#ff4757", medium: "#ffa502" };
  const typeIcons = { news: "◎", level: "◈", earnings: "▣", concentration: "⚠" };
  const color = colors[alert.severity] || "#4a6080";

  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      padding: "8px 12px",
      borderBottom: "1px solid #0f1420",
      gap: 10,
      borderLeft: `2px solid ${color}`,
    }}>
      <span style={{ color, fontSize: 12, marginTop: 1 }}>{typeIcons[alert.type]}</span>
      <div>
        <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#c8d6e8", fontSize: 12, marginRight: 6 }}>
          {alert.symbol}
        </span>
        <span style={{ fontSize: 11, color: "#7a8ba0" }}>{alert.message}</span>
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle, action, onAction }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "13px 20px 11px",
      borderBottom: "1px solid #1a1f2e",
    }}>
      <div>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#c8d6e8", letterSpacing: 1.5, fontFamily: "monospace" }}>
          {title}
        </span>
        {subtitle && <span style={{ fontSize: 12, color: "#3a4558", marginLeft: 10 }}>{subtitle}</span>}
      </div>
      {action && (
        <button onClick={onAction} style={{
          background: "transparent",
          border: "1px solid #1a2535",
          color: "#4a6080",
          fontSize: 12,
          padding: "5px 12px",
          borderRadius: 3,
          cursor: "pointer",
          fontFamily: "monospace",
        }}>{action}</button>
      )}
    </div>
  );
}

function Panel({ children, style = {} }) {
  return (
    <div style={{
      background: "#0d1117",
      border: "1px solid #1a1f2e",
      borderRadius: 8,
      overflow: "hidden",
      ...style,
    }}>
      {children}
    </div>
  );
}

// ============================================================
// DASHBOARD PAGE
// ============================================================

function DashboardPage({ prices, pulseCount, lastUpdate, poll, dataSource }) {
  const [aiBrief, setAiBrief] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [briefGenerated, setBriefGenerated] = useState(false);
  const [activeMoversTab, setActiveMoversTab] = useState("gainers");
  const [marketStatus, setMarketStatus] = useState({ lse: {}, nyse: {} });
  const [fearGreed, setFearGreed] = useState(null);

  useEffect(() => {
    fetchFearAndGreed().then(d => { if (d && d.score) setFearGreed(d); });
    const t = setInterval(() => fetchFearAndGreed().then(d => { if (d && d.score) setFearGreed(d); }), 300000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const utcH = now.getUTCHours();
      const utcM = now.getUTCMinutes();
      const utcMins = utcH * 60 + utcM;
      const day = now.getUTCDay();
      const isWeekday = day >= 1 && day <= 5;
      const lseOpen = 8 * 60, lseClose = 16 * 60 + 30;
      const nyseOpen = 14 * 60 + 30, nyseClose = 21 * 60;
      const lseIsOpen = isWeekday && utcMins >= lseOpen && utcMins < lseClose;
      const nyseIsOpen = isWeekday && utcMins >= nyseOpen && utcMins < nyseClose;
      const minsUntil = (target) => {
        let diff = target - utcMins;
        if (diff < 0) diff += 24 * 60;
        return `${Math.floor(diff / 60)}h ${diff % 60}m`;
      };
      setMarketStatus({
        lse: { open: lseIsOpen, label: lseIsOpen ? "OPEN" : "CLOSED", next: lseIsOpen ? `Closes ${minsUntil(lseClose)}` : `Opens ${minsUntil(lseOpen)}` },
        nyse: { open: nyseIsOpen, label: nyseIsOpen ? "OPEN" : "CLOSED", next: nyseIsOpen ? `Closes ${minsUntil(nyseClose)}` : `Opens ${minsUntil(nyseOpen)}` },
      });
    };
    tick();
    const t = setInterval(tick, 30000);
    return () => clearInterval(t);
  }, []);

  const gainers = [...MOCK_MOVERS].filter(m => m.change > 0).sort((a, b) => b.change - a.change);
  const losers = [...MOCK_MOVERS].filter(m => m.change < 0).sort((a, b) => a.change - b.change);
  const movers = activeMoversTab === "gainers" ? gainers : losers;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Regime + countdown bar */}
      <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
        <div style={{ flex: 1 }}>
          <RegimeBadge regime={computeRegime(prices)} />
        </div>
        <div style={{
          background: "#0d1117",
          border: "1px solid #1a1f2e",
          borderRadius: 6,
          padding: "10px 16px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 160,
        }}>
          <div style={{ fontSize: 9, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 6 }}>MARKET STATUS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, width: "100%" }}>
            {[{ key: "lse", label: "LSE" }, { key: "nyse", label: "NYSE" }].map(({ key, label }) => {
              const s = marketStatus[key] || {};
              const color = s.open ? "#00d4aa" : "#ff4757";
              return (
                <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 11, color: "#7a8ba0" }}>{label}</span>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color }}>{s.label}</span>
                    <div style={{ fontSize: 9, color: "#4a6080" }}>{s.next}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{
          background: "#0d1117",
          border: "1px solid #1a1f2e",
          borderRadius: 6,
          padding: "10px 16px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 120,
        }}>
          <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4 }}>
            NEXT POLL
          </div>
          <PulseIndicator pulseCount={pulseCount} lastUpdate={lastUpdate} dataSource={dataSource} />
          <button onClick={poll} style={{
            marginTop: 6, background: "transparent", border: "1px solid #1a2535",
            color: "#4a6080", fontSize: 9, padding: "2px 8px", borderRadius: 3,
            cursor: "pointer", fontFamily: "monospace",
          }}>REFRESH NOW</button>
        </div>
      </div>

      {/* Global snapshot grid */}
      <div>
        <div style={{ fontSize: 10, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1.5, marginBottom: 8 }}>
          GLOBAL MARKET SNAPSHOT
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* US Indices */}
          <div>
            <div style={{ fontSize: 9, color: "#2a3548", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4 }}>US INDICES</div>
            <div style={{ display: "flex", gap: 8 }}>
              {TICKERS.usIndices.map(s => <MarketCard key={s} symbol={s} prices={prices} />)}
            </div>
          </div>
          {/* International Indices */}
          <div>
            <div style={{ fontSize: 9, color: "#2a3548", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4 }}>INTERNATIONAL INDICES</div>
            <div style={{ display: "flex", gap: 8 }}>
              {TICKERS.intIndices.map(s => <MarketCard key={s} symbol={s} prices={prices} />)}
            </div>
          </div>
          {/* Gold + VIX row */}
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 2 }}>
              <div style={{ fontSize: 9, color: "#2a3548", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4 }}>GOLD</div>
              <div style={{ display: "flex", gap: 8 }}>
                {TICKERS.gold.map(s => <MarketCard key={s} symbol={s} prices={prices} />)}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 9, color: "#2a3548", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4 }}>VOLATILITY</div>
              <div style={{ display: "flex", gap: 8 }}>
                {TICKERS.volatility.map(s => <MarketCard key={s} symbol={s} prices={prices} />)}
              </div>
            </div>
          </div>
          {/* Energy */}
          <div>
            <div style={{ fontSize: 9, color: "#2a3548", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4 }}>ENERGY</div>
            <div style={{ display: "flex", gap: 8 }}>
              {TICKERS.energy.map(s => <MarketCard key={s} symbol={s} prices={prices} />)}
            </div>
          </div>
          {/* Currencies */}
          <div>
            <div style={{ fontSize: 9, color: "#2a3548", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4 }}>CURRENCIES</div>
            <div style={{ display: "flex", gap: 8 }}>
              {TICKERS.forex.map(s => <MarketCard key={s} symbol={s} prices={prices} />)}
            </div>
          </div>
        </div>
      </div>

      {/* Main content grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>

        {/* Fear & Greed + AI Brief row */}
        <Panel style={{ gridColumn: "1 / 2" }}>
          <SectionHeader title="FEAR & GREED INDEX" subtitle="CNN Market Sentiment" />
          <FearGreedGauge data={fearGreed} />
        </Panel>

        {/* AI Daily Brief */}
        <Panel style={{ gridColumn: "2 / 4" }}>
          <SectionHeader
            title="AI DAILY BRIEF"
            subtitle="Generate on demand"
            action={aiLoading ? "GENERATING..." : "GENERATE BRIEF"}
            onAction={() => fetchAIBrief(prices, setAiBrief, setAiLoading)}
          />
          <div style={{ padding: 14 }}>
            {aiLoading ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{
                  width: 16, height: 16, border: "2px solid #1a2535",
                  borderTop: "2px solid #00d4aa", borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }} />
                <span style={{ color: "#4a6080", fontSize: 12, fontFamily: "monospace" }}>
                  Analysing market conditions...
                </span>
              </div>
            ) : aiBrief ? (
              <div style={{
                fontSize: 12, lineHeight: 1.7, color: "#a0b4c8",
                fontFamily: "'Georgia', serif",
                borderLeft: "2px solid #00d4aa30",
                paddingLeft: 12,
              }}>
                {aiBrief.split("\n\n").map((para, i) => (
                  <p key={i} style={{ margin: "0 0 10px 0" }}>{para}</p>
                ))}
              </div>
            ) : (
              <div style={{ color: "#3a4558", fontSize: 12, fontFamily: "monospace" }}>
                Click GENERATE BRIEF for an AI-powered market summary using live prices and current conditions.
              </div>
            )}
          </div>
        </Panel>

        {/* Portfolio Alerts */}
        <Panel>
          <SectionHeader title="PORTFOLIO ALERTS" subtitle={`${PORTFOLIO_ALERTS.length} active`} />
          {PORTFOLIO_ALERTS.map((alert, i) => <AlertRow key={i} alert={alert} />)}
        </Panel>

        {/* Pre-market Movers */}
        <Panel>
          <SectionHeader title="PRE-MARKET MOVERS" />
          <div style={{ display: "flex", borderBottom: "1px solid #1a1f2e" }}>
            {["gainers", "losers"].map(tab => (
              <button key={tab} onClick={() => setActiveMoversTab(tab)} style={{
                flex: 1, padding: "7px 0", background: "transparent",
                border: "none", borderBottom: activeMoversTab === tab ? "2px solid #00d4aa" : "2px solid transparent",
                color: activeMoversTab === tab ? "#00d4aa" : "#4a6080",
                fontFamily: "monospace", fontSize: 11, cursor: "pointer", letterSpacing: 1,
              }}>
                {tab === "gainers" ? "▲ GAINERS" : "▼ LOSERS"}
              </button>
            ))}
          </div>
          {movers.map((m, i) => <MoverRow key={m.symbol} mover={m} i={i} />)}
        </Panel>

        {/* Sector Heatmap */}
        <Panel>
          <SectionHeader title="SECTOR PERFORMANCE" subtitle="Today" />
          <div style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {[
              { name: "Tech", val: 1.42 }, { name: "Energy", val: -0.82 },
              { name: "Financials", val: 0.31 }, { name: "Healthcare", val: -0.14 },
              { name: "Consumer Disc", val: 0.88 }, { name: "Industrials", val: 0.22 },
              { name: "Materials", val: -0.55 }, { name: "Utilities", val: -0.33 },
              { name: "Real Estate", val: -0.67 }, { name: "Comm Svcs", val: 1.12 },
              { name: "Staples", val: 0.08 },
            ].map(s => {
              const up = s.val >= 0;
              const intensity = Math.min(Math.abs(s.val) / 2, 1);
              const bg = up
                ? `rgba(0, 212, 170, ${0.08 + intensity * 0.22})`
                : `rgba(255, 71, 87, ${0.08 + intensity * 0.22})`;
              return (
                <div key={s.name} style={{
                  background: bg, border: `1px solid ${up ? "#00d4aa30" : "#ff475730"}`,
                  borderRadius: 4, padding: "6px 10px", minWidth: 80, flex: "1 1 80px",
                }}>
                  <div style={{ fontSize: 10, color: "#7a8ba0" }}>{s.name}</div>
                  <div style={{ fontFamily: "monospace", fontSize: 12, color: up ? "#00d4aa" : "#ff4757" }}>
                    {up ? "+" : ""}{s.val}%
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        {/* Market Internals */}
        <Panel>
          <SectionHeader title="MARKET INTERNALS" subtitle="Breadth snapshot" />
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { label: "% S&P Above 200DMA", val: 68.4, good: true },
              { label: "% S&P Above 50DMA", val: 54.2, good: true },
              { label: "A/D Line", val: "+842", good: true, raw: true },
              { label: "New 52W Highs", val: 87, good: true, raw: true },
              { label: "New 52W Lows", val: 23, good: true, raw: true },
              { label: "AAII Bull/Bear Spread", val: "+12.4%", good: true, raw: true },
            ].map(item => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: "#4a6080" }}>{item.label}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {!item.raw && (
                    <div style={{ width: 60, height: 4, background: "#1a2535", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ width: `${item.val}%`, height: "100%", background: item.good ? "#00d4aa" : "#ff4757", borderRadius: 2 }} />
                    </div>
                  )}
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: item.good ? "#00d4aa" : "#ff4757", minWidth: 50, textAlign: "right" }}>
                    {item.raw ? item.val : `${item.val}%`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        {/* Today's Catalysts */}
        <Panel>
          <SectionHeader title="TODAY'S CATALYSTS" subtitle="High-impact only" />
          {MOCK_CATALYSTS.map((c, i) => <CatalystRow key={i} catalyst={c} />)}
        </Panel>

      </div>
    </div>
  );
}

// ============================================================
// MACRO & REGIME DASHBOARD PAGE
// ============================================================

function GaugeBar({ label, value, max = 100, color = "#00d4aa", format = v => `${v}%` }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: "#7a8ba0" }}>{label}</span>
        <span style={{ fontSize: 11, fontFamily: "monospace", color }}>{format(value)}</span>
      </div>
      <div style={{ height: 5, background: "#1a2535", borderRadius: 3 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}

function MacroPage({ prices }) {
  const [aiMacro, setAiMacro] = useState("");
  const [aiMacroLoading, setAiMacroLoading] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");

  useEffect(() => {
    if (!generated && Object.keys(prices).length > 0) {
      setGenerated(true);
      fetchAIMacro(prices, setAiMacro, setAiMacroLoading);
    }
  }, [prices, generated]);

  const vixVal = prices["^VIX"]?.price || 16.82;
  const tnx = prices["^TNX"]?.price || 4.312;
  const irx = prices["^IRX"]?.price || 5.024;
  const dxy = prices["DX-Y.NYB"]?.price || 104.22;
  const vixColor = vixVal < 15 ? "#00d4aa" : vixVal < 20 ? "#ffa502" : vixVal < 30 ? "#ff6b35" : "#ff4757";
  const curveInverted = irx > tnx;

  const tabs = ["overview", "breadth", "cross-asset", "regime", "calendar"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Tab bar */}
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid #1a1f2e", paddingBottom: 0 }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            background: "transparent", border: "none",
            borderBottom: activeTab === t ? "2px solid #00d4aa" : "2px solid transparent",
            color: activeTab === t ? "#00d4aa" : "#4a6080",
            padding: "8px 14px", cursor: "pointer", fontFamily: "monospace",
            fontSize: 11, letterSpacing: 1, textTransform: "uppercase",
          }}>{t}</button>
        ))}
      </div>

      {activeTab === "overview" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
          {/* Rates & Liquidity */}
          <Panel>
            <SectionHeader title="RATES & LIQUIDITY" />
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { label: "Fed Funds Rate", val: "5.25–5.50%", color: "#ffa502" },
                { label: "2Y Treasury", val: `${irx.toFixed(3)}%`, color: irx > 5 ? "#ff6b35" : "#c8d6e8" },
                { label: "10Y Treasury", val: `${tnx.toFixed(3)}%`, color: "#c8d6e8" },
                { label: "Yield Curve (2Y-10Y)", val: `${(irx - tnx).toFixed(3)}%`, color: curveInverted ? "#ff4757" : "#00d4aa" },
                { label: "DXY Dollar Index", val: dxy.toFixed(2), color: dxy > 104 ? "#ffa502" : "#c8d6e8" },
                { label: "Real 10Y Yield (est)", val: "2.1%", color: "#c8d6e8" },
              ].map(item => (
                <div key={item.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "#7a8ba0" }}>{item.label}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: item.color }}>{item.val}</span>
                </div>
              ))}
              <div style={{
                marginTop: 4, padding: "8px 10px", background: curveInverted ? "#ff475715" : "#00d4aa15",
                borderRadius: 4, border: `1px solid ${curveInverted ? "#ff475730" : "#00d4aa30"}`,
                fontSize: 11, color: curveInverted ? "#ff6b35" : "#00d4aa",
              }}>
                {curveInverted
                  ? "⚠ Yield curve inverted — recession signal active. Short-duration bias favoured."
                  : "✓ Yield curve normal — accommodative conditions for risk assets."}
              </div>
            </div>
          </Panel>

          {/* Volatility Structure */}
          <Panel>
            <SectionHeader title="VOLATILITY STRUCTURE" />
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ textAlign: "center", padding: "12px 0" }}>
                <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4 }}>VIX SPOT</div>
                <div style={{ fontSize: 42, fontWeight: 900, fontFamily: "monospace", color: vixColor }}>{vixVal.toFixed(2)}</div>
                <div style={{ fontSize: 11, color: vixColor, marginTop: 4 }}>
                  {vixVal < 15 ? "COMPLACENCY" : vixVal < 20 ? "LOW VOL" : vixVal < 25 ? "ELEVATED" : "FEAR"}
                </div>
              </div>
              {[
                { label: "VIX 1M Fwd (est)", val: "17.4", note: "Contango — normal" },
                { label: "VIX 3M Fwd (est)", val: "18.8", note: "" },
                { label: "Term Structure", val: "CONTANGO", color: "#00d4aa" },
                { label: "Realized Vol 10D", val: "12.4%", color: "#c8d6e8" },
                { label: "Implied Vol (ATM)", val: "14.8%", color: "#c8d6e8" },
                { label: "IV vs RV Premium", val: "+2.4%", color: "#ffa502" },
              ].map(item => (
                <div key={item.label} style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, color: "#7a8ba0" }}>{item.label}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: item.color || "#c8d6e8" }}>{item.val}</span>
                </div>
              ))}
              <div style={{
                padding: "6px 10px", background: "#ffa50215", borderRadius: 4,
                border: "1px solid #ffa50230", fontSize: 11, color: "#ffa502",
              }}>
                IV trading above RV — options buyers paying premium. Favour selling vol in low-impact windows.
              </div>
            </div>
          </Panel>

          {/* Regime Box */}
          <Panel>
            <SectionHeader title="REGIME CLASSIFICATION" />
            <div style={{ padding: 14 }}>
              <div style={{
                textAlign: "center", padding: "10px 0 14px",
                borderBottom: "1px solid #1a1f2e", marginBottom: 12,
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#00d4aa", fontFamily: "monospace", letterSpacing: 1.5 }}>
                  {REGIME_MATRIX.current}
                </div>
                <div style={{ fontSize: 10, color: "#4a6080", marginTop: 4 }}>
                  Confidence: {REGIME_MATRIX.confidence}% · Analogue: {REGIME_MATRIX.historical}
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 6 }}>REGIME SIGNALS</div>
                {[
                  { label: "Trending", val: REGIME_MATRIX.trending },
                  { label: "High Volatility", val: REGIME_MATRIX.highVol },
                  { label: "Growth-Led", val: REGIME_MATRIX.growthLed },
                  { label: "Dollar Strength", val: REGIME_MATRIX.dollarUp },
                ].map(s => (
                  <div key={s.label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: "#7a8ba0" }}>{s.label}</span>
                    <span style={{
                      fontSize: 10, fontFamily: "monospace",
                      color: s.val ? "#00d4aa" : "#ff4757",
                      background: s.val ? "#00d4aa15" : "#ff475715",
                      padding: "1px 6px", borderRadius: 3,
                    }}>{s.val ? "ACTIVE" : "INACTIVE"}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 6 }}>STRATEGIES THIS REGIME</div>
                {REGIME_MATRIX.strategies.map(s => (
                  <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    <span style={{ color: s.works ? "#00d4aa" : "#ff4757", fontSize: 10 }}>{s.works ? "✓" : "✗"}</span>
                    <span style={{ fontSize: 11, color: s.works ? "#7a8ba0" : "#3a4558" }}>{s.label}</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: "8px 10px", background: "#ff475715", borderRadius: 4, border: "1px solid #ff475730" }}>
                <div style={{ fontSize: 10, color: "#ff4757", fontFamily: "monospace", marginBottom: 4 }}>AVOID NOW</div>
                {REGIME_MATRIX.avoid.map(a => (
                  <div key={a} style={{ fontSize: 11, color: "#7a8ba0" }}>· {a}</div>
                ))}
              </div>
            </div>
          </Panel>

          {/* AI Macro Interpretation — full width */}
          <Panel style={{ gridColumn: "1 / -1" }}>
            <SectionHeader
              title="AI MACRO INTERPRETATION"
              action={aiMacroLoading ? "THINKING..." : "REGENERATE"}
              onAction={() => fetchAIMacro(prices, setAiMacro, setAiMacroLoading)}
            />
            <div style={{ padding: 14 }}>
              {aiMacroLoading ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 14, height: 14, border: "2px solid #1a2535", borderTop: "2px solid #00d4aa", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                  <span style={{ color: "#4a6080", fontSize: 12, fontFamily: "monospace" }}>Analysing macro conditions...</span>
                </div>
              ) : aiMacro ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  {aiMacro.split(/\n(?=[A-Z]+:)/).filter(Boolean).map((section, i) => {
                    const colonIdx = section.indexOf(":");
                    const label = colonIdx > -1 ? section.slice(0, colonIdx).trim() : `Section ${i + 1}`;
                    const body = colonIdx > -1 ? section.slice(colonIdx + 1).trim() : section;
                    const colors = ["#00d4aa", "#3d8bff", "#ff4757", "#ffa502"];
                    return (
                      <div key={i} style={{ borderLeft: `2px solid ${colors[i % 4]}40`, paddingLeft: 12 }}>
                        <div style={{ fontSize: 10, fontFamily: "monospace", color: colors[i % 4], letterSpacing: 1, marginBottom: 4 }}>{label}</div>
                        <div style={{ fontSize: 12, color: "#a0b4c8", lineHeight: 1.6, fontFamily: "Georgia, serif" }}>{body}</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ color: "#3a4558", fontSize: 12 }}>Click REGENERATE for AI macro analysis.</div>
              )}
            </div>
          </Panel>
        </div>
      )}

      {activeTab === "breadth" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Panel>
            <SectionHeader title="MARKET BREADTH — S&P 500" />
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
              <GaugeBar label="% Above 200 DMA" value={BREADTH_DATA.above200dma} color="#00d4aa" />
              <GaugeBar label="% Above 50 DMA" value={BREADTH_DATA.above50dma} color="#3d8bff" />
              <GaugeBar label="% Above 20 DMA" value={BREADTH_DATA.above20dma} color="#ffa502" />
              <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  { label: "A/D Line", val: BREADTH_DATA.advDecLine, color: "#00d4aa" },
                  { label: "52W Highs", val: BREADTH_DATA.new52wHigh, color: "#00d4aa" },
                  { label: "52W Lows", val: BREADTH_DATA.new52wLow, color: "#ff4757" },
                  { label: "Bull/Bear Spread", val: BREADTH_DATA.bullBearSpread, color: "#00d4aa" },
                ].map(item => (
                  <div key={item.label} style={{ background: "#080b12", borderRadius: 4, padding: "8px 10px" }}>
                    <div style={{ fontSize: 10, color: "#4a6080" }}>{item.label}</div>
                    <div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: item.color }}>{item.val}</div>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="SECTOR BREADTH" subtitle="% Above 50DMA" />
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
              {BREADTH_DATA.sectors.map(s => {
                const mColor = s.momentum === "strong" ? "#00d4aa" : s.momentum === "weak" ? "#ff4757" : s.momentum === "improving" ? "#3d8bff" : "#ffa502";
                return (
                  <div key={s.name}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                      <span style={{ fontSize: 11, color: "#7a8ba0" }}>{s.name}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 9, background: `${mColor}20`, color: mColor, padding: "1px 5px", borderRadius: 2, fontFamily: "monospace" }}>{s.momentum.toUpperCase()}</span>
                        <span style={{ fontSize: 11, fontFamily: "monospace", color: "#c8d6e8" }}>{s.above50}%</span>
                      </div>
                    </div>
                    <div style={{ height: 4, background: "#1a2535", borderRadius: 2 }}>
                      <div style={{ width: `${s.above50}%`, height: "100%", background: mColor, borderRadius: 2 }} />
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 8, padding: "8px 10px", background: "#00d4aa10", borderRadius: 4, border: "1px solid #00d4aa20", fontSize: 11, color: "#7a8ba0" }}>
                Breadth reading: rally is <strong style={{ color: "#00d4aa" }}>broad-based</strong>. Tech leading but participation expanding across sectors.
              </div>
            </div>
          </Panel>
        </div>
      )}

      {activeTab === "cross-asset" && (
        <Panel>
          <SectionHeader title="CROSS-ASSET PERFORMANCE MATRIX" />
          <div style={{ padding: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
              {CROSS_ASSET_DATA.map(asset => {
                const wUp = asset.weekChg >= 0;
                const mUp = asset.monthChg >= 0;
                return (
                  <div key={asset.name} style={{
                    background: "#080b12", borderRadius: 6, padding: 12,
                    border: "1px solid #1a1f2e",
                  }}>
                    <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", marginBottom: 6 }}>{asset.name}</div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 9, color: "#3a4558" }}>1W</div>
                        <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: wUp ? "#00d4aa" : "#ff4757" }}>
                          {wUp ? "+" : ""}{asset.weekChg}%
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: "#3a4558" }}>1M</div>
                        <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: mUp ? "#00d4aa" : "#ff4757" }}>
                          {mUp ? "+" : ""}{asset.monthChg}%
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ padding: "10px 12px", background: "#0d1117", borderRadius: 6, border: "1px solid #1a1f2e" }}>
              <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 6 }}>CORRELATION SHIFTS</div>
              {[
                { pair: "Stocks ↔ Bonds", status: "NEGATIVE (normal)", detail: "Classic risk-off hedge intact", color: "#00d4aa" },
                { pair: "Gold ↔ Dollar", status: "NEGATIVE (normal)", detail: "Dollar strength capping gold", color: "#ffa502" },
                { pair: "Oil ↔ Equities", status: "POSITIVE (risk-on)", detail: "Growth narrative driving both", color: "#3d8bff" },
              ].map(c => (
                <div key={c.pair} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                  <span style={{ minWidth: 140, fontFamily: "monospace", fontSize: 11, color: "#c8d6e8" }}>{c.pair}</span>
                  <span style={{ fontSize: 9, background: `${c.color}20`, color: c.color, padding: "1px 6px", borderRadius: 2, fontFamily: "monospace" }}>{c.status}</span>
                  <span style={{ fontSize: 11, color: "#7a8ba0" }}>{c.detail}</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {activeTab === "regime" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Panel>
            <SectionHeader title="REGIME CLASSIFICATION ENGINE" />
            <div style={{ padding: 14 }}>
              <div style={{ marginBottom: 14 }}>
                {[
                  { axis: "Trend", left: "Mean Reverting", right: "Trending", val: 78, color: "#00d4aa" },
                  { axis: "Volatility", left: "Low Vol", right: "High Vol", val: 22, color: "#ffa502" },
                  { axis: "Leadership", left: "Defensive", right: "Growth", val: 72, color: "#3d8bff" },
                  { axis: "Dollar", left: "Dollar Down", right: "Dollar Up", val: 65, color: "#a855f7" },
                ].map(item => (
                  <div key={item.axis} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#4a6080", marginBottom: 3 }}>
                      <span>{item.left}</span>
                      <span style={{ color: "#c8d6e8", fontFamily: "monospace", fontWeight: 700 }}>{item.axis}</span>
                      <span>{item.right}</span>
                    </div>
                    <div style={{ position: "relative", height: 8, background: "#1a2535", borderRadius: 4 }}>
                      <div style={{
                        position: "absolute", left: `${item.val}%`, top: -2,
                        width: 12, height: 12, borderRadius: "50%",
                        background: item.color, boxShadow: `0 0 6px ${item.color}`,
                        transform: "translateX(-50%)",
                      }} />
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: "10px 12px", background: "#00d4aa10", border: "1px solid #00d4aa20", borderRadius: 6 }}>
                <div style={{ fontSize: 11, color: "#00d4aa", fontFamily: "monospace", fontWeight: 700, marginBottom: 4 }}>
                  CURRENT: TRENDING GROWTH / LOW-VOL
                </div>
                <div style={{ fontSize: 11, color: "#7a8ba0", lineHeight: 1.5 }}>
                  Historical analogue: Late 2023 post-pivot rally. Momentum strategies outperformed. Mean reversion consistently punished. Duration punished.
                </div>
              </div>
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="DOLLAR REGIME & IMPLICATIONS" />
            <div style={{ padding: 14 }}>
              <div style={{ marginBottom: 12, padding: "10px 12px", background: "#ffa50215", border: "1px solid #ffa50230", borderRadius: 6 }}>
                <div style={{ fontSize: 10, color: "#ffa502", fontFamily: "monospace", letterSpacing: 1 }}>DOLLAR STATUS: FIRM / TRENDING HIGHER</div>
                <div style={{ fontSize: 12, fontFamily: "monospace", color: "#c8d6e8", marginTop: 4 }}>DXY {prices["DX-Y.NYB"]?.price?.toFixed(2) || "104.22"} — above 104 resistance turned support</div>
              </div>
              {[
                { asset: "Emerging Markets", implication: "Headwind — dollar strength = EM pressure", bad: true },
                { asset: "Gold", implication: "Capping upside — inverse correlation active", bad: true },
                { asset: "Oil", implication: "Mixed — supply narrative offsetting dollar drag", bad: false },
                { asset: "US Large Cap", implication: "Mixed — multinationals face FX headwinds", bad: false },
                { asset: "USD/JPY", implication: "Bullish continuation above 149 — BoJ lag", bad: false },
                { asset: "Commodities", implication: "Broad headwind from dollar pricing pressure", bad: true },
              ].map(item => (
                <div key={item.asset} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
                  <span style={{ color: item.bad ? "#ff4757" : "#00d4aa", fontSize: 11, marginTop: 1 }}>{item.bad ? "▼" : "▲"}</span>
                  <div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#c8d6e8", fontFamily: "monospace" }}>{item.asset}</span>
                    <div style={{ fontSize: 11, color: "#7a8ba0" }}>{item.implication}</div>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {activeTab === "calendar" && (
        <Panel>
          <SectionHeader title="MACRO EVENT CALENDAR" subtitle="Next 30 days — high & medium impact" />
          <div>
            {MACRO_CALENDAR_EVENTS.map((ev, i) => {
              const impColors = { high: "#ff4757", medium: "#ffa502", low: "#4a6080" };
              const c = impColors[ev.importance];
              return (
                <div key={i} style={{
                  display: "flex", alignItems: "flex-start", gap: 12,
                  padding: "10px 14px", borderBottom: "1px solid #0f1420",
                  borderLeft: `3px solid ${c}`,
                }}>
                  <div style={{ minWidth: 80, fontFamily: "monospace", fontSize: 11, color: "#4a6080" }}>
                    <div>{ev.date}</div>
                    <div>{ev.time}</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#c8d6e8" }}>{ev.event}</span>
                      <span style={{ fontSize: 9, background: `${c}20`, color: c, padding: "1px 5px", borderRadius: 2, fontFamily: "monospace" }}>
                        {ev.importance.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "#7a8ba0" }}>
                      Est: <span style={{ color: "#3d8bff" }}>{ev.est}</span> &nbsp;|&nbsp;
                      Prev: <span style={{ color: "#ffa502" }}>{ev.prev}</span>
                    </div>
                    <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                      {ev.assets.map(a => (
                        <span key={a} style={{ fontSize: 9, background: "#1a2535", color: "#4a6080", padding: "1px 5px", borderRadius: 2, fontFamily: "monospace" }}>{a}</span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ============================================================
// PORTFOLIO / RISK CONSOLE PAGE
// ============================================================

function PortfolioPage() {
  const [holdings, setHoldings] = useState(INITIAL_HOLDINGS);
  const [activeTab, setActiveTab] = useState("holdings");
  const [aiPortfolio, setAiPortfolio] = useState("");
  const [aiPortfolioLoading, setAiPortfolioLoading] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newHolding, setNewHolding] = useState({ symbol: "", name: "", shares: "", avgCost: "", brokerUrl: "", sector: "Technology", thesis: "", catalyst: "", invalidation: "", timeHorizon: "Medium swing (3-6 months)", nextEvent: "" });

  const totalValue = holdings.reduce((s, h) => s + h.shares * h.currentPrice, 0);
  const totalCost = holdings.reduce((s, h) => s + h.shares * h.avgCost, 0);
  const totalPL = totalValue - totalCost;
  const totalPLPct = (totalPL / totalCost) * 100;

  const sectorAlloc = holdings.reduce((acc, h) => {
    acc[h.sector] = (acc[h.sector] || 0) + h.shares * h.currentPrice;
    return acc;
  }, {});

  const thesisColors = { intact: "#00d4aa", weakening: "#ffa502", broken: "#ff4757" };

  const tabs = ["holdings", "exposure", "risk", "attribution", "health"];

  function addHolding() {
    if (!newHolding.symbol || !newHolding.shares || !newHolding.avgCost) return;
    const mockPrice = parseFloat(newHolding.avgCost) * (0.95 + Math.random() * 0.2);
    setHoldings(prev => [...prev, {
      id: Date.now(),
      symbol: newHolding.symbol.toUpperCase(),
      name: newHolding.name || newHolding.symbol.toUpperCase(),
      type: newHolding.brokerUrl ? "etc" : "stock",
      shares: parseFloat(newHolding.shares),
      avgCost: parseFloat(newHolding.avgCost),
      currentPrice: mockPrice,
      sector: newHolding.sector,
      marketCap: "Large", geography: "US",
      factor: "Growth", beta: 1.0,
      thesis: newHolding.thesis,
      catalyst: newHolding.catalyst,
      invalidation: newHolding.invalidation,
      timeHorizon: newHolding.timeHorizon,
      nextEvent: newHolding.nextEvent,
      thesisStatus: "intact",
      brokerUrl: newHolding.brokerUrl || null,
    }]);
    setNewHolding({ symbol: "", name: "", shares: "", avgCost: "", brokerUrl: "", sector: "Technology", thesis: "", catalyst: "", invalidation: "", timeHorizon: "Medium swing (3-6 months)", nextEvent: "" });
    setShowAddForm(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Summary header */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {[
          { label: "TOTAL VALUE", val: `$${totalValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, color: "#c8d6e8" },
          { label: "TOTAL P&L", val: `${totalPL >= 0 ? "+" : ""}$${totalPL.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, color: totalPL >= 0 ? "#00d4aa" : "#ff4757" },
          { label: "RETURN", val: `${totalPLPct >= 0 ? "+" : ""}${totalPLPct.toFixed(2)}%`, color: totalPLPct >= 0 ? "#00d4aa" : "#ff4757" },
          { label: "POSITIONS", val: holdings.length, color: "#c8d6e8" },
        ].map(s => (
          <div key={s.label} style={{ background: "#0d1117", border: "1px solid #1a1f2e", borderRadius: 6, padding: "10px 14px" }}>
            <div style={{ fontSize: 9, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "monospace", color: s.color }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid #1a1f2e" }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            background: "transparent", border: "none",
            borderBottom: activeTab === t ? "2px solid #00d4aa" : "2px solid transparent",
            color: activeTab === t ? "#00d4aa" : "#4a6080",
            padding: "8px 14px", cursor: "pointer", fontFamily: "monospace",
            fontSize: 11, letterSpacing: 1, textTransform: "uppercase",
          }}>{t}</button>
        ))}
        <button onClick={() => setShowAddForm(s => !s)} style={{
          marginLeft: "auto", background: "#00d4aa20", border: "1px solid #00d4aa40",
          color: "#00d4aa", padding: "6px 14px", cursor: "pointer",
          fontFamily: "monospace", fontSize: 11, borderRadius: 4,
        }}>+ ADD HOLDING</button>
      </div>

      {/* Add holding form */}
      {showAddForm && (
        <Panel>
          <SectionHeader title="ADD NEW HOLDING" />
          <div style={{ padding: 14, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[
              { key: "symbol", label: "Ticker / Symbol", placeholder: "NVDA" },
              { key: "name", label: "Name", placeholder: "NVIDIA Corp" },
              { key: "shares", label: "Shares / Units", placeholder: "10" },
              { key: "avgCost", label: "Avg Cost Price", placeholder: "612.40" },
              { key: "brokerUrl", label: "Broker URL (optional)", placeholder: "https://www.hl.co.uk/..." },
              { key: "nextEvent", label: "Next Event", placeholder: "Earnings Apr 24" },
            ].map(field => (
              <div key={field.key}>
                <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", marginBottom: 4 }}>{field.label}</div>
                <input
                  value={newHolding[field.key]}
                  onChange={e => setNewHolding(p => ({ ...p, [field.key]: e.target.value }))}
                  placeholder={field.placeholder}
                  style={{
                    width: "100%", background: "#080b12", border: "1px solid #1a2535",
                    color: "#c8d6e8", padding: "6px 10px", borderRadius: 4,
                    fontSize: 12, fontFamily: "monospace", outline: "none",
                  }}
                />
              </div>
            ))}
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", marginBottom: 4 }}>THESIS</div>
              <input
                value={newHolding.thesis}
                onChange={e => setNewHolding(p => ({ ...p, thesis: e.target.value }))}
                placeholder="Why are you entering this position?"
                style={{ width: "100%", background: "#080b12", border: "1px solid #1a2535", color: "#c8d6e8", padding: "6px 10px", borderRadius: 4, fontSize: 12, fontFamily: "monospace", outline: "none" }}
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", marginBottom: 4 }}>CATALYST</div>
              <input value={newHolding.catalyst} onChange={e => setNewHolding(p => ({ ...p, catalyst: e.target.value }))} placeholder="Expected trigger" style={{ width: "100%", background: "#080b12", border: "1px solid #1a2535", color: "#c8d6e8", padding: "6px 10px", borderRadius: 4, fontSize: 12, fontFamily: "monospace", outline: "none" }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", marginBottom: 4 }}>INVALIDATION LEVEL</div>
              <input value={newHolding.invalidation} onChange={e => setNewHolding(p => ({ ...p, invalidation: e.target.value }))} placeholder="Where is the thesis broken?" style={{ width: "100%", background: "#080b12", border: "1px solid #1a2535", color: "#c8d6e8", padding: "6px 10px", borderRadius: 4, fontSize: 12, fontFamily: "monospace", outline: "none" }} />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button onClick={addHolding} style={{
                background: "#00d4aa", border: "none", color: "#000",
                padding: "8px 20px", borderRadius: 4, cursor: "pointer",
                fontFamily: "monospace", fontWeight: 700, fontSize: 12,
              }}>ADD TO PORTFOLIO</button>
            </div>
          </div>
        </Panel>
      )}

      {activeTab === "holdings" && (
        <Panel>
          <SectionHeader title="HOLDINGS OVERVIEW" subtitle={`${holdings.length} positions`} />
          <div>
            {/* Header row */}
            <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 80px 80px 90px 80px 80px 50px", gap: 8, padding: "6px 14px", borderBottom: "1px solid #1a1f2e", fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1 }}>
              <span>SYMBOL</span><span>NAME</span><span>PRICE</span><span>COST</span><span>P&L</span><span>WEIGHT</span><span>THESIS</span><span></span>
            </div>
            {holdings.map(h => {
              const pl = (h.currentPrice - h.avgCost) * h.shares;
              const plPct = ((h.currentPrice - h.avgCost) / h.avgCost) * 100;
              const weight = (h.shares * h.currentPrice / totalValue) * 100;
              const plUp = pl >= 0;
              const tc = thesisColors[h.thesisStatus];
              const isExpanded = expandedId === h.id;
              return (
                <div key={h.id}>
                  <div
                    onClick={() => setExpandedId(isExpanded ? null : h.id)}
                    style={{ display: "grid", gridTemplateColumns: "80px 1fr 80px 80px 90px 80px 80px 50px", gap: 8, padding: "10px 14px", borderBottom: "1px solid #0f1420", cursor: "pointer", background: isExpanded ? "#0d1421" : "transparent" }}
                  >
                    <div>
                      <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#c8d6e8", fontSize: 13 }}>{h.symbol}</div>
                      <div style={{ fontSize: 9, color: "#4a6080" }}>{h.type.toUpperCase()}</div>
                    </div>
                    <div style={{ fontSize: 11, color: "#7a8ba0", alignSelf: "center" }}>{h.name}</div>
                    <div style={{ fontFamily: "monospace", color: "#c8d6e8", fontSize: 12, alignSelf: "center" }}>${h.currentPrice.toFixed(2)}</div>
                    <div style={{ fontFamily: "monospace", color: "#4a6080", fontSize: 12, alignSelf: "center" }}>${h.avgCost.toFixed(2)}</div>
                    <div style={{ alignSelf: "center" }}>
                      <div style={{ fontFamily: "monospace", color: plUp ? "#00d4aa" : "#ff4757", fontSize: 12 }}>{plUp ? "+" : ""}${Math.abs(pl).toFixed(0)}</div>
                      <div style={{ fontFamily: "monospace", color: plUp ? "#00d4aa" : "#ff4757", fontSize: 10 }}>{plUp ? "+" : ""}{plPct.toFixed(1)}%</div>
                    </div>
                    <div style={{ fontFamily: "monospace", color: weight > 20 ? "#ffa502" : "#c8d6e8", fontSize: 12, alignSelf: "center" }}>{weight.toFixed(1)}%</div>
                    <div style={{ alignSelf: "center" }}>
                      <span style={{ fontSize: 9, background: `${tc}20`, color: tc, padding: "2px 6px", borderRadius: 3, fontFamily: "monospace" }}>
                        {h.thesisStatus.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ alignSelf: "center", display: "flex", gap: 4 }}>
                      {h.brokerUrl && (
                        <a href={h.brokerUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: "#3d8bff", fontSize: 14, textDecoration: "none" }} title="Open broker page">⬡</a>
                      )}
                      <span style={{ color: "#4a6080", fontSize: 12 }}>{isExpanded ? "▲" : "▼"}</span>
                    </div>
                  </div>
                  {isExpanded && (
                    <div style={{ padding: "12px 14px", background: "#080b12", borderBottom: "1px solid #1a1f2e", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                      {[
                        { label: "THESIS", val: h.thesis },
                        { label: "CATALYST", val: h.catalyst },
                        { label: "INVALIDATION", val: h.invalidation },
                        { label: "TIME HORIZON", val: h.timeHorizon },
                        { label: "NEXT EVENT", val: h.nextEvent },
                        { label: "FACTOR", val: h.factor },
                      ].map(item => (
                        <div key={item.label} style={{ background: "#0d1117", borderRadius: 4, padding: "8px 10px" }}>
                          <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1, marginBottom: 3 }}>{item.label}</div>
                          <div style={{ fontSize: 11, color: "#a0b4c8", lineHeight: 1.4 }}>{item.val || "—"}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {activeTab === "exposure" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Panel>
            <SectionHeader title="SECTOR ALLOCATION" />
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {Object.entries(sectorAlloc).sort((a, b) => b[1] - a[1]).map(([sector, val]) => {
                const pct = (val / totalValue) * 100;
                const over = pct > 40;
                return (
                  <div key={sector}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ fontSize: 11, color: "#7a8ba0" }}>{sector}</span>
                      <span style={{ fontFamily: "monospace", fontSize: 12, color: over ? "#ffa502" : "#c8d6e8" }}>{pct.toFixed(1)}%</span>
                    </div>
                    <div style={{ height: 5, background: "#1a2535", borderRadius: 3 }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: over ? "#ffa502" : "#3d8bff", borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="CONCENTRATION & CORRELATION RISK" />
            <div style={{ padding: 14 }}>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 6 }}>CONCENTRATION FLAGS</div>
                {holdings.sort((a, b) => (b.shares * b.currentPrice) - (a.shares * a.currentPrice)).slice(0, 3).map((h, i) => {
                  const w = (h.shares * h.currentPrice / totalValue) * 100;
                  return (
                    <div key={h.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontFamily: "monospace", color: "#c8d6e8", fontSize: 12 }}>#{i + 1} {h.symbol}</span>
                      <span style={{ fontFamily: "monospace", color: w > 20 ? "#ffa502" : "#00d4aa", fontSize: 13, fontWeight: 700 }}>{w.toFixed(1)}%</span>
                    </div>
                  );
                })}
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 6 }}>CORRELATION CLUSTERS</div>
                {CORRELATION_CLUSTERS.map(cluster => (
                  <div key={cluster.group} style={{ marginBottom: 8, padding: "8px 10px", background: `${cluster.color}10`, border: `1px solid ${cluster.color}30`, borderRadius: 4 }}>
                    <div style={{ fontSize: 11, color: cluster.color, fontWeight: 700, marginBottom: 2 }}>{cluster.group}</div>
                    <div style={{ fontSize: 11, color: "#7a8ba0" }}>
                      {cluster.members.join(" · ")}
                      {cluster.correlation && <span style={{ color: "#4a6080", marginLeft: 8 }}>ρ = {cluster.correlation}</span>}
                    </div>
                  </div>
                ))}
                <div style={{ padding: "8px 10px", background: "#ffa50215", border: "1px solid #ffa50230", borderRadius: 4, fontSize: 11, color: "#ffa502", marginTop: 6 }}>
                  ⚠ 62% of portfolio is correlated to AI/Tech beta. You are not as diversified as you think.
                </div>
              </div>
            </div>
          </Panel>
        </div>
      )}

      {activeTab === "risk" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Panel>
            <SectionHeader title="RISK METRICS" />
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                { label: "Portfolio Beta (vs SPY)", val: "1.38", warn: true, note: "Amplified market moves" },
                { label: "Portfolio Beta (vs QQQ)", val: "1.22", warn: false, note: "" },
                { label: "Estimated Portfolio Vol", val: "18.4%", warn: true, note: "Annualised" },
                { label: "Max Drawdown (inception)", val: "-14.2%", warn: false, note: "" },
                { label: "Max Drawdown (90D)", val: "-6.8%", warn: false, note: "" },
                { label: "VaR 95% (1D est)", val: "-$2,840", warn: false, note: "Directional guide only" },
                { label: "Sharpe (inception est)", val: "1.42", warn: false, note: "" },
              ].map(item => (
                <div key={item.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "6px 0", borderBottom: "1px solid #0f1420" }}>
                  <div>
                    <div style={{ fontSize: 11, color: "#7a8ba0" }}>{item.label}</div>
                    {item.note && <div style={{ fontSize: 10, color: "#3a4558" }}>{item.note}</div>}
                  </div>
                  <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: item.warn ? "#ffa502" : "#c8d6e8" }}>{item.val}</span>
                </div>
              ))}
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="PORTFOLIO HEATMAP" subtitle="Sized by weight, coloured by P&L" />
            <div style={{ padding: 14, display: "flex", flexWrap: "wrap", gap: 6 }}>
              {holdings.map(h => {
                const plPct = ((h.currentPrice - h.avgCost) / h.avgCost) * 100;
                const weight = (h.shares * h.currentPrice / totalValue) * 100;
                const intensity = Math.min(Math.abs(plPct) / 30, 1);
                const bg = plPct >= 0
                  ? `rgba(0,212,170,${0.1 + intensity * 0.35})`
                  : `rgba(255,71,87,${0.1 + intensity * 0.35})`;
                const minW = Math.max(60, weight * 5);
                return (
                  <div key={h.id} style={{ background: bg, borderRadius: 5, padding: "8px 10px", minWidth: minW, flex: `0 0 ${minW}px` }}>
                    <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color: "#e8f0fe" }}>{h.symbol}</div>
                    <div style={{ fontFamily: "monospace", fontSize: 11, color: plPct >= 0 ? "#00d4aa" : "#ff4757" }}>
                      {plPct >= 0 ? "+" : ""}{plPct.toFixed(1)}%
                    </div>
                    <div style={{ fontSize: 10, color: "#7a8ba0" }}>{weight.toFixed(1)}% wt</div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      )}

      {activeTab === "attribution" && (
        <Panel>
          <SectionHeader title="PERFORMANCE ATTRIBUTION" subtitle="Since inception" />
          <div style={{ padding: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
              {holdings.sort((a, b) => {
                const plA = (a.currentPrice - a.avgCost) * a.shares;
                const plB = (b.currentPrice - b.avgCost) * b.shares;
                return plB - plA;
              }).map(h => {
                const pl = (h.currentPrice - h.avgCost) * h.shares;
                const contribution = (pl / totalCost) * 100;
                const plUp = pl >= 0;
                return (
                  <div key={h.id} style={{ background: "#080b12", borderRadius: 6, padding: 12, border: `1px solid ${plUp ? "#00d4aa20" : "#ff475720"}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#c8d6e8", fontSize: 13 }}>{h.symbol}</span>
                      <span style={{ fontSize: 10, color: "#4a6080" }}>{h.sector}</span>
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: plUp ? "#00d4aa" : "#ff4757" }}>
                      {plUp ? "+" : ""}${Math.abs(pl).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </div>
                    <div style={{ fontSize: 11, color: "#7a8ba0", marginTop: 2 }}>
                      {plUp ? "+" : ""}{contribution.toFixed(2)}% portfolio contribution
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Panel>
      )}

      {activeTab === "health" && (
        <Panel>
          <SectionHeader
            title="AI PORTFOLIO HEALTH CHECK"
            action={aiPortfolioLoading ? "ANALYSING..." : "REGENERATE"}
            onAction={() => fetchAIPortfolio(holdings, setAiPortfolio, setAiPortfolioLoading)}
          />
          <div style={{ padding: 14 }}>
            {!aiPortfolio && !aiPortfolioLoading && (
              <button onClick={() => fetchAIPortfolio(holdings, setAiPortfolio, setAiPortfolioLoading)} style={{
                background: "#00d4aa20", border: "1px solid #00d4aa40", color: "#00d4aa",
                padding: "10px 20px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace", fontSize: 12,
              }}>RUN PORTFOLIO HEALTH CHECK</button>
            )}
            {aiPortfolioLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 14, height: 14, border: "2px solid #1a2535", borderTop: "2px solid #00d4aa", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                <span style={{ color: "#4a6080", fontSize: 12, fontFamily: "monospace" }}>Analysing portfolio risk profile...</span>
              </div>
            )}
            {aiPortfolio && (
              <div style={{ fontSize: 12, lineHeight: 1.7, color: "#a0b4c8", fontFamily: "Georgia, serif", borderLeft: "2px solid #00d4aa30", paddingLeft: 12 }}>
                {aiPortfolio.split("\n\n").map((para, i) => <p key={i} style={{ margin: "0 0 12px 0" }}>{para}</p>)}
              </div>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ============================================================
// WATCHLIST / IDEA PIPELINE PAGE
// ============================================================

const TIER_CONFIG = [
  { id: "active", label: "Active This Week", icon: "⚡", color: "#ff4757" },
  { id: "conviction", label: "High Conviction", icon: "◈", color: "#00d4aa" },
  { id: "earnings", label: "Earnings Watch", icon: "▣", color: "#ffa502" },
  { id: "macro", label: "Macro Sensitive", icon: "◬", color: "#a855f7" },
  { id: "longterm", label: "Long-Term Candidates", icon: "◎", color: "#3d8bff" },
];

const INITIAL_WATCHLIST = [
  {
    id: 1, symbol: "MSFT", name: "Microsoft Corp", tier: "conviction", price: 415.32, change: 0.84,
    keyLevels: { support: 408.00, resistance: 421.50, ma50: 410.20 },
    thesis: "Azure AI revenue inflection — Copilot monetisation just beginning",
    trigger: "Break and close above $421.50 on volume >30M",
    stop: "$398 — below Feb consolidation base",
    catalyst: "Q3 earnings Apr 25 — Azure guide key",
    regimeFit: "Risk-on trending",
    daysOnList: 12,
    alertStatus: ["nearBreakout"],
    notes: "Watch for volume confirmation on any breakout attempt",
  },
  {
    id: 2, symbol: "XOM", name: "Exxon Mobil", tier: "macro", price: 118.44, change: -0.32,
    keyLevels: { support: 114.00, resistance: 122.80, ma50: 116.80 },
    thesis: "Oil supply constraint + dividend yield floor — geopolitical premium",
    trigger: "Oil above $86/bbl sustained + XOM reclaims $120",
    stop: "$112 — invalidates range support",
    catalyst: "EIA inventory data weekly + OPEC meeting Jun",
    regimeFit: "Risk-on / commodity bull",
    daysOnList: 28,
    alertStatus: ["eventImminent"],
    notes: "Dollar correlation watch — DXY above 105 is headwind",
  },
  {
    id: 3, symbol: "SMCI", name: "Super Micro Computer", tier: "active", price: 892.14, change: 6.42,
    keyLevels: { support: 840.00, resistance: 920.00, ma50: 798.40 },
    thesis: "AI server infrastructure beneficiary — NVDA GPU demand proxy",
    trigger: "Already triggered — managing position",
    stop: "$840 — previous breakout level",
    catalyst: "NVDA earnings Apr 24 — derivative move",
    regimeFit: "Risk-on / AI momentum",
    daysOnList: 4,
    alertStatus: ["volumeSpike", "nearBreakout"],
    notes: "High beta name — size accordingly. Earnings risk elevated",
  },
  {
    id: 4, symbol: "AMGN", name: "Amgen Inc", tier: "longterm", price: 284.22, change: 0.14,
    keyLevels: { support: 275.00, resistance: 298.00, ma50: 281.40 },
    thesis: "Obesity drug pipeline optionality + defensive yield characteristics",
    trigger: "Pullback to $278-282 support zone on low volume",
    stop: "$268 — below 200DMA",
    catalyst: "GLP-1 data readout Q2 + earnings May 2",
    regimeFit: "Risk-off / defensive rotation",
    daysOnList: 41,
    alertStatus: ["pullbackSupport"],
    notes: "Stale idea — reassess if no catalyst in 2 weeks",
  },
  {
    id: 5, symbol: "COST", name: "Costco Wholesale", tier: "earnings", price: 748.80, change: -1.22,
    keyLevels: { support: 730.00, resistance: 768.00, ma50: 738.20 },
    thesis: "Earnings reaction trade — consistent beat + raise history",
    trigger: "Post-earnings gap + hold above $755 on follow day",
    stop: "$728 — gap fill risk",
    catalyst: "Earnings after close today — EPS est $3.71",
    regimeFit: "Any regime — earnings-specific",
    daysOnList: 6,
    alertStatus: ["eventImminent", "newsAlert"],
    notes: "Implied move ±3.8%. Consider options for defined risk",
  },
  {
    id: 6, symbol: "GDX", name: "VanEck Gold Miners ETF", tier: "macro", price: 28.42, change: -0.88,
    keyLevels: { support: 27.00, resistance: 30.40, ma50: 27.80 },
    thesis: "Leveraged gold play — miners lag spot, mean reversion due",
    trigger: "Gold spot above $2350 + GDX reclaims $29.50",
    stop: "$26.50 — below recent consolidation",
    catalyst: "Fed dovish pivot or geopolitical escalation",
    regimeFit: "Risk-off / dollar weakness",
    daysOnList: 19,
    alertStatus: [],
    notes: "Dollar strength is primary headwind — watch DXY 104 level",
  },
];

const ALERT_STATUS_CONFIG = {
  nearBreakout: { label: "Near Breakout", color: "#00d4aa", icon: "▲" },
  pullbackSupport: { label: "Pullback to Support", color: "#3d8bff", icon: "◈" },
  volumeSpike: { label: "Volume Spike", color: "#ffa502", icon: "⚡" },
  newsAlert: { label: "News Catalyst", color: "#a855f7", icon: "◉" },
  eventImminent: { label: "Event Imminent", color: "#ff4757", icon: "▣" },
};

async function fetchAIWatchlistBrief(items, setAiWatchlist, setLoading) {
  setLoading(true);
  const summary = items.slice(0, 6).map(i =>
    `${i.symbol} (${i.tier} tier, ${i.daysOnList}d on list, alerts: ${i.alertStatus.join(",") || "none"}, trigger: ${i.trigger})`
  ).join("; ");
  const prompt = `You are a tactical trading desk analyst. Watchlist summary: ${summary}.

Answer two questions concisely in plain text:
CHANGED: What changed today for these watchlist names? Which ones moved closest to their trigger levels?
PRIORITY: Which 3 names deserve the most attention right now and why — be specific, one sentence each.

No markdown. No bullet points. Label each answer clearly.`;
  const { text } = await callAI(prompt, 600);
  setAiWatchlist(text);
  setLoading(false);
}

function WatchlistPage() {
  const [items, setItems] = useState(INITIAL_WATCHLIST);
  const [activeTier, setActiveTier] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [aiWatchlist, setAiWatchlist] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [archived, setArchived] = useState([]);
  const [newItem, setNewItem] = useState({ symbol: "", name: "", tier: "conviction", trigger: "", stop: "", catalyst: "", thesis: "", regimeFit: "", notes: "" });

  const filtered = activeTier === "all" ? items : items.filter(i => i.tier === activeTier);

  function archiveItem(id) {
    const item = items.find(i => i.id === id);
    setArchived(a => [...a, { ...item, archivedAt: new Date().toLocaleDateString() }]);
    setItems(prev => prev.filter(i => i.id !== id));
  }

  function addItem() {
    if (!newItem.symbol) return;
    setItems(prev => [...prev, {
      id: Date.now(), symbol: newItem.symbol.toUpperCase(), name: newItem.name || newItem.symbol.toUpperCase(),
      tier: newItem.tier, price: 0, change: 0,
      keyLevels: { support: 0, resistance: 0, ma50: 0 },
      thesis: newItem.thesis, trigger: newItem.trigger, stop: newItem.stop,
      catalyst: newItem.catalyst, regimeFit: newItem.regimeFit, daysOnList: 0,
      alertStatus: [], notes: newItem.notes,
    }]);
    setNewItem({ symbol: "", name: "", tier: "conviction", trigger: "", stop: "", catalyst: "", thesis: "", regimeFit: "", notes: "" });
    setShowAddForm(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* AI Monitor Panel */}
      <Panel>
        <SectionHeader
          title="AI WATCHLIST MONITOR"
          subtitle="Daily intelligence"
          action={aiLoading ? "THINKING..." : "RUN MONITOR"}
          onAction={() => fetchAIWatchlistBrief(items, setAiWatchlist, setAiLoading)}
        />
        <div style={{ padding: 12 }}>
          {!aiWatchlist && !aiLoading && (
            <div style={{ fontSize: 11, color: "#3a4558", fontFamily: "monospace" }}>
              Click RUN MONITOR → "What changed today? Which 3 names need attention?"
            </div>
          )}
          {aiLoading && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 12, height: 12, border: "2px solid #1a2535", borderTop: "2px solid #00d4aa", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
              <span style={{ color: "#4a6080", fontSize: 11, fontFamily: "monospace" }}>Scanning watchlist...</span>
            </div>
          )}
          {aiWatchlist && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {aiWatchlist.split(/\n(?=[A-Z]+:)/).filter(Boolean).map((section, i) => {
                const colonIdx = section.indexOf(":");
                const label = colonIdx > -1 ? section.slice(0, colonIdx).trim() : `Note ${i + 1}`;
                const body = colonIdx > -1 ? section.slice(colonIdx + 1).trim() : section;
                const colors = ["#3d8bff", "#00d4aa"];
                return (
                  <div key={i} style={{ borderLeft: `2px solid ${colors[i % 2]}40`, paddingLeft: 10 }}>
                    <div style={{ fontSize: 9, fontFamily: "monospace", color: colors[i % 2], letterSpacing: 1, marginBottom: 3 }}>{label}</div>
                    <div style={{ fontSize: 11, color: "#a0b4c8", lineHeight: 1.6 }}>{body}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Panel>

      {/* Tier filter + Add button */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, borderBottom: "1px solid #1a1f2e", paddingBottom: 0 }}>
        <button onClick={() => setActiveTier("all")} style={{
          background: "transparent", border: "none",
          borderBottom: activeTier === "all" ? "2px solid #c8d6e8" : "2px solid transparent",
          color: activeTier === "all" ? "#c8d6e8" : "#4a6080",
          padding: "8px 14px", cursor: "pointer", fontFamily: "monospace", fontSize: 11, letterSpacing: 1,
        }}>ALL ({items.length})</button>
        {TIER_CONFIG.map(t => {
          const count = items.filter(i => i.tier === t.id).length;
          return (
            <button key={t.id} onClick={() => setActiveTier(t.id)} style={{
              background: "transparent", border: "none",
              borderBottom: activeTier === t.id ? `2px solid ${t.color}` : "2px solid transparent",
              color: activeTier === t.id ? t.color : "#4a6080",
              padding: "8px 14px", cursor: "pointer", fontFamily: "monospace", fontSize: 11,
              display: "flex", alignItems: "center", gap: 4,
            }}>
              <span>{t.icon}</span> {t.label} ({count})
            </button>
          );
        })}
        <button onClick={() => setShowAddForm(s => !s)} style={{
          marginLeft: "auto", background: "#00d4aa20", border: "1px solid #00d4aa40",
          color: "#00d4aa", padding: "6px 14px", cursor: "pointer",
          fontFamily: "monospace", fontSize: 11, borderRadius: 4,
        }}>+ ADD IDEA</button>
      </div>

      {/* Add form */}
      {showAddForm && (
        <Panel>
          <SectionHeader title="ADD TO WATCHLIST" />
          <div style={{ padding: 14, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[
              { key: "symbol", label: "Ticker", placeholder: "MSFT" },
              { key: "name", label: "Name", placeholder: "Microsoft Corp" },
              { key: "catalyst", label: "Next Catalyst", placeholder: "Earnings Apr 25" },
              { key: "trigger", label: "Entry Trigger", placeholder: "Break above $421.50 on volume" },
              { key: "stop", label: "Stop / Invalidation", placeholder: "$398 — below Feb base" },
              { key: "regimeFit", label: "Regime Fit", placeholder: "Risk-on trending" },
            ].map(f => (
              <div key={f.key}>
                <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", marginBottom: 3 }}>{f.label}</div>
                <input value={newItem[f.key]} onChange={e => setNewItem(p => ({ ...p, [f.key]: e.target.value }))} placeholder={f.placeholder}
                  style={{ width: "100%", background: "#080b12", border: "1px solid #1a2535", color: "#c8d6e8", padding: "6px 8px", borderRadius: 4, fontSize: 11, fontFamily: "monospace", outline: "none" }} />
              </div>
            ))}
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", marginBottom: 3 }}>THESIS</div>
              <input value={newItem.thesis} onChange={e => setNewItem(p => ({ ...p, thesis: e.target.value }))} placeholder="Why is this on the list?"
                style={{ width: "100%", background: "#080b12", border: "1px solid #1a2535", color: "#c8d6e8", padding: "6px 8px", borderRadius: 4, fontSize: 11, fontFamily: "monospace", outline: "none" }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", marginBottom: 3 }}>TIER</div>
              <select value={newItem.tier} onChange={e => setNewItem(p => ({ ...p, tier: e.target.value }))}
                style={{ background: "#080b12", border: "1px solid #1a2535", color: "#c8d6e8", padding: "6px 8px", borderRadius: 4, fontSize: 11, fontFamily: "monospace", outline: "none", width: "100%" }}>
                {TIER_CONFIG.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <button onClick={addItem} style={{ background: "#00d4aa", border: "none", color: "#000", padding: "8px 16px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace", fontWeight: 700, fontSize: 11 }}>ADD</button>
              <button onClick={() => setShowAddForm(false)} style={{ background: "transparent", border: "1px solid #1a2535", color: "#4a6080", padding: "8px 16px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace", fontSize: 11 }}>CANCEL</button>
            </div>
          </div>
        </Panel>
      )}

      {/* Watchlist items */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.length === 0 && (
          <div style={{ color: "#3a4558", fontSize: 12, fontFamily: "monospace", padding: 20, textAlign: "center" }}>
            No items in this tier. Add ideas using the + ADD IDEA button.
          </div>
        )}
        {filtered.map(item => {
          const tierConfig = TIER_CONFIG.find(t => t.id === item.tier);
          const isExpanded = expandedId === item.id;
          const up = item.change >= 0;
          const isStale = item.daysOnList > 30;
          return (
            <Panel key={item.id} style={{ borderLeft: `3px solid ${tierConfig?.color || "#4a6080"}` }}>
              {/* Header row */}
              <div
                onClick={() => setExpandedId(isExpanded ? null : item.id)}
                style={{ display: "grid", gridTemplateColumns: "100px 1fr auto auto auto", gap: 12, padding: "12px 14px", cursor: "pointer", alignItems: "start" }}
              >
                {/* Symbol */}
                <div>
                  <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#e8f0fe", fontSize: 15 }}>{item.symbol}</div>
                  <div style={{ fontSize: 10, color: "#4a6080" }}>{item.name}</div>
                  {item.price > 0 && (
                    <div style={{ fontFamily: "monospace", fontSize: 12, color: up ? "#00d4aa" : "#ff4757", marginTop: 2 }}>
                      ${item.price.toFixed(2)} {up ? "+" : ""}{item.change.toFixed(2)}%
                    </div>
                  )}
                </div>

                {/* Setup summary */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontSize: 11, color: "#7a8ba0" }}>
                    <span style={{ color: "#4a6080", fontFamily: "monospace", fontSize: 10 }}>TRIGGER </span>
                    {item.trigger}
                  </div>
                  <div style={{ fontSize: 11, color: "#7a8ba0" }}>
                    <span style={{ color: "#ff475780", fontFamily: "monospace", fontSize: 10 }}>STOP </span>
                    {item.stop}
                  </div>
                  {item.catalyst && (
                    <div style={{ fontSize: 11, color: "#7a8ba0" }}>
                      <span style={{ color: "#ffa50280", fontFamily: "monospace", fontSize: 10 }}>CATALYST </span>
                      {item.catalyst}
                    </div>
                  )}
                </div>

                {/* Alert badges */}
                <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 130 }}>
                  {item.alertStatus.map(a => {
                    const cfg = ALERT_STATUS_CONFIG[a];
                    if (!cfg) return null;
                    return (
                      <span key={a} style={{
                        fontSize: 9, background: `${cfg.color}20`, color: cfg.color,
                        padding: "2px 6px", borderRadius: 3, fontFamily: "monospace",
                        display: "flex", alignItems: "center", gap: 4,
                      }}>
                        <span>{cfg.icon}</span> {cfg.label}
                      </span>
                    );
                  })}
                  {isStale && (
                    <span style={{ fontSize: 9, background: "#ff475720", color: "#ff4757", padding: "2px 6px", borderRadius: 3, fontFamily: "monospace" }}>
                      ⚠ {item.daysOnList}D STALE
                    </span>
                  )}
                </div>

                {/* Meta */}
                <div style={{ textAlign: "right", minWidth: 80 }}>
                  <div style={{ fontSize: 10, color: "#3a4558", fontFamily: "monospace" }}>{item.daysOnList}d on list</div>
                  <div style={{ fontSize: 9, background: `${tierConfig?.color}20`, color: tierConfig?.color, padding: "2px 5px", borderRadius: 2, fontFamily: "monospace", marginTop: 3 }}>
                    {tierConfig?.icon} {tierConfig?.label}
                  </div>
                  <div style={{ fontSize: 9, color: "#3a4558", marginTop: 3 }}>{item.regimeFit}</div>
                </div>

                {/* Actions */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                  <span style={{ color: "#4a6080", fontSize: 12 }}>{isExpanded ? "▲" : "▼"}</span>
                </div>
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div style={{ borderTop: "1px solid #1a1f2e", padding: "12px 14px", background: "#080b12" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
                    {[
                      { label: "THESIS", val: item.thesis },
                      { label: "KEY LEVELS", val: item.keyLevels?.support ? `Support: $${item.keyLevels.support} | Resist: $${item.keyLevels.resistance} | 50MA: $${item.keyLevels.ma50}` : "Add levels" },
                      { label: "NOTES", val: item.notes || "—" },
                    ].map(f => (
                      <div key={f.label} style={{ background: "#0d1117", borderRadius: 4, padding: "8px 10px" }}>
                        <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1, marginBottom: 3 }}>{f.label}</div>
                        <div style={{ fontSize: 11, color: "#a0b4c8", lineHeight: 1.5 }}>{f.val}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={e => { e.stopPropagation(); archiveItem(item.id); }} style={{
                      background: "transparent", border: "1px solid #1a2535", color: "#4a6080",
                      padding: "5px 12px", borderRadius: 3, cursor: "pointer", fontFamily: "monospace", fontSize: 10,
                    }}>ARCHIVE IDEA</button>
                    <button style={{
                      background: "#00d4aa20", border: "1px solid #00d4aa40", color: "#00d4aa",
                      padding: "5px 12px", borderRadius: 3, cursor: "pointer", fontFamily: "monospace", fontSize: 10,
                    }}>→ MOVE TO PORTFOLIO</button>
                    {TIER_CONFIG.filter(t => t.id !== item.tier).map(t => (
                      <button key={t.id} onClick={e => { e.stopPropagation(); setItems(prev => prev.map(i => i.id === item.id ? { ...i, tier: t.id } : i)); }} style={{
                        background: "transparent", border: `1px solid ${t.color}40`, color: t.color,
                        padding: "5px 10px", borderRadius: 3, cursor: "pointer", fontFamily: "monospace", fontSize: 9,
                      }}>→ {t.label}</button>
                    ))}
                  </div>
                </div>
              )}
            </Panel>
          );
        })}
      </div>

      {/* Archived section */}
      {archived.length > 0 && (
        <Panel>
          <SectionHeader title={`ARCHIVED IDEAS (${archived.length})`} subtitle="Completed or invalidated" />
          <div style={{ padding: 12 }}>
            {archived.map(item => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #0f1420", opacity: 0.5 }}>
                <span style={{ fontFamily: "monospace", color: "#7a8ba0", fontSize: 12 }}>{item.symbol}</span>
                <span style={{ fontSize: 10, color: "#3a4558" }}>Archived {item.archivedAt}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ============================================================
// SCREENER / OPPORTUNITY SCANNER PAGE
// ============================================================

const SCREENER_RESULTS = {
  equities: [
    { rank: 1, symbol: "NVDA", name: "NVIDIA Corp", sector: "Tech", price: 914.30, change: 4.82, volume: "89.2M", volRatio: 2.4, techScore: 94, fundScore: 88, liqScore: 98, rrScore: 82, composite: 91, setup: "Momentum continuation — AI infrastructure theme intact, breakout above ATH cluster", invalidation: "Close below $880 (prior breakout level)", regime: "Trending / Risk-on" },
    { rank: 2, symbol: "META", name: "Meta Platforms", sector: "Tech", price: 533.18, change: 2.94, volume: "22.1M", volRatio: 1.6, techScore: 88, fundScore: 92, liqScore: 96, rrScore: 84, composite: 90, setup: "High-quality pullback — 8% correction to rising 21EMA, fundamental upgrade cycle", invalidation: "Break below $510 on volume", regime: "Trending / Risk-on" },
    { rank: 3, symbol: "SMCI", name: "Super Micro", sector: "Tech", price: 892.14, change: 6.42, volume: "34.8M", volRatio: 3.1, techScore: 91, fundScore: 74, liqScore: 72, rrScore: 68, composite: 78, setup: "Breakout continuation — AI server demand + NVDA derivative. High beta, size small", invalidation: "$840 reclaimed by bears", regime: "Trending / Risk-on" },
    { rank: 4, symbol: "JPM", name: "JPMorgan Chase", sector: "Financials", price: 198.44, change: 0.62, volume: "12.4M", volRatio: 1.1, techScore: 78, fundScore: 86, liqScore: 98, rrScore: 80, composite: 85, setup: "Sector leadership — financials rotating into leadership, earnings beat cycle intact", invalidation: "Yield curve meaningfully steepens negatively", regime: "Trending / Risk-on" },
    { rank: 5, symbol: "LRCX", name: "Lam Research", sector: "Semis", price: 924.82, change: 1.84, volume: "8.2M", volRatio: 1.4, techScore: 82, fundScore: 84, liqScore: 82, rrScore: 86, composite: 84, setup: "Relative strength leader — semi equipment cycle recovery, lower vol entry vs NVDA", invalidation: "Semis breadth deteriorates broadly", regime: "Trending / Risk-on" },
    { rank: 6, symbol: "AMGN", name: "Amgen Inc", sector: "Healthcare", price: 284.22, change: 0.14, volume: "4.8M", volRatio: 0.9, techScore: 72, fundScore: 88, liqScore: 88, rrScore: 84, composite: 83, setup: "Mean reversion bounce — oversold vs sector, GLP-1 pipeline optionality unpriced", invalidation: "Fails to hold $275 support on retest", regime: "Mean-reverting / Any" },
    { rank: 7, symbol: "GS", name: "Goldman Sachs", sector: "Financials", price: 442.18, change: 1.12, volume: "7.2M", volRatio: 1.3, techScore: 80, fundScore: 84, liqScore: 94, rrScore: 78, composite: 82, setup: "Post-earnings drift — beat + raise cycle, IB recovery narrative gaining traction", invalidation: "Market risk-off rotation into defensives", regime: "Trending / Risk-on" },
  ],
  fx: [
    { rank: 1, pair: "USD/JPY", change: 0.28, price: 149.82, techScore: 88, macroScore: 92, composite: 90, setup: "Trend persistence — BoJ-Fed divergence intact. Short JPY positioning well-supported above 148", invalidation: "BoJ surprise hike or Fed emergency cut", regime: "Dollar strength / Carry" },
    { rank: 2, pair: "GBP/USD", change: -0.14, price: 1.2634, techScore: 74, macroScore: 68, composite: 71, setup: "Breakout from compression — 6-week range resolving. BoE hawkish hold vs Fed cut expectations", invalidation: "UK inflation surprise to downside", regime: "Ranging / Event-driven" },
    { rank: 3, pair: "EUR/USD", change: -0.22, price: 1.0842, techScore: 62, macroScore: 66, composite: 64, setup: "ATR expansion signal — volatility compression breaking down. ECB cut priced faster than Fed", invalidation: "EUR reclaims 1.0920", regime: "Trending / Dollar strength" },
  ],
  commodities: [
    { rank: 1, asset: "Gold (GC)", price: 2318.40, change: -0.54, techScore: 76, eventScore: 82, composite: 79, setup: "Momentum with macro hedge — central bank buying floor, geopolitical risk premium intact despite dollar headwind", invalidation: "DXY breaks above 106 sustained", regime: "Any / Geopolitical risk" },
    { rank: 2, asset: "WTI Crude", price: 82.14, change: 1.18, techScore: 80, eventScore: 76, composite: 78, setup: "Inventory sensitivity — EIA draw expected, supply cut compliance improving. Dollar headwind key risk", invalidation: "Inventory build >3M barrels", regime: "Risk-on / Supply-driven" },
    { rank: 3, asset: "Natural Gas", price: 1.94, change: -2.84, techScore: 58, eventScore: 72, composite: 65, setup: "Mean reversion from multi-year lows — seasonal demand builds Q2, production growth slowing", invalidation: "Warm spring extends into May", regime: "Mean-reverting / Seasonal" },
  ],
};

const STRATEGY_PRESETS = [
  { id: "momentum", label: "Strong Trend Continuation", icon: "▲", description: "High momentum, volume confirmation, trend intact" },
  { id: "reversion", label: "Mean Reversion Bounce", icon: "◈", description: "Oversold, support holding, catalyst for snap-back" },
  { id: "postearnings", label: "Post-Earnings Drift", icon: "▣", description: "Beat + raise, gap held, continuation setup" },
  { id: "rsleader", label: "Relative Strength Leaders", icon: "◎", description: "Outperforming sector and index, sector rotation" },
  { id: "pullback", label: "High-Quality Pullbacks", icon: "◬", description: "Trending name, controlled retrace to key level" },
];

async function fetchAISetup(item, setAiSetup, setLoading) {
  setLoading(true);
  const name = item.symbol || item.pair || item.asset;
  const prompt = `You are a professional trading analyst. Asset: ${name}. Setup: ${item.setup}. Composite score: ${item.composite}/100.

Write exactly 3 short sentences:
1. Why this is specifically interesting RIGHT NOW (not generic)
2. What market regime this setup is best suited for and why it fits current conditions
3. One specific thing that would make you more or less confident in this trade

Be concrete, opinionated, no hedging. Plain text only.`;
  const { text } = await callAI(prompt, 400);
  setAiSetup(text);
  setLoading(false);
}

function ScoreBar({ score, color = "#00d4aa" }) {
  const c = score >= 85 ? "#00d4aa" : score >= 70 ? "#3d8bff" : score >= 55 ? "#ffa502" : "#ff4757";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <div style={{ width: 40, height: 4, background: "#1a2535", borderRadius: 2 }}>
        <div style={{ width: `${score}%`, height: "100%", background: c, borderRadius: 2 }} />
      </div>
      <span style={{ fontFamily: "monospace", fontSize: 11, color: c, minWidth: 24 }}>{score}</span>
    </div>
  );
}

function ScreenerPage() {
  const [activeCategory, setActiveCategory] = useState("equities");
  const [activePreset, setActivePreset] = useState(null);
  const [expandedItem, setExpandedItem] = useState(null);
  const [aiSetups, setAiSetups] = useState({});
  const [aiLoadingId, setAiLoadingId] = useState(null);

  const categories = [
    { id: "equities", label: "Equities", icon: "◎", count: SCREENER_RESULTS.equities.length },
    { id: "fx", label: "FX", icon: "◬", count: SCREENER_RESULTS.fx.length },
    { id: "commodities", label: "Commodities", icon: "◈", count: SCREENER_RESULTS.commodities.length },
  ];

  const results = SCREENER_RESULTS[activeCategory] || [];

  function handleAISetup(item, id) {
    if (aiSetups[id]) return;
    setAiLoadingId(id);
    fetchAISetup(item, (text) => {
      setAiSetups(prev => ({ ...prev, [id]: text }));
      setAiLoadingId(null);
    }, () => setAiLoadingId(null));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Header + strategy presets */}
      <Panel>
        <SectionHeader title="OPPORTUNITY SCANNER" subtitle="Ranked shortlist — max 20 results per view" />
        <div style={{ padding: "10px 12px" }}>
          <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 8 }}>STRATEGY PRESETS</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {STRATEGY_PRESETS.map(p => (
              <button key={p.id} onClick={() => setActivePreset(activePreset === p.id ? null : p.id)} style={{
                background: activePreset === p.id ? "#00d4aa20" : "#080b12",
                border: activePreset === p.id ? "1px solid #00d4aa40" : "1px solid #1a2535",
                color: activePreset === p.id ? "#00d4aa" : "#7a8ba0",
                padding: "6px 12px", borderRadius: 4, cursor: "pointer",
                fontFamily: "monospace", fontSize: 10,
                display: "flex", alignItems: "center", gap: 5,
              }}>
                <span>{p.icon}</span>
                <span>{p.label}</span>
              </button>
            ))}
            {activePreset && (
              <div style={{ display: "flex", alignItems: "center", padding: "0 10px", fontSize: 11, color: "#4a6080", fontStyle: "italic" }}>
                {STRATEGY_PRESETS.find(p => p.id === activePreset)?.description}
              </div>
            )}
          </div>
        </div>
      </Panel>

      {/* Category tabs */}
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid #1a1f2e" }}>
        {categories.map(c => (
          <button key={c.id} onClick={() => setActiveCategory(c.id)} style={{
            background: "transparent", border: "none",
            borderBottom: activeCategory === c.id ? "2px solid #00d4aa" : "2px solid transparent",
            color: activeCategory === c.id ? "#00d4aa" : "#4a6080",
            padding: "8px 16px", cursor: "pointer", fontFamily: "monospace", fontSize: 11, letterSpacing: 1,
            display: "flex", alignItems: "center", gap: 5,
          }}>
            <span>{c.icon}</span> {c.label.toUpperCase()} SCAN ({c.count})
          </button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", padding: "0 12px", fontSize: 10, color: "#3a4558", fontFamily: "monospace" }}>
          SORTED BY COMPOSITE SCORE ↓
        </div>
      </div>

      {/* Score legend */}
      <div style={{ display: "flex", gap: 16, padding: "0 4px" }}>
        {[["85+", "#00d4aa", "Strong"], ["70-84", "#3d8bff", "Good"], ["55-69", "#ffa502", "Moderate"], ["<55", "#ff4757", "Weak"]].map(([range, color, label]) => (
          <div key={range} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
            <span style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace" }}>{range} {label}</span>
          </div>
        ))}
      </div>

      {/* Results */}
      {activeCategory === "equities" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Column headers */}
          <div style={{ display: "grid", gridTemplateColumns: "32px 90px 1fr 70px 70px 55px 55px 55px 55px 60px 32px", gap: 8, padding: "4px 14px", fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1 }}>
            <span>#</span><span>SYMBOL</span><span>SETUP SUMMARY</span><span>PRICE</span><span>CHANGE</span>
            <span>TECH</span><span>FUND</span><span>LIQ</span><span>R/R</span><span>SCORE</span><span></span>
          </div>
          {results.map((item) => {
            const id = item.symbol;
            const isExp = expandedItem === id;
            const compColor = item.composite >= 85 ? "#00d4aa" : item.composite >= 70 ? "#3d8bff" : "#ffa502";
            const up = item.change >= 0;
            return (
              <Panel key={id} style={{ borderLeft: `3px solid ${compColor}` }}>
                <div onClick={() => { setExpandedItem(isExp ? null : id); if (!isExp) handleAISetup(item, id); }}
                  style={{ display: "grid", gridTemplateColumns: "32px 90px 1fr 70px 70px 55px 55px 55px 55px 60px 32px", gap: 8, padding: "10px 14px", cursor: "pointer", alignItems: "center" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#3a4558" }}>#{item.rank}</span>
                  <div>
                    <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#e8f0fe", fontSize: 13 }}>{item.symbol}</div>
                    <div style={{ fontSize: 9, color: "#4a6080" }}>{item.sector}</div>
                  </div>
                  <div style={{ fontSize: 11, color: "#7a8ba0", lineHeight: 1.4 }}>{item.setup}</div>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#c8d6e8" }}>${item.price.toFixed(2)}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: up ? "#00d4aa" : "#ff4757" }}>{up ? "+" : ""}{item.change.toFixed(2)}%</span>
                  <ScoreBar score={item.techScore} />
                  <ScoreBar score={item.fundScore} />
                  <ScoreBar score={item.liqScore} />
                  <ScoreBar score={item.rrScore} />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, borderRadius: "50%", background: `${compColor}20`, border: `2px solid ${compColor}` }}>
                    <span style={{ fontFamily: "monospace", fontWeight: 900, fontSize: 13, color: compColor }}>{item.composite}</span>
                  </div>
                  <span style={{ color: "#4a6080", fontSize: 12 }}>{isExp ? "▲" : "▼"}</span>
                </div>
                {isExp && (
                  <div style={{ borderTop: "1px solid #1a1f2e", padding: "12px 14px", background: "#080b12", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                        {[
                          { label: "INVALIDATION", val: item.invalidation, color: "#ff4757" },
                          { label: "REGIME FIT", val: item.regime, color: "#3d8bff" },
                          { label: "VOLUME RATIO", val: `${item.volRatio}x avg`, color: item.volRatio > 2 ? "#ffa502" : "#c8d6e8" },
                          { label: "VOLUME", val: item.volume, color: "#c8d6e8" },
                        ].map(f => (
                          <div key={f.label} style={{ background: "#0d1117", borderRadius: 4, padding: "7px 9px" }}>
                            <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1, marginBottom: 2 }}>{f.label}</div>
                            <div style={{ fontSize: 11, color: f.color }}>{f.val}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
                        {[
                          { label: "TECH", val: item.techScore },
                          { label: "FUND", val: item.fundScore },
                          { label: "LIQ", val: item.liqScore },
                          { label: "R/R", val: item.rrScore },
                        ].map(s => {
                          const c = s.val >= 85 ? "#00d4aa" : s.val >= 70 ? "#3d8bff" : "#ffa502";
                          return (
                            <div key={s.label} style={{ background: "#0d1117", borderRadius: 4, padding: "6px 8px", textAlign: "center" }}>
                              <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace" }}>{s.label}</div>
                              <div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: c }}>{s.val}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#00d4aa", fontFamily: "monospace", letterSpacing: 1, marginBottom: 6 }}>AI SETUP COMMENTARY</div>
                      {aiLoadingId === id ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 12, height: 12, border: "2px solid #1a2535", borderTop: "2px solid #00d4aa", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                          <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace" }}>Analysing setup...</span>
                        </div>
                      ) : aiSetups[id] ? (
                        <div style={{ fontSize: 11, color: "#a0b4c8", lineHeight: 1.7, fontFamily: "Georgia, serif" }}>{aiSetups[id]}</div>
                      ) : (
                        <button onClick={e => { e.stopPropagation(); handleAISetup(item, id); }} style={{ background: "#00d4aa20", border: "1px solid #00d4aa40", color: "#00d4aa", padding: "6px 12px", borderRadius: 3, cursor: "pointer", fontFamily: "monospace", fontSize: 10 }}>
                          GET AI COMMENTARY
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      )}

      {activeCategory === "fx" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "32px 100px 1fr 80px 60px 60px 60px 32px", gap: 8, padding: "4px 14px", fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1 }}>
            <span>#</span><span>PAIR</span><span>SETUP</span><span>PRICE</span><span>TECH</span><span>MACRO</span><span>SCORE</span><span></span>
          </div>
          {results.map(item => {
            const id = item.pair;
            const isExp = expandedItem === id;
            const compColor = item.composite >= 85 ? "#00d4aa" : item.composite >= 70 ? "#3d8bff" : "#ffa502";
            return (
              <Panel key={id} style={{ borderLeft: `3px solid ${compColor}` }}>
                <div onClick={() => { setExpandedItem(isExp ? null : id); if (!isExp) handleAISetup(item, id); }}
                  style={{ display: "grid", gridTemplateColumns: "32px 100px 1fr 80px 60px 60px 60px 32px", gap: 8, padding: "10px 14px", cursor: "pointer", alignItems: "center" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#3a4558" }}>#{item.rank}</span>
                  <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#e8f0fe", fontSize: 13 }}>{item.pair}</div>
                  <div style={{ fontSize: 11, color: "#7a8ba0" }}>{item.setup}</div>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#c8d6e8" }}>{item.price.toFixed(4)}</span>
                  <ScoreBar score={item.techScore} />
                  <ScoreBar score={item.macroScore} />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, borderRadius: "50%", background: `${compColor}20`, border: `2px solid ${compColor}` }}>
                    <span style={{ fontFamily: "monospace", fontWeight: 900, fontSize: 13, color: compColor }}>{item.composite}</span>
                  </div>
                  <span style={{ color: "#4a6080" }}>{isExp ? "▲" : "▼"}</span>
                </div>
                {isExp && (
                  <div style={{ borderTop: "1px solid #1a1f2e", padding: "12px 14px", background: "#080b12" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                      {[
                        { label: "INVALIDATION", val: item.invalidation },
                        { label: "REGIME FIT", val: item.regime },
                      ].map(f => (
                        <div key={f.label} style={{ background: "#0d1117", borderRadius: 4, padding: "8px 10px" }}>
                          <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace", marginBottom: 2 }}>{f.label}</div>
                          <div style={{ fontSize: 11, color: "#a0b4c8" }}>{f.val}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 9, color: "#00d4aa", fontFamily: "monospace", letterSpacing: 1, marginBottom: 6 }}>AI SETUP COMMENTARY</div>
                    {aiLoadingId === id ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 12, height: 12, border: "2px solid #1a2535", borderTop: "2px solid #00d4aa", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                        <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace" }}>Analysing...</span>
                      </div>
                    ) : aiSetups[id] ? (
                      <div style={{ fontSize: 11, color: "#a0b4c8", lineHeight: 1.7 }}>{aiSetups[id]}</div>
                    ) : (
                      <button onClick={e => { e.stopPropagation(); handleAISetup(item, id); }} style={{ background: "#00d4aa20", border: "1px solid #00d4aa40", color: "#00d4aa", padding: "6px 12px", borderRadius: 3, cursor: "pointer", fontFamily: "monospace", fontSize: 10 }}>GET AI COMMENTARY</button>
                    )}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      )}

      {activeCategory === "commodities" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "32px 140px 1fr 80px 60px 60px 60px 32px", gap: 8, padding: "4px 14px", fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1 }}>
            <span>#</span><span>ASSET</span><span>SETUP</span><span>PRICE</span><span>TECH</span><span>EVENT</span><span>SCORE</span><span></span>
          </div>
          {results.map(item => {
            const id = item.asset;
            const isExp = expandedItem === id;
            const compColor = item.composite >= 85 ? "#00d4aa" : item.composite >= 70 ? "#3d8bff" : "#ffa502";
            const up = item.change >= 0;
            return (
              <Panel key={id} style={{ borderLeft: `3px solid ${compColor}` }}>
                <div onClick={() => { setExpandedItem(isExp ? null : id); if (!isExp) handleAISetup(item, id); }}
                  style={{ display: "grid", gridTemplateColumns: "32px 140px 1fr 80px 60px 60px 60px 32px", gap: 8, padding: "10px 14px", cursor: "pointer", alignItems: "center" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#3a4558" }}>#{item.rank}</span>
                  <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#e8f0fe", fontSize: 12 }}>{item.asset}</div>
                  <div style={{ fontSize: 11, color: "#7a8ba0" }}>{item.setup}</div>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#c8d6e8" }}>${item.price.toFixed(2)}</span>
                  <ScoreBar score={item.techScore} />
                  <ScoreBar score={item.eventScore} />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, borderRadius: "50%", background: `${compColor}20`, border: `2px solid ${compColor}` }}>
                    <span style={{ fontFamily: "monospace", fontWeight: 900, fontSize: 13, color: compColor }}>{item.composite}</span>
                  </div>
                  <span style={{ color: "#4a6080" }}>{isExp ? "▲" : "▼"}</span>
                </div>
                {isExp && (
                  <div style={{ borderTop: "1px solid #1a1f2e", padding: "12px 14px", background: "#080b12" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                      {[{ label: "INVALIDATION", val: item.invalidation }, { label: "REGIME FIT", val: item.regime }].map(f => (
                        <div key={f.label} style={{ background: "#0d1117", borderRadius: 4, padding: "8px 10px" }}>
                          <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace", marginBottom: 2 }}>{f.label}</div>
                          <div style={{ fontSize: 11, color: "#a0b4c8" }}>{f.val}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 9, color: "#00d4aa", fontFamily: "monospace", letterSpacing: 1, marginBottom: 6 }}>AI SETUP COMMENTARY</div>
                    {aiLoadingId === id ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 12, height: 12, border: "2px solid #1a2535", borderTop: "2px solid #00d4aa", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                        <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace" }}>Analysing...</span>
                      </div>
                    ) : aiSetups[id] ? (
                      <div style={{ fontSize: 11, color: "#a0b4c8", lineHeight: 1.7 }}>{aiSetups[id]}</div>
                    ) : (
                      <button onClick={e => { e.stopPropagation(); handleAISetup(item, id); }} style={{ background: "#00d4aa20", border: "1px solid #00d4aa40", color: "#00d4aa", padding: "6px 12px", borderRadius: 3, cursor: "pointer", fontFamily: "monospace", fontSize: 10 }}>GET AI COMMENTARY</button>
                    )}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// FOREX & COMMODITIES PAGE
// ============================================================

const FX_PAIRS = [
  { pair: "EUR/USD", symbol: "EURUSD=X", price: 1.0842, change: -0.22, high: 1.0891, low: 1.0812, centralBanks: "ECB vs Fed", bias: "Bearish", driver: "ECB cutting faster than Fed. Dollar strength persisting above 104 DXY.", support: 1.0780, resistance: 1.0920 },
  { pair: "GBP/USD", symbol: "GBPUSD=X", price: 1.2634, change: -0.14, high: 1.2680, low: 1.2601, centralBanks: "BoE vs Fed", bias: "Neutral", driver: "BoE holding hawkish stance. UK CPI still sticky. Range-bound pending data.", support: 1.2520, resistance: 1.2780 },
  { pair: "USD/JPY", symbol: "USDJPY=X", price: 149.82, change: 0.28, high: 150.14, low: 149.44, centralBanks: "Fed vs BoJ", bias: "Bullish USD", driver: "BoJ-Fed divergence intact. Carry trade well-supported. Watch 150 psychological level.", support: 148.00, resistance: 151.90 },
  { pair: "AUD/USD", price: 0.6524, change: -0.34, high: 0.6558, low: 0.6501, centralBanks: "RBA vs Fed", bias: "Bearish", driver: "China growth concerns weighing. RBA less hawkish than peers. Commodity drag.", support: 0.6450, resistance: 0.6620 },
  { pair: "USD/CAD", price: 1.3582, change: 0.18, high: 1.3608, low: 1.3551, centralBanks: "Fed vs BoC", bias: "Bullish USD", driver: "BoC dovish pivot underway. Oil price support partially offsetting.", support: 1.3480, resistance: 1.3680 },
  { pair: "USD/CHF", price: 0.8982, change: 0.12, high: 0.9012, low: 0.8961, centralBanks: "Fed vs SNB", bias: "Neutral", driver: "SNB already cut. CHF losing safe-haven premium. Risk-on conditions mildly bearish CHF.", support: 0.8880, resistance: 0.9080 },
];

const COMMODITIES_DATA = [
  { name: "Gold", symbol: "GC=F", price: 2318.40, change: -0.54, high: 2341.20, low: 2298.80, unit: "$/oz", driver: "Central bank buying + geopolitical floor. Dollar headwind capping upside.", support: 2280, resistance: 2360, season: "Neutral Q1", dollarCorr: -0.78 },
  { name: "Silver", price: 27.42, change: -0.88, high: 27.92, low: 27.14, unit: "$/oz", driver: "Industrial demand + gold ratio stretched. Solar panel demand secular tailwind.", support: 26.50, resistance: 29.00, season: "Neutral", dollarCorr: -0.72 },
  { name: "WTI Crude", symbol: "CL=F", price: 82.14, change: 1.18, high: 82.88, low: 81.22, unit: "$/bbl", driver: "OPEC+ compliance improving. EIA draw expected. Geopolitical risk premium.", support: 79.00, resistance: 86.00, season: "Seasonal strength Q2", dollarCorr: -0.44 },
  { name: "Brent Crude", symbol: "BZ=F", price: 86.22, change: 0.94, high: 87.10, low: 85.44, unit: "$/bbl", driver: "Spread to WTI normalising. Middle East risk premium. European demand recovery.", support: 83.00, resistance: 90.00, season: "Seasonal strength Q2", dollarCorr: -0.42 },
  { name: "Natural Gas", symbol: "NG=F", price: 1.94, change: -2.84, high: 2.02, low: 1.88, unit: "$/MMBtu", driver: "Multi-year lows. Storage builds. Seasonal demand builds Q2. Mean reversion candidate.", support: 1.80, resistance: 2.40, season: "Seasonal inflection Q2", dollarCorr: -0.18 },
  { name: "Copper", price: 3.98, change: 0.62, high: 4.02, low: 3.92, unit: "$/lb", driver: "China recovery proxy. Green energy demand structural. LME inventory draws.", support: 3.80, resistance: 4.20, season: "Positive Q2", dollarCorr: -0.56 },
];

const CB_MATRIX = [
  { bank: "Federal Reserve", country: "US", rate: "5.25-5.50%", bias: "Hold / Hawkish", nextMeeting: "Mar 19", expectation: "Hold", color: "#3d8bff" },
  { bank: "ECB", country: "Eurozone", rate: "4.00%", bias: "Cutting", nextMeeting: "Apr 11", expectation: "Cut -25bp", color: "#ffa502" },
  { bank: "Bank of England", country: "UK", rate: "5.25%", bias: "Hold / Hawkish", nextMeeting: "May 9", expectation: "Hold", color: "#00d4aa" },
  { bank: "Bank of Japan", country: "Japan", rate: "0.10%", bias: "Hiking slowly", nextMeeting: "Apr 26", expectation: "Hold", color: "#ff4757" },
  { bank: "Bank of Canada", country: "Canada", rate: "5.00%", bias: "Cutting", nextMeeting: "Apr 10", expectation: "Cut -25bp", color: "#a855f7" },
  { bank: "SNB", country: "Switzerland", rate: "1.50%", bias: "Cutting", nextMeeting: "Jun 20", expectation: "Hold", color: "#c8d6e8" },
];

async function fetchAIForex(setCommentary, setLoading) {
  setLoading(true);
  const prompt = `You are an FX strategist. Current conditions: DXY at 104.22 (firm), Fed holding 5.25-5.50%, ECB cutting, BoJ at 0.1%, BoE holding hawkish. VIX 16.82, risk-on environment.

Write a concise FX macro commentary (2 short paragraphs):
1. The dominant FX theme right now and which crosses benefit most
2. The single biggest risk to current FX positioning in the next 2 weeks

Then one sentence on commodities: what does current macro mean for Gold and Oil specifically?

Plain text only. No markdown. Direct and specific.`;
  const { text } = await callAI(prompt, 600);
  setCommentary(text);
  setLoading(false);
}

function BiasTag({ bias }) {
  const colors = { "Bullish": "#00d4aa", "Bullish USD": "#00d4aa", "Bearish": "#ff4757", "Neutral": "#ffa502", "Cutting": "#ff6b35", "Hold / Hawkish": "#00d4aa", "Hiking slowly": "#ffa502" };
  const c = colors[bias] || "#4a6080";
  return <span style={{ fontSize: 9, background: `${c}20`, color: c, padding: "2px 6px", borderRadius: 3, fontFamily: "monospace" }}>{bias}</span>;
}

function ForexPage({ prices }) {
  const [activeTab, setActiveTab] = useState("fx");
  const [aiCommentary, setAiCommentary] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [expandedItem, setExpandedItem] = useState(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel>
        <SectionHeader title="AI FX & MACRO COMMENTARY" action={aiLoading ? "THINKING..." : "GENERATE"} onAction={() => fetchAIForex(setAiCommentary, setAiLoading)} />
        <div style={{ padding: 12 }}>
          {!aiCommentary && !aiLoading && <div style={{ fontSize: 11, color: "#3a4558", fontFamily: "monospace" }}>Click GENERATE for dominant FX theme, key risks, Gold and Oil context.</div>}
          {aiLoading && <div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ width: 12, height: 12, border: "2px solid #1a2535", borderTop: "2px solid #00d4aa", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} /><span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace" }}>Analysing FX conditions...</span></div>}
          {aiCommentary && <div style={{ fontSize: 12, color: "#a0b4c8", lineHeight: 1.7, fontFamily: "Georgia, serif", borderLeft: "2px solid #3d8bff40", paddingLeft: 12 }}>{aiCommentary}</div>}
        </div>
      </Panel>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {[
          { label: "DXY", val: (prices["DX-Y.NYB"]?.price || 104.22).toFixed(2), pct: formatChange(prices["DX-Y.NYB"]?.changePct || 0.34), color: "#ffa502" },
          { label: "EUR/USD", val: (prices["EURUSD=X"]?.price || 1.0842).toFixed(4), pct: formatChange(prices["EURUSD=X"]?.changePct || -0.22), color: "#ff4757" },
          { label: "GBP/USD", val: (prices["GBPUSD=X"]?.price || 1.2634).toFixed(4), pct: formatChange(prices["GBPUSD=X"]?.changePct || -0.14), color: "#ffa502" },
          { label: "USD/JPY", val: (prices["USDJPY=X"]?.price || 149.82).toFixed(2), pct: formatChange(prices["USDJPY=X"]?.changePct || 0.28), color: "#00d4aa" },
        ].map(item => (
          <div key={item.label} style={{ background: "#0d1117", border: "1px solid #1a1f2e", borderRadius: 6, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4 }}>{item.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "monospace", color: "#e8f0fe" }}>{item.val}</div>
            <div style={{ fontSize: 12, fontFamily: "monospace", color: item.color, marginTop: 2 }}>{item.pct}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid #1a1f2e" }}>
        {[{ id: "fx", label: "FX Pairs" }, { id: "commodities", label: "Commodities" }, { id: "centralbanks", label: "Central Banks" }, { id: "dxy", label: "DXY & Correlations" }].map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            background: "transparent", border: "none",
            borderBottom: activeTab === t.id ? "2px solid #00d4aa" : "2px solid transparent",
            color: activeTab === t.id ? "#00d4aa" : "#4a6080",
            padding: "8px 16px", cursor: "pointer", fontFamily: "monospace", fontSize: 11, letterSpacing: 1,
          }}>{t.label.toUpperCase()}</button>
        ))}
      </div>

      {activeTab === "fx" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {FX_PAIRS.map(pair => {
            const isExp = expandedItem === pair.pair;
            const up = pair.change >= 0;
            return (
              <Panel key={pair.pair} style={{ borderLeft: `3px solid ${up ? "#00d4aa40" : "#ff475740"}` }}>
                <div onClick={() => setExpandedItem(isExp ? null : pair.pair)} style={{ display: "grid", gridTemplateColumns: "110px 100px 70px 70px 90px 1fr auto", gap: 10, padding: "12px 14px", cursor: "pointer", alignItems: "center" }}>
                  <div><div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 14, color: "#e8f0fe" }}>{pair.pair}</div><div style={{ fontSize: 9, color: "#4a6080" }}>{pair.centralBanks}</div></div>
                  <div><div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: "#c8d6e8" }}>{pair.price.toFixed(4)}</div><div style={{ fontFamily: "monospace", fontSize: 11, color: up ? "#00d4aa" : "#ff4757" }}>{up ? "+" : ""}{pair.change.toFixed(2)}%</div></div>
                  <div><div style={{ fontSize: 9, color: "#3a4558" }}>HIGH</div><div style={{ fontFamily: "monospace", fontSize: 11, color: "#00d4aa" }}>{pair.high.toFixed(4)}</div></div>
                  <div><div style={{ fontSize: 9, color: "#3a4558" }}>LOW</div><div style={{ fontFamily: "monospace", fontSize: 11, color: "#ff4757" }}>{pair.low.toFixed(4)}</div></div>
                  <BiasTag bias={pair.bias} />
                  <div style={{ fontSize: 11, color: "#7a8ba0" }}>{pair.driver}</div>
                  <span style={{ color: "#4a6080" }}>{isExp ? "▲" : "▼"}</span>
                </div>
                {isExp && (
                  <div style={{ borderTop: "1px solid #1a1f2e", padding: "12px 14px", background: "#080b12", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
                    {[{ label: "SUPPORT", val: pair.support?.toFixed(4), color: "#00d4aa" }, { label: "RESISTANCE", val: pair.resistance?.toFixed(4), color: "#ff4757" }, { label: "SESSION HIGH", val: pair.high.toFixed(4), color: "#c8d6e8" }, { label: "SESSION LOW", val: pair.low.toFixed(4), color: "#c8d6e8" }].map(f => (
                      <div key={f.label} style={{ background: "#0d1117", borderRadius: 4, padding: "8px 10px" }}>
                        <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace", marginBottom: 3 }}>{f.label}</div>
                        <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: f.color }}>{f.val}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      )}

      {activeTab === "commodities" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {COMMODITIES_DATA.map(com => {
            const isExp = expandedItem === com.name;
            const up = com.change >= 0;
            return (
              <Panel key={com.name} style={{ borderLeft: `3px solid ${up ? "#00d4aa40" : "#ff475740"}` }}>
                <div onClick={() => setExpandedItem(isExp ? null : com.name)} style={{ display: "grid", gridTemplateColumns: "120px 110px 70px 70px 100px 1fr auto", gap: 10, padding: "12px 14px", cursor: "pointer", alignItems: "center" }}>
                  <div><div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 14, color: "#e8f0fe" }}>{com.name}</div><div style={{ fontSize: 9, color: "#4a6080" }}>{com.unit}</div></div>
                  <div><div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: "#c8d6e8" }}>${com.price.toLocaleString()}</div><div style={{ fontFamily: "monospace", fontSize: 11, color: up ? "#00d4aa" : "#ff4757" }}>{up ? "+" : ""}{com.change.toFixed(2)}%</div></div>
                  <div><div style={{ fontSize: 9, color: "#3a4558" }}>HIGH</div><div style={{ fontFamily: "monospace", fontSize: 11, color: "#00d4aa" }}>${com.high.toLocaleString()}</div></div>
                  <div><div style={{ fontSize: 9, color: "#3a4558" }}>LOW</div><div style={{ fontFamily: "monospace", fontSize: 11, color: "#ff4757" }}>${com.low.toLocaleString()}</div></div>
                  <div style={{ fontSize: 9, background: "#1a2535", color: "#4a6080", padding: "3px 7px", borderRadius: 3, fontFamily: "monospace", whiteSpace: "nowrap" }}>{com.season}</div>
                  <div style={{ fontSize: 11, color: "#7a8ba0" }}>{com.driver}</div>
                  <span style={{ color: "#4a6080" }}>{isExp ? "▲" : "▼"}</span>
                </div>
                {isExp && (
                  <div style={{ borderTop: "1px solid #1a1f2e", padding: "12px 14px", background: "#080b12", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
                    {[{ label: "SUPPORT", val: `$${com.support.toLocaleString()}`, color: "#00d4aa" }, { label: "RESISTANCE", val: `$${com.resistance.toLocaleString()}`, color: "#ff4757" }, { label: "USD CORRELATION", val: com.dollarCorr.toFixed(2), color: com.dollarCorr < 0 ? "#ff4757" : "#00d4aa" }, { label: "SEASONALITY", val: com.season, color: "#ffa502" }].map(f => (
                      <div key={f.label} style={{ background: "#0d1117", borderRadius: 4, padding: "8px 10px" }}>
                        <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace", marginBottom: 3 }}>{f.label}</div>
                        <div style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: f.color }}>{f.val}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      )}

      {activeTab === "centralbanks" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            {CB_MATRIX.map(cb => (
              <Panel key={cb.bank} style={{ borderTop: `3px solid ${cb.color}` }}>
                <div style={{ padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div><div style={{ fontFamily: "monospace", fontWeight: 700, color: "#e8f0fe", fontSize: 13 }}>{cb.bank}</div><div style={{ fontSize: 10, color: "#4a6080" }}>{cb.country}</div></div>
                    <BiasTag bias={cb.bias} />
                  </div>
                  {[{ label: "CURRENT RATE", val: cb.rate, big: true }, { label: "NEXT MEETING", val: cb.nextMeeting, big: false }, { label: "EXPECTATION", val: cb.expectation, big: false }].map(f => (
                    <div key={f.label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 10, color: "#4a6080" }}>{f.label}</span>
                      <span style={{ fontFamily: "monospace", fontSize: f.big ? 16 : 12, fontWeight: f.big ? 700 : 400, color: f.big ? cb.color : "#c8d6e8" }}>{f.val}</span>
                    </div>
                  ))}
                </div>
              </Panel>
            ))}
          </div>
          <Panel>
            <SectionHeader title="CENTRAL BANK DIVERGENCE MAP" />
            <div style={{ padding: 14 }}>
              {[
                { pair: "USD vs EUR", diff: "+1.25-1.50%", impl: "ECB cutting while Fed holds. EUR/USD downside bias.", favours: "Long USD / Short EUR", color: "#3d8bff" },
                { pair: "USD vs JPY", diff: "+5.15-5.40%", impl: "Extreme divergence. BoJ at 0.1% vs Fed 5.5%. Carry trade dominant.", favours: "Long USD/JPY carry", color: "#ffa502" },
                { pair: "USD vs GBP", diff: "-0.25-0.00%", impl: "Near-parity. BoE hawkish hold = GBP support. Range-bound.", favours: "Neutral — monitor data", color: "#00d4aa" },
                { pair: "USD vs CAD", diff: "+0.25-0.50%", impl: "BoC ahead of Fed in cutting cycle. CAD under moderate pressure.", favours: "Mild USD/CAD upside", color: "#a855f7" },
              ].map(item => (
                <div key={item.pair} style={{ display: "grid", gridTemplateColumns: "120px 110px 1fr 160px", gap: 12, padding: "8px 0", borderBottom: "1px solid #0f1420", alignItems: "center" }}>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#c8d6e8", fontSize: 12 }}>{item.pair}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: item.color }}>{item.diff}</span>
                  <span style={{ fontSize: 11, color: "#7a8ba0" }}>{item.impl}</span>
                  <span style={{ fontSize: 9, background: `${item.color}20`, color: item.color, padding: "2px 7px", borderRadius: 3, fontFamily: "monospace", textAlign: "center" }}>{item.favours}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {activeTab === "dxy" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Panel>
            <SectionHeader title="DXY DOLLAR INDEX" subtitle="Key levels & context" />
            <div style={{ padding: 14 }}>
              <div style={{ textAlign: "center", padding: "10px 0 16px", borderBottom: "1px solid #1a1f2e", marginBottom: 14 }}>
                <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 4 }}>DXY SPOT</div>
                <div style={{ fontSize: 44, fontWeight: 900, fontFamily: "monospace", color: "#ffa502" }}>{(prices["DX-Y.NYB"]?.price || 104.22).toFixed(2)}</div>
                <div style={{ fontSize: 12, fontFamily: "monospace", color: "#00d4aa", marginTop: 4 }}>{formatChange(prices["DX-Y.NYB"]?.changePct || 0.34)}</div>
              </div>
              {[{ label: "Major Support", val: "103.40", color: "#00d4aa" }, { label: "Key Resistance", val: "105.20", color: "#ff4757" }, { label: "200 DMA", val: "104.82", color: "#3d8bff" }, { label: "50 DMA", val: "103.88", color: "#a855f7" }, { label: "YTD High", val: "105.80", color: "#ffa502" }, { label: "YTD Low", val: "100.62", color: "#ffa502" }].map(item => (
                <div key={item.label} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #0a0d14" }}>
                  <span style={{ fontSize: 11, color: "#7a8ba0" }}>{item.label}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: item.color }}>{item.val}</span>
                </div>
              ))}
              <div style={{ marginTop: 12, padding: "8px 10px", background: "#ffa50215", border: "1px solid #ffa50230", borderRadius: 4, fontSize: 11, color: "#ffa502" }}>
                DXY above 104 = headwind for Gold, EM, commodity exporters. Below 103 = significant USD weakness signal.
              </div>
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="DXY CORRELATION MAP" subtitle="How dollar moves affect assets" />
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                { asset: "Gold", corr: -0.78, desc: "Strong inverse — dollar up = gold headwind" },
                { asset: "EUR/USD", corr: -0.88, desc: "Very strong inverse — primary inverse pair" },
                { asset: "GBP/USD", corr: -0.72, desc: "Strong inverse — follows EUR/USD broadly" },
                { asset: "USD/JPY", corr: +0.84, desc: "Strong positive — dollar up = JPY weakness" },
                { asset: "WTI Crude", corr: -0.44, desc: "Moderate inverse — supply narrative can override" },
                { asset: "Copper", corr: -0.56, desc: "Moderate inverse — China demand also key driver" },
                { asset: "S&P 500", corr: -0.28, desc: "Weak inverse — multinationals FX headwind" },
                { asset: "Emerging Mkts", corr: -0.62, desc: "Strong inverse — EM USD debt = pressure" },
              ].map(item => {
                const abs = Math.abs(item.corr);
                const pos = item.corr > 0;
                const barColor = pos ? "#00d4aa" : "#ff4757";
                return (
                  <div key={item.asset}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ fontSize: 11, color: "#7a8ba0" }}>{item.asset}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 10, color: "#4a6080" }}>{item.desc}</span>
                        <span style={{ fontFamily: "monospace", fontSize: 12, color: barColor, minWidth: 40, textAlign: "right" }}>{item.corr.toFixed(2)}</span>
                      </div>
                    </div>
                    <div style={{ height: 4, background: "#1a2535", borderRadius: 2 }}>
                      <div style={{ width: `${abs * 100}%`, height: "100%", background: barColor, borderRadius: 2 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

// ============================================================
// CALENDAR PAGE
// ============================================================

const CAL_TYPE_META = {
  earnings: { label: "EARNINGS", color: "#3d8bff" },
  dividend: { label: "DIVIDEND", color: "#00d4aa" },
  econ:     { label: "ECONOMIC", color: "#ffa502" },
  fed:      { label: "CENTRAL BANK", color: "#a855f7" },
  tax:      { label: "TAX DEADLINE", color: "#f472b6" },
};

function calAddDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function calNextApril5(from) {
  const y = from.getFullYear();
  let d = new Date(y, 3, 5, 23, 59, 0);
  if (d <= from) d = new Date(y + 1, 3, 5, 23, 59, 0);
  return d;
}

function calIsSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function calFmtDate(d) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function calGroupLabel(d, now) {
  if (calIsSameDay(d, now)) return "TODAY";
  if (calIsSameDay(d, calAddDays(now, 1))) return "TOMORROW";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toUpperCase();
}

function calCountdown(target, now) {
  const diff = target - now;
  if (diff <= 0) return "now";
  const mins = Math.floor(diff / 60000);
  const days = Math.floor(mins / 1440);
  const hrs = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${m}m`;
  return `${m}m`;
}

function calMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function buildMockCalendarEvents(now) {
  const at = (n, h = 8, m = 30) => { const d = calAddDays(now, n); d.setHours(h, m, 0, 0); return d; };
  return [
    { id: "e1", type: "earnings", symbol: "AAPL", title: "Apple Inc — Earnings", date: at(3, 16, 0), importance: "high",
      detail: { time: "After Close", epsEst: "$1.82", epsPrev: "$1.64", revEst: "$94.2B" } },
    { id: "e2", type: "earnings", symbol: "TSLA", title: "Tesla Inc — Earnings", date: at(9, 16, 0), importance: "high",
      detail: { time: "After Close", epsEst: "$0.68", epsPrev: "$0.52", revEst: "$26.8B" } },
    { id: "e3", type: "earnings", symbol: "JPM", title: "JPMorgan Chase — Earnings", date: at(14, 7, 0), importance: "high",
      detail: { time: "Pre-Market", epsEst: "$4.31", epsPrev: "$4.17", revEst: "$43.1B" } },
    { id: "e4", type: "earnings", symbol: "ASML", title: "ASML Holding — Earnings", date: at(21, 7, 0), importance: "high",
      detail: { time: "Pre-Market (EU)", epsEst: "€6.12", epsPrev: "€5.28", revEst: "€7.5B" } },
    { id: "d1", type: "dividend", symbol: "VOD.L", title: "Vodafone Group — Ex-Dividend", date: at(5, 0, 0), importance: "medium",
      detail: { amount: "£0.027/share", payDate: calFmtDate(at(35)) } },
    { id: "d2", type: "dividend", symbol: "JPM", title: "JPMorgan Chase — Ex-Dividend", date: at(18, 0, 0), importance: "medium",
      detail: { amount: "$1.25/share", payDate: calFmtDate(at(48)) } },
    { id: "c1", type: "econ", title: "US CPI (YoY)", date: at(2, 13, 30), importance: "high",
      detail: { note: "Headline & core inflation print — key input for the Fed's rate path." } },
    { id: "c2", type: "econ", title: "US Non-Farm Payrolls", date: at(6, 13, 30), importance: "high",
      detail: { note: "Monthly jobs report — labour market strength gauge." } },
    { id: "c3", type: "fed", title: "FOMC Rate Decision", date: at(12, 19, 0), importance: "high",
      detail: { note: "Federal Reserve interest rate decision, followed by the Powell press conference." } },
    { id: "c4", type: "econ", title: "UK CPI (YoY)", date: at(16, 7, 0), importance: "high",
      detail: { note: "UK inflation print — directly relevant to a GBP-denominated portfolio and the BoE's policy path." } },
    { id: "c5", type: "fed", title: "Bank of England Rate Decision (MPC)", date: at(20, 12, 0), importance: "high",
      detail: { note: "BoE Monetary Policy Committee interest rate decision." } },
    { id: "c6", type: "econ", title: "US Core PCE (Fed's preferred gauge)", date: at(27, 13, 30), importance: "high",
      detail: { note: "The Fed's own preferred inflation measure." } },
    { id: "tax1", type: "tax", title: "UK ISA Tax Year End", date: calNextApril5(now), importance: "high",
      detail: { note: "Use-it-or-lose-it: any unused ISA allowance for this tax year expires at midnight. Current annual allowance is £20,000." } },
  ];
}

async function calAskAI(ev, setText, setLoading) {
  setLoading(true);
  const d = ev.detail ?? {};
  const context = ev.type === "earnings"
    ? `EPS estimate ${d.epsEst} vs prior ${d.epsPrev}. Revenue estimate ${d.revEst}. Reports ${d.time}.`
    : ev.type === "dividend"
    ? `Amount ${d.amount}, paid ${d.payDate}.`
    : d.note ?? "";
  const prompt = `You are a markets analyst. Upcoming event: "${ev.title}"${ev.symbol ? ` (${ev.symbol})` : ""}, on ${calFmtDate(ev.date)}. ${context}

Give a short, plain-text (no markdown) take in 3-4 sentences: why this matters and what to watch for.`;
  const res = await callAI(prompt, 300);
  setText(res.text);
  setLoading(false);
}

function CalendarEventRow({ ev, now, held, watch, expanded, onToggle }) {
  const meta = CAL_TYPE_META[ev.type];
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const d = ev.detail ?? {};

  return (
    <div style={{ marginBottom: 8 }}>
      <div onClick={onToggle} style={{
        display: "flex", alignItems: "center", gap: 14, padding: "13px 18px",
        background: "#0d1117", borderRadius: expanded ? "6px 6px 0 0" : 6,
        border: "1px solid #1a1f2e", borderLeft: `3px solid ${meta.color}`,
        cursor: "pointer",
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700, color: meta.color, background: `${meta.color}18`,
          padding: "3px 8px", borderRadius: 3, letterSpacing: 0.5, whiteSpace: "nowrap",
        }}>{meta.label}</span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {ev.symbol && <span style={{ fontSize: 14, fontWeight: 700, color: "#e8f0fe", fontFamily: "monospace" }}>{ev.symbol}</span>}
            <span style={{ fontSize: 13, color: "#c8d6e8" }}>{ev.title}</span>
            {held && <span style={{ fontSize: 10, fontWeight: 700, color: "#00d4aa", background: "#00d4aa18", padding: "2px 7px", borderRadius: 3 }}>HELD</span>}
            {watch && <span style={{ fontSize: 10, fontWeight: 700, color: "#3d8bff", background: "#3d8bff18", padding: "2px 7px", borderRadius: 3 }}>WATCHLIST</span>}
          </div>
        </div>

        <div style={{ fontSize: 12, color: "#4a6080", fontFamily: "monospace", whiteSpace: "nowrap" }}>{calFmtDate(ev.date)}</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#ffa502", fontFamily: "monospace", minWidth: 70, textAlign: "right" }}>
          {calCountdown(ev.date, now)}
        </div>
      </div>

      {expanded && (
        <div style={{ background: "#080b12", borderRadius: "0 0 6px 6px", padding: "16px 18px", border: "1px solid #1a1f2e", borderTop: "none" }}>
          {ev.type === "earnings" && (
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12, fontSize: 13 }}>
              <div><span style={{ color: "#4a6080" }}>Reports: </span><span style={{ color: "#c8d6e8" }}>{d.time}</span></div>
              <div><span style={{ color: "#4a6080" }}>EPS est: </span><span style={{ color: "#3d8bff", fontWeight: 700 }}>{d.epsEst}</span><span style={{ color: "#4a6080" }}> (prev {d.epsPrev})</span></div>
              <div><span style={{ color: "#4a6080" }}>Revenue est: </span><span style={{ color: "#c8d6e8", fontWeight: 700 }}>{d.revEst}</span></div>
            </div>
          )}
          {ev.type === "dividend" && (
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12, fontSize: 13 }}>
              <div><span style={{ color: "#4a6080" }}>Amount: </span><span style={{ color: "#00d4aa", fontWeight: 700 }}>{d.amount}</span></div>
              <div><span style={{ color: "#4a6080" }}>Pay date: </span><span style={{ color: "#c8d6e8" }}>{d.payDate}</span></div>
            </div>
          )}
          {d.note && <div style={{ fontSize: 13, color: "#7a8ba0", marginBottom: 12, lineHeight: 1.6 }}>{d.note}</div>}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: aiText ? 8 : 0 }}>
            <span style={{ fontSize: 10, color: "#4a6080", letterSpacing: 1 }}>ASK AI</span>
            <button onClick={() => calAskAI(ev, setAiText, setAiLoading)} disabled={aiLoading} style={{
              background: aiLoading ? "#1a2535" : "#3d8bff20", border: "1px solid #3d8bff40", color: "#3d8bff",
              padding: "5px 12px", borderRadius: 3, fontSize: 11, fontFamily: "monospace",
              cursor: aiLoading ? "default" : "pointer",
            }}>{aiLoading ? "THINKING…" : "ASK OPINION"}</button>
          </div>
          {aiText && (
            <div style={{ background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4, padding: 12, fontSize: 13, color: "#c8d6e8", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
              {aiText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CalendarPage() {
  const [now, setNow] = useState(() => new Date());
  const [events] = useState(() => buildMockCalendarEvents(new Date()));
  const [view, setView] = useState("timeline");
  const [relevance, setRelevance] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [heldSymbols, setHeldSymbols] = useState([]);
  const [watchSymbols, setWatchSymbols] = useState([]);
  const [gridMonth, setGridMonth] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [selectedDay, setSelectedDay] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    fetch(`${API}/portfolio`).then(r => r.json()).then(d => setHeldSymbols((d.positions ?? []).map(p => p.symbol))).catch(() => {});
    fetch(`${API}/watchlist`).then(r => r.json()).then(d => setWatchSymbols((d.watchlist ?? []).map(w => w.symbol))).catch(() => {});
  }, []);

  const isRelevant = ev => {
    if (relevance === "held") return ev.symbol && heldSymbols.includes(ev.symbol);
    if (relevance === "watchlist") return ev.symbol && watchSymbols.includes(ev.symbol);
    if (relevance === "econ") return ev.type === "econ" || ev.type === "fed" || ev.type === "tax";
    return true;
  };

  const relevantEvents = events.filter(isRelevant);
  const upcoming = relevantEvents.filter(ev => ev.date >= now).sort((a, b) => a.date - b.date);
  const nextEvent = upcoming[0];

  const groups = [];
  for (const ev of upcoming) {
    const last = groups[groups.length - 1];
    if (last && calIsSameDay(last.date, ev.date)) last.events.push(ev);
    else groups.push({ date: ev.date, events: [ev] });
  }

  const RELEVANCE_FILTERS = [
    { key: "all", label: "ALL" },
    { key: "held", label: "MY HOLDINGS" },
    { key: "watchlist", label: "WATCHLIST" },
    { key: "econ", label: "ECONOMIC" },
  ];

  const weeks = calMonthGrid(gridMonth.getFullYear(), gridMonth.getMonth());
  const dayEvents = d => relevantEvents.filter(ev => calIsSameDay(ev.date, d));
  const selectedDayEvents = dayEvents(selectedDay).sort((a, b) => a.date - b.date);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#e8f0fe", fontFamily: "monospace" }}>CALENDAR</div>
        <div style={{ fontSize: 13, color: "#4a6080", marginTop: 3 }}>
          {upcoming.length} upcoming events · earnings, dividends, macro & tax dates
        </div>
      </div>

      {/* Next Up hero */}
      {nextEvent && (
        <Panel>
          <div style={{ padding: "18px 22px", display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11, color: "#4a6080", letterSpacing: 1, marginBottom: 6 }}>NEXT UP</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, color: CAL_TYPE_META[nextEvent.type].color,
                  background: `${CAL_TYPE_META[nextEvent.type].color}18`, padding: "3px 8px", borderRadius: 3,
                }}>{CAL_TYPE_META[nextEvent.type].label}</span>
                {nextEvent.symbol && <span style={{ fontSize: 18, fontWeight: 700, color: "#e8f0fe", fontFamily: "monospace" }}>{nextEvent.symbol}</span>}
                <span style={{ fontSize: 16, color: "#c8d6e8" }}>{nextEvent.title}</span>
              </div>
              <div style={{ fontSize: 12, color: "#4a6080", marginTop: 4 }}>{calFmtDate(nextEvent.date)}</div>
            </div>
            <div style={{ marginLeft: "auto", textAlign: "right" }}>
              <div style={{ fontSize: 30, fontWeight: 700, color: "#ffa502", fontFamily: "monospace" }}>{calCountdown(nextEvent.date, now)}</div>
            </div>
          </div>
        </Panel>
      )}

      {/* Controls */}
      <Panel>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 20px", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", gap: 4 }}>
            {[{ key: "timeline", label: "TIMELINE" }, { key: "grid", label: "GRID" }].map(v => (
              <button key={v.key} onClick={() => setView(v.key)} style={{
                background: view === v.key ? "#0d1421" : "transparent",
                border: `1px solid ${view === v.key ? "#3d8bff40" : "#1a2535"}`,
                color: view === v.key ? "#c8d6e8" : "#4a6080",
                fontSize: 12, fontWeight: 700, padding: "6px 13px", borderRadius: 3,
                cursor: "pointer", fontFamily: "monospace", letterSpacing: 0.5,
              }}>{v.label}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {RELEVANCE_FILTERS.map(f => (
              <button key={f.key} onClick={() => setRelevance(f.key)} style={{
                background: relevance === f.key ? "#00d4aa20" : "transparent",
                border: relevance === f.key ? "1px solid #00d4aa40" : "1px solid #1a2535",
                color: relevance === f.key ? "#00d4aa" : "#4a6080",
                fontSize: 12, padding: "5px 12px", borderRadius: 3,
                cursor: "pointer", fontFamily: "monospace",
              }}>{f.label}</button>
            ))}
          </div>
        </div>
      </Panel>

      {view === "timeline" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {groups.length === 0 ? (
            <Panel><div style={{ padding: 32, textAlign: "center", color: "#4a6080", fontSize: 13 }}>No upcoming events match this filter.</div></Panel>
          ) : groups.map(g => (
            <div key={g.date.toISOString()} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, padding: "6px 2px", borderBottom: "1px solid #1a1f2e", marginBottom: 8 }}>
                {calGroupLabel(g.date, now)}
              </div>
              {g.events.map(ev => (
                <CalendarEventRow key={ev.id} ev={ev} now={now}
                  held={ev.symbol && heldSymbols.includes(ev.symbol)}
                  watch={ev.symbol && watchSymbols.includes(ev.symbol)}
                  expanded={expandedId === ev.id}
                  onToggle={() => setExpandedId(expandedId === ev.id ? null : ev.id)} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Panel>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 20px 11px", borderBottom: "1px solid #1a1f2e" }}>
              <button onClick={() => setGridMonth(d => { const n = new Date(d); n.setMonth(n.getMonth() - 1); return n; })}
                style={{ background: "transparent", border: "1px solid #1a2535", color: "#7a8ba0", borderRadius: 3, padding: "4px 10px", cursor: "pointer", fontSize: 13 }}>‹</button>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#c8d6e8", fontFamily: "monospace", letterSpacing: 1 }}>
                {gridMonth.toLocaleDateString("en-GB", { month: "long", year: "numeric" }).toUpperCase()}
              </span>
              <button onClick={() => setGridMonth(d => { const n = new Date(d); n.setMonth(n.getMonth() + 1); return n; })}
                style={{ background: "transparent", border: "1px solid #1a2535", color: "#7a8ba0", borderRadius: 3, padding: "4px 10px", cursor: "pointer", fontSize: 13 }}>›</button>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, marginBottom: 8 }}>
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => (
                  <div key={d} style={{ fontSize: 11, color: "#4a6080", textAlign: "center", letterSpacing: 1 }}>{d.toUpperCase()}</div>
                ))}
              </div>
              {weeks.map((week, wi) => (
                <div key={wi} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, marginBottom: 8 }}>
                  {week.map((day, di) => {
                    if (!day) return <div key={di} />;
                    const dayEvs = dayEvents(day);
                    const isToday = calIsSameDay(day, now);
                    const isSelected = calIsSameDay(day, selectedDay);
                    return (
                      <div key={di} onClick={() => setSelectedDay(day)} style={{
                        minHeight: 68, padding: "8px 10px", borderRadius: 5, cursor: "pointer",
                        background: isSelected ? "#0d1421" : "#0d1117",
                        border: `1px solid ${isSelected ? "#3d8bff60" : isToday ? "#00d4aa40" : "#1a1f2e"}`,
                      }}>
                        <div style={{ fontSize: 13, fontWeight: isToday ? 700 : 400, color: isToday ? "#00d4aa" : "#c8d6e8", marginBottom: 6 }}>
                          {day.getDate()}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                          {dayEvs.slice(0, 6).map(ev => (
                            <div key={ev.id} title={ev.title} style={{
                              width: 7, height: 7, borderRadius: "50%", background: CAL_TYPE_META[ev.type].color,
                            }} />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <SectionHeader title={calFmtDate(selectedDay).toUpperCase()} subtitle={`${selectedDayEvents.length} event${selectedDayEvents.length === 1 ? "" : "s"}`} />
            <div style={{ padding: 16 }}>
              {selectedDayEvents.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "#4a6080", fontSize: 13 }}>Nothing on this day.</div>
              ) : selectedDayEvents.map(ev => (
                <CalendarEventRow key={ev.id} ev={ev} now={now}
                  held={ev.symbol && heldSymbols.includes(ev.symbol)}
                  watch={ev.symbol && watchSymbols.includes(ev.symbol)}
                  expanded={expandedId === ev.id}
                  onToggle={() => setExpandedId(expandedId === ev.id ? null : ev.id)} />
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

// ============================================================
// NEWS / CATALYST INTELLIGENCE PAGE
// ============================================================

async function fetchAINewsSummary(story, setResult, setLoading) {
  setLoading(true);
  const symbolsStr = story.symbols?.length ? story.symbols.join(", ") : "none tagged";
  const prompt = `You are a buy-side analyst. Headline: "${story.title}" (${story.source}). Summary: ${story.summary || "none provided"}. Tagged symbols: ${symbolsStr}.

Write exactly 3 labeled sentences:
WHAT HAPPENED: One sentence plain English summary.
WHY MARKETS CARE: The mechanism — why could this move prices?
ACTIONABLE OR NOISE: Is this likely a tradeable catalyst or background noise? Be explicit, give a reason.

Plain text only. No markdown.`;
  const { text } = await callAI(prompt, 400);
  setResult(text);
  setLoading(false);
}

function newsSentimentMeta(score) {
  if (score == null) return { label: "NEUTRAL", color: "#4a6080" };
  if (score > 0.15) return { label: "POSITIVE", color: "#00d4aa" };
  if (score < -0.15) return { label: "NEGATIVE", color: "#ff4757" };
  return { label: "NEUTRAL", color: "#4a6080" };
}

function newsRelativeTime(ms) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function NewsPage() {
  const [stories, setStories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [relevance, setRelevance] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [symbolFilter, setSymbolFilter] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("smart");
  const [tier, setTier] = useState("relevant");
  const [expandedId, setExpandedId] = useState(null);
  const [aiAnalysis, setAiAnalysis] = useState({});
  const [aiLoadingId, setAiLoadingId] = useState(null);
  const [heldSymbols, setHeldSymbols] = useState([]);
  const [watchSymbols, setWatchSymbols] = useState([]);
  const [failedFeeds, setFailedFeeds] = useState([]);
  const [aiStatus, setAiStatus] = useState({ enabled: false, scored: 0, pending: 0, total: 0 });

  // Relevance floors. "Everything" still ranks, it just stops hiding the
  // low-scoring tail — useful when hunting for something specific.
  const TIERS = {
    essential: { min: 60, label: "Essential", hint: "Market-moving only" },
    relevant:  { min: 25, label: "Relevant",  hint: "Filters out noise" },
    all:       { min: 0,  label: "Everything", hint: "Unfiltered firehose" },
  };
  const minRelevance = TIERS[tier].min;

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        limit: "120",
        sort,
        minRelevance: String(minRelevance),
      });
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      const res = await fetch(`${API}/news?${params}`);
      const data = await res.json();
      setStories(data.news ?? []);
      setLastRefresh(data.lastRefresh ?? null);
      setFailedFeeds(data.failedFeeds ?? []);
      setAiStatus(data.ai ?? { enabled: false, scored: 0, pending: 0, total: 0 });
      setError(null);
    } catch {
      setError("Could not reach the server at localhost:3001. Is npm start running?");
    } finally {
      setLoading(false);
    }
  }, [sort, minRelevance, categoryFilter]);

  useEffect(() => {
    load();
    fetch(`${API}/portfolio`).then(r => r.json()).then(d => setHeldSymbols((d.positions ?? []).map(p => p.symbol))).catch(() => {});
    fetch(`${API}/watchlist`).then(r => r.json()).then(d => setWatchSymbols((d.watchlist ?? []).map(w => w.symbol))).catch(() => {});
  }, [load]);

  // The backend refreshes feeds every 10 min on its own — poll quietly so new
  // stories appear without a manual reload.
  useEffect(() => {
    const poll = setInterval(load, 90_000);
    return () => clearInterval(poll);
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await fetch(`${API}/news/refresh`, { method: "POST" }).catch(() => {});
    await load();
    setRefreshing(false);
  }

  // Fills in the scoring backlog on demand rather than waiting for the next
  // refresh cycle — mainly matters right after a key is first added.
  async function scoreNow() {
    setScoring(true);
    try {
      await fetch(`${API}/news/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 60 }),
      });
      await load();
    } catch { /* surfaced via aiStatus staying put */ }
    setScoring(false);
  }

  function handleAI(story) {
    if (aiAnalysis[story.guid] || aiLoadingId === story.guid) return;
    setAiLoadingId(story.guid);
    fetchAINewsSummary(story, (text) => {
      setAiAnalysis(prev => ({ ...prev, [story.guid]: text }));
      setAiLoadingId(null);
    }, () => setAiLoadingId(null));
  }

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#4a6080", fontSize: 12 }}>Loading news…</div>;
  if (error) return <Panel style={{ padding: 20 }}><div style={{ color: "#ff4757", fontSize: 12 }}>⚠ {error}</div></Panel>;

  const isRelevant = s => {
    if (relevance === "held") return s.symbols?.some(sym => heldSymbols.includes(sym));
    if (relevance === "watchlist") return s.symbols?.some(sym => watchSymbols.includes(sym));
    return true;
  };
  const searchQ = search.trim().toLowerCase();
  const filtered = stories
    .filter(isRelevant)
    .filter(s => sourceFilter === "all" || s.source === sourceFilter)
    .filter(s => !symbolFilter || s.symbols?.includes(symbolFilter))
    .filter(s => !searchQ || s.title?.toLowerCase().includes(searchQ) || s.summary?.toLowerCase().includes(searchQ));

  const sources = [...new Set(stories.map(s => s.source))].sort();
  const cats = [...new Set(stories.map(s => s.category).filter(Boolean))].sort();
  const portfolioCount = stories.filter(s => s.symbols?.some(sym => heldSymbols.includes(sym))).length;
  const watchlistCount = stories.filter(s => s.symbols?.some(sym => watchSymbols.includes(sym))).length;

  const mentionCounts = {};
  for (const s of stories) for (const sym of s.symbols ?? []) mentionCounts[sym] = (mentionCounts[sym] ?? 0) + 1;
  const topMentions = Object.entries(mentionCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const scoredPct = aiStatus.total ? Math.round((aiStatus.scored / aiStatus.total) * 100) : 0;
  const selectStyle = { background: "#0d1117", border: "1px solid #1a2535", color: "#7a8ba0", padding: "5px 10px", borderRadius: 3, cursor: "pointer", fontFamily: "monospace", fontSize: 11 };
  const btn = (active, color) => ({
    background: active ? `${color}20` : "transparent",
    border: `1px solid ${active ? `${color}40` : "#1a2535"}`,
    color: active ? color : "#4a6080",
    padding: "5px 12px", borderRadius: 3, cursor: "pointer", fontFamily: "monospace", fontSize: 11,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#e8f0fe", fontFamily: "monospace" }}>NEWS</div>
          <div style={{ fontSize: 13, color: "#4a6080", marginTop: 3 }}>
            {filtered.length} shown · {sources.length} feeds
            {lastRefresh && ` · refreshed ${newsRelativeTime(lastRefresh)}`}
          </div>
          {failedFeeds.length > 0 && (
            <div style={{ fontSize: 11, color: "#ffa502", marginTop: 4 }}>
              ⚠ {failedFeeds.length} feed{failedFeeds.length > 1 ? "s" : ""} failed last refresh: {failedFeeds.join(", ")}
            </div>
          )}
        </div>
        <button onClick={refresh} disabled={refreshing} style={{
          background: refreshing ? "#1a2535" : "#00d4aa20", border: "1px solid #00d4aa40", color: "#00d4aa",
          padding: "8px 16px", borderRadius: 4, fontSize: 12, fontFamily: "monospace",
          cursor: refreshing ? "default" : "pointer",
        }}>{refreshing ? "REFRESHING…" : "↻ REFRESH FEED"}</button>
      </div>

      {/* AI scoring status — the thing that makes the ranking meaningful, so
          it gets stated plainly rather than hidden in Settings. */}
      <Panel style={{ borderLeft: `3px solid ${aiStatus.enabled ? "#00d4aa" : "#ffa502"}` }}>
        <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, fontFamily: "monospace", letterSpacing: 1, color: aiStatus.enabled ? "#00d4aa" : "#ffa502" }}>
              {aiStatus.enabled ? "◉ AI RANKING ACTIVE" : "○ AI RANKING OFF"}
            </span>
            {aiStatus.enabled ? (
              <span style={{ fontSize: 12, color: "#7a8ba0" }}>
                {aiStatus.scored} of {aiStatus.total} stories scored ({scoredPct}%)
                {aiStatus.pending > 0 && <span style={{ color: "#4a6080" }}> · {aiStatus.pending} pending</span>}
                {aiStatus.gaveUp > 0 && <span style={{ color: "#4a6080" }}> · {aiStatus.gaveUp} unscoreable</span>}
              </span>
            ) : (
              <span style={{ fontSize: 12, color: "#7a8ba0" }}>
                Add a Gemini key in Settings to rank stories by real relevance instead of keywords.
              </span>
            )}
          </div>
          {aiStatus.enabled && aiStatus.pending > 0 && (
            <button onClick={scoreNow} disabled={scoring} style={{
              background: scoring ? "#1a2535" : "#3d8bff20", border: "1px solid #3d8bff40", color: "#3d8bff",
              padding: "6px 14px", borderRadius: 3, fontSize: 11, fontFamily: "monospace",
              cursor: scoring ? "default" : "pointer",
            }}>{scoring ? "SCORING…" : `SCORE ${Math.min(aiStatus.pending, 60)} NOW`}</button>
          )}
        </div>
        {aiStatus.enabled && aiStatus.total > 0 && (
          <div style={{ height: 3, background: "#1a2535" }}>
            <div style={{ width: `${scoredPct}%`, height: "100%", background: "#00d4aa", transition: "width .4s" }} />
          </div>
        )}
      </Panel>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {[
          { label: "SHOWING", val: filtered.length, color: "#c8d6e8" },
          { label: "PORTFOLIO MENTIONS", val: portfolioCount, color: "#00d4aa" },
          { label: "WATCHLIST MENTIONS", val: watchlistCount, color: "#3d8bff" },
          { label: "LIVE FEEDS", val: sources.length, color: "#ffa502" },
        ].map(s => (
          <div key={s.label} style={{ background: "#0d1117", border: `1px solid ${s.color}20`, borderTop: `2px solid ${s.color}`, borderRadius: 6, padding: "12px 16px" }}>
            <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1, marginBottom: 5 }}>{s.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "monospace", color: s.color }}>{s.val}</div>
          </div>
        ))}
      </div>

      {topMentions.length > 0 && (
        <Panel>
          <SectionHeader title="MOST MENTIONED" subtitle="by symbol, across current feed — click to filter" />
          <div style={{ padding: "14px 16px", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {topMentions.map(([sym, count]) => {
              const active = symbolFilter === sym;
              return (
                <div key={sym} onClick={() => setSymbolFilter(active ? null : sym)} style={{
                  display: "flex", alignItems: "center", gap: 6, background: active ? "#00d4aa18" : "#0d1117",
                  border: active ? "1px solid #00d4aa60" : "1px solid #1a2535", borderRadius: 4, padding: "6px 12px",
                  cursor: "pointer",
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: active ? "#00d4aa" : "#c8d6e8", fontFamily: "monospace" }}>{sym}</span>
                  <span style={{ fontSize: 11, color: "#4a6080" }}>{count}</span>
                  {heldSymbols.includes(sym) && <span style={{ fontSize: 9, color: "#00d4aa" }}>HELD</span>}
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* Primary controls: what gets shown, and in what order. */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace" }}>SHOW:</span>
        {Object.entries(TIERS).map(([id, t]) => (
          <button key={id} onClick={() => setTier(id)} title={t.hint} style={btn(tier === id, "#00d4aa")}>{t.label}</button>
        ))}
        <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace", marginLeft: 8 }}>ORDER:</span>
        <button onClick={() => setSort("smart")} title="Rank by relevance, your holdings, source quality and freshness" style={btn(sort === "smart", "#a855f7")}>Smart</button>
        <button onClick={() => setSort("newest")} title="Strict reverse-chronological" style={btn(sort === "newest", "#a855f7")}>Newest</button>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search headlines…"
          style={{ marginLeft: "auto", background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4, color: "#c8d6e8", fontFamily: "monospace", fontSize: 12, padding: "7px 12px", minWidth: 200 }}
        />
      </div>

      {/* Secondary controls. */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: -8 }}>
        <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace" }}>RELEVANCE:</span>
        {[{ id: "all", label: "All" }, { id: "held", label: `My Holdings (${portfolioCount})` }, { id: "watchlist", label: `Watchlist (${watchlistCount})` }].map(f => (
          <button key={f.id} onClick={() => setRelevance(f.id)} style={btn(relevance === f.id, "#00d4aa")}>{f.label}</button>
        ))}
        <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace", marginLeft: 8 }}>SOURCE:</span>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} style={selectStyle}>
          <option value="all">All ({stories.length})</option>
          {sources.map(src => <option key={src} value={src}>{src}</option>)}
        </select>
        {cats.length > 0 && (
          <>
            <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace", marginLeft: 8 }}>TYPE:</span>
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} style={selectStyle}>
              <option value="all">All</option>
              {cats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </>
        )}
        {symbolFilter && (
          <button onClick={() => setSymbolFilter(null)} style={btn(true, "#00d4aa")}>{symbolFilter} ✕</button>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.length === 0 && (
          <Panel><div style={{ color: "#4a6080", fontSize: 13, padding: 24, textAlign: "center" }}>
            No stories match current filters.
            {tier !== "all" && <> Try <span onClick={() => setTier("all")} style={{ color: "#3d8bff", cursor: "pointer" }}>Everything</span>.</>}
          </div></Panel>
        )}
        {filtered.map(story => {
          const isExp = expandedId === story.guid;
          const sentiment = newsSentimentMeta(story.sentiment);
          const held = story.symbols?.some(sym => heldSymbols.includes(sym));
          const watch = story.symbols?.some(sym => watchSymbols.includes(sym));
          const rel = story.relevance ?? 0;
          const relColor = rel >= 70 ? "#00d4aa" : rel >= 40 ? "#ffa502" : "#4a6080";
          return (
            <Panel key={story.guid} style={{ borderLeft: `3px solid ${sentiment.color}` }}>
              <div onClick={() => { setExpandedId(isExp ? null : story.guid); if (!isExp) handleAI(story); }} style={{ padding: "13px 18px", cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                  <div style={{ minWidth: 90, flexShrink: 0 }}>
                    <div style={{ fontFamily: "monospace", fontSize: 12, color: "#4a6080" }}>{newsRelativeTime(story.published)}</div>
                    <div style={{ fontSize: 11, color: "#3a4558", marginTop: 2 }}>{story.source}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, flexWrap: "wrap" }}>
                      {/* Relevance is the headline signal now, so it leads. */}
                      <span title={story.scored ? "AI-assessed relevance" : "Estimated — not yet AI-scored"} style={{
                        fontSize: 10, fontWeight: 700, fontFamily: "monospace",
                        background: `${relColor}18`, color: relColor, padding: "2px 7px", borderRadius: 3,
                        border: story.scored ? "none" : `1px dashed ${relColor}50`,
                      }}>{rel}{story.scored ? "" : "?"}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, background: `${sentiment.color}18`, color: sentiment.color, padding: "2px 7px", borderRadius: 3, fontFamily: "monospace" }}>{sentiment.label}</span>
                      {story.category && <span style={{ fontSize: 10, color: "#7a8ba0", fontFamily: "monospace", background: "#1a2535", padding: "2px 7px", borderRadius: 3 }}>{story.category}</span>}
                      {held && <span style={{ fontSize: 10, fontWeight: 700, background: "#00d4aa18", color: "#00d4aa", padding: "2px 7px", borderRadius: 3 }}>HELD</span>}
                      {watch && <span style={{ fontSize: 10, fontWeight: 700, background: "#3d8bff18", color: "#3d8bff", padding: "2px 7px", borderRadius: 3 }}>WATCHLIST</span>}
                      {story.alsoReported > 0 && (
                        <span title="Same story carried by other feeds" style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace" }}>
                          +{story.alsoReported} source{story.alsoReported > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 14, color: "#c8d6e8", lineHeight: 1.4 }}>{story.title}</div>
                    {/* The one line that turns a headline list into something
                        you can actually triage at a glance. */}
                    {story.why && (
                      <div style={{ fontSize: 12, color: "#7a8ba0", marginTop: 5, lineHeight: 1.45, fontStyle: "italic" }}>
                        {story.why}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 90, alignItems: "flex-end" }}>
                    {(story.symbols ?? []).slice(0, 3).map(sym => <span key={sym} style={{ fontSize: 10, background: "#1a2535", color: "#7a8ba0", padding: "1px 6px", borderRadius: 2, fontFamily: "monospace" }}>{sym}</span>)}
                  </div>
                  <span style={{ color: "#4a6080", fontSize: 13, flexShrink: 0 }}>{isExp ? "▲" : "▼"}</span>
                </div>
              </div>
              {isExp && (
                <div style={{ borderTop: "1px solid #1a1f2e", padding: "14px 18px", background: "#080b12" }}>
                  {story.summary && <div style={{ fontSize: 13, color: "#a0b4c8", lineHeight: 1.6, marginBottom: 12 }}>{story.summary}</div>}
                  {story.url && (
                    <a href={story.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#3d8bff", textDecoration: "none" }}>
                      Read full story ↗
                    </a>
                  )}
                  <div style={{ marginTop: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 10, color: "#00d4aa", fontFamily: "monospace", letterSpacing: 1 }}>AI STORY ANALYSIS</span>
                      {!aiAnalysis[story.guid] && aiLoadingId !== story.guid && (
                        <button onClick={e => { e.stopPropagation(); handleAI(story); }} style={{ background: "#00d4aa20", border: "1px solid #00d4aa40", color: "#00d4aa", padding: "5px 12px", borderRadius: 3, cursor: "pointer", fontFamily: "monospace", fontSize: 11 }}>ANALYSE</button>
                      )}
                    </div>
                    {aiLoadingId === story.guid ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 12, height: 12, border: "2px solid #1a2535", borderTop: "2px solid #00d4aa", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                        <span style={{ fontSize: 12, color: "#4a6080", fontFamily: "monospace" }}>Analysing…</span>
                      </div>
                    ) : aiAnalysis[story.guid] && (
                      <div style={{ background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4, padding: 12, fontSize: 13, color: "#c8d6e8", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
                        {aiAnalysis[story.guid]}
                      </div>
                    )}
                  </div>
                  {(story.symbols ?? []).length > 0 && (
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 12 }}>
                      <span style={{ fontSize: 10, color: "#4a6080" }}>TAGGED:</span>
                      {story.symbols.map(sym => <span key={sym} style={{ fontSize: 10, background: "#1a2535", color: "#7a8ba0", padding: "2px 7px", borderRadius: 2, fontFamily: "monospace" }}>{sym}</span>)}
                      {story.aiSymbols && <span style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace" }}>(AI-verified)</span>}
                    </div>
                  )}
                </div>
              )}
            </Panel>
          );
        })}
      </div>
    </div>
  );
}

function ResearchPage({ prices }) {
  const trackedSymbols = Object.keys(DISPLAY_NAMES);
  const [query, setQuery] = useState("^GSPC");
  const [symbol, setSymbol] = useState("^GSPC");
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  const data = prices?.[symbol];
  const name = DISPLAY_NAMES[symbol] || symbol;
  const isTracked = trackedSymbols.includes(symbol);
  const price = data?.price;
  const levels = price ? { r2: price * 1.05, r1: price * 1.02, s1: price * 0.98, s2: price * 0.95 } : null;

  const runSearch = () => {
    const s = query.trim();
    if (!s) return;
    setSymbol(s); setAiText("");
  };

  const runAI = async () => {
    setAiLoading(true);
    const ctx = data
      ? `Current price ${formatPrice(data.price, symbol)}, day change ${formatChange(data.changePct)}, week change ${formatChange(data.weekChangePct)}.`
      : "No live price available for this asset in the terminal feed.";
    const prompt = `You are a senior sell-side analyst. Asset: ${name} (${symbol}). ${ctx}

Write a structured research note in plain text, no markdown, with these four labelled sections, each 2-3 sentences:
BULL CASE: The strongest argument to be long.
BEAR CASE: The strongest argument against / to be short.
BASE CASE: The most probable path from here.
WHAT WOULD CHANGE MY VIEW: The specific signals that would upgrade or downgrade this.

Be specific and opinionated. No hedging filler.`;
    const { text } = await callAI(prompt, 900);
    setAiText(text);
    setAiLoading(false);
  };

  const inputStyle = { background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4, color: "#c8d6e8", fontFamily: "monospace", fontSize: 13, padding: "9px 12px" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel>
        <SectionHeader title="ASSET RESEARCH" subtitle="Deep-dive on any tracked symbol" />
        <div style={{ padding: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && runSearch()} placeholder="Symbol e.g. ^GSPC, GC=F, GBPUSD=X" style={{ ...inputStyle, flex: 1, minWidth: 220 }} />
          <button onClick={runSearch} style={{ background: "#3d8bff20", border: "1px solid #3d8bff40", color: "#3d8bff", padding: "9px 18px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace", fontSize: 12 }}>ANALYSE</button>
        </div>
        <div style={{ padding: "0 14px 12px", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {trackedSymbols.slice(0, 10).map(s => (
            <button key={s} onClick={() => { setQuery(s); setSymbol(s); setAiText(""); }} style={{ background: symbol === s ? "#00d4aa20" : "#0d1117", border: `1px solid ${symbol === s ? "#00d4aa40" : "#1a2535"}`, color: symbol === s ? "#00d4aa" : "#7a8ba0", padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace", fontSize: 10 }}>{DISPLAY_NAMES[s] || s}</button>
          ))}
        </div>
      </Panel>

      <Panel>
        <div style={{ padding: 16, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#e8f0fc", fontFamily: "monospace" }}>{name}</div>
            <div style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace", marginTop: 2 }}>{symbol} {isTracked ? "\u00b7 LIVE TRACKED" : "\u00b7 NOT TRACKED"}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#e8f0fc", fontFamily: "monospace" }}>{data ? formatPrice(data.price, symbol) : "\u2014"}</div>
            {data && (
              <div style={{ display: "flex", gap: 14, justifyContent: "flex-end", marginTop: 4 }}>
                <span style={{ fontSize: 12, fontFamily: "monospace", color: data.changePct >= 0 ? "#00d4aa" : "#ff4757" }}>1D {formatChange(data.changePct)}</span>
                <span style={{ fontSize: 12, fontFamily: "monospace", color: data.weekChangePct >= 0 ? "#00d4aa" : "#ff4757" }}>1W {formatChange(data.weekChangePct)}</span>
              </div>
            )}
          </div>
        </div>
      </Panel>

      {!data && (
        <Panel><div style={{ padding: 16, fontSize: 12, color: "#7a8ba0" }}>No live price for <span style={{ color: "#c8d6e8", fontFamily: "monospace" }}>{symbol}</span> in the terminal feed. You can still generate an AI research note below, or add a price link in Settings.</div></Panel>
      )}

      {levels && (
        <Panel>
          <SectionHeader title="APPROXIMATE KEY LEVELS" subtitle="Derived from current price \u2014 reference only, not technical analysis" />
          <div style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
            {[["R2 (+5%)", levels.r2, "#ff4757"], ["R1 (+2%)", levels.r1, "#ff8c42"], ["S1 (-2%)", levels.s1, "#4ade80"], ["S2 (-5%)", levels.s2, "#00d4aa"]].map(([lbl, val, col]) => (
              <div key={lbl} style={{ background: "#0d1117", border: "1px solid #1a1f2e", borderRadius: 5, padding: "10px 12px", borderTop: `2px solid ${col}` }}>
                <div style={{ fontSize: 9, color: "#4a6080", fontFamily: "monospace" }}>{lbl}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#c8d6e8", fontFamily: "monospace", marginTop: 3 }}>{formatPrice(val, symbol)}</div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel>
        <SectionHeader title="AI RESEARCH NOTE" subtitle="Bull / bear / base case" action={aiLoading ? "THINKING..." : "GENERATE"} onAction={runAI} />
        <div style={{ padding: 16 }}>
          {aiText
            ? <div style={{ fontSize: 12.5, lineHeight: 1.8, color: "#b8c6da", whiteSpace: "pre-wrap", fontFamily: "'Courier New', monospace" }}>{aiText}</div>
            : <div style={{ fontSize: 12, color: "#4a6080" }}>Click GENERATE for a structured bull / bear / base research note on {name}. Requires a Gemini API key (Settings).</div>}
        </div>
      </Panel>
    </div>
  );
}

// ============================================================
// RISK PAGE
// New in v2 — reads live from the local risk engine at :3001/risk.
// Built to match the existing Panel / SectionHeader / GaugeBar conventions
// used elsewhere in this file, so it doesn't look bolted on.
// ============================================================

function RiskMetric({ label, value, sub, color = "#c8d6e8" }) {
  return (
    <div style={{ padding: "18px 22px", borderRight: "1px solid #1a1f2e" }}>
      <div style={{ fontSize: 11, color: "#4a6080", letterSpacing: 1, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, color, fontFamily: "monospace" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: "#4a6080", marginTop: 5 }}>{sub}</div>
      )}
    </div>
  );
}

function RiskContributionRow({ row }) {
  const gap = row.pctOfRisk - row.weight;
  const gapColor = gap > 3 ? "#ff4757" : gap < -3 ? "#00d4aa" : "#7a8ba0";
  const barMax = Math.max(row.weight, row.pctOfRisk, 1);
  return (
    <div style={{ padding: "10px 16px", borderBottom: "1px solid #12161f" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#c8d6e8", fontFamily: "monospace" }}>
          {row.symbol}
        </span>
        <span style={{ fontSize: 11, color: gapColor, fontFamily: "monospace" }}>
          {gap > 0 ? "+" : ""}{gap.toFixed(1)}pp risk vs weight
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
        <span style={{ fontSize: 9, color: "#4a6080", width: 44 }}>WEIGHT</span>
        <div style={{ flex: 1, height: 5, background: "#1a2535", borderRadius: 3 }}>
          <div style={{ width: `${(row.weight / barMax) * 100}%`, height: "100%", background: "#3d8bff", borderRadius: 3 }} />
        </div>
        <span style={{ fontSize: 10, color: "#7a8ba0", width: 44, textAlign: "right", fontFamily: "monospace" }}>{row.weight.toFixed(1)}%</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 9, color: "#4a6080", width: 44 }}>RISK</span>
        <div style={{ flex: 1, height: 5, background: "#1a2535", borderRadius: 3 }}>
          <div style={{ width: `${(row.pctOfRisk / barMax) * 100}%`, height: "100%", background: gapColor, borderRadius: 3 }} />
        </div>
        <span style={{ fontSize: 10, color: "#7a8ba0", width: 44, textAlign: "right", fontFamily: "monospace" }}>{row.pctOfRisk.toFixed(1)}%</span>
      </div>
    </div>
  );
}

function CorrelationCell({ value }) {
  const v = value;
  const bg = v >= 0.99 ? "#1a2535"
    : v > 0.5 ? `rgba(255,71,87,${Math.min(v, 1) * 0.55})`
    : v > 0.15 ? `rgba(255,165,2,${v * 0.5})`
    : v < -0.15 ? `rgba(0,212,170,${Math.min(-v, 1) * 0.55})`
    : "transparent";
  return (
    <div style={{
      width: 52, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
      background: bg, fontSize: 10, fontFamily: "monospace", color: "#c8d6e8",
      border: "1px solid #12161f",
    }}>
      {v.toFixed(2)}
    </div>
  );
}

function RiskPage() {
  const [risk, setRisk] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("http://localhost:3001/risk", { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        if (!cancelled) {
          if (data.error) setError(data.error);
          else { setRisk(data); setError(null); }
        }
      } catch (e) {
        if (!cancelled) setError("Could not reach the risk engine at localhost:3001. Is npm start running?");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#4a6080", fontSize: 12 }}>
        Loading risk profile…
      </div>
    );
  }

  if (error) {
    return (
      <Panel style={{ padding: 20 }}>
        <div style={{ color: "#ff4757", fontSize: 12, marginBottom: 8 }}>⚠ {error}</div>
        <div style={{ color: "#4a6080", fontSize: 11 }}>
          Add holdings via the API and make sure history has been synced (npm run sync).
        </div>
      </Panel>
    );
  }

  const varColor = risk.varInPounds.daily95 > risk.totalValue * 0.03 ? "#ff4757" : "#c8d6e8";
  const ddColor = risk.drawdown?.stillUnderwater ? "#ffa502" : "#7a8ba0";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#e8f0fe", fontFamily: "monospace" }}>RISK</div>
        <div style={{ fontSize: 11, color: "#4a6080", marginTop: 2 }}>
          Computed from {risk.observations} trading days of stored history · {risk.coverage.analysed}/{risk.coverage.total} holdings analysed
        </div>
      </div>

      {/* Top metrics strip */}
      <Panel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)" }}>
          <RiskMetric label="ANNUALISED VOL" value={`${risk.volatility.toFixed(1)}%`} />
          <RiskMetric label="BETA VS S&P 500" value={risk.beta.toFixed(2)} sub={`α ${risk.alpha >= 0 ? "+" : ""}${risk.alpha.toFixed(1)}%`} />
          <RiskMetric label="SHARPE" value={risk.sharpe.toFixed(2)} sub={`Sortino ${risk.sortino.toFixed(2)}`} />
          <RiskMetric
            label="VAR (95%, 1-DAY)"
            value={`£${risk.varInPounds.daily95.toLocaleString()}`}
            sub={`CVaR £${risk.varInPounds.cvarDaily.toLocaleString()}`}
            color={varColor}
          />
          <RiskMetric
            label="DRAWDOWN"
            value={`${risk.drawdown?.max.toFixed(1)}%`}
            sub={risk.drawdown?.stillUnderwater ? `still underwater (now ${risk.drawdown.current.toFixed(1)}%)` : "recovered"}
            color={ddColor}
          />
        </div>
      </Panel>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>

        {/* Risk contribution vs weight */}
        <Panel>
          <SectionHeader title="RISK CONTRIBUTION vs WEIGHT" subtitle="where risk actually comes from" />
          {risk.riskContributions.map(r => <RiskContributionRow key={r.symbol} row={r} />)}
        </Panel>

        {/* Diversification + concentration */}
        <Panel>
          <SectionHeader title="DIVERSIFICATION" />
          <div style={{ padding: 16 }}>
            <GaugeBar label="Average pairwise correlation" value={risk.diversification.averageCorrelation * 100} max={100} color="#3d8bff" format={v => (v / 100).toFixed(2)} />
            <GaugeBar label="Diversification ratio" value={Math.min(risk.diversification.diversificationRatio * 50, 100)} max={100} color="#00d4aa" format={() => risk.diversification.diversificationRatio.toFixed(2)} />
            <GaugeBar label="Effective holdings" value={Math.min(risk.diversification.effectiveHoldings * 20, 100)} max={100} color="#ffa502" format={() => risk.diversification.effectiveHoldings.toFixed(2)} />
          </div>
          <div style={{ borderTop: "1px solid #1a1f2e", padding: 16 }}>
            <div style={{ fontSize: 10, color: "#4a6080", marginBottom: 10, letterSpacing: 1 }}>CONCENTRATION</div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 6 }}>
              <span style={{ color: "#7a8ba0" }}>Largest position</span>
              <span style={{ fontFamily: "monospace", color: "#c8d6e8" }}>{risk.concentration.largestPosition.toFixed(1)}%</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 6 }}>
              <span style={{ color: "#7a8ba0" }}>Top 3 positions</span>
              <span style={{ fontFamily: "monospace", color: "#c8d6e8" }}>{risk.concentration.top3.toFixed(1)}%</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span style={{ color: "#7a8ba0" }}>Look-through US exposure</span>
              <span style={{ fontFamily: "monospace", color: risk.concentration.lookThroughUS > 50 ? "#ffa502" : "#c8d6e8" }}>
                {risk.concentration.lookThroughUS.toFixed(1)}%
              </span>
            </div>
          </div>
        </Panel>
      </div>

      {/* Correlation matrix */}
      <Panel>
        <SectionHeader title="CORRELATION MATRIX" subtitle={`${risk.correlationMatrix.observations} trading days`} />
        <div style={{ padding: 16, overflowX: "auto" }}>
          <div style={{ display: "inline-block" }}>
            <div style={{ display: "flex" }}>
              <div style={{ width: 60 }} />
              {risk.correlationMatrix.symbols.map(s => (
                <div key={s} style={{ width: 52, fontSize: 9, color: "#4a6080", textAlign: "center", fontFamily: "monospace" }}>{s.replace(".L", "")}</div>
              ))}
            </div>
            {risk.correlationMatrix.matrix.map((row, i) => (
              <div key={i} style={{ display: "flex" }}>
                <div style={{ width: 60, fontSize: 10, color: "#7a8ba0", display: "flex", alignItems: "center", fontFamily: "monospace" }}>
                  {risk.correlationMatrix.symbols[i].replace(".L", "")}
                </div>
                {row.map((v, j) => <CorrelationCell key={j} value={v} />)}
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}

// ============================================================
// PORTFOLIO PAGE (v2) — live, editable, no PowerShell required
// Reads and writes the real holdings table at :3001.
// Adding a holding auto-syncs its price history server-side, so it becomes
// visible to Risk / Optimiser / Backtest immediately rather than silently
// being excluded until a manual sync is run.
// ============================================================

const API = "http://localhost:3001";

const WRAPPERS = ["ISA", "SIPP", "GIA"];
const SECTORS = ["Broad", "Tech", "Defence", "Gold", "EM", "Energy", "Financials", "Healthcare", "Property", "Other"];
const GEOGRAPHIES = ["US", "UK", "Europe", "Global", "Japan", "Asia-Pacific", "India", "EM", "Other"];

function fieldStyle(width) {
  return {
    width, background: "#0d1220", border: "1px solid #1e2940", color: "#c8d6e8",
    padding: "7px 9px", fontSize: 11, fontFamily: "monospace", borderRadius: 3, outline: "none",
  };
}

function AddHoldingForm({ onAdded }) {
  const [form, setForm] = useState({
    symbol: "", qty: "", avgPrice: "",
    sector: "", geography: "", account: "Main", targetPct: "", isin: "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [detectedCcy, setDetectedCcy] = useState(null);
  const [checkingCcy, setCheckingCcy] = useState(false);
  const [livePrice, setLivePrice] = useState(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
async function detectCurrency(symbol) {
  if (!symbol.trim()) { setDetectedCcy(null); return; }
  setCheckingCcy(true);
  try {
    const res = await fetch(`${API}/quote?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`);
    const data = await res.json();
    const raw = data.rawCurrency;
    setDetectedCcy(raw === "GBp" ? "GBP" : raw ?? null);
    setLivePrice(typeof data.price === "number" ? data.price : null);
  } catch {
    setDetectedCcy(null);
    setLivePrice(null);
  } finally {
    setCheckingCcy(false);
  }
}

  async function submit() {
    if (!form.symbol.trim()) { setMsg({ type: "error", text: "Symbol is required." }); return; }
    if (!form.qty || Number(form.qty) <= 0) { setMsg({ type: "error", text: "Quantity must be greater than zero." }); return; }
    if (!form.sector) { setMsg({ type: "error", text: "Please select a sector." }); return; }
    if (!form.geography) { setMsg({ type: "error", text: "Please select a geography." }); return; }
    if (form.isin.trim() && !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(form.isin.trim().toUpperCase())) {
      setMsg({ type: "error", text: `"${form.isin}" is not a valid ISIN — expected exactly 12 characters (e.g. GB00BN08ZR66), no Yahoo-style ".L" suffix.` });
      return;
    }

    setBusy(true);
    setMsg({ type: "info", text: "Adding and fetching price history…" });
    try {
      const res = await fetch(`${API}/holdings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: form.symbol.trim().toUpperCase(),
          qty: Number(form.qty),
          avgPrice: Number(form.avgPrice) || 0,
          sector: form.sector,
          geography: form.geography,
          account: form.account,
          targetPct: form.targetPct === "" ? null : Number(form.targetPct),
          isin: form.isin.trim() || null,
        }),
      });
      const data = await res.json();

      if (data.error) {
        setMsg({ type: "error", text: data.error });
      } else if (data.action === "updated") {
        setMsg({ type: "warn", text: data.message });
        setForm(f => ({ ...f, symbol: "", qty: "", avgPrice: "", targetPct: "", isin: "" }));
        onAdded();
      } else {
        const h = data.historySynced;
        let detail;
        if (data.ftFallback && !data.ftFallback.error) {
          detail = ` — no Yahoo history, but priced via FT fallback at £${data.ftFallback.price} (${data.ftFallback.asOf ?? "no date"}). No chart history for this holding.`;
        } else if (data.ftFallback?.error) {
          detail = ` — no Yahoo history, and FT fallback failed (${data.ftFallback.error}). Excluded from valuation until resolved.`;
        } else if (typeof h === "object" && h.error) {
          detail = ` — history unavailable (${h.error}); excluded from risk until resolved`;
        } else if (typeof h === "object") {
          detail = ` — ${h.bars} bars of history stored${h.rejected ? `, ${h.rejected} corrupt bars rejected` : ""}`;
        } else {
          detail = "";
        }
        setMsg({ type: "ok", text: `Added ${form.symbol.toUpperCase()}${detail}` });
        setForm(f => ({ ...f, symbol: "", qty: "", avgPrice: "", targetPct: "", isin: "" }));
        onAdded();
      }
    } catch (e) {
      setMsg({ type: "error", text: "Could not reach the server. Is npm start running?" });
    } finally {
      setBusy(false);
    }
  }

  const msgColor = msg?.type === "error" ? "#ff4757" : msg?.type === "warn" ? "#ffa502"
    : msg?.type === "ok" ? "#00d4aa" : "#4a6080";

  return (
    <Panel>
      <SectionHeader title="ADD HOLDING" subtitle="history syncs automatically" />
      <div style={{ padding: 16, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 9, color: "#4a6080", marginBottom: 4, letterSpacing: 1 }}>SYMBOL</div>
          <input style={fieldStyle(100)} value={form.symbol} placeholder="VUSA.L"
            onChange={e => set("symbol", e.target.value)}
            onBlur={e => detectCurrency(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()} />
        </div>
        <div>
          <div style={{ fontSize: 9, color: "#4a6080", marginBottom: 4, letterSpacing: 1 }}>PRICE</div>
          <div style={{ ...fieldStyle(90), display: "flex", alignItems: "center", color: "#7a8ba0" }}>
            {checkingCcy ? "…" : livePrice != null ? `${ccySymbol(detectedCcy)}${livePrice.toFixed(2)}` : "—"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: "#4a6080", marginBottom: 4, letterSpacing: 1 }}>QUANTITY</div>
          <input style={fieldStyle(90)} value={form.qty} placeholder="100" type="number"
            onChange={e => set("qty", e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()} />
        </div>
        <div>
          <div style={{ fontSize: 9, color: "#4a6080", marginBottom: 4, letterSpacing: 1 }}>
            AVG PRICE {checkingCcy ? "(checking…)" : detectedCcy ? `(${ccySymbol(detectedCcy)})` : ""}
          </div>
          <input style={fieldStyle(100)} value={form.avgPrice} placeholder="79.39" type="number"
            onChange={e => set("avgPrice", e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()} />
        </div>
        <div>
          <div style={{ fontSize: 9, color: "#4a6080", marginBottom: 4, letterSpacing: 1 }}>SECTOR</div>
          <select style={fieldStyle(110)} value={form.sector} onChange={e => set("sector", e.target.value)}>
            <option value="">Select…</option>
            {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 9, color: "#4a6080", marginBottom: 4, letterSpacing: 1 }}>GEOGRAPHY</div>
          <select style={fieldStyle(120)} value={form.geography} onChange={e => set("geography", e.target.value)}>
            <option value="">Select…</option>
            {GEOGRAPHIES.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 9, color: "#4a6080", marginBottom: 4, letterSpacing: 1 }}>TARGET %</div>
          <input style={fieldStyle(80)} value={form.targetPct} placeholder="optional" type="number"
            onChange={e => set("targetPct", e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()} />
        </div>
        <div>
          <div style={{ fontSize: 9, color: "#4a6080", marginBottom: 4, letterSpacing: 1 }} title="Only needed if Yahoo has no data for this fund — used as a fallback price source via FT">
            ISIN (if not on Yahoo)
          </div>
          <input style={fieldStyle(140)} value={form.isin} placeholder="GB00BN08ZR66"
            onChange={e => set("isin", e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && submit()} />
        </div>
        <button onClick={submit} disabled={busy}
          style={{
            background: busy ? "#1a2535" : "#00d4aa", color: busy ? "#4a6080" : "#060810",
            border: "none", padding: "8px 20px", fontSize: 11, fontWeight: 700,
            fontFamily: "monospace", borderRadius: 3, cursor: busy ? "default" : "pointer",
            letterSpacing: 1,
          }}>
          {busy ? "WORKING…" : "ADD"}
        </button>
      </div>
      {msg && (
        <div style={{ padding: "0 16px 14px", fontSize: 11, color: msgColor }}>
          {msg.text}
        </div>
      )}
    </Panel>
  );
}

function HoldingRow({ p, coverage, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [qty, setQty] = useState(p.qty);
  const [avg, setAvg] = useState(p.avgPrice);
  const [target, setTarget] = useState(p.targetPct ?? "");

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  async function save() {
    await fetch(`${API}/holdings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: p.id, qty: Number(qty), avgPrice: Number(avg),
        targetPct: target === "" ? null : Number(target),
      }),
    });
    setEditing(false);
    onChanged();
  }

  async function remove() {
    if (!window.confirm(`Delete ${p.symbol} (${p.qty} units in ${p.wrapper})?`)) return;
    await fetch(`${API}/holdings?id=${p.id}`, { method: "DELETE" });
    onChanged();
  }

  const pnlColor = p.pnl >= 0 ? "#00d4aa" : "#ff4757";
  const dayColor = (p.dayChangePct ?? 0) >= 0 ? "#00d4aa" : "#ff4757";
  const cov = coverage?.find(c => c.symbol === p.symbol);
  const thinHistory = cov && !cov.analysable;

  return (
    <div style={{ borderBottom: "1px solid #12161f" }}>
      <div onClick={() => setExpanded(e => !e)} style={{
        display: "grid",
        gridTemplateColumns: "22px minmax(120px, 1.6fr) 0.8fr 1fr 1fr 1.1fr 1.2fr 1fr 0.9fr 60px",
        alignItems: "center", padding: "14px 20px", gap: 8,
        fontSize: 14, fontFamily: "monospace", cursor: "pointer",
      }}>
        <span style={{ color: "#4a6080", fontSize: 11, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▶</span>

        <div>
          <span style={{ color: "#c8d6e8", fontWeight: 700, fontSize: 15 }}>{p.name || p.symbol}</span>
          <a href={`https://finance.yahoo.com/quote/${encodeURIComponent(p.symbol)}`}
            target="_blank" rel="noopener noreferrer"
            title="View on Yahoo Finance"
            onClick={e => e.stopPropagation()}
            style={{ marginLeft: 6, color: "#4a6080", fontSize: 12, textDecoration: "none" }}>
            ↗
          </a>
          {thinHistory && (
            <span title="Not enough stored history for risk analysis"
              style={{ color: "#ffa502", marginLeft: 6, fontSize: 12 }}>⚠</span>
          )}
          <div style={{ fontSize: 11, color: "#4a6080", marginTop: 2 }}>{p.symbol}</div>
        </div>

        {editing ? (
          <input style={{ ...fieldStyle("100%"), padding: "5px 7px" }} value={qty} onClick={e => e.stopPropagation()} onChange={e => setQty(e.target.value)} />
        ) : (
          <div style={{ color: "#7a8ba0" }}>{p.qty}</div>
        )}

        {editing ? (
          <input style={{ ...fieldStyle("100%"), padding: "5px 7px" }} value={avg} onClick={e => e.stopPropagation()} onChange={e => setAvg(e.target.value)} />
        ) : (
          <div style={{ color: "#7a8ba0" }}>{ccySymbol(p.currency)}{p.avgPrice?.toFixed(2)}</div>
        )}

        <div style={{ color: "#c8d6e8" }}>
          {ccySymbol(p.currency)}{p.price != null ? p.price.toFixed(p.price < 10 ? 4 : 2) : "—"}
          {p.priceSource === "ft" && (
            <span title={`Yahoo has no data for this fund — priced via FT fallback${p.priceAsOf ? `, as of ${p.priceAsOf}` : ""}`}
              style={{ marginLeft: 4, fontSize: 9, color: "#a855f7", border: "1px solid #a855f740", borderRadius: 2, padding: "0 3px" }}>FT</span>
          )}
        </div>
        <div style={{ color: "#c8d6e8" }}>£{p.value?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        <div style={{ color: pnlColor }}>
          {p.pnl >= 0 ? "+" : ""}£{Math.abs(p.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          <div style={{ fontSize: 11, marginTop: 2 }}>{p.pnlPct >= 0 ? "+" : ""}{p.pnlPct?.toFixed(1)}%</div>
        </div>
        <div style={{ color: dayColor }}>{(p.dayChangePct ?? 0) >= 0 ? "+" : ""}{p.dayChangePct?.toFixed(2)}%</div>
        <div style={{ color: "#7a8ba0" }}>{p.weight?.toFixed(1)}%</div>

        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", position: "relative" }} onClick={e => e.stopPropagation()}>
          {editing ? (
            <>
              <button onClick={save} style={btn("#00d4aa")}>SAVE</button>
              <button onClick={() => setEditing(false)} style={btn("#4a6080")}>×</button>
            </>
          ) : (
            <>
              <button onClick={() => setMenuOpen(o => !o)} style={{
                background: menuOpen ? "#1a2535" : "transparent", border: "1px solid #1a2535", color: "#7a8ba0",
                borderRadius: 3, fontSize: 14, fontWeight: 700, cursor: "pointer",
                width: 32, height: 27, lineHeight: "20px", letterSpacing: 1,
              }}>···</button>
              {menuOpen && (
                <div style={{
                  position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 10,
                  background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4,
                  minWidth: 100, overflow: "hidden",
                }}>
                  <button onClick={() => { setEditing(true); setMenuOpen(false); }} style={{
                    display: "block", width: "100%", textAlign: "left", background: "transparent",
                    border: "none", color: "#3d8bff", fontSize: 11, fontFamily: "monospace",
                    padding: "8px 12px", cursor: "pointer",
                  }}>Edit</button>
                  <button onClick={() => { setMenuOpen(false); remove(); }} style={{
                    display: "block", width: "100%", textAlign: "left", background: "transparent",
                    border: "none", color: "#ff4757", fontSize: 11, fontFamily: "monospace",
                    padding: "8px 12px", cursor: "pointer", borderTop: "1px solid #1a1f2e",
                  }}>Delete</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {expanded && <HoldingDetail p={p} onChanged={onChanged} />}
    </div>
  );
}

function formatBigNumber(n) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

function HoldingDetail({ p }) {
  const [quote, setQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [range, setRange] = useState("3M");
  const [view, setView] = useState("value");
  const [allBars, setAllBars] = useState(null);
  const [barsLoading, setBarsLoading] = useState(true);
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/quote?symbol=${encodeURIComponent(p.symbol)}`).then(r => r.json())
      .then(q => { if (!cancelled) setQuote(q); })
      .catch(() => { if (!cancelled) setQuote(null); })
      .finally(() => { if (!cancelled) setQuoteLoading(false); });
    return () => { cancelled = true; };
  }, [p.symbol]);

  useEffect(() => {
    let cancelled = false;
    setBarsLoading(true);
    fetch(`${API}/history?symbol=${encodeURIComponent(p.symbol)}`).then(r => r.json())
      .then(d => { if (!cancelled) setAllBars(d?.data ?? []); })
      .catch(() => { if (!cancelled) setAllBars([]); })
      .finally(() => { if (!cancelled) setBarsLoading(false); });
    return () => { cancelled = true; };
  }, [p.symbol]);

  async function askAI() {
    setAiLoading(true);
    setAiText("");
    const prompt = `You are a buy-side analyst giving a colleague a quick verbal take, not a report.
Holding: ${p.name || p.symbol} (${p.symbol}), tagged ${p.sector}/${p.geography} in this portfolio.
Current price ${ccySymbol(p.currency)}${p.price?.toFixed(2) ?? "—"}, position P&L ${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct?.toFixed(1)}%, portfolio weight ${p.weight?.toFixed(1)}%.
${quote?.marketCap != null ? `Market cap ${formatBigNumber(quote.marketCap)}. ` : ""}${quote?.beta != null ? `Beta ${quote.beta.toFixed(2)}. ` : ""}${quote?.low52 != null && quote?.high52 != null ? `52-week range ${ccySymbol(p.currency)}${quote.low52.toFixed(2)}–${ccySymbol(p.currency)}${quote.high52.toFixed(2)}.` : ""}

Give a short, opinionated take in plain text, no markdown, 4-6 sentences: is this holding currently attractive to add to, hold, or trim, and why — reference the valuation/momentum context above where relevant.`;
    const res = await callAI(prompt, 350);
    setAiText(res.text);
    setAiLoading(false);
  }

  const symbol = p.symbol;
  const lookback = PORTFOLIO_CHART_RANGES.find(r => r.key === range).lookback;
  const bars = allBars ?? [];
  let sliced = bars.slice(-lookback);
  if (range === "YTD") sliced = bars.filter(b => b.date >= `${new Date().getFullYear()}-01-01`);

  const priceSeries = sliced.map(b => ({ date: b.date, value: b.adj_close ?? b.close }));
  const basePrice = priceSeries[0]?.value;
  const percentSeries = priceSeries.map(b => ({ date: b.date, value: basePrice ? +(((b.value / basePrice) - 1) * 100).toFixed(2) : 0 }));
  const activeSeries = view === "value" ? priceSeries : percentSeries;
  const up = activeSeries.length >= 2 && activeSeries[activeSeries.length - 1].value >= activeSeries[0].value;
  const chartColor = up ? "#00d4aa" : "#ff4757";
  const insufficientHistory = bars.length > 0 && bars.length < 30;

  const stats = [
    { label: "52W RANGE", val: quote?.low52 != null && quote?.high52 != null ? `${ccySymbol(p.currency)}${quote.low52.toFixed(2)} – ${ccySymbol(p.currency)}${quote.high52.toFixed(2)}` : "—" },
    { label: "MARKET CAP", val: quote?.marketCap != null ? `${ccySymbol(p.currency)}${formatBigNumber(quote.marketCap)}` : "—" },
    { label: "SHARES OUTSTANDING", val: quote?.sharesOutstanding != null ? formatBigNumber(quote.sharesOutstanding) : "—" },
    { label: "BETA", val: quote?.beta != null ? quote.beta.toFixed(2) : "—" },
  ];

  const dayColor = (p.dayChangePct ?? 0) >= 0 ? "#00d4aa" : "#ff4757";

  return (
    <div style={{ padding: "12px 16px 20px 32px", background: "#0a0d14", borderBottom: "1px solid #1a1f2e" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 26, fontWeight: 700, color: "#e8f0fe", fontFamily: "monospace" }}>
          {ccySymbol(p.currency)}{p.price != null ? p.price.toFixed(p.price < 10 ? 4 : 2) : "—"}
        </span>
        <span style={{ fontSize: 12, color: dayColor, fontFamily: "monospace" }}>
          {(p.dayChangePct ?? 0) >= 0 ? "+" : ""}{p.dayChangePct?.toFixed(2)}% today
        </span>
        <span style={{ fontSize: 11, color: "#4a6080" }}>{p.name || p.symbol}</span>
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "3 1 420px", minWidth: 320 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 4 }}>
              {[{ key: "value", label: "PRICE" }, { key: "percent", label: "% RETURN" }].map(v => (
                <button key={v.key} onClick={() => setView(v.key)} style={{
                  background: view === v.key ? "#0d1421" : "transparent",
                  border: `1px solid ${view === v.key ? "#3d8bff40" : "#1a2535"}`,
                  color: view === v.key ? "#c8d6e8" : "#4a6080",
                  fontSize: 11, fontWeight: 700, padding: "5px 11px", borderRadius: 3,
                  cursor: "pointer", fontFamily: "monospace", letterSpacing: 0.5,
                }}>{v.label}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
              {PORTFOLIO_CHART_RANGES.map(r => (
                <button key={r.key} onClick={() => setRange(r.key)} style={{
                  background: range === r.key ? "#0d4d40" : "transparent",
                  border: `1px solid ${range === r.key ? "#00d4aa40" : "#1a2535"}`,
                  color: range === r.key ? "#00d4aa" : "#4a6080",
                  fontSize: 11, padding: "4px 9px", borderRadius: 3,
                  cursor: "pointer", fontFamily: "monospace",
                }}>{r.label}</button>
              ))}
            </div>
          </div>

          {barsLoading ? (
            <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: "#4a6080", fontSize: 11 }}>Loading…</div>
          ) : activeSeries.length < 2 || insufficientHistory ? (
            <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: "#4a6080", fontSize: 11, textAlign: "center", padding: "0 20px" }}>
              {insufficientHistory ? "Insufficient stored history for this holding." : "Not enough overlapping price history yet."}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={activeSeries} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id={`detailFill-${symbol}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={chartColor} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={chartColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#12161f" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#3a4558", fontSize: 11, fontFamily: "monospace" }} axisLine={{ stroke: "#1a2535" }} tickLine={false} minTickGap={50} />
                <YAxis tick={{ fill: "#3a4558", fontSize: 11, fontFamily: "monospace" }} axisLine={false} tickLine={false} width={54}
                  domain={["auto", "auto"]}
                  tickFormatter={v => view === "percent" ? `${v.toFixed(0)}%` : `${ccySymbol(p.currency)}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
                <Tooltip
                  contentStyle={{ background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4, fontFamily: "monospace", fontSize: 13 }}
                  labelStyle={{ color: "#7a8ba0" }}
                  formatter={v => [view === "percent" ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : `${ccySymbol(p.currency)}${v.toFixed(2)}`, view === "percent" ? "Return" : "Price"]}
                />
                <Area type="monotone" dataKey="value" stroke={chartColor} strokeWidth={1.5} fill={`url(#detailFill-${symbol})`} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div style={{ flex: "1 1 220px", minWidth: 200 }}>
          <div style={{ fontSize: 11, color: "#4a6080", letterSpacing: 1, marginBottom: 10 }}>KEY STATS</div>
          {quoteLoading ? (
            <div style={{ color: "#4a6080", fontSize: 11 }}>Loading…</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {stats.map(s => (
                <div key={s.label} style={{
                  background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4, padding: "8px 10px",
                }}>
                  <div style={{ fontSize: 10, color: "#4a6080", letterSpacing: 0.5, marginBottom: 5 }}>{s.label}</div>
                  <div style={{ fontSize: 14, color: "#c8d6e8", fontWeight: 700 }}>{s.val}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: "#4a6080", letterSpacing: 1 }}>ASK AI</div>
              <button onClick={askAI} disabled={aiLoading} style={{
                background: aiLoading ? "#1a2535" : "#3d8bff20", border: "1px solid #3d8bff40", color: "#3d8bff",
                padding: "6px 13px", borderRadius: 3, fontSize: 11, fontFamily: "monospace",
                cursor: aiLoading ? "default" : "pointer",
              }}>{aiLoading ? "THINKING…" : "ASK OPINION"}</button>
            </div>
            {aiText && (
              <div style={{
                background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4,
                padding: 13, fontSize: 13, color: "#c8d6e8", lineHeight: 1.65, whiteSpace: "pre-wrap",
              }}>{aiText}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
function ccySymbol(ccy) {
  return { GBP: "£", USD: "$", EUR: "€", JPY: "¥" }[ccy] ?? ccy + " ";
}

function btn(color) {
  return {
    background: "transparent", border: `1px solid ${color}`, color,
    fontSize: 11, padding: "5px 10px", borderRadius: 3, cursor: "pointer",
    fontFamily: "monospace", letterSpacing: 0.5,
  };
}

const PORTFOLIO_CHART_RANGES = [
  { key: "1M", label: "1M", lookback: 21 },
  { key: "3M", label: "3M", lookback: 63 },
  { key: "6M", label: "6M", lookback: 126 },
  { key: "YTD", label: "YTD", lookback: 280 },
  { key: "1Y", label: "1Y", lookback: 252 },
  { key: "3Y", label: "3Y", lookback: 756 },
  { key: "5Y", label: "5Y", lookback: 1260 },
  { key: "MAX", label: "MAX", lookback: 8000 },
];

const PORTFOLIO_CHART_VIEWS = [
  { key: "combined", label: "COMBINED" },
  { key: "percent", label: "% RETURN" },
  { key: "value", label: "£ VALUE" },
];

const HOLDING_LINE_COLORS = ["#00d4aa", "#3d8bff", "#ffa502", "#ff4757", "#a78bfa", "#38bdf8", "#f472b6", "#facc15"];

function PortfolioValueChart() {
  const [range, setRange] = useState("3M");
  const [view, setView] = useState("combined");
  const [hist, setHist] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const lookback = PORTFOLIO_CHART_RANGES.find(r => r.key === range).lookback;
    fetch(`${API}/portfolio/history/holdings?lookback=${lookback}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setHist(d); })
      .catch(() => { if (!cancelled) setHist({ series: [], normalized: [], symbols: [], note: "Could not load portfolio history." }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range]);

  const symbols = hist?.symbols ?? [];
  const rawSeries = hist?.series ?? [];
  const normSeries = hist?.normalized ?? [];

  // YTD is a calendar concept, not a fixed bar count — trim client-side to
  // this calendar year once the (slightly oversized) lookback comes back.
  const trimYTD = arr => range === "YTD"
    ? arr.filter(r => r.date >= `${new Date().getFullYear()}-01-01`)
    : arr;

  const combinedSeries = trimYTD(rawSeries).map(r => ({
    date: r.date,
    value: +symbols.reduce((a, s) => a + (r[s] ?? 0), 0).toFixed(2),
  }));
  const valueSeries = trimYTD(rawSeries);
  const percentSeries = trimYTD(normSeries);

  const activeSeries = view === "combined" ? combinedSeries : view === "value" ? valueSeries : percentSeries;
  const up = combinedSeries.length >= 2 && combinedSeries[combinedSeries.length - 1].value >= combinedSeries[0].value;
  const lineColor = up ? "#00d4aa" : "#ff4757";

  const axisTick = { fill: "#3a4558", fontSize: 11, fontFamily: "monospace" };
  const tooltipStyle = {
    contentStyle: { background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4, fontFamily: "monospace", fontSize: 13 },
    labelStyle: { color: "#7a8ba0" },
  };

  return (
    <Panel>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 20px 11px", borderBottom: "1px solid #1a1f2e", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 4 }}>
          {PORTFOLIO_CHART_VIEWS.map(v => (
            <button key={v.key} onClick={() => setView(v.key)} style={{
              background: view === v.key ? "#0d1421" : "transparent",
              border: `1px solid ${view === v.key ? "#3d8bff40" : "#1a2535"}`,
              color: view === v.key ? "#c8d6e8" : "#4a6080",
              fontSize: 12, fontWeight: 700, padding: "6px 13px", borderRadius: 3,
              cursor: "pointer", fontFamily: "monospace", letterSpacing: 0.5,
            }}>{v.label}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {PORTFOLIO_CHART_RANGES.map(r => (
            <button key={r.key} onClick={() => setRange(r.key)} style={{
              background: range === r.key ? "#0d4d40" : "transparent",
              border: `1px solid ${range === r.key ? "#00d4aa40" : "#1a2535"}`,
              color: range === r.key ? "#00d4aa" : "#4a6080",
              fontSize: 12, padding: "5px 12px", borderRadius: 3,
              cursor: "pointer", fontFamily: "monospace",
            }}>{r.label}</button>
          ))}
        </div>
      </div>
      <div style={{ padding: "12px 16px 16px" }}>
        {loading ? (
          <div style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center", color: "#4a6080", fontSize: 12 }}>
            Loading…
          </div>
        ) : activeSeries.length < 2 ? (
          <div style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center", color: "#4a6080", fontSize: 12, textAlign: "center", padding: "0 20px" }}>
            {hist?.note ?? "Not enough overlapping price history yet to chart portfolio value."}
          </div>
        ) : view === "combined" ? (
          <>
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={activeSeries} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="portfolioValueFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lineColor} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#12161f" vertical={false} />
                <XAxis dataKey="date" tick={axisTick} axisLine={{ stroke: "#1a2535" }} tickLine={false} minTickGap={40} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} width={60}
                  domain={["auto", "auto"]}
                  tickFormatter={v => `£${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                <Tooltip {...tooltipStyle} formatter={v => [`£${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, "Value"]} />
                <Area type="monotone" dataKey="value" stroke={lineColor} strokeWidth={1.5}
                  fill="url(#portfolioValueFill)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
            <ChartCaption hist={hist} />
          </>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={activeSeries} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#12161f" vertical={false} />
                <XAxis dataKey="date" tick={axisTick} axisLine={{ stroke: "#1a2535" }} tickLine={false} minTickGap={40} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} width={60}
                  domain={["auto", "auto"]}
                  tickFormatter={v => view === "percent" ? `${v.toFixed(0)}%` : `£${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                <Tooltip {...tooltipStyle}
                  formatter={(v, name) => [view === "percent" ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : `£${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, name]} />
                <Legend wrapperStyle={{ fontSize: 12, fontFamily: "monospace" }} />
                {symbols.map((s, i) => (
                  <Line key={s} type="monotone" dataKey={s} name={s}
                    stroke={HOLDING_LINE_COLORS[i % HOLDING_LINE_COLORS.length]}
                    strokeWidth={1.5} dot={false} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <ChartCaption hist={hist} />
          </>
        )}
      </div>
    </Panel>
  );
}

function ChartCaption({ hist }) {
  return (
    <div style={{ fontSize: 11, color: "#3a4558", marginTop: 10 }}>
      Reconstructed at current holdings weights — excludes cash{hist?.excluded?.length ? ` and ${hist.excluded.join(", ")} (insufficient history)` : ""}.
    </div>
  );
}

function Modal({ onClose, children }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(3,5,10,0.7)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      paddingTop: "8vh", zIndex: 1000,
    }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "min(720px, 92vw)", position: "relative" }}>
        <button onClick={onClose} style={{
          position: "absolute", top: -32, right: 0, background: "transparent", border: "none",
          color: "#7a8ba0", fontSize: 22, cursor: "pointer", lineHeight: 1,
        }}>×</button>
        {children}
      </div>
    </div>
  );
}

function CashTile({ cashAccounts, cash, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(cash);

  async function save() {
    const value = Number(amount) || 0;
    if (cashAccounts.length >= 1) {
      await fetch(`${API}/cash`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cashAccounts[0].id, amount: value }),
      });
    } else {
      await fetch(`${API}/cash`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: "Main", wrapper: "ISA", currency: "GBP", amount: value }),
      });
    }
    setEditing(false);
    onChanged();
  }

  return (
    <div style={{ padding: "10px 22px 13px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 11, color: "#4a6080", letterSpacing: 1 }}>CASH</div>
        {!editing && (
          <button onClick={() => { setAmount(cash); setEditing(true); }} title="Edit cash balance"
            style={{ background: "transparent", border: "none", color: "#4a6080", fontSize: 13, cursor: "pointer", padding: 0 }}>✎</button>
        )}
      </div>
      {editing ? (
        <div style={{ display: "flex", gap: 6, marginTop: 5, alignItems: "center" }}>
          <input autoFocus type="number" value={amount} onChange={e => setAmount(e.target.value)}
            onKeyDown={e => e.key === "Enter" && save()}
            style={{ ...fieldStyle(110), padding: "4px 7px", fontSize: 16 }} />
          <button onClick={save} style={btn("#00d4aa")}>SAVE</button>
          <button onClick={() => setEditing(false)} style={btn("#4a6080")}>×</button>
        </div>
      ) : (
        <div style={{ fontSize: 23, fontWeight: 700, color: "#c8d6e8", fontFamily: "monospace", marginTop: 5 }}>
          £{cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </div>
      )}
    </div>
  );
}

function PortfolioPageV2() {
  const [data, setData] = useState(null);
  const [coverage, setCoverage] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [pRes, hRes] = await Promise.all([
        fetch(`${API}/portfolio`),
        fetch(`${API}/holdings`),
      ]);
      const p = await pRes.json();
      const h = await hRes.json();
      setData(p);
      setCoverage(h.coverage ?? []);
      setError(null);
    } catch {
      setError("Could not reach the server at localhost:3001. Is npm start running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#4a6080", fontSize: 12 }}>Loading portfolio…</div>;
  if (error) return <Panel style={{ padding: 20 }}><div style={{ color: "#ff4757", fontSize: 12 }}>⚠ {error}</div></Panel>;

  const thin = coverage.filter(c => !c.analysable);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#e8f0fe", fontFamily: "monospace" }}>PORTFOLIO</div>
        <div style={{ fontSize: 13, color: "#4a6080", marginTop: 3 }}>
          {data.positions.length} positions · live valuation in GBP
        </div>
      </div>

      {/* Summary strip */}
      <Panel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)" }}>
          <RiskMetric label="TOTAL VALUE" value={`£${data.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
          <div style={{ borderRight: "1px solid #1a1f2e", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "13px 22px 10px", borderBottom: "1px solid #1a1f2e" }}>
              <div style={{ fontSize: 11, color: "#4a6080", letterSpacing: 1, marginBottom: 5 }}>INVESTED</div>
              <div style={{ fontSize: 23, fontWeight: 700, color: "#c8d6e8", fontFamily: "monospace" }}>
                £{data.invested.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
            </div>
            <CashTile cashAccounts={data.cashAccounts} cash={data.cash} onChanged={load} />
          </div>
          <RiskMetric label="TOTAL P&L" value={`${data.pnl >= 0 ? "+" : ""}£${Math.abs(data.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
            sub={`${data.pnlPct >= 0 ? "+" : ""}${data.pnlPct.toFixed(1)}%`}
            color={data.pnl >= 0 ? "#00d4aa" : "#ff4757"} />
          <RiskMetric label="TODAY" value={`${data.dayChange >= 0 ? "+" : ""}£${Math.abs(data.dayChange).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
            sub={`${data.dayChangePct >= 0 ? "+" : ""}${data.dayChangePct.toFixed(2)}%`}
            color={data.dayChange >= 0 ? "#00d4aa" : "#ff4757"} />
        </div>
      </Panel>

      <PortfolioValueChart />

      {addOpen && (
        <Modal onClose={() => setAddOpen(false)}>
          <AddHoldingForm onAdded={() => { load(); setAddOpen(false); }} />
        </Modal>
      )}

      {thin.length > 0 && (
        <Panel style={{ padding: 12 }}>
          <div style={{ fontSize: 11, color: "#ffa502" }}>
            ⚠ {thin.map(t => t.symbol).join(", ")} {thin.length === 1 ? "has" : "have"} insufficient
            price history and {thin.length === 1 ? "is" : "are"} excluded from risk analysis.
          </div>
        </Panel>
      )}

      {/* Holdings table */}
      <Panel>
        <SectionHeader title="HOLDINGS" subtitle="click a row to expand · edit to adjust quantity or average price"
          action="+ ADD POSITION" onAction={() => setAddOpen(true)} />
        <div style={{
          display: "grid",
          gridTemplateColumns: "22px minmax(120px, 1.6fr) 0.8fr 1fr 1fr 1.1fr 1.2fr 1fr 0.9fr 60px",
          padding: "11px 20px", borderBottom: "1px solid #1a1f2e", gap: 8,
          fontSize: 11, color: "#4a6080", letterSpacing: 1,
        }}>
          <div /><div>NAME / SYMBOL</div><div>QTY</div><div>AVG</div><div>PRICE</div>
          <div>VALUE</div><div>P&L</div><div>TODAY</div><div>WEIGHT</div><div />
        </div>
        {data.positions.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "#4a6080", fontSize: 14 }}>
            No holdings yet — use "+ ADD POSITION" above to add one.
          </div>
        ) : (
          data.positions.map(p => (
            <HoldingRow key={p.id} p={p} coverage={coverage} onChanged={load} />
          ))
        )}
      </Panel>

      {/* Breakdowns */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <BreakdownPanel title="GEOGRAPHY" rows={data.breakdowns.geography} />
        <BreakdownPanel title="SECTOR" rows={data.breakdowns.sector} />
      </div>
    </div>
  );
}

function BreakdownPanel({ title, rows }) {
  const [view, setView] = useState("bars");

  return (
    <Panel>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 20px 11px", borderBottom: "1px solid #1a1f2e" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#c8d6e8", letterSpacing: 1.5, fontFamily: "monospace" }}>{title}</span>
        <div style={{ display: "flex", gap: 4 }}>
          {[{ key: "bars", label: "BARS" }, { key: "pie", label: "PIE" }].map(v => (
            <button key={v.key} onClick={() => setView(v.key)} style={{
              background: view === v.key ? "#0d1421" : "transparent",
              border: `1px solid ${view === v.key ? "#3d8bff40" : "#1a2535"}`,
              color: view === v.key ? "#c8d6e8" : "#4a6080",
              fontSize: 11, fontWeight: 700, padding: "5px 11px", borderRadius: 3,
              cursor: "pointer", fontFamily: "monospace", letterSpacing: 0.5,
            }}>{v.label}</button>
          ))}
        </div>
      </div>

      {view === "bars" ? (
        <div style={{ padding: "18px 22px" }}>
          {rows.map(b => (
            <div key={b.label} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 6 }}>
                <span style={{ color: "#7a8ba0" }}>{b.label}</span>
                <span style={{ color: "#c8d6e8", fontFamily: "monospace" }}>{b.pct.toFixed(1)}%</span>
              </div>
              <div style={{ height: 6, background: "#1a2535", borderRadius: 3 }}>
                <div style={{ width: `${b.pct}%`, height: "100%", background: "#3d8bff", borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: "18px 22px" }}>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={rows} dataKey="pct" nameKey="label" cx="50%" cy="50%"
                innerRadius={62} outerRadius={110} paddingAngle={1} isAnimationActive={false}>
                {rows.map((b, i) => (
                  <Cell key={b.label} fill={HOLDING_LINE_COLORS[i % HOLDING_LINE_COLORS.length]} stroke="#0d1117" strokeWidth={2} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4, fontFamily: "monospace", fontSize: 13 }}
                labelStyle={{ color: "#7a8ba0" }}
                itemStyle={{ color: "#c8d6e8" }}
                formatter={(v, name) => [`${v.toFixed(1)}%`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 12, fontFamily: "monospace" }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

function ComingSoonPage({ title, icon, description }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", height: "60vh", gap: 16,
    }}>
      <div style={{ fontSize: 48, opacity: 0.3 }}>{icon}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#c8d6e8", fontFamily: "monospace" }}>{title}</div>
      <div style={{ fontSize: 13, color: "#4a6080", textAlign: "center", maxWidth: 400 }}>{description}</div>
      <div style={{
        background: "#0d1117", border: "1px solid #1a2535", borderRadius: 6,
        padding: "8px 20px", fontSize: 11, color: "#3a4558", fontFamily: "monospace",
      }}>
        PHASE {["macro","research","portfolio","watchlist","screener","forex","calendar","news"].indexOf(title.toLowerCase().split(" ")[0]) + 3} — IN DEVELOPMENT
      </div>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================

// ============================================================
// SETTINGS PAGE
// ============================================================

function SettingsPage({ onApiKeySet }) {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("meridian_gemini_key") || "");
  const [saved, setSaved] = useState(false);
  const [priceLinks, setPriceLinks] = useState(() => {
    try { return JSON.parse(localStorage.getItem("meridian_price_links") || "[]"); } catch { return []; }
  });
  const [newSymbol, setNewSymbol] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const saveApiKey = () => {
    localStorage.setItem("meridian_gemini_key", apiKey);
    onApiKeySet(apiKey);
    // Also hand the key to the backend: news relevance scoring runs on the
    // 10-minute refresh loop, when no browser is necessarily open, so it
    // can't read localStorage. Stays on your machine either way.
    pushKeyToServer(apiKey);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const addPriceLink = () => {
    if (!newSymbol || !newUrl) return;
    const updated = [...priceLinks, { symbol: newSymbol.toUpperCase(), url: newUrl }];
    setPriceLinks(updated);
    localStorage.setItem("meridian_price_links", JSON.stringify(updated));
    setNewSymbol(""); setNewUrl("");
  };

  const removePriceLink = (i) => {
    const updated = priceLinks.filter((_, idx) => idx !== i);
    setPriceLinks(updated);
    localStorage.setItem("meridian_price_links", JSON.stringify(updated));
  };

  const inputStyle = {
    background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4,
    color: "#c8d6e8", fontFamily: "monospace", fontSize: 12, padding: "8px 10px", width: "100%",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 700 }}>

      {/* API Key */}
      <Panel>
        <SectionHeader title="GOOGLE GEMINI API KEY" subtitle="Required for all AI features (Daily Brief, Portfolio Health, etc.)" />
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 11, color: "#7a8ba0" }}>
            Get a free API key at <span style={{ color: "#3d8bff" }}>aistudio.google.com</span> → Get API Key. Paste it below. It is stored only on your machine.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="AIza..."
              style={{ ...inputStyle, flex: 1 }}
            />
            <button onClick={saveApiKey} style={{
              background: saved ? "#00d4aa20" : "#3d8bff20", border: `1px solid ${saved ? "#00d4aa40" : "#3d8bff40"}`,
              color: saved ? "#00d4aa" : "#3d8bff", padding: "8px 16px", borderRadius: 4,
              cursor: "pointer", fontFamily: "monospace", fontSize: 11, whiteSpace: "nowrap",
            }}>{saved ? "✓ SAVED" : "SAVE KEY"}</button>
          </div>
          {apiKey && <div style={{ fontSize: 10, color: "#00d4aa", fontFamily: "monospace" }}>✓ API key configured — AI features enabled</div>}
          {!apiKey && <div style={{ fontSize: 10, color: "#ff4757", fontFamily: "monospace" }}>✗ No API key — AI features disabled</div>}
        </div>
      </Panel>

      {/* Price Links */}
      <Panel>
        <SectionHeader title="LIVE PRICE LINKS" subtitle="Link any stock/asset to a URL for manual price reference" />
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 11, color: "#7a8ba0" }}>
            Add a URL for any symbol (e.g. a Yahoo Finance or broker page). These open directly from the dashboard so you can quickly check current prices.
          </div>

          {/* Existing links */}
          {priceLinks.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {priceLinks.map((link, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#080b12", borderRadius: 4, border: "1px solid #1a1f2e" }}>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#00d4aa", fontSize: 12, minWidth: 60 }}>{link.symbol}</span>
                  <a href={link.url} target="_blank" rel="noreferrer" style={{ flex: 1, color: "#3d8bff", fontSize: 11, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{link.url}</a>
                  <button onClick={() => removePriceLink(i)} style={{ background: "transparent", border: "none", color: "#ff4757", cursor: "pointer", fontSize: 14 }}>×</button>
                </div>
              ))}
            </div>
          )}

          {/* Add new link */}
          <div style={{ display: "flex", gap: 8 }}>
            <input value={newSymbol} onChange={e => setNewSymbol(e.target.value)} placeholder="Symbol (e.g. AAPL)" style={{ ...inputStyle, width: 140 }} />
            <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="https://finance.yahoo.com/quote/AAPL" style={{ ...inputStyle, flex: 1 }} />
            <button onClick={addPriceLink} style={{
              background: "#00d4aa20", border: "1px solid #00d4aa40", color: "#00d4aa",
              padding: "8px 14px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace", fontSize: 11, whiteSpace: "nowrap",
            }}>+ ADD</button>
          </div>
        </div>
      </Panel>

      {/* How to use */}
      <Panel>
        <SectionHeader title="HOW TO START MERIDIAN" subtitle="Run these commands in Terminal each time" />
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            { label: "Navigate to app folder", cmd: "cd ~/meridian" },
            { label: "Start the app", cmd: "npm run dev" },
            { label: "Then open Chrome and go to", cmd: "http://localhost:3000" },
          ].map(item => (
            <div key={item.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #0f1420" }}>
              <span style={{ fontSize: 11, color: "#7a8ba0" }}>{item.label}</span>
              <code style={{ fontFamily: "monospace", fontSize: 12, color: "#00d4aa", background: "#080b12", padding: "3px 8px", borderRadius: 3 }}>{item.cmd}</code>
            </div>
          ))}
        </div>
      </Panel>

    </div>
  );
}

export default function TradingTerminal() {
  const [activePage, setActivePage] = useState("dashboard");
  const { prices, lastUpdate, pulseCount, poll, dataSource } = useMarketData();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("meridian_gemini_key") || GEMINI_API_KEY);

  // A key saved before news scoring existed lives only in the browser — hand
  // it to the backend once on load so ranking works without re-saving it.
  useEffect(() => { syncKeyToServerIfNeeded(); }, []);

  const pageDescriptions = {
    macro: "Rates & liquidity, volatility structure, breadth internals, cross-asset dashboard, regime classification engine",
    research: "Deep-dive asset analysis — candlestick charting, technicals, fundamentals, positioning, AI bull/bear/base case",
    portfolio: "Risk console — holdings, exposure breakdown, correlation clustering, heatmap, thesis cards, AI health check",
    watchlist: "Idea pipeline — 5 tiered lists, setup cards, alert flags, AI daily watchlist monitor",
    screener: "Opportunity scanner — equities/FX/commodities scans, strategy presets, composite scoring, AI setup commentary",
    forex: "FX pairs, commodities charts, DXY tracker, central bank backdrop, AI macro commentary",
    calendar: "Economic events + earnings calendar — CPI/NFP/Fed countdowns, expected vs previous, portfolio-aware warnings",
    news: "Catalyst intelligence — filtered by portfolio/watchlist, importance scoring, AI summarisation, actionable vs noise",
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#060810",
      color: "#c8d6e8",
      fontFamily: "'Courier New', monospace",
      display: "flex",
      flexDirection: "column",
    }}>
      <style>{`
        @keyframes tape { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        * { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: #1a2535 #060810; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: #060810; }
        ::-webkit-scrollbar-thumb { background: #1a2535; border-radius: 3px; }
      `}</style>

      {/* Top bar */}
      <div style={{
        background: "#080b12",
        borderBottom: "1px solid #1a1f2e",
        padding: "0 20px",
        height: 48,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button onClick={() => setSidebarCollapsed(c => !c)} style={{
            background: "transparent", border: "none", color: "#4a6080",
            fontSize: 16, cursor: "pointer", padding: "4px 8px",
          }}>☰</button>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              width: 28, height: 28, background: "linear-gradient(135deg, #00d4aa, #3d8bff)",
              borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 900,
            }}>⬡</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#e8f0fe", letterSpacing: 2, fontFamily: "monospace" }}>
                MERIDIAN
              </div>
              <div style={{ fontSize: 9, color: "#3a4558", letterSpacing: 1 }}>TRADING INTELLIGENCE</div>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <PulseIndicator pulseCount={pulseCount} lastUpdate={lastUpdate} dataSource={dataSource} />
          <div style={{ fontSize: 11, color: "#3a4558", fontFamily: "monospace" }}>
            {new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
          </div>
        </div>
      </div>

      {/* Ticker tape */}
      <TickerTape prices={prices} />

      {/* Body */}
      <div style={{ display: "flex", flex: 1 }}>

        {/* Sidebar */}
        <div style={{
          width: sidebarCollapsed ? 48 : 180,
          background: "#080b12",
          borderRight: "1px solid #1a1f2e",
          transition: "width 0.2s ease",
          overflow: "hidden",
          position: "sticky",
          top: 80,
          alignSelf: "flex-start",
          height: "calc(100vh - 80px)",
        }}>
          <div style={{ padding: "12px 0" }}>
            {NAV_ITEMS.map(item => {
              const active = activePage === item.id;
              return (
                <button key={item.id} onClick={() => setActivePage(item.id)} style={{
                  width: "100%",
                  background: active ? "#0d1421" : "transparent",
                  border: "none",
                  borderLeft: active ? "2px solid #00d4aa" : "2px solid transparent",
                  color: active ? "#00d4aa" : "#4a6080",
                  padding: sidebarCollapsed ? "10px 0" : "10px 16px",
                  textAlign: sidebarCollapsed ? "center" : "left",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 12,
                  fontFamily: "monospace",
                  letterSpacing: 0.5,
                  transition: "all 0.15s",
                  whiteSpace: "nowrap",
                }}>
                  <span style={{ fontSize: 14, minWidth: 16 }}>{item.icon}</span>
                  {!sidebarCollapsed && item.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Main content */}
        <div style={{ flex: 1, padding: 20, overflowY: "auto", animation: "fadeIn 0.3s ease", minWidth: 0 }}>
          {activePage === "dashboard" && (
            <DashboardPage prices={prices} pulseCount={pulseCount} lastUpdate={lastUpdate} poll={poll} dataSource={dataSource} />
          )}
          {activePage === "risk" && (
            <RiskPage />
          )}
          {activePage === "macro" && (
            <MacroPage prices={prices} />
          )}
          {activePage === "research" && (
            <ResearchPage prices={prices} />
          )}
          {activePage === "portfolio" && (
            <PortfolioPageV2 />
          )}
          {activePage === "watchlist" && (
            <WatchlistPage />
          )}
          {activePage === "screener" && (
            <ScreenerPage />
          )}
          {activePage === "forex" && (
            <ForexPage prices={prices} />
          )}
          {activePage === "calendar" && (
            <CalendarPage />
          )}
          {activePage === "news" && (
            <NewsPage />
          )}
          {activePage === "settings" && (
            <SettingsPage onApiKeySet={setApiKey} />
          )}
        </div>
      </div>
    </div>
  );
}
