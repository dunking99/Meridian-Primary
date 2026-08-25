import React, { useState, useEffect, useCallback, useRef } from "react";
import { AreaChart, Area, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { fetchLivePrices, fetchFearAndGreed } from "./prices.js";
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
  { id: "changed", label: "What Changed", icon: "⬡" },
  { id: "risk", label: "Risk", icon: "◉" },
  { id: "research", label: "Research", icon: "◎" },
  { id: "portfolio", label: "Portfolio", icon: "◰" },
  { id: "watchlist", label: "Watchlist", icon: "◫" },
  { id: "screener", label: "Screener", icon: "▦" },
  { id: "markets", label: "Markets", icon: "◬" },
  { id: "calendar", label: "Calendar", icon: "▣" },
  { id: "news", label: "News", icon: "◉" },
  { id: "settings", label: "Settings", icon: "⚙" },
];







// ============================================================
// UTILITY HOOKS & HELPERS
// ============================================================

/**
 * The live price feed.
 *
 * Prices only ever come from the API. There is no seeded starting state and no
 * synthesised movement: a symbol the API has not returned is simply absent
 * from `prices`, and every consumer treats absent as "no data" rather than
 * drawing a number.
 *
 * `feed` carries the provenance the numbers need to be trustworthy — whether
 * the last poll succeeded, when the browser last heard from the API, and when
 * the API itself last reached its upstream. Those last two differ whenever the
 * API is up but its own fetches are failing, which is precisely the situation
 * a single "last updated" timestamp hides.
 */
function useMarketData() {
  const [prices, setPrices] = useState({});
  const [feed, setFeed] = useState({
    status: "loading",     // loading | live | stale | unavailable
    polledAt: null,        // when the browser last got a good response
    upstreamAt: null,      // when the API last reached Yahoo
    reason: null,
    count: 0,
  });
  const [pulseCount, setPulseCount] = useState(0);

  const poll = useCallback(async () => {
    const r = await fetchLivePrices();
    if (r.ok && r.count > 0) {
      // The API's own changePct is measured against the previous close, which
      // is what a day change means. The previous implementation recomputed it
      // against the last poll, so every "day change" on screen was really the
      // change over the preceding sixty seconds.
      setPrices(r.prices);
      setFeed({ status: "live", polledAt: Date.now(), upstreamAt: r.lastFetch, reason: null, count: r.count });
    } else {
      // Whatever is already on screen stays — it was real when it arrived —
      // but it stops being described as live, and keeps its original
      // timestamp so its age is visible.
      setFeed(f => ({
        ...f,
        status: f.count > 0 ? "stale" : "unavailable",
        reason: r.reason,
      }));
    }
    setPulseCount(c => c + 1);
  }, []);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [poll]);

  return { prices, feed, pulseCount, poll };
}

function formatPrice(price, symbol) {
  if (!price) return "—";
  if (symbol?.includes("=X")) return price.toFixed(4);
  // ^FVX (US 5Y) belongs with the other yields — it was missing here, so the
  // 5-year rendered as a bare "4.12" next to "5.301%" and "4.372%".
  if (symbol === "^IRX" || symbol === "^TNX" || symbol === "^FVX") return price.toFixed(3) + "%";
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

/**
 * Renders an absent value.
 *
 * Missing data must not be able to look like a real reading. A dash in the
 * muted "no data" colour reads as absence at a glance, and the title carries
 * the reason so it is answerable rather than merely blank.
 */
function NoData({ reason = "No data", compact = false }) {
  return (
    <span
      title={reason}
      style={{
        color: "#3a4558", fontFamily: "monospace",
        fontSize: compact ? 11 : 12, letterSpacing: 1, cursor: "help",
      }}
    >
      ——
    </span>
  );
}

/** Relative age of a timestamp, for provenance labels. */
function ageLabel(ts) {
  if (!ts) return "never";
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/**
 * Feed status and provenance.
 *
 * Shows both timestamps, because they answer different questions: `polled` is
 * whether the browser can reach the API, `upstream` is whether the API can
 * reach Yahoo. A green light on the first while the second is hours old was
 * previously indistinguishable from everything working.
 */
function PulseIndicator({ pulseCount, feed }) {
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 600);
    return () => clearTimeout(t);
  }, [pulseCount]);

  const { status, polledAt, upstreamAt, reason, count } = feed;
  const color = status === "live" ? "#00d4aa"
              : status === "loading" ? "#ffa502"
              : status === "stale" ? "#ffa502" : "#ff4757";
  const label = status === "live" ? `LIVE · ${count}`
              : status === "loading" ? "CONNECTING"
              : status === "stale" ? "STALE" : "NO FEED";

  const detail = status === "unavailable"
    ? (reason ?? "API unreachable")
    : `polled ${ageLabel(polledAt)} · upstream ${ageLabel(upstreamAt)}${reason ? ` · ${reason}` : ""}`;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }} title={detail}>
      <div style={{
        width: 7, height: 7, borderRadius: "50%",
        background: pulse ? color : `${color}66`,
        boxShadow: pulse ? `0 0 8px ${color}` : "none",
        transition: "all 0.3s ease",
      }} />
      <span style={{ fontSize: 10, color: status === "unavailable" ? "#ff4757" : "#4a5568", fontFamily: "monospace" }}>
        {label}
      </span>
      <span style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace" }}>
        {status === "unavailable" ? (reason ?? "") : ageLabel(upstreamAt)}
      </span>
    </div>
  );
}

function TickerTape({ prices, feed }) {
  const items = ALL_SYMBOLS.filter(s => DISPLAY_NAMES[s] && prices[s]);

  // An empty tape scrolling silently reads as "the market is closed". Say what
  // is actually wrong instead.
  if (!items.length) {
    return (
      <div style={{
        background: "#0a0c0f", borderBottom: "1px solid #1a1f2e",
        padding: "7px 20px", fontSize: 11, fontFamily: "monospace",
        color: feed?.status === "loading" ? "#4a6080" : "#ff4757",
      }}>
        {feed?.status === "loading"
          ? "Connecting to the Meridian API…"
          : `No live prices — ${feed?.reason ?? "the API returned nothing"}. Start it with: npm run server`}
      </div>
    );
  }

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


function FearGreedGauge({ data, tried = false }) {
  // Once a fetch has been attempted and come back empty, this is unavailable —
  // not still loading. Sitting on a spinner forever is its own small lie.
  if (!data || !data.score) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center", justifyContent: "center", height: 120, color: "#3a4558", fontSize: 11, fontFamily: "monospace" }}>
      {tried ? <><NoData reason="CNN Fear & Greed could not be reached" /><span>SOURCE UNREACHABLE</span></> : "LOADING FEAR & GREED..."}
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





function SectionHeader({ title, subtitle, action, onAction, extra }) {
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
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {extra}
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

// ============================================================
// WHAT CHANGED — the front page
//
// This replaced a dashboard whose movers, alerts, sector performance, market
// internals and catalysts were all hardcoded constants. Rather than sourcing
// the same panels for real — an index level and a sector table being things
// any free site shows better — the page now answers the one question those
// sites cannot: what is different, measured against this universe's own
// history.
//
// Everything here comes from GET /changes, GET /leadership and
// GET /relationships, all computed locally from stored daily bars. The page is
// designed to be able to say "nothing happened", because most days nothing
// does, and a front page that finds a headline daily is one you stop reading.
// ============================================================

const TONE_STYLE = {
  quiet:    { color: "#4a6080", label: "QUIET" },
  mild:     { color: "#7a8ba0", label: "MILD" },
  isolated: { color: "#ffa502", label: "ISOLATED MOVES" },
  broad:    { color: "#3d8bff", label: "BROAD MOVE" },
};

const pct = (v, dp = 1) => v == null ? null : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(dp)}%`;

/** 1st, 2nd, 3rd, 4th — including the 11-13 exception. */
function ordinal(n) {
  const r100 = n % 100, r10 = n % 10;
  const suffix = (r100 >= 11 && r100 <= 13) ? "th"
    : r10 === 1 ? "st" : r10 === 2 ? "nd" : r10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}
const pctPlain = (v, dp = 0) => v == null ? null : `${(v * 100).toFixed(dp)}%`;

/** Colour a signed value, with an explicit neutral for exactly-zero. */
function signColor(v, { invert = false } = {}) {
  if (v == null) return "#3a4558";
  if (v === 0) return "#7a8ba0";
  const up = v > 0;
  return (up !== invert) ? "#00d4aa" : "#ff4757";
}

/**
 * One instrument that moved unusually.
 *
 * The sigma figure leads because it is the comparable number: a 1.9% day in a
 * world equity fund and a 0.4% day in a short bond fund can be the same event
 * in their own terms, and only the sigma says so.
 */
function ChangeRow({ n }) {
  const c = signColor(n.ret1d);
  const sigma = Math.abs(n.retZ);
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "minmax(90px,1.4fr) 74px 62px 1fr",
      gap: 10, alignItems: "center",
      padding: "8px 12px", borderBottom: "1px solid #10151f",
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: "monospace", fontSize: 12, color: "#c8d6e8", fontWeight: 700,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {n.symbol}
        </div>
        <div style={{ fontSize: 9, color: "#3a4558" }}>
          {n.pctRank != null ? `${pctPlain(n.pctRank)} of 1y range` : "range unknown"}
        </div>
      </div>

      <div style={{ textAlign: "right", fontFamily: "monospace", fontSize: 13, color: c, fontWeight: 700 }}>
        {pct(n.ret1d, 2)}
      </div>

      {/* Sigma is the headline measure, so it gets its own emphasised column. */}
      <div style={{ textAlign: "right", fontFamily: "monospace", fontSize: 12,
                    color: sigma >= 2.5 ? "#ffa502" : sigma >= 2 ? "#c8d6e8" : "#7a8ba0" }}>
        {sigma.toFixed(1)}σ
      </div>

      <div style={{ fontSize: 10, color: "#4a6080", display: "flex", gap: 10, justifyContent: "flex-end" }}>
        {n.dist200dma != null && (
          <span title="Distance from its own 200-day average">
            200d {pct(n.dist200dma, 0)}
          </span>
        )}
        {n.volRatio != null && n.volRatio > 1.25 && (
          <span style={{ color: "#ffa502" }} title="21-day volatility versus its own 252-day volatility">
            vol ×{n.volRatio.toFixed(1)}
          </span>
        )}
        {n.drawdown != null && n.drawdown < -0.1 && (
          <span style={{ color: "#ff4757" }} title="Below its own trailing 1-year high">
            dd {pct(n.drawdown, 0)}
          </span>
        )}
      </div>
    </div>
  );
}

/** A universe-level statistic shown with its own historical percentile. */
function RegimeStat({ label, value, percentile, hint, invert }) {
  const p = percentile;
  // The percentile is the interpretation. 0.94 means "higher than 94% of the
  // last year" — that is what makes a bare correlation figure legible.
  const extreme = p != null && (p >= 0.9 || p <= 0.1);
  return (
    <div style={{ flex: 1, minWidth: 120, padding: "10px 12px", background: "#0b0f18",
                  border: `1px solid ${extreme ? "#ffa50240" : "#141b28"}`, borderRadius: 5 }}>
      <div style={{ fontSize: 9, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1 }}>{label}</div>
      <div style={{ fontFamily: "monospace", fontSize: 17, fontWeight: 700, color: value == null ? "#3a4558" : "#c8d6e8", marginTop: 3 }}>
        {value ?? <NoData reason={hint ?? "Not enough stored history"} />}
      </div>
      {p != null ? (
        <div style={{ fontSize: 9, color: extreme ? "#ffa502" : "#3a4558", marginTop: 2 }}>
          {ordinal(Math.round(p * 100))} pct of past year
        </div>
      ) : (
        <div style={{ fontSize: 9, color: "#2a3548", marginTop: 2 }}>no percentile yet</div>
      )}
    </div>
  );
}

function WhatChangedPage({ prices, pulseCount, poll, feed }) {
  const [data, setData] = useState(null);
  const [lead, setLead] = useState(null);
  const [rel, setRel] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fearGreed, setFearGreed] = useState(null);
  const [fgTried, setFgTried] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [c, l, r] = await Promise.all([
        fetch(`${API}/changes?limit=14`).then(x => x.json()),
        fetch(`${API}/leadership?window=21`).then(x => x.json()),
        fetch(`${API}/relationships`).then(x => x.json()),
      ]);
      setData(c); setLead(l); setRel(r);
    } catch {
      setErr("Could not reach the Meridian API. Start it with: npm run server");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const get = () => fetchFearAndGreed().then(d => { setFearGreed(d); setFgTried(true); });
    get();
    const t = setInterval(get, 300000);
    return () => clearInterval(t);
  }, []);

  if (err) {
    return (
      <Panel>
        <SectionHeader title="WHAT CHANGED" action="RETRY" onAction={load} />
        <div style={{ padding: 20, color: "#ff4757", fontSize: 12, fontFamily: "monospace" }}>{err}</div>
      </Panel>
    );
  }

  if (loading && !data) {
    return (
      <Panel>
        <SectionHeader title="WHAT CHANGED" />
        <div style={{ padding: 20, color: "#4a6080", fontSize: 12, fontFamily: "monospace" }}>Reading the memory…</div>
      </Panel>
    );
  }

  // The memory is empty until history has been synced at least once. Say what
  // to run rather than rendering an empty page that looks broken.
  if (data && !data.available) {
    return (
      <Panel>
        <SectionHeader title="WHAT CHANGED" subtitle="No memory yet" action="RETRY" onAction={load} />
        <div style={{ padding: 20, fontSize: 12, color: "#7a8ba0", lineHeight: 1.8, fontFamily: "monospace" }}>
          {data.reason}
          <div style={{ marginTop: 12, color: "#4a6080" }}>
            curl -X POST http://localhost:3001/sync
          </div>
        </div>
      </Panel>
    );
  }

  const tone = TONE_STYLE[data.verdict?.tone] ?? TONE_STYLE.mild;
  const r = data.regime;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* The verdict. Allowed to say nothing happened. */}
      <div style={{
        background: "#0d1117", border: `1px solid ${tone.color}35`, borderRadius: 6,
        padding: "14px 18px", display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1.5 }}>SESSION VERDICT</div>
          <div style={{ fontFamily: "monospace", fontSize: 15, fontWeight: 700, color: tone.color, letterSpacing: 1, marginTop: 3 }}>
            {tone.label}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 260, fontSize: 13, color: "#a0b4c8", lineHeight: 1.6 }}>
          {data.verdict?.text}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace" }}>SESSION</div>
          <div style={{ fontFamily: "monospace", fontSize: 12, color: "#7a8ba0" }}>{data.date}</div>
          <div style={{ fontSize: 9, color: "#2a3548", fontFamily: "monospace" }}>
            {data.observed} instruments · vs {data.previousDate ?? "—"}
          </div>
        </div>
        <PulseIndicator pulseCount={pulseCount} feed={feed} />
      </div>

      {/* Universe-level state, each figure with its own historical percentile. */}
      <Panel>
        <SectionHeader
          title="UNIVERSE STATE"
          subtitle={r ? `${r.nSymbols} instruments · derived from stored daily bars` : "not enough coverage"}
          action="REFRESH" onAction={load}
        />
        <div style={{ padding: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <RegimeStat label="ABOVE 50DMA" value={pctPlain(r?.breadth50)} percentile={r?.breadth50Pct}
                      hint="Needs 50 bars per symbol" />
          <RegimeStat label="ABOVE 200DMA" value={pctPlain(r?.breadth200)} percentile={r?.breadth200Pct}
                      hint="Needs 200 bars per symbol" />
          <RegimeStat label="DISPERSION" value={r?.dispersion != null ? (r.dispersion * 100).toFixed(2) + "%" : null}
                      percentile={r?.dispersionPct}
                      hint="Cross-sectional spread of same-day returns" />
          <RegimeStat label="AVG CORRELATION" value={r?.avgCorr != null ? r.avgCorr.toFixed(2) : null}
                      percentile={r?.avgCorrPct}
                      hint="Mean pairwise 60-day correlation" />
          <RegimeStat label="ADVANCING" value={pctPlain(r?.pctUp)} percentile={null} />
          <RegimeStat label="2σ DAYS" value={pctPlain(r?.pctExtreme)} percentile={null}
                      hint="Share of the universe with an unusual move" />
        </div>
        {r?.breadth50Streak > 1 && (
          <div style={{ padding: "0 14px 12px", fontSize: 11, color: "#7a8ba0" }}>
            Breadth has been {r.breadth50 >= 0.5 ? "above" : "below"} half for{" "}
            <span style={{ color: "#c8d6e8", fontWeight: 700 }}>{r.breadth50Streak}</span> consecutive sessions.
          </div>
        )}
      </Panel>

      <div style={{ display: "grid", gridTemplateColumns: "1.35fr 1fr", gap: 14, alignItems: "start" }}>

        {/* Instruments that moved beyond their own normal range. */}
        <Panel>
          <SectionHeader
            title="MOVED UNUSUALLY"
            subtitle="Ranked by standard deviations against each instrument's own trailing year"
          />
          {data.notable.length === 0 ? (
            <div style={{ padding: 20, fontSize: 12, color: "#4a6080", fontFamily: "monospace", lineHeight: 1.7 }}>
              Nothing moved beyond 1.5σ of its own normal range.
              <div style={{ color: "#2a3548", marginTop: 6 }}>
                That is the expected result on most days.
              </div>
            </div>
          ) : (
            <>
              <div style={{
                display: "grid", gridTemplateColumns: "minmax(90px,1.4fr) 74px 62px 1fr",
                gap: 10, padding: "6px 12px", borderBottom: "1px solid #1a1f2e",
                fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1,
              }}>
                <span>INSTRUMENT</span>
                <span style={{ textAlign: "right" }}>DAY</span>
                <span style={{ textAlign: "right" }}>SIGMA</span>
                <span style={{ textAlign: "right" }}>CONTEXT</span>
              </div>
              {data.notable.map(n => <ChangeRow key={n.symbol} n={n} />)}
            </>
          )}
        </Panel>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Leadership rotation — needs two windows, so no quote page has it. */}
          <Panel>
            <SectionHeader title="LEADERSHIP" subtitle="21 sessions, and how the ranking has rotated" />
            {!lead?.available ? (
              <div style={{ padding: 16 }}><NoData reason="Not enough stored history" /></div>
            ) : (
              <div style={{ padding: "6px 0" }}>
                {lead.groups.map(g => (
                  <div key={g.group} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "6px 14px", fontSize: 11,
                  }}>
                    <span style={{ flex: 1, color: "#7a8ba0", fontFamily: "monospace" }}>{g.group}</span>
                    <span style={{ fontFamily: "monospace", color: signColor(g.ret), minWidth: 58, textAlign: "right" }}>
                      {pct(g.ret, 2)}
                    </span>
                    {/* Rank movement is the rotation signal; flat means no change. */}
                    <span style={{
                      minWidth: 34, textAlign: "right", fontFamily: "monospace", fontSize: 10,
                      color: g.rankChange == null ? "#2a3548" : g.rankChange > 0 ? "#00d4aa" : g.rankChange < 0 ? "#ff4757" : "#3a4558",
                    }} title={g.priorRank != null ? `Ranked ${g.priorRank + 1} a month ago, ${g.rank + 1} now` : "No prior window"}>
                      {g.rankChange == null ? "·" : g.rankChange === 0 ? "—" : `${g.rankChange > 0 ? "▲" : "▼"}${Math.abs(g.rankChange)}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Relationships that changed — the reason to keep history at all. */}
          <Panel>
            <SectionHeader title="RELATIONSHIPS" subtitle="60-day correlation vs the preceding 60" />
            {!rel?.available ? (
              <div style={{ padding: 16 }}><NoData reason="Needs 120 sessions of overlapping history" /></div>
            ) : (
              <div style={{ padding: "6px 0" }}>
                {rel.pairs.slice(0, 6).map(p => (
                  <div key={p.pair} style={{ padding: "6px 14px", fontSize: 11 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ flex: 1, color: "#7a8ba0", fontFamily: "monospace", fontSize: 10 }}>{p.pair}</span>
                      <span style={{ fontFamily: "monospace", color: "#3a4558" }}>{p.previous.toFixed(2)}</span>
                      <span style={{ color: "#2a3548" }}>→</span>
                      <span style={{ fontFamily: "monospace", color: p.flipped ? "#ffa502" : "#c8d6e8", fontWeight: 700 }}>
                        {p.now.toFixed(2)}
                      </span>
                    </div>
                    {p.percentile != null && (p.percentile >= 0.9 || p.percentile <= 0.1) && (
                      <div style={{ fontSize: 9, color: "#ffa502", marginTop: 1 }}>
                        {ordinal(Math.round(p.percentile * 100))} percentile of the past year
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel>
            <SectionHeader title="FEAR & GREED" subtitle="CNN — external source" />
            <FearGreedGauge data={fearGreed} tried={fgTried} />
          </Panel>
        </div>
      </div>

      {/* Provenance, stated rather than implied. */}
      <div style={{ fontSize: 10, color: "#2a3548", fontFamily: "monospace", padding: "0 4px" }}>
        {data.source} · Fear &amp; Greed from CNN. Live quotes polled {ageLabel(feed?.upstreamAt)}.
      </div>
    </div>
  );
}


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
// SCREENER
//
// The backend has scored every tracked symbol against six weighted factor
// strategies since v2, entirely from stored bar history — /screen and /score
// in server/engines/screener.js. This page never called either. It rendered
// SCREENER_RESULTS: twenty-one lines of fixed rows with invented composite
// scores, invented setups and invented invalidation levels that never changed
// no matter what the market did.
//
// This is now a front end for the engine that was already there.
// ============================================================

function ScoreBar({ score, color = "#00d4aa", showValue = true }) {
  if (score == null) return <NoData compact reason="Not scored" />;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, height: 4, background: "#141b28", borderRadius: 2, overflow: "hidden", minWidth: 40 }}>
        <div style={{ width: `${Math.max(0, Math.min(100, score))}%`, height: "100%", background: color, borderRadius: 2 }} />
      </div>
      {showValue && (
        <span style={{ fontFamily: "monospace", fontSize: 10, color: "#7a8ba0", minWidth: 26, textAlign: "right" }}>
          {score.toFixed(0)}
        </span>
      )}
    </div>
  );
}

// Colour by strength so a table of sixty rows can be read at a glance.
function compositeColor(v) {
  if (v == null) return "#3a4558";
  if (v >= 70) return "#00d4aa";
  if (v >= 55) return "#a8e063";
  if (v >= 45) return "#ffa502";
  return "#ff7043";
}

const FACTOR_COLORS = {
  trend: "#00d4aa", momentum: "#3d8bff", meanRev: "#a855f7",
  volume: "#ffa502", lowVol: "#4ade80", breakout: "#ff7043",
};

/** Expanded detail for one result — the components behind its composite. */
function ScreenDetail({ r }) {
  const m = r.metrics;
  const cell = (label, value, suffix = "") => (
    <div key={label}>
      <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontFamily: "monospace", fontSize: 12, color: value == null ? "#3a4558" : "#c8d6e8", marginTop: 2 }}>
        {value == null ? <NoData compact /> : `${value}${suffix}`}
      </div>
    </div>
  );

  return (
    <div style={{ padding: "12px 16px", background: "#080b12", borderBottom: "1px solid #10151f" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>

        <div>
          <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1, marginBottom: 8 }}>
            FACTOR COMPONENTS
          </div>
          {Object.entries(r.scores).map(([k, v]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
              <span style={{ fontSize: 10, color: "#7a8ba0", minWidth: 74, fontFamily: "monospace" }}>{k}</span>
              <div style={{ flex: 1 }}><ScoreBar score={v} color={FACTOR_COLORS[k] ?? "#4a6080"} /></div>
            </div>
          ))}
          <div style={{ fontSize: 9, color: "#2a3548", marginTop: 8, lineHeight: 1.5 }}>
            Weighted by the selected strategy. Computed from {r.observations} stored daily bars.
          </div>
        </div>

        <div>
          <div style={{ fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1, marginBottom: 8 }}>
            MEASURES
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 14px" }}>
            {cell("1M", m.return1m, "%")}
            {cell("3M", m.return3m, "%")}
            {cell("6M", m.return6m, "%")}
            {cell("12-1M", m.return12m1, "%")}
            {cell("RSI(14)", m.rsi)}
            {cell("Z-SCORE", m.zScore)}
            {cell("ANN VOL", m.annualVol, "%")}
            {cell("VOL RATIO", m.volumeRatio, "×")}
            {cell("52W RANGE", m.rangePosition, "%")}
            {cell("50DMA", m.ma50)}
            {cell("200DMA", m.ma200)}
            {cell("MACD HIST", m.macdHistogram)}
          </div>

          {r.signals.length > 0 && (
            <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 5 }}>
              {r.signals.map(s => (
                <span key={s} style={{
                  fontSize: 10, fontFamily: "monospace", padding: "2px 7px", borderRadius: 3,
                  background: "#0d1421", border: "1px solid #1a2535", color: "#7a8ba0",
                }}>{s}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScreenerPage() {
  const [strategy, setStrategy] = useState("balanced");
  const [strategies, setStrategies] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [minScore, setMinScore] = useState(0);

  useEffect(() => {
    fetch(`${API}/screener/strategies`)
      .then(r => r.json())
      .then(d => setStrategies(d.screener ?? null))
      .catch(() => {});
  }, []);

  const run = useCallback(async (strat, floor) => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`${API}/screen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: strat, minScore: floor, limit: 60 }),
      });
      setData(await res.json());
    } catch {
      setErr("Could not reach the Meridian API. Start it with: npm run server");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { run(strategy, minScore); }, [strategy, minScore, run]);

  const stratList = strategies
    ? Object.entries(strategies).map(([id, s]) => ({ id, label: s.label }))
    : [{ id: "balanced", label: "Balanced" }];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      <Panel>
        <SectionHeader
          title="SCREENER"
          subtitle="Factor scores computed from stored daily bars"
          action={loading ? "SCANNING…" : "RESCAN"}
          onAction={() => run(strategy, minScore)}
        />

        <div style={{ padding: "10px 14px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid #1a1f2e" }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {stratList.map(s => (
              <button key={s.id} onClick={() => setStrategy(s.id)} style={{
                background: strategy === s.id ? "#0d2820" : "transparent",
                border: `1px solid ${strategy === s.id ? "#00d4aa50" : "#1a2535"}`,
                color: strategy === s.id ? "#00d4aa" : "#4a6080",
                fontFamily: "monospace", fontSize: 11, padding: "4px 10px",
                borderRadius: 3, cursor: "pointer",
              }}>{s.label}</button>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
            <span style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace" }}>MIN SCORE</span>
            <input
              type="range" min="0" max="80" step="5" value={minScore}
              onChange={e => setMinScore(Number(e.target.value))}
              style={{ width: 110, accentColor: "#00d4aa" }}
            />
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "#c8d6e8", minWidth: 20 }}>{minScore}</span>
          </div>
        </div>

        {err ? (
          <div style={{ padding: 20, color: "#ff4757", fontSize: 12, fontFamily: "monospace" }}>{err}</div>
        ) : loading && !data ? (
          <div style={{ padding: 20, color: "#4a6080", fontSize: 12, fontFamily: "monospace" }}>Scoring stored history…</div>
        ) : !data?.results?.length ? (
          <div style={{ padding: 20, color: "#4a6080", fontSize: 12, fontFamily: "monospace", lineHeight: 1.7 }}>
            Nothing scored{minScore > 0 ? ` above ${minScore}` : ""}.
            {data?.skipped?.length > 0 && (
              <div style={{ color: "#2a3548", marginTop: 6 }}>
                {data.skipped.length} symbol{data.skipped.length === 1 ? "" : "s"} skipped for having under 120 stored bars.
              </div>
            )}
          </div>
        ) : (
          <>
            <div style={{
              display: "grid", gridTemplateColumns: "22px minmax(90px,1.2fr) 80px 90px 1.1fr 1.4fr",
              gap: 10, padding: "7px 14px", borderBottom: "1px solid #1a1f2e",
              fontSize: 9, color: "#3a4558", fontFamily: "monospace", letterSpacing: 1,
            }}>
              <span />
              <span>SYMBOL</span>
              <span style={{ textAlign: "right" }}>PRICE</span>
              <span style={{ textAlign: "right" }}>COMPOSITE</span>
              <span>STRENGTH</span>
              <span>SIGNALS</span>
            </div>

            {data.results.map(r => {
              const open = expanded === r.symbol;
              return (
                <div key={r.symbol}>
                  <div
                    onClick={() => setExpanded(open ? null : r.symbol)}
                    style={{
                      display: "grid", gridTemplateColumns: "22px minmax(90px,1.2fr) 80px 90px 1.1fr 1.4fr",
                      gap: 10, padding: "8px 14px", borderBottom: "1px solid #10151f",
                      cursor: "pointer", alignItems: "center",
                      background: open ? "#0b0f18" : "transparent",
                    }}
                  >
                    <span style={{ color: "#3a4558", fontSize: 10 }}>{open ? "▾" : "▸"}</span>
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: "#c8d6e8", fontWeight: 700 }}>
                      {r.symbol}
                    </span>
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: "#7a8ba0", textAlign: "right" }}>
                      {r.price}
                    </span>
                    <span style={{
                      fontFamily: "monospace", fontSize: 14, fontWeight: 700,
                      color: compositeColor(r.composite), textAlign: "right",
                    }}>
                      {r.composite}
                    </span>
                    <ScoreBar score={r.composite} color={compositeColor(r.composite)} showValue={false} />
                    <span style={{ fontSize: 10, color: "#4a6080", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.signals.length ? r.signals.join(" · ") : "—"}
                    </span>
                  </div>
                  {open && <ScreenDetail r={r} />}
                </div>
              );
            })}

            <div style={{ padding: "8px 14px", fontSize: 10, color: "#2a3548", fontFamily: "monospace" }}>
              {data.strategyLabel} · scanned {data.scanned}, showing {data.results.length}
              {data.skipped?.length > 0 && ` · ${data.skipped.length} skipped for insufficient history`}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

const CB_MATRIX = [
  { bank: "Federal Reserve", country: "US", rate: "5.25-5.50%", bias: "Hold / Hawkish", nextMeeting: "Mar 19", expectation: "Hold", color: "#3d8bff" },
  { bank: "ECB", country: "Eurozone", rate: "4.00%", bias: "Cutting", nextMeeting: "Apr 11", expectation: "Cut -25bp", color: "#ffa502" },
  { bank: "Bank of England", country: "UK", rate: "5.25%", bias: "Hold / Hawkish", nextMeeting: "May 9", expectation: "Hold", color: "#00d4aa" },
  { bank: "Bank of Japan", country: "Japan", rate: "0.10%", bias: "Hiking slowly", nextMeeting: "Apr 26", expectation: "Hold", color: "#ff4757" },
  { bank: "Bank of Canada", country: "Canada", rate: "5.00%", bias: "Cutting", nextMeeting: "Apr 10", expectation: "Cut -25bp", color: "#a855f7" },
  { bank: "SNB", country: "Switzerland", rate: "1.50%", bias: "Cutting", nextMeeting: "Jun 20", expectation: "Hold", color: "#c8d6e8" },
];

// ============================================================
// MARKETS PAGE
// Replaces the old FX & Commod. page. One hub for every quoted
// market: indices, FX, commodities, sectors, rates, crypto,
// central banks.
//
// Two rules hold across every sub-page here:
//   1. Prices are live or absent — never a hardcoded stand-in.
//      The page this replaced showed fabricated support/resistance
//      levels next to real quotes, which is worse than showing
//      nothing: it reads as data.
//   2. One visual language. Every board is built from the same
//      MarketTile / Sparkline / RangeBar / heat-cell parts, so the
//      sub-pages read as one page rather than seven.
// ============================================================

const MK = {
  panel: "#0d1117", panelAlt: "#080b12", hair: "#12161f",
  border: "#1a1f2e", border2: "#1a2535",
  up: "#00d4aa", down: "#ff4757", flat: "#4a6080",
  blue: "#3d8bff", amber: "#ffa502", purple: "#a855f7",
  ink: "#e8f0fe", ink2: "#c8d6e8", ink3: "#7a8ba0", ink4: "#4a6080", ink5: "#3a4558",
  mono: "monospace",
};

// VIX and similar inverted gauges: a rising print is risk-off, so the
// usual green-is-good mapping would tell the opposite story.
const INVERTED = new Set(["^VIX"]);
const moveColor = (pct, symbol) => {
  if (pct == null || Number.isNaN(pct)) return MK.flat;
  const good = INVERTED.has(symbol) ? pct < 0 : pct >= 0;
  return Math.abs(pct) < 0.005 ? MK.flat : (good ? MK.up : MK.down);
};

// Diverging scale: two hues with a NEUTRAL midpoint. A hue at zero would
// imply direction where there is none, so near-flat values go grey.
function heatStyle(pct, scale = 2) {
  if (pct == null || Number.isNaN(pct)) return { background: MK.hair, color: MK.ink5 };
  const t = Math.max(-1, Math.min(1, pct / scale));
  if (Math.abs(t) < 0.05) return { background: "#141a24", color: MK.ink4 };
  const rgb = t > 0 ? "0,212,170" : "255,71,87";
  return {
    background: `rgba(${rgb},${(0.10 + Math.abs(t) * 0.42).toFixed(3)})`,
    color: t > 0 ? MK.up : MK.down,
  };
}

const pctText = v => (v == null || Number.isNaN(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

// ─── Primitives ──────────────────────────────────────────────

/** Bare shape-of-the-trend line. Renders nothing when history is missing. */
function Sparkline({ data, color = MK.up, width = 120, height = 30, fill = true, id }) {
  if (!Array.isArray(data) || data.length < 2) return null;
  const lo = Math.min(...data), hi = Math.max(...data);
  const span = hi - lo || 1;
  const dx = width / (data.length - 1);
  // Guard the top and bottom by 2px so peaks aren't clipped by the viewBox.
  const y = v => height - 2 - ((v - lo) / span) * (height - 4);
  const pts = data.map((v, i) => `${(i * dx).toFixed(2)},${y(v).toFixed(2)}`);
  const gid = `sg-${id}`;
  const lastX = (data.length - 1) * dx, lastY = y(data[data.length - 1]);
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }} aria-hidden="true">
      {fill && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon points={`0,${height} ${pts.join(" ")} ${width},${height}`} fill={`url(#${gid})`} />
        </>
      )}
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5"
                strokeLinejoin="round" strokeLinecap="round" />
      {/* Emphasised endpoint — the eye should land on "now". */}
      <circle cx={lastX} cy={lastY} r="2.4" fill={color} />
    </svg>
  );
}

/** Where the current print sits inside a low–high band. */
function RangeBar({ low, high, value, label, compact = false, symbol }) {
  if ([low, high, value].some(v => typeof v !== "number" || Number.isNaN(v)) || high <= low) return null;
  const pos = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {label && <div style={{ fontSize: 8, color: MK.ink5, fontFamily: MK.mono, letterSpacing: 1 }}>{label}</div>}
      <div style={{ position: "relative", height: compact ? 3 : 4, background: MK.border2, borderRadius: 2 }}>
        <div style={{
          position: "absolute", left: `${pos * 100}%`, top: -2, bottom: -2,
          width: 2, background: MK.ink2, borderRadius: 1, transform: "translateX(-1px)",
        }} />
      </div>
      {!compact && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: MK.ink5, fontFamily: MK.mono }}>
          {/* Match the instrument's own precision — a 4dp index bound
              ("5,568.7945") reads as noise next to a 2dp price. */}
          <span>{symbol ? formatPrice(low, symbol) : low.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
          <span>{symbol ? formatPrice(high, symbol) : high.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
        </div>
      )}
    </div>
  );
}

/** Signed bar growing left or right from a shared centre line. */
function DivergingBar({ value, max, label, sub, unit = "%" }) {
  const t = max ? Math.max(-1, Math.min(1, value / max)) : 0;
  const pos = t >= 0;
  const col = Math.abs(t) < 0.02 ? MK.flat : pos ? MK.up : MK.down;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "84px 1fr 64px", alignItems: "center", gap: 10, padding: "5px 0" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: MK.ink2, fontFamily: MK.mono }}>{label}</div>
        {sub && <div style={{ fontSize: 9, color: MK.ink5 }}>{sub}</div>}
      </div>
      <div style={{ position: "relative", height: 14 }}>
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "#2a3548" }} />
        <div style={{
          position: "absolute", top: 3, height: 8, borderRadius: 2, background: col,
          left: pos ? "50%" : `${50 + t * 50}%`,
          width: `${Math.abs(t) * 50}%`,
        }} />
      </div>
      <div style={{ fontSize: 12, fontFamily: MK.mono, color: col, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {value >= 0 ? "+" : ""}{value.toFixed(2)}{unit}
      </div>
    </div>
  );
}

/** The workhorse card. Every board on this page is a grid of these. */
function MarketTile({ symbol, name, sub, prices, spark, onClick, active, unit }) {
  const d = prices?.[symbol];
  const pct = d?.changePct;
  const col = moveColor(pct, symbol);
  const live = !!d;

  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      style={{
        background: MK.panel,
        border: `1px solid ${active ? `${col}66` : MK.border}`,
        borderTop: `2px solid ${live ? col : MK.border2}`,
        borderRadius: 7,
        padding: "12px 14px 10px",
        cursor: onClick ? "pointer" : "default",
        display: "flex", flexDirection: "column", gap: 8,
        position: "relative", overflow: "hidden",
        transition: "border-color .15s",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: MK.ink, fontFamily: MK.mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {name}
          </div>
          {sub && <div style={{ fontSize: 9.5, color: MK.ink5, marginTop: 1 }}>{sub}</div>}
        </div>
        {spark && spark.length > 1 && (
          <Sparkline data={spark} color={col} width={62} height={24} id={symbol} />
        )}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 19, fontWeight: 700, color: live ? MK.ink : MK.ink5, fontFamily: MK.mono, fontVariantNumeric: "tabular-nums" }}>
          {live ? formatPrice(d.price, symbol) : "—"}
        </div>
        <div style={{ fontSize: 12.5, fontFamily: MK.mono, color: col, fontVariantNumeric: "tabular-nums" }}>
          {pctText(pct)}
        </div>
      </div>

      {unit && <div style={{ fontSize: 9, color: MK.ink5, fontFamily: MK.mono, marginTop: -4 }}>{unit}</div>}

      {live && d.dayLow != null && d.dayHigh != null && d.dayHigh > d.dayLow
        ? <RangeBar low={d.dayLow} high={d.dayHigh} value={d.price} label="DAY RANGE" symbol={symbol} />
        : !live && <div style={{ fontSize: 9, color: MK.ink5, fontFamily: MK.mono }}>awaiting price feed</div>}
    </div>
  );
}

/** Sub-page switcher. */
function TabRail({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${MK.border}`, overflowX: "auto" }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)} style={{
          background: "transparent", border: "none",
          borderBottom: active === t.id ? `2px solid ${MK.up}` : "2px solid transparent",
          color: active === t.id ? MK.up : MK.ink4,
          padding: "9px 15px", cursor: "pointer", fontFamily: MK.mono, fontSize: 11,
          letterSpacing: 1, whiteSpace: "nowrap", flexShrink: 0,
        }}>{t.label.toUpperCase()}</button>
      ))}
    </div>
  );
}

function BoardHeading({ title, note }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "2px 0 -2px" }}>
      <span style={{ fontSize: 10, color: MK.ink4, fontFamily: MK.mono, letterSpacing: 1.6 }}>{title}</span>
      {note && <span style={{ fontSize: 10.5, color: MK.ink5 }}>{note}</span>}
    </div>
  );
}

// Auto-fitting grid — the old page stacked one row per instrument and left
// most of a wide monitor empty. auto-FIT (not auto-fill) collapses the unused
// tracks, so a three-item row like Energy stretches across the width instead
// of huddling at the left with three empty columns beside it.
const grid = (min = 210, max = 420) => ({
  display: "grid",
  gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
  maxWidth: `calc(${max}px * 6)`,
  gap: 10,
  alignItems: "start",
});

// ─── Static reference data ───────────────────────────────────
// Structural context only: which central banks set a pair, what a contract is
// quoted in, what durably drives it. Deliberately no price calls, no support
// and resistance levels — those were invented in the page this replaces.

const FX_BOARD = [
  { symbol: "EURUSD=X", name: "EUR/USD", banks: "ECB vs Fed",  note: "The most-traded pair; policy-rate spread is the dominant driver." },
  { symbol: "GBPUSD=X", name: "GBP/USD", banks: "BoE vs Fed",  note: "Sensitive to UK inflation prints and gilt moves." },
  { symbol: "USDJPY=X", name: "USD/JPY", banks: "Fed vs BoJ",  note: "Rate-differential and carry proxy; moves on BoJ policy shifts." },
  { symbol: "GBPEUR=X", name: "GBP/EUR", banks: "BoE vs ECB",  note: "UK-vs-eurozone growth and rate spread, no dollar leg." },
  { symbol: "AUDUSD=X", name: "AUD/USD", banks: "RBA vs Fed",  note: "Traded as a China growth and industrial-commodity proxy." },
  { symbol: "USDCAD=X", name: "USD/CAD", banks: "Fed vs BoC",  note: "Crude oil is a persistent second driver alongside rates." },
  { symbol: "USDCHF=X", name: "USD/CHF", banks: "Fed vs SNB",  note: "Franc carries a safe-haven bid in risk-off episodes." },
];

// Which side of each pair each currency sits on, for the strength read.
const FX_LEGS = {
  "EURUSD=X": ["EUR", "USD"], "GBPUSD=X": ["GBP", "USD"], "USDJPY=X": ["USD", "JPY"],
  "GBPEUR=X": ["GBP", "EUR"], "AUDUSD=X": ["AUD", "USD"], "USDCAD=X": ["USD", "CAD"],
  "USDCHF=X": ["USD", "CHF"],
};

const COMMODITY_BOARD = [
  { symbol: "GC=F", name: "Gold",        unit: "$ / troy oz", group: "Metals", note: "Real yields and the dollar set the tone; central-bank buying is the structural bid." },
  { symbol: "SI=F", name: "Silver",      unit: "$ / troy oz", group: "Metals", note: "Half precious metal, half industrial input — solar demand is the secular leg." },
  { symbol: "HG=F", name: "Copper",      unit: "$ / lb",      group: "Metals", note: "Read as a global growth proxy; China construction and grid spend dominate." },
  { symbol: "CL=F", name: "WTI Crude",   unit: "$ / barrel",  group: "Energy", note: "US benchmark. OPEC+ supply policy and inventory draws drive it." },
  { symbol: "BZ=F", name: "Brent Crude", unit: "$ / barrel",  group: "Energy", note: "Seaborne global benchmark; carries more geopolitical risk premium than WTI." },
  { symbol: "NG=F", name: "Natural Gas", unit: "$ / MMBtu",   group: "Energy", note: "Weather and storage driven; the most volatile of the majors." },
];

const INDEX_BOARD = [
  { symbol: "^GSPC",     name: "S&P 500",       sub: "US large cap",        group: "United States" },
  { symbol: "^IXIC",     name: "NASDAQ Comp.",  sub: "US tech-weighted",    group: "United States" },
  { symbol: "^DJI",      name: "Dow Jones",     sub: "US blue chip",        group: "United States" },
  { symbol: "^RUT",      name: "Russell 2000",  sub: "US small cap",        group: "United States" },
  { symbol: "^FTSE",     name: "FTSE 100",      sub: "UK large cap",        group: "International" },
  { symbol: "^STOXX50E", name: "EuroStoxx 50",  sub: "Eurozone blue chip",  group: "International" },
  { symbol: "^GDAXI",    name: "DAX",           sub: "Germany",             group: "International" },
  { symbol: "^N225",     name: "Nikkei 225",    sub: "Japan",               group: "International" },
  { symbol: "EEM",       name: "MSCI EM",       sub: "Emerging markets",    group: "International" },
];

const SECTOR_BOARD = [
  { symbol: "XLK",  name: "Technology" },      { symbol: "XLF",  name: "Financials" },
  { symbol: "XLV",  name: "Health Care" },     { symbol: "XLE",  name: "Energy" },
  { symbol: "XLI",  name: "Industrials" },     { symbol: "XLY",  name: "Cons. Disc." },
  { symbol: "XLP",  name: "Cons. Staples" },   { symbol: "XLU",  name: "Utilities" },
  { symbol: "XLRE", name: "Real Estate" },     { symbol: "XLB",  name: "Materials" },
  { symbol: "XLC",  name: "Communications" },
];

const RATE_BOARD = [
  { symbol: "^IRX", name: "US 3-Month", years: 0.25, sub: "T-bill — tracks the Fed's policy rate" },
  { symbol: "^FVX", name: "US 5-Year",  years: 5,    sub: "Belly of the curve" },
  { symbol: "^TNX", name: "US 10-Year", years: 10,   sub: "The global discount-rate benchmark" },
];

// Placeholder until a price source is wired — labelled as such everywhere it
// shows, rather than quietly rendering as though it were live.
const CRYPTO_BOARD = [
  { symbol: "BTC", name: "Bitcoin",  sub: "BTC" },
  { symbol: "ETH", name: "Ethereum", sub: "ETH" },
  { symbol: "SOL", name: "Solana",   sub: "SOL" },
  { symbol: "XRP", name: "XRP",      sub: "XRP" },
];

// Rate gaps below are hand-maintained alongside CB_MATRIX; the banner on that
// board says so, because a stale policy spread reads exactly like a live one.
const CB_DIVERGENCE = [
  { pair: "USD vs EUR", gap: "+1.25-1.50%", note: "ECB cutting while the Fed holds — EUR/USD carries a downside bias.", tag: "Long USD / Short EUR", color: "#3d8bff" },
  { pair: "USD vs JPY", gap: "+5.15-5.40%", note: "The widest gap of the majors; the carry trade dominates positioning.", tag: "Long USD/JPY carry", color: "#ffa502" },
  { pair: "USD vs GBP", gap: "-0.25-0.00%", note: "Near parity. A hawkish BoE hold keeps sterling supported and the cross range-bound.", tag: "Neutral - watch data", color: "#00d4aa" },
  { pair: "USD vs CAD", gap: "+0.25-0.50%", note: "The BoC is ahead of the Fed in cutting, leaving CAD under moderate pressure.", tag: "Mild USD/CAD upside", color: "#a855f7" },
];

// Labels are derived from the board definitions above rather than kept in a
// parallel hand-maintained map — one source of truth, no drift.
const MARKET_META = Object.fromEntries([
  ...INDEX_BOARD.map(x => [x.symbol, { name: x.name, sub: x.sub }]),
  ...FX_BOARD.map(x => [x.symbol, { name: x.name, sub: x.banks }]),
  ...COMMODITY_BOARD.map(x => [x.symbol, { name: x.name, sub: x.unit }]),
  ...SECTOR_BOARD.map(x => [x.symbol, { name: x.name, sub: x.symbol }]),
  ...RATE_BOARD.map(x => [x.symbol, { name: x.name, sub: x.sub }]),
  ["^VIX",      { name: "VIX",          sub: "Implied volatility, S&P 500" }],
  ["DX-Y.NYB",  { name: "Dollar Index", sub: "Trade-weighted USD" }],
]);
const mkName = s => MARKET_META[s]?.name || DISPLAY_NAMES[s] || s;
const mkSub  = s => MARKET_META[s]?.sub;

const ALL_MARKET_SYMBOLS = [
  ...INDEX_BOARD.map(x => x.symbol), ...FX_BOARD.map(x => x.symbol),
  ...COMMODITY_BOARD.map(x => x.symbol), ...SECTOR_BOARD.map(x => x.symbol),
  ...RATE_BOARD.map(x => x.symbol), "^VIX", "DX-Y.NYB",
];

// ─── Derived measures ────────────────────────────────────────

/**
 * Per-currency strength from the tracked pairs.
 * Each pair contributes its move to the base currency and the negation of it
 * to the quote currency; a currency's score is the mean across the pairs it
 * appears in. Averaging (not summing) keeps USD — which appears in six pairs —
 * on the same scale as CHF, which appears in one.
 */
function currencyStrength(prices) {
  const acc = {};
  for (const [sym, [base, quote]] of Object.entries(FX_LEGS)) {
    const pct = prices?.[sym]?.changePct;
    if (pct == null || Number.isNaN(pct)) continue;
    (acc[base] ??= []).push(pct);
    (acc[quote] ??= []).push(-pct);
  }
  return Object.entries(acc)
    .map(([ccy, vals]) => ({ ccy, value: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length }))
    .sort((a, b) => b.value - a.value);
}

/** Pearson correlation of daily returns. Real history in, real number out. */
function returnsCorrelation(a, b) {
  if (!a || !b) return null;
  const n = Math.min(a.length, b.length);
  if (n < 20) return null;                      // too short to mean anything
  const ra = [], rb = [];
  const sa = a.slice(-n), sb = b.slice(-n);
  for (let i = 1; i < n; i++) {
    if (!sa[i - 1] || !sb[i - 1]) continue;
    ra.push(sa[i] / sa[i - 1] - 1);
    rb.push(sb[i] / sb[i - 1] - 1);
  }
  if (ra.length < 15) return null;
  const m = xs => xs.reduce((s, v) => s + v, 0) / xs.length;
  const ma = m(ra), mb = m(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) {
    const x = ra[i] - ma, y = rb[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den ? num / den : null;
}

/** Percent change across a close series — the sparkline's own period. */
const periodChange = s => (Array.isArray(s) && s.length > 1 && s[0] ? (s[s.length - 1] / s[0] - 1) * 100 : null);

// ─── Page ────────────────────────────────────────────────────

function MarketsPage({ prices }) {
  const [tab, setTab] = useState("overview");
  const [hist, setHist] = useState({});
  const [histLoaded, setHistLoaded] = useState(false);
  const [detail, setDetail] = useState(null);
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  // One batched call for every sparkline on the page.
  useEffect(() => {
    let alive = true;
    fetch(`${API}/history/batch?symbols=${encodeURIComponent(ALL_MARKET_SYMBOLS.join(","))}&days=90`)
      .then(r => r.json())
      .then(d => { if (alive) { setHist(d.series ?? {}); setHistLoaded(true); } })
      .catch(() => { if (alive) setHistLoaded(true); });   // no history: tiles still render, just without sparklines
    return () => { alive = false; };
  }, []);

  const sp = sym => hist[sym];
  const px = sym => prices?.[sym];

  const TABS = [
    { id: "overview",  label: "Overview" },
    { id: "indices",   label: "Indices" },
    { id: "fx",        label: "FX" },
    { id: "commod",    label: "Commodities" },
    { id: "sectors",   label: "Sectors" },
    { id: "rates",     label: "Rates" },
    { id: "crypto",    label: "Crypto" },
    { id: "banks",     label: "Central Banks" },
  ];

  // Ranked movers across everything quoted, for the overview.
  // Yields are excluded: a 1.3% move in a 5.3% yield is a 7bp shift, which is
  // not the same kind of quantity as a stock rising 1.3%, and ranking them
  // together puts rates at the top of the board on a quiet day.
  const RANKABLE = ALL_MARKET_SYMBOLS.filter(s => !RATE_BOARD.some(r => r.symbol === s));
  const movers = RANKABLE
    .map(s => ({ symbol: s, name: mkName(s), pct: px(s)?.changePct }))
    .filter(m => m.pct != null && !Number.isNaN(m.pct))
    .sort((a, b) => b.pct - a.pct);

  const liveCount = ALL_MARKET_SYMBOLS.filter(s => px(s)).length;

  function runAI() {
    setAiLoading(true);
    const line = (label, sym) => {
      const d = px(sym);
      return d ? `${label} ${formatPrice(d.price, sym)} (${pctText(d.changePct)})` : null;
    };
    const ctx = [
      line("S&P 500", "^GSPC"), line("NASDAQ", "^IXIC"), line("FTSE 100", "^FTSE"),
      line("VIX", "^VIX"), line("DXY", "DX-Y.NYB"), line("Gold", "GC=F"),
      line("WTI", "CL=F"), line("US 10Y", "^TNX"), line("EUR/USD", "EURUSD=X"),
    ].filter(Boolean).join("; ");
    const strength = currencyStrength(prices).slice(0, 3).map(s => `${s.ccy} ${s.value >= 0 ? "+" : ""}${s.value.toFixed(2)}%`).join(", ");
    const prompt = `You are a macro strategist writing a cross-asset read for a UK private investor.

Live session data: ${ctx || "no live prices available"}.
Strongest currencies today: ${strength || "n/a"}.

Write four labelled sections, 2 sentences each, plain text, no markdown:
THE SESSION: What is actually happening across assets right now.
WHAT IS DRIVING IT: The mechanism linking these moves.
WHAT TO WATCH: The specific level or event that would change the picture.
POSITIONING READ: What this backdrop favours and what it punishes.

Be specific about the numbers given. No hedging filler.`;
    callAI(prompt, 900).then(({ text }) => { setAiText(text); setAiLoading(false); });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: MK.ink, fontFamily: MK.mono, letterSpacing: 1 }}>MARKETS</div>
          <div style={{ fontSize: 12.5, color: MK.ink4, marginTop: 3 }}>
            {liveCount} of {ALL_MARKET_SYMBOLS.length} instruments live
            {histLoaded && ` · ${Object.keys(hist).length} with stored history`}
          </div>
        </div>
      </div>

      <TabRail tabs={TABS} active={tab} onChange={t => { setTab(t); setDetail(null); }} />

      {/* ─── OVERVIEW ─────────────────────────────────────── */}
      {tab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={grid(200)}>
            {["^GSPC", "^FTSE", "DX-Y.NYB", "^VIX", "GC=F", "^TNX"].map(s => (
              <MarketTile key={s} symbol={s} name={mkName(s)}
                          sub={mkSub(s)} prices={prices} spark={sp(s)} />
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12, alignItems: "start" }}>
            <Panel>
              <SectionHeader title="LEADERS" subtitle="strongest today, all tracked markets" />
              <div style={{ padding: "10px 16px 14px" }}>
                {movers.slice(0, 6).map(m => (
                  <MarketMoverRow key={m.symbol} {...m} spark={sp(m.symbol)} />
                ))}
                {!movers.length && <Empty text="No live prices yet." />}
              </div>
            </Panel>
            <Panel>
              <SectionHeader title="LAGGARDS" subtitle="weakest today, all tracked markets" />
              <div style={{ padding: "10px 16px 14px" }}>
                {movers.slice(-6).reverse().map(m => (
                  <MarketMoverRow key={m.symbol} {...m} spark={sp(m.symbol)} />
                ))}
                {!movers.length && <Empty text="No live prices yet." />}
              </div>
            </Panel>
          </div>

          <Panel>
            <SectionHeader title="CROSS-ASSET MAP" subtitle="today's move by asset class — colour and number both encode the same value" />
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              {[
                { label: "EQUITY INDICES", syms: INDEX_BOARD.map(i => i.symbol) },
                { label: "SECTORS",        syms: SECTOR_BOARD.map(i => i.symbol) },
                { label: "COMMODITIES",    syms: COMMODITY_BOARD.map(i => i.symbol) },
                { label: "FX",             syms: FX_BOARD.map(i => i.symbol) },
                { label: "RATES & VOL",    syms: [...RATE_BOARD.map(i => i.symbol), "^VIX", "DX-Y.NYB"] },
              ].map(row => (
                <div key={row.label}>
                  <BoardHeading title={row.label} />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: 4, marginTop: 6 }}>
                    {row.syms.map(s => {
                      const d = px(s);
                      const st = heatStyle(d?.changePct);
                      return (
                        <div key={s} title={`${mkName(s)}: ${pctText(d?.changePct)}`} style={{
                          ...st, borderRadius: 4, padding: "7px 8px",
                          border: `1px solid ${MK.border}`, minWidth: 0,
                        }}>
                          <div style={{ fontSize: 9.5, color: MK.ink4, fontFamily: MK.mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {mkName(s)}
                          </div>
                          <div style={{ fontSize: 12, fontFamily: MK.mono, fontWeight: 700, color: st.color, fontVariantNumeric: "tabular-nums" }}>
                            {pctText(d?.changePct)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <SectionHeader title="AI CROSS-ASSET READ" subtitle="generated from the live prices above"
                           action={aiLoading ? "THINKING..." : "GENERATE"} onAction={runAI} />
            <div style={{ padding: 16 }}>
              {aiText
                ? <div style={{ fontSize: 12.5, lineHeight: 1.8, color: "#b8c6da", whiteSpace: "pre-wrap", fontFamily: "'Courier New', monospace" }}>{aiText}</div>
                : <div style={{ fontSize: 12, color: MK.ink4 }}>Click GENERATE for a session read across equities, rates, FX and commodities. Requires a Gemini API key (Settings).</div>}
            </div>
          </Panel>
        </div>
      )}

      {/* ─── INDICES ──────────────────────────────────────── */}
      {tab === "indices" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {["United States", "International"].map(g => (
            <div key={g} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <BoardHeading title={g.toUpperCase()} />
              <div style={grid(215)}>
                {INDEX_BOARD.filter(i => i.group === g).map(i => (
                  <MarketTile key={i.symbol} symbol={i.symbol} name={i.name} sub={i.sub}
                              prices={prices} spark={sp(i.symbol)}
                              active={detail === i.symbol}
                              onClick={() => setDetail(detail === i.symbol ? null : i.symbol)} />
                ))}
              </div>
            </div>
          ))}
          <PerformancePanel
            title="INDEX PERFORMANCE"
            note="which markets are actually leading, today and over the quarter"
            rows={INDEX_BOARD} prices={prices} hist={hist} />
          <DetailStrip symbol={detail} prices={prices} spark={sp(detail)} />
        </div>
      )}

      {/* ─── FX ───────────────────────────────────────────── */}
      {tab === "fx" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, alignItems: "start" }}>
            <Panel>
              <SectionHeader title="CURRENCY STRENGTH"
                             subtitle="today's mean move across the pairs each currency trades in" />
              <div style={{ padding: "12px 16px 14px" }}>
                {(() => {
                  const rows = currencyStrength(prices);
                  if (!rows.length) return <Empty text="No live FX prices yet." />;
                  const max = Math.max(...rows.map(r => Math.abs(r.value)), 0.25);
                  return rows.map(r => (
                    <DivergingBar key={r.ccy} label={r.ccy} value={r.value} max={max}
                                  sub={`${r.n} pair${r.n > 1 ? "s" : ""}`} />
                  ));
                })()}
                <div style={{ fontSize: 10, color: MK.ink5, marginTop: 10, lineHeight: 1.5 }}>
                  Derived from the seven pairs tracked here, not a full G10 basket — a
                  currency quoted in only one pair moves on thinner evidence than one quoted in six.
                </div>
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="DOLLAR INDEX" subtitle="DXY — the dollar's trade-weighted level" />
              <div style={{ padding: "16px 18px" }}>
                {px("DX-Y.NYB") ? (
                  <>
                    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
                      <div>
                        <div style={{ fontSize: 34, fontWeight: 700, color: MK.ink, fontFamily: MK.mono, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                          {px("DX-Y.NYB").price.toFixed(2)}
                        </div>
                        <div style={{ fontSize: 13, fontFamily: MK.mono, color: moveColor(px("DX-Y.NYB").changePct), marginTop: 5 }}>
                          {pctText(px("DX-Y.NYB").changePct)} today
                        </div>
                      </div>
                      <Sparkline data={sp("DX-Y.NYB")} color={moveColor(px("DX-Y.NYB").changePct)} width={130} height={46} id="dxy-hero" />
                    </div>
                    <RangeBar low={px("DX-Y.NYB").low52} high={px("DX-Y.NYB").high52} value={px("DX-Y.NYB").price} label="52-WEEK RANGE" symbol="DX-Y.NYB" />
                  </>
                ) : <Empty text="No live DXY price." />}
              </div>
            </Panel>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <BoardHeading title="MAJOR PAIRS" note="click a pair for its 52-week position and dollar correlation" />
            <div style={grid(215)}>
              {FX_BOARD.map(p => (
                <MarketTile key={p.symbol} symbol={p.symbol} name={p.name} sub={p.banks}
                            prices={prices} spark={sp(p.symbol)}
                            active={detail === p.symbol}
                            onClick={() => setDetail(detail === p.symbol ? null : p.symbol)} />
              ))}
            </div>
          </div>
          <DetailStrip symbol={detail} prices={prices} spark={sp(detail)} hist={hist}
                       note={FX_BOARD.find(p => p.symbol === detail)?.note} />
        </div>
      )}

      {/* ─── COMMODITIES ──────────────────────────────────── */}
      {tab === "commod" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {["Energy", "Metals"].map(g => (
            <div key={g} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <BoardHeading title={g.toUpperCase()} />
              <div style={grid(215)}>
                {COMMODITY_BOARD.filter(c => c.group === g).map(c => (
                  <MarketTile key={c.symbol} symbol={c.symbol} name={c.name} unit={c.unit}
                              prices={prices} spark={sp(c.symbol)}
                              active={detail === c.symbol}
                              onClick={() => setDetail(detail === c.symbol ? null : c.symbol)} />
                ))}
              </div>
            </div>
          ))}
          <PerformancePanel
            title="COMMODITY PERFORMANCE"
            note="today against the quarter — a one-day move can run opposite the trend"
            rows={COMMODITY_BOARD} prices={prices} hist={hist} />
          <DollarCorrelationPanel rows={COMMODITY_BOARD} hist={hist} />
          <DetailStrip symbol={detail} prices={prices} spark={sp(detail)} hist={hist}
                       note={COMMODITY_BOARD.find(c => c.symbol === detail)?.note} />
        </div>
      )}

      {/* ─── SECTORS ──────────────────────────────────────── */}
      {tab === "sectors" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Panel>
            <SectionHeader title="US SECTOR MAP" subtitle="SPDR sector ETFs — today's move" />
            <div style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))", gap: 5 }}>
              {SECTOR_BOARD.map(s => {
                const d = px(s.symbol);
                const st = heatStyle(d?.changePct, 1.5);
                return (
                  <div key={s.symbol} style={{ ...st, border: `1px solid ${MK.border}`, borderRadius: 5, padding: "10px 11px" }}>
                    <div style={{ fontSize: 10, color: MK.ink4, fontFamily: MK.mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, marginTop: 4 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, fontFamily: MK.mono, color: st.color, fontVariantNumeric: "tabular-nums" }}>
                        {pctText(d?.changePct)}
                      </span>
                      <span style={{ fontSize: 9, color: MK.ink5, fontFamily: MK.mono }}>{s.symbol}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel>
            <SectionHeader title="SECTOR ROTATION" subtitle="ranked by today's move — leadership at the top" />
            <div style={{ padding: "12px 18px 16px" }}>
              {(() => {
                const rows = SECTOR_BOARD
                  .map(s => ({ ...s, pct: px(s.symbol)?.changePct }))
                  .filter(s => s.pct != null)
                  .sort((a, b) => b.pct - a.pct);
                if (!rows.length) return <Empty text="No live sector prices yet. Sector ETFs sync with the rest of the price feed." />;
                const max = Math.max(...rows.map(r => Math.abs(r.pct)), 0.4);
                return rows.map(r => <DivergingBar key={r.symbol} label={r.symbol} sub={r.name} value={r.pct} max={max} />);
              })()}
            </div>
          </Panel>

          <div style={grid(215)}>
            {SECTOR_BOARD.map(s => (
              <MarketTile key={s.symbol} symbol={s.symbol} name={s.name} sub={s.symbol}
                          prices={prices} spark={sp(s.symbol)} />
            ))}
          </div>
        </div>
      )}

      {/* ─── RATES ────────────────────────────────────────── */}
      {tab === "rates" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={grid(230)}>
            {RATE_BOARD.map(r => (
              <MarketTile key={r.symbol} symbol={r.symbol} name={r.name} sub={r.sub}
                          prices={prices} spark={sp(r.symbol)} />
            ))}
          </div>

          <Panel>
            <SectionHeader title="YIELD CURVE" subtitle="US Treasury yields by maturity" />
            <div style={{ padding: "18px 20px 14px" }}>
              <YieldCurve prices={prices} />
            </div>
          </Panel>

          <Panel>
            <SectionHeader title="CURVE SPREADS" subtitle="an inverted curve has preceded most post-war US recessions" />
            <div style={{ padding: "12px 18px 16px" }}>
              {(() => {
                const y = s => px(s)?.price;
                const spreads = [
                  { label: "10Y − 3M", a: "^TNX", b: "^IRX", note: "The Fed's own preferred recession signal" },
                  { label: "10Y − 5Y", a: "^TNX", b: "^FVX", note: "Belly-to-long-end slope" },
                ].map(s => ({ ...s, v: y(s.a) != null && y(s.b) != null ? y(s.a) - y(s.b) : null }))
                 .filter(s => s.v != null);
                if (!spreads.length) return <Empty text="No live yield data yet." />;
                return spreads.map(s => (
                  <div key={s.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                                              gap: 12, padding: "11px 0", borderBottom: `1px solid ${MK.hair}` }}>
                    <div>
                      <div style={{ fontSize: 12.5, color: MK.ink2, fontFamily: MK.mono, fontWeight: 700 }}>{s.label}</div>
                      <div style={{ fontSize: 10.5, color: MK.ink5, marginTop: 2 }}>{s.note}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 17, fontWeight: 700, fontFamily: MK.mono,
                                    color: s.v < 0 ? MK.down : MK.up, fontVariantNumeric: "tabular-nums" }}>
                        {s.v >= 0 ? "+" : ""}{s.v.toFixed(3)}%
                      </div>
                      <div style={{ fontSize: 10, color: s.v < 0 ? MK.down : MK.ink4, fontFamily: MK.mono, marginTop: 2 }}>
                        {s.v < 0 ? "INVERTED" : "NORMAL"}
                      </div>
                    </div>
                  </div>
                ));
              })()}
            </div>
          </Panel>
        </div>
      )}

      {/* ─── CRYPTO ───────────────────────────────────────── */}
      {tab === "crypto" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Panel style={{ borderLeft: `3px solid ${MK.amber}` }}>
            <div style={{ padding: "14px 18px" }}>
              <div style={{ fontSize: 10.5, color: MK.amber, fontFamily: MK.mono, letterSpacing: 1.4, marginBottom: 6 }}>
                ⚠ NO PRICE SOURCE CONNECTED
              </div>
              <div style={{ fontSize: 12.5, color: MK.ink3, lineHeight: 1.6, maxWidth: "70ch" }}>
                Crypto has no data feed in Meridian yet — the tiles below are structure only, and
                deliberately show no numbers rather than placeholder ones that would read as real.
                Wiring a source (CoinGecko's public API needs no key) is tracked as its own piece of work.
                Crypto <em>news</em> is already live on the News page via CoinDesk and Cointelegraph.
              </div>
            </div>
          </Panel>
          <div style={grid(215)}>
            {CRYPTO_BOARD.map(c => (
              <div key={c.symbol} style={{
                background: MK.panel, border: `1px dashed ${MK.border2}`, borderRadius: 7,
                padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, opacity: 0.75,
              }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: MK.ink3, fontFamily: MK.mono }}>{c.name}</div>
                  <div style={{ fontSize: 9.5, color: MK.ink5, marginTop: 1 }}>{c.sub}</div>
                </div>
                <div style={{ fontSize: 19, fontWeight: 700, color: MK.ink5, fontFamily: MK.mono }}>—</div>
                <div style={{ fontSize: 9, color: MK.ink5, fontFamily: MK.mono }}>awaiting data source</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── CENTRAL BANKS ────────────────────────────────── */}
      {tab === "banks" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Panel style={{ borderLeft: `3px solid ${MK.amber}` }}>
            <div style={{ padding: "12px 18px", fontSize: 11.5, color: MK.ink3, lineHeight: 1.6 }}>
              Policy rates and meeting dates below are maintained by hand and do not update
              automatically — check against the bank's own release before trading on them.
            </div>
          </Panel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, alignItems: "start" }}>
            {CB_MATRIX.map(cb => (
              <Panel key={cb.bank} style={{ borderTop: `3px solid ${cb.color}` }}>
                <div style={{ padding: 15 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 12 }}>
                    <div>
                      <div style={{ fontFamily: MK.mono, fontWeight: 700, color: MK.ink, fontSize: 13 }}>{cb.bank}</div>
                      <div style={{ fontSize: 10, color: MK.ink4, marginTop: 1 }}>{cb.country}</div>
                    </div>
                    <span style={{ fontSize: 9.5, fontFamily: MK.mono, background: `${cb.color}1e`, color: cb.color,
                                   padding: "3px 8px", borderRadius: 3, whiteSpace: "nowrap" }}>{cb.bias}</span>
                  </div>
                  {[["CURRENT RATE", cb.rate, cb.color], ["NEXT MEETING", cb.nextMeeting, MK.ink2], ["EXPECTATION", cb.expectation, MK.ink2]].map(([l, v, c]) => (
                    <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
                                          padding: "7px 0", borderTop: `1px solid ${MK.hair}` }}>
                      <span style={{ fontSize: 9.5, color: MK.ink5, fontFamily: MK.mono, letterSpacing: 1 }}>{l}</span>
                      <span style={{ fontSize: l === "CURRENT RATE" ? 15 : 12, fontWeight: 700, color: c, fontFamily: MK.mono }}>{v}</span>
                    </div>
                  ))}
                </div>
              </Panel>
            ))}
          </div>

          <Panel>
            <SectionHeader title="POLICY DIVERGENCE" subtitle="where the rate gaps sit, and what they imply for the crosses" />
            <div style={{ padding: "6px 18px 14px" }}>
              {CB_DIVERGENCE.map(d => (
                <div key={d.pair} style={{ display: "grid", gridTemplateColumns: "110px 92px 1fr auto", gap: 12,
                                           alignItems: "center", padding: "11px 0", borderBottom: `1px solid ${MK.hair}` }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: MK.ink2, fontFamily: MK.mono }}>{d.pair}</span>
                  <span style={{ fontSize: 12, color: MK.blue, fontFamily: MK.mono }}>{d.gap}</span>
                  <span style={{ fontSize: 11.5, color: MK.ink3 }}>{d.note}</span>
                  <span style={{ fontSize: 9.5, fontFamily: MK.mono, background: `${d.color}1e`, color: d.color,
                                 padding: "3px 9px", borderRadius: 3, whiteSpace: "nowrap" }}>{d.tag}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

// ─── Page-local sub-components ───────────────────────────────

function Empty({ text }) {
  return <div style={{ fontSize: 12, color: MK.ink4, padding: "14px 0", textAlign: "center" }}>{text}</div>;
}

function MarketMoverRow({ symbol, name, pct, spark }) {
  const col = moveColor(pct, symbol);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", alignItems: "center", gap: 10,
                  padding: "7px 0", borderBottom: `1px solid ${MK.hair}` }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: MK.ink2, fontFamily: MK.mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
        <div style={{ fontSize: 9, color: MK.ink5, fontFamily: MK.mono }}>{symbol}</div>
      </div>
      <Sparkline data={spark} color={col} width={54} height={20} fill={false} id={`mv-${symbol}`} />
      <div style={{ fontSize: 13, fontWeight: 700, fontFamily: MK.mono, color: col, minWidth: 62,
                    textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {pctText(pct)}
      </div>
    </div>
  );
}

/** Expanded row shown under a board when a tile is selected. */
function DetailStrip({ symbol, prices, spark, hist, note }) {
  if (!symbol) return null;
  const d = prices?.[symbol];
  if (!d) return null;
  const col = moveColor(d.changePct, symbol);
  const dxyCorr = hist ? returnsCorrelation(hist[symbol], hist["DX-Y.NYB"]) : null;
  const per = periodChange(spark);

  return (
    <Panel style={{ borderLeft: `3px solid ${col}` }}>
      <SectionHeader title={mkName(symbol).toUpperCase()} subtitle={symbol} />
      <div style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, alignItems: "flex-start" }}>
        <Stat label="LAST" value={formatPrice(d.price, symbol)} color={MK.ink} />
        <Stat label="TODAY" value={pctText(d.changePct)} color={col} />
        {per != null && <Stat label="90-DAY" value={pctText(per)} color={moveColor(per, symbol)} />}
        {d.dayLow != null && d.dayHigh != null && (
          <div><RangeBar low={d.dayLow} high={d.dayHigh} value={d.price} label="DAY RANGE" symbol={symbol} /></div>
        )}
        {d.low52 != null && d.high52 != null && (
          <div><RangeBar low={d.low52} high={d.high52} value={d.price} label="52-WEEK RANGE" symbol={symbol} /></div>
        )}
        {dxyCorr != null && symbol !== "DX-Y.NYB" && (
          <Stat label="90D DXY CORR" value={dxyCorr.toFixed(2)}
                color={dxyCorr < -0.3 ? MK.down : dxyCorr > 0.3 ? MK.up : MK.ink3} />
        )}
      </div>
      {spark && spark.length > 1 && (
        <div style={{ padding: "0 16px 14px" }}>
          <Sparkline data={spark} color={col} width={760} height={70} id={`detail-${symbol}`} />
          <div style={{ fontSize: 9.5, color: MK.ink5, fontFamily: MK.mono, marginTop: 4 }}>
            90 days of stored closes
          </div>
        </div>
      )}
      {note && (
        <div style={{ padding: "0 16px 16px", fontSize: 12, color: MK.ink3, lineHeight: 1.6, maxWidth: "78ch" }}>
          {note}
        </div>
      )}
    </Panel>
  );
}

/**
 * Today's move beside the 90-day move, both ranked.
 * The pairing is the point: a name up strongly today can still be the worst
 * thing on the board over the quarter, and one column alone hides that.
 */
function PerformancePanel({ title, note, rows, prices, hist }) {
  const build = key => rows
    .map(r => ({
      symbol: r.symbol,
      name: r.name,
      v: key === "day" ? prices?.[r.symbol]?.changePct : periodChange(hist?.[r.symbol]),
    }))
    .filter(r => r.v != null && !Number.isNaN(r.v))
    .sort((a, b) => b.v - a.v);

  const cols = [
    { key: "day", label: "TODAY", sub: "since previous close" },
    { key: "period", label: "90 DAYS", sub: "from stored history" },
  ].map(c => ({ ...c, data: build(c.key) }));

  if (cols.every(c => !c.data.length)) return null;

  return (
    <Panel>
      <SectionHeader title={title} subtitle={note} />
      <div style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 18, alignItems: "start" }}>
        {cols.map(c => (
          <div key={c.key}>
            <BoardHeading title={c.label} note={c.sub} />
            <div style={{ marginTop: 8 }}>
              {c.data.length
                ? (() => {
                    const max = Math.max(...c.data.map(r => Math.abs(r.v)), 0.4);
                    return c.data.map(r => (
                      <DivergingBar key={r.symbol} label={r.symbol} sub={r.name} value={r.v} max={max} />
                    ));
                  })()
                : <Empty text="No stored history yet — run a sync to populate." />}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/**
 * Real 90-day correlation of daily returns against the dollar index.
 * The page this replaced carried hand-written correlation figures that never
 * moved; these are computed from the same stored closes the sparklines use.
 */
function DollarCorrelationPanel({ rows, hist }) {
  const data = rows
    .map(r => ({ ...r, c: returnsCorrelation(hist?.[r.symbol], hist?.["DX-Y.NYB"]) }))
    .filter(r => r.c != null)
    .sort((a, b) => a.c - b.c);
  if (!data.length) return null;

  return (
    <Panel>
      <SectionHeader title="DOLLAR CORRELATION"
                     subtitle="90-day correlation of daily returns against DXY — computed, not assumed" />
      <div style={{ padding: "12px 18px 16px" }}>
        {data.map(r => (
          <DivergingBar key={r.symbol} label={r.symbol} sub={r.name} value={r.c} max={1} unit="" />
        ))}
        <div style={{ fontSize: 10, color: MK.ink5, marginTop: 10, lineHeight: 1.5 }}>
          −1 moves exactly opposite the dollar, +1 exactly with it, 0 no linear relationship.
          Correlation is not causation and it drifts — a commodity with its own supply story
          can decouple from the dollar for months.
        </div>
      </div>
    </Panel>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: MK.ink5, fontFamily: MK.mono, letterSpacing: 1, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color, fontFamily: MK.mono, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

/** Yields plotted against maturity — the curve's actual shape, not a table of it. */
function YieldCurve({ prices }) {
  const pts = RATE_BOARD
    .map(r => ({ ...r, y: prices?.[r.symbol]?.price }))
    .filter(p => p.y != null && !Number.isNaN(p.y));
  if (pts.length < 2) return <Empty text="Not enough live yield data to plot the curve." />;

  const W = 620, H = 160, PAD = { l: 46, r: 20, t: 26, b: 28 };
  const ys = pts.map(p => p.y);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.45 || 0.2;
  const yMin = lo - pad, yMax = hi + pad;
  // Maturity is log-spaced: 3M to 10Y is two orders of magnitude, and a linear
  // axis would crush the short end into the y-axis.
  const xs = pts.map(p => Math.log(p.years));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const px = i => PAD.l + ((xs[i] - xMin) / (xMax - xMin || 1)) * (W - PAD.l - PAD.r);
  const py = v => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b);
  const line = pts.map((p, i) => `${px(i).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const inverted = pts[pts.length - 1].y < pts[0].y;
  const col = inverted ? MK.down : MK.up;

  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 420, height: "auto", display: "block" }}>
        {/* Recessive gridlines — present for reading values, never competing with the data. */}
        {[0, 0.5, 1].map(t => {
          const v = yMin + t * (yMax - yMin);
          return (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={py(v)} y2={py(v)} stroke={MK.border} strokeWidth="1" />
              <text x={PAD.l - 8} y={py(v) + 3.5} textAnchor="end" fill={MK.ink5} fontSize="9.5" fontFamily="monospace">
                {v.toFixed(2)}
              </text>
            </g>
          );
        })}
        <polyline points={line} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) => (
          <g key={p.symbol}>
            {/* 2px surface ring keeps the marker legible where it sits on the line. */}
            <circle cx={px(i)} cy={py(p.y)} r="4.5" fill={col} stroke={MK.panel} strokeWidth="2" />
            {/* End labels are anchored inward: centred on the first point a
                label overlaps the y-axis tick text, and on the last it runs off
                the right edge. Near the top it also drops below the marker. */}
            <text x={px(i) + (i === 0 ? 8 : i === pts.length - 1 ? -8 : 0)}
                  y={py(p.y) < PAD.t + 18 ? py(p.y) + 20 : py(p.y) - 12}
                  textAnchor={i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}
                  fill={MK.ink2} fontSize="11" fontFamily="monospace" fontWeight="700">
              {p.y.toFixed(2)}%
            </text>
            <text x={px(i)} y={H - 8} textAnchor="middle" fill={MK.ink4} fontSize="9.5" fontFamily="monospace">
              {p.years < 1 ? `${p.years * 12}M` : `${p.years}Y`}
            </text>
          </g>
        ))}
      </svg>
      <div style={{ fontSize: 11, color: inverted ? MK.down : MK.ink4, fontFamily: MK.mono, marginTop: 8 }}>
        {inverted
          ? "INVERTED — the long end yields less than the short end"
          : "Upward sloping — the conventional shape"}
      </div>
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

function ResearchStat({ label, value, color = "#c8d6e8" }) {
  return (
    <div style={{ background: "#0d1117", border: "1px solid #1a1f2e", borderRadius: 5, padding: "10px 12px" }}>
      <div style={{ fontSize: 9, color: "#4a6080", fontFamily: "monospace", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color, fontFamily: "monospace", marginTop: 3 }}>{value ?? "\u2014"}</div>
    </div>
  );
}

const RATING_COLORS = { strongBuy: "#00d4aa", buy: "#4ade80", hold: "#ffa502", sell: "#ff8c42", strongSell: "#ff4757" };
const RATING_LABELS = { strongBuy: "Strong Buy", buy: "Buy", hold: "Hold", sell: "Sell", strongSell: "Strong Sell" };

function ResearchOverviewTab({ symbol, name, data, summary, summaryLoading, levels }) {
  const s = summary && !summary.error ? summary : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {!data && (
        <Panel><div style={{ padding: 16, fontSize: 12, color: "#7a8ba0" }}>No live price for <span style={{ color: "#c8d6e8", fontFamily: "monospace" }}>{symbol}</span> in the terminal feed. Fundamentals below still load independently — you can also add a price link in Settings.</div></Panel>
      )}

      {(s?.dates?.nextEarnings || s?.dates?.exDividendDate) && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {s.dates.nextEarnings && (
            <div style={{ flex: 1, minWidth: 200, background: "#0d1117", border: "1px solid #3d8bff30", borderTop: "2px solid #3d8bff", borderRadius: 6, padding: "12px 16px" }}>
              <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1 }}>NEXT EARNINGS</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#3d8bff", fontFamily: "monospace", marginTop: 4 }}>
                {s.dates.nextEarnings}{s.dates.nextEarningsLate && s.dates.nextEarningsLate !== s.dates.nextEarnings ? ` \u2013 ${s.dates.nextEarningsLate}` : ""}
              </div>
            </div>
          )}
          {s.dates.exDividendDate && (
            <div style={{ flex: 1, minWidth: 200, background: "#0d1117", border: "1px solid #a855f730", borderTop: "2px solid #a855f7", borderRadius: 6, padding: "12px 16px" }}>
              <div style={{ fontSize: 10, color: "#4a6080", fontFamily: "monospace", letterSpacing: 1 }}>EX-DIVIDEND DATE</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#a855f7", fontFamily: "monospace", marginTop: 4 }}>{s.dates.exDividendDate}</div>
            </div>
          )}
        </div>
      )}

      <Panel>
        <SectionHeader title="KEY STATS" subtitle={summaryLoading ? "Loading\u2026" : s ? `${s.sector || s.industry ? [s.sector, s.industry].filter(Boolean).join(" \u00b7 ") : "Fundamentals"}${s.country ? ` \u00b7 ${s.country}` : ""}` : "No fundamentals data for this symbol"} />
        {s ? (
          <div style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
            <ResearchStat label="MARKET CAP" value={s.marketCap ? formatBigNumber(s.marketCap) : null} />
            <ResearchStat label="P/E (TTM)" value={s.pe ? s.pe.toFixed(1) : null} />
            <ResearchStat label="FORWARD P/E" value={s.forwardPe ? s.forwardPe.toFixed(1) : null} />
            <ResearchStat label="DIV YIELD" value={s.dividendYield ? `${(s.dividendYield * 100).toFixed(2)}%` : null} />
            <ResearchStat label="BETA" value={s.beta ? s.beta.toFixed(2) : null} />
            <ResearchStat label="52W RANGE" value={s.low52 && s.high52 ? `${formatPrice(s.low52, symbol)} \u2013 ${formatPrice(s.high52, symbol)}` : null} />
            <ResearchStat label="AVG VOLUME" value={s.avgVolume ? formatBigNumber(s.avgVolume) : null} />
            <ResearchStat label="EXPENSE RATIO" value={s.expenseRatio ? `${(s.expenseRatio * 100).toFixed(2)}%` : null} />
          </div>
        ) : !summaryLoading && (
          <div style={{ padding: 16, fontSize: 12, color: "#4a6080" }}>
            {summary?.error ? `Could not fetch fundamentals: ${summary.error}` : "No fundamentals available \u2014 common for indices, FX pairs and futures, which don't carry company financials."}
          </div>
        )}
      </Panel>

      {levels && (
        <Panel>
          <SectionHeader title="APPROXIMATE KEY LEVELS" subtitle="Derived from current price — reference only, not technical analysis" />
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
    </div>
  );
}

function ResearchAnalystTab({ symbol, price, summary, summaryLoading }) {
  const s = summary && !summary.error ? summary : null;
  const a = s?.analyst;
  const trend = s?.ratingTrend;
  const trendTotal = trend ? trend.strongBuy + trend.buy + trend.hold + trend.sell + trend.strongSell : 0;

  if (summaryLoading) return <Panel><div style={{ padding: 24, textAlign: "center", color: "#4a6080", fontSize: 12 }}>Loading…</div></Panel>;
  if (!a && !trend && !s?.upgrades?.length && !s?.earningsHistory?.length) {
    return <Panel><div style={{ padding: 16, fontSize: 12, color: "#4a6080" }}>No analyst coverage data for {symbol} — common for indices, FX, commodities and many funds, which aren't individually rated.</div></Panel>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {a && (
        <Panel>
          <SectionHeader title="CONSENSUS PRICE TARGET" subtitle={a.numberOfAnalysts ? `${a.numberOfAnalysts} analyst${a.numberOfAnalysts === 1 ? "" : "s"}` : undefined} />
          <div style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
            <ResearchStat label="LOW" value={a.targetLow ? formatPrice(a.targetLow, symbol) : null} color="#ff4757" />
            <ResearchStat label="MEAN" value={a.targetMean ? formatPrice(a.targetMean, symbol) : null} color="#e8f0fc" />
            <ResearchStat label="MEDIAN" value={a.targetMedian ? formatPrice(a.targetMedian, symbol) : null} />
            <ResearchStat label="HIGH" value={a.targetHigh ? formatPrice(a.targetHigh, symbol) : null} color="#00d4aa" />
          </div>
          {price && a.targetMean && (
            <div style={{ padding: "0 14px 14px", fontSize: 12, color: a.targetMean >= price ? "#00d4aa" : "#ff4757" }}>
              Mean target implies {a.targetMean >= price ? "+" : ""}{(((a.targetMean - price) / price) * 100).toFixed(1)}% vs current price
              {a.recommendationKey && <span style={{ color: "#7a8ba0" }}> · consensus: <span style={{ fontFamily: "monospace", textTransform: "capitalize" }}>{a.recommendationKey.replace(/_/g, " ")}</span></span>}
            </div>
          )}
        </Panel>
      )}

      {trend && trendTotal > 0 && (
        <Panel>
          <SectionHeader title="RATING BREAKDOWN" subtitle="Current analyst ratings" />
          <div style={{ padding: 14 }}>
            <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", marginBottom: 10 }}>
              {["strongBuy", "buy", "hold", "sell", "strongSell"].map(k => trend[k] > 0 && (
                <div key={k} style={{ width: `${(trend[k] / trendTotal) * 100}%`, background: RATING_COLORS[k] }} title={`${RATING_LABELS[k]}: ${trend[k]}`} />
              ))}
            </div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {["strongBuy", "buy", "hold", "sell", "strongSell"].map(k => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: RATING_COLORS[k] }} />
                  <span style={{ fontSize: 11, color: "#7a8ba0" }}>{RATING_LABELS[k]}</span>
                  <span style={{ fontSize: 11, color: "#c8d6e8", fontFamily: "monospace" }}>{trend[k]}</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {s?.upgrades?.length > 0 && (
        <Panel>
          <SectionHeader title="RECENT RATING CHANGES" />
          <div style={{ padding: "4px 0" }}>
            {s.upgrades.map((u, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 16px", borderBottom: i < s.upgrades.length - 1 ? "1px solid #12161f" : "none" }}>
                <div>
                  <span style={{ fontSize: 12, color: "#c8d6e8" }}>{u.firm || "Unknown firm"}</span>
                  {u.fromGrade && u.toGrade && u.fromGrade !== u.toGrade && (
                    <span style={{ fontSize: 11, color: "#4a6080" }}> · {u.fromGrade} → {u.toGrade}</span>
                  )}
                  {(!u.fromGrade || u.fromGrade === u.toGrade) && u.toGrade && (
                    <span style={{ fontSize: 11, color: "#4a6080" }}> · {u.toGrade}</span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {u.action && <span style={{ fontSize: 10, textTransform: "uppercase", fontFamily: "monospace", color: u.action === "up" ? "#00d4aa" : u.action === "down" ? "#ff4757" : "#7a8ba0" }}>{u.action}</span>}
                  <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace" }}>{u.date || "\u2014"}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {s?.earningsHistory?.length > 0 && (
        <Panel>
          <SectionHeader title="EARNINGS TRACK RECORD" subtitle="Actual vs. estimate, last 4 quarters" />
          <div style={{ padding: "4px 0" }}>
            {s.earningsHistory.map((e, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 16px", borderBottom: i < s.earningsHistory.length - 1 ? "1px solid #12161f" : "none" }}>
                <span style={{ fontSize: 12, color: "#c8d6e8", fontFamily: "monospace" }}>{e.quarter || "\u2014"}</span>
                <div style={{ display: "flex", gap: 14 }}>
                  <span style={{ fontSize: 11, color: "#7a8ba0" }}>Est {e.epsEstimate != null ? e.epsEstimate.toFixed(2) : "\u2014"}</span>
                  <span style={{ fontSize: 11, color: "#c8d6e8" }}>Actual {e.epsActual != null ? e.epsActual.toFixed(2) : "\u2014"}</span>
                  <span style={{ fontSize: 11, fontFamily: "monospace", color: e.surprisePercent > 0 ? "#00d4aa" : e.surprisePercent < 0 ? "#ff4757" : "#7a8ba0" }}>
                    {e.surprisePercent != null ? `${e.surprisePercent >= 0 ? "+" : ""}${e.surprisePercent.toFixed(1)}%` : "\u2014"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function ResearchNewsTab({ symbol, name, newsData, newsLoading }) {
  if (newsLoading) return <Panel><div style={{ padding: 24, textAlign: "center", color: "#4a6080", fontSize: 12 }}>Searching feed and live sources for {name}…</div></Panel>;
  const stories = newsData?.news ?? [];
  if (!stories.length) {
    return <Panel><div style={{ padding: 16, fontSize: 12, color: "#4a6080" }}>No news found for {name}. Try a broader company name in the search box above.</div></Panel>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace" }}>
        {newsData.feedCount} from your tracked feed · {newsData.liveCount} from live search
      </div>
      {stories.map(story => {
        const sentiment = newsSentimentMeta(story.sentiment);
        return (
          <Panel key={story.guid} style={{ borderLeft: `3px solid ${sentiment.color}` }}>
            <div style={{ padding: "12px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, fontWeight: 700, fontFamily: "monospace", background: story.live ? "#3d8bff18" : "#00d4aa18", color: story.live ? "#3d8bff" : "#00d4aa", padding: "2px 7px", borderRadius: 3 }}>
                  {story.live ? "LIVE SEARCH" : "TRACKED FEED"}
                </span>
                <span style={{ fontSize: 10, fontWeight: 700, background: `${sentiment.color}18`, color: sentiment.color, padding: "2px 7px", borderRadius: 3, fontFamily: "monospace" }}>{sentiment.label}</span>
                <span style={{ fontSize: 11, color: "#3a4558" }}>{story.source}</span>
                <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace" }}>{newsRelativeTime(story.published)}</span>
              </div>
              <div style={{ fontSize: 14, color: "#c8d6e8", lineHeight: 1.4 }}>{story.title}</div>
              {story.summary && <div style={{ fontSize: 12, color: "#7a8ba0", marginTop: 5, lineHeight: 1.5 }}>{story.summary}</div>}
              {story.url && (
                <a href={story.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#3d8bff", textDecoration: "none", marginTop: 6, display: "inline-block" }}>
                  Read full story ↗
                </a>
              )}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

function ResearchFilingsTab({ symbol, filingsData, insidersData, filingsLoading }) {
  if (filingsLoading) return <Panel><div style={{ padding: 24, textAlign: "center", color: "#4a6080", fontSize: 12 }}>Loading SEC data…</div></Panel>;
  if (filingsData?.error) {
    return <Panel><div style={{ padding: 16, fontSize: 12, color: "#4a6080" }}>{filingsData.error} SEC EDGAR only covers US-listed tickers, so this is expected for LSE and other non-US symbols.</div></Panel>;
  }
  const filings = filingsData?.filings ?? [];
  const insiders = insidersData?.filings ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel>
        <SectionHeader title="SEC FILINGS" subtitle={filingsData?.company ? `${filingsData.company} \u00b7 CIK ${filingsData.cik}` : undefined} />
        {filings.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: "#4a6080" }}>No filings found.</div>
        ) : (
          <div style={{ padding: "4px 0" }}>
            {filings.map((f, i) => (
              <div key={f.accession} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 16px", borderBottom: i < filings.length - 1 ? "1px solid #12161f" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, fontFamily: "monospace", background: "#1a2535", color: "#7a8ba0", padding: "2px 7px", borderRadius: 3 }}>{f.form}</span>
                  <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace" }}>{f.date}</span>
                </div>
                <a href={f.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "#3d8bff", textDecoration: "none" }}>View filing ↗</a>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel>
        <SectionHeader title="INSIDER ACTIVITY" subtitle="Form 4 filings — filing index only, not parsed transaction detail" />
        {insiders.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: "#4a6080" }}>No Form 4 filings on record.</div>
        ) : (
          <div style={{ padding: "4px 0" }}>
            {insiders.map((f, i) => (
              <div key={f.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 16px", borderBottom: i < insiders.length - 1 ? "1px solid #12161f" : "none" }}>
                <span style={{ fontSize: 12, color: "#c8d6e8" }}>{f.filer || symbol}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace" }}>{f.date}</span>
                  <a href={f.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "#3d8bff", textDecoration: "none" }}>View ↗</a>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function ResearchPage({ prices }) {
  const trackedSymbols = Object.keys(DISPLAY_NAMES);
  const [query, setQuery] = useState("^GSPC");
  const [symbol, setSymbol] = useState("^GSPC");
  const [companyName, setCompanyName] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [tab, setTab] = useState("overview");

  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const [newsData, setNewsData] = useState(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const newsCache = useRef({});

  const [filingsData, setFilingsData] = useState(null);
  const [insidersData, setInsidersData] = useState(null);
  const [filingsLoading, setFilingsLoading] = useState(false);
  const filingsCache = useRef({});

  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  const data = prices?.[symbol];
  const name = companyName || DISPLAY_NAMES[symbol] || symbol;
  const isTracked = trackedSymbols.includes(symbol);
  const price = data?.price ?? (summary && !summary.error ? summary.price : null);
  const levels = price ? { r2: price * 1.05, r1: price * 1.02, s1: price * 0.98, s2: price * 0.95 } : null;

  // Company-name autocomplete. Debounced so every keystroke doesn't fire a
  // request, and skipped once the query already matches the selected symbol.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || q === symbol) { setSuggestions([]); return; }
    const t = setTimeout(() => {
      fetch(`${API}/search?q=${encodeURIComponent(q)}`).then(r => r.json())
        .then(d => setSuggestions(d.results ?? []))
        .catch(() => setSuggestions([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query, symbol]);

  const selectSymbol = (sym, nm) => {
    setSymbol(sym); setQuery(sym); setCompanyName(nm || DISPLAY_NAMES[sym] || null);
    setSuggestions([]); setAiText("");
  };

  const runSearch = () => {
    const s = query.trim();
    if (!s) return;
    selectSymbol(s.toUpperCase(), null);
  };

  // Overview + Analyst tabs share one fetch — same underlying quoteSummary call.
  useEffect(() => {
    let cancelled = false;
    setSummaryLoading(true);
    fetch(`${API}/quote?symbol=${encodeURIComponent(symbol)}`).then(r => r.json())
      .then(d => {
        if (cancelled) return;
        setSummary(d);
        if (d?.name && !d.error) setCompanyName(d.name);
      })
      .catch(() => { if (!cancelled) setSummary(null); })
      .finally(() => { if (!cancelled) setSummaryLoading(false); });
    return () => { cancelled = true; };
  }, [symbol]);

  // News tab: lazy-loaded on first visit per symbol, then cached.
  useEffect(() => {
    if (tab !== "news") return;
    if (newsCache.current[symbol]) { setNewsData(newsCache.current[symbol]); return; }
    setNewsLoading(true);
    const params = new URLSearchParams({ symbol, query: name, limit: "30" });
    fetch(`${API}/research/news?${params}`).then(r => r.json())
      .then(d => { newsCache.current[symbol] = d; setNewsData(d); })
      .catch(() => setNewsData({ news: [], feedCount: 0, liveCount: 0 }))
      .finally(() => setNewsLoading(false));
  }, [tab, symbol, name]);

  // Filings tab: same lazy-load-and-cache pattern.
  useEffect(() => {
    if (tab !== "filings") return;
    if (filingsCache.current[symbol]) {
      const c = filingsCache.current[symbol];
      setFilingsData(c.filings); setInsidersData(c.insiders);
      return;
    }
    setFilingsLoading(true);
    Promise.all([
      fetch(`${API}/filings?symbol=${encodeURIComponent(symbol)}&type=`).then(r => r.json()),
      fetch(`${API}/insiders?symbol=${encodeURIComponent(symbol)}`).then(r => r.json()),
    ]).then(([f, i]) => {
      filingsCache.current[symbol] = { filings: f, insiders: i };
      setFilingsData(f); setInsidersData(i);
    }).catch(() => {
      setFilingsData({ error: "Could not reach the server." }); setInsidersData(null);
    }).finally(() => setFilingsLoading(false));
  }, [tab, symbol]);

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
  const tabs = [["overview", "Overview"], ["analyst", "Analyst"], ["news", "News"], ["filings", "Filings"], ["ai", "AI Note"]];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel>
        <SectionHeader title="ASSET RESEARCH" subtitle="Look up any ticker or company — live fundamentals, analyst view, news, filings" />
        <div style={{ padding: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", position: "relative" }}>
          <div style={{ flex: 1, minWidth: 220, position: "relative" }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && runSearch()}
              placeholder="Company name or symbol e.g. Apple, AAPL, ^GSPC, GC=F"
              style={{ ...inputStyle, width: "100%" }}
            />
            {suggestions.length > 0 && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "#0d1117", border: "1px solid #1a2535", borderRadius: 4, zIndex: 10, maxHeight: 260, overflowY: "auto" }}>
                {suggestions.map(r => (
                  <div key={r.symbol} onMouseDown={() => selectSymbol(r.symbol, r.name)} style={{ padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid #12161f", display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <span style={{ fontSize: 12, color: "#c8d6e8" }}>{r.name}</span>
                    <span style={{ fontSize: 11, color: "#4a6080", fontFamily: "monospace", flexShrink: 0 }}>{r.symbol}{r.exchange ? ` \u00b7 ${r.exchange}` : ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={runSearch} style={{ background: "#3d8bff20", border: "1px solid #3d8bff40", color: "#3d8bff", padding: "9px 18px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace", fontSize: 12 }}>ANALYSE</button>
        </div>
        <div style={{ padding: "0 14px 12px", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {trackedSymbols.slice(0, 10).map(s => (
            <button key={s} onClick={() => selectSymbol(s, null)} style={{ background: symbol === s ? "#00d4aa20" : "#0d1117", border: `1px solid ${symbol === s ? "#00d4aa40" : "#1a2535"}`, color: symbol === s ? "#00d4aa" : "#7a8ba0", padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace", fontSize: 10 }}>{DISPLAY_NAMES[s] || s}</button>
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

      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid #1a1f2e" }}>
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            background: "transparent", border: "none",
            borderBottom: tab === id ? "2px solid #00d4aa" : "2px solid transparent",
            color: tab === id ? "#00d4aa" : "#4a6080",
            padding: "8px 14px", cursor: "pointer", fontFamily: "monospace",
            fontSize: 11, letterSpacing: 1, textTransform: "uppercase",
          }}>{label}</button>
        ))}
      </div>

      {tab === "overview" && <ResearchOverviewTab symbol={symbol} name={name} data={data} summary={summary} summaryLoading={summaryLoading} levels={levels} />}
      {tab === "analyst" && <ResearchAnalystTab symbol={symbol} price={price} summary={summary} summaryLoading={summaryLoading} />}
      {tab === "news" && <ResearchNewsTab symbol={symbol} name={name} newsData={newsData} newsLoading={newsLoading} />}
      {tab === "filings" && <ResearchFilingsTab symbol={symbol} filingsData={filingsData} insidersData={insidersData} filingsLoading={filingsLoading} />}
      {tab === "ai" && (
        <Panel>
          <SectionHeader title="AI RESEARCH NOTE" subtitle="Bull / bear / base case" action={aiLoading ? "THINKING..." : "GENERATE"} onAction={runAI} />
          <div style={{ padding: 16 }}>
            {aiText
              ? <div style={{ fontSize: 12.5, lineHeight: 1.8, color: "#b8c6da", whiteSpace: "pre-wrap", fontFamily: "'Courier New', monospace" }}>{aiText}</div>
              : <div style={{ fontSize: 12, color: "#4a6080" }}>Click GENERATE for a structured bull / bear / base research note on {name}. Requires a Gemini API key (Settings).</div>}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ============================================================
// RISK PAGE
// New in v2 — reads live from the local risk engine at :3001/risk.
// Built to match the existing Panel / SectionHeader / GaugeBar conventions
// used elsewhere in this file, so it doesn't look bolted on.
// ============================================================

function RiskMetric({ label, value, sub, color = "#c8d6e8", align = "left" }) {
  const centered = align === "center";
  return (
    <div style={{
      padding: "18px 22px", borderRight: "1px solid #1a1f2e",
      ...(centered && { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }),
    }}>
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

// Shared by the header row and every HoldingRow so the columns always line
// up. NAME/SYMBOL gets the lion's share since a fund's full name ("Fidelity
// Index World Fund") plus ticker and market otherwise wraps to two lines;
// the numeric columns are right-aligned and only as wide as their content
// needs, which is what removes the dead space that used to sit in front of
// the "···" menu.
const HOLDINGS_GRID_COLUMNS = "22px minmax(280px, 2.6fr) 0.5fr 0.65fr 0.65fr 0.85fr 0.95fr 0.6fr 0.5fr 44px";
const numCell = { textAlign: "right" };

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
        gridTemplateColumns: HOLDINGS_GRID_COLUMNS,
        alignItems: "center", padding: "14px 20px", gap: 8,
        fontSize: 14, fontFamily: "monospace", cursor: "pointer",
      }}>
        <span style={{ color: "#4a6080", fontSize: 11, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▶</span>

        <div style={{ minWidth: 0, overflow: "hidden" }}>
          <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
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
          </div>
          <div style={{ fontSize: 11, color: "#4a6080", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {p.symbol}{p.exchange ? ` | ${p.exchange}` : ""}
          </div>
        </div>

        {editing ? (
          <input style={{ ...fieldStyle("100%"), padding: "5px 7px" }} value={qty} onClick={e => e.stopPropagation()} onChange={e => setQty(e.target.value)} />
        ) : (
          <div style={{ ...numCell, color: "#7a8ba0" }}>{p.qty}</div>
        )}

        {editing ? (
          <input style={{ ...fieldStyle("100%"), padding: "5px 7px" }} value={avg} onClick={e => e.stopPropagation()} onChange={e => setAvg(e.target.value)} />
        ) : (
          <div style={{ ...numCell, color: "#7a8ba0" }}>{ccySymbol(p.currency)}{p.avgPrice?.toFixed(2)}</div>
        )}

        <div style={{ ...numCell, color: "#c8d6e8" }}>
          {ccySymbol(p.currency)}{p.price != null ? p.price.toFixed(2) : "—"}
          {p.priceSource === "ft" && (
            <span title={`Yahoo has no data for this fund — priced via FT fallback${p.priceAsOf ? `, as of ${p.priceAsOf}` : ""}`}
              style={{ marginLeft: 4, fontSize: 9, color: "#a855f7", border: "1px solid #a855f740", borderRadius: 2, padding: "0 3px" }}>FT</span>
          )}
        </div>
        <div style={{ ...numCell, color: "#c8d6e8" }}>£{p.value?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        <div style={{ ...numCell, color: pnlColor }}>
          {p.pnl >= 0 ? "+" : ""}£{Math.abs(p.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          <div style={{ fontSize: 11, marginTop: 2 }}>{p.pnlPct >= 0 ? "+" : ""}{p.pnlPct?.toFixed(1)}%</div>
        </div>
        <div style={{ ...numCell, color: dayColor }}>{(p.dayChangePct ?? 0) >= 0 ? "+" : ""}{p.dayChangePct?.toFixed(2)}%</div>
        <div style={{ ...numCell, color: "#7a8ba0" }}>{p.weight?.toFixed(1)}%</div>

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

function CashTile({ cashAccounts, cash, onChanged, centered = false }) {
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
    <div style={{ padding: "10px 22px 13px", textAlign: centered ? "center" : "left" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: centered ? "center" : "space-between", gap: 6 }}>
        <div style={{ fontSize: 11, color: "#4a6080", letterSpacing: 1 }}>CASH</div>
        {!editing && (
          <button onClick={() => { setAmount(cash); setEditing(true); }} title="Edit cash balance"
            style={{ background: "transparent", border: "none", color: "#4a6080", fontSize: 13, cursor: "pointer", padding: 0 }}>✎</button>
        )}
      </div>
      {editing ? (
        <div style={{ display: "flex", gap: 6, marginTop: 5, alignItems: "center", justifyContent: centered ? "center" : "flex-start" }}>
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
  const [namesBusy, setNamesBusy] = useState(false);
  const [namesMsg, setNamesMsg] = useState(null);

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

  async function refreshNames() {
    setNamesBusy(true);
    setNamesMsg(null);
    try {
      const res = await fetch(`${API}/holdings/refresh-names`, { method: "POST" });
      const d = await res.json();
      // d.message only comes back when there was nothing to target at all —
      // otherwise always report what happened, even a 0-resolved run with
      // failures (checking `d.resolved` truthily would wrongly show the
      // "nothing to target" message here since 0 is falsy).
      setNamesMsg(d.message ?? `Resolved ${d.resolved} name${d.resolved === 1 ? "" : "s"}${d.failed?.length ? ` — couldn't resolve ${d.failed.join(", ")}` : ""}.`);
      await load();
    } catch {
      setNamesMsg("Could not reach the server.");
    } finally {
      setNamesBusy(false);
    }
  }

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
          <RiskMetric align="center" label="TOTAL VALUE" value={`£${data.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
          <div style={{ borderRight: "1px solid #1a1f2e", display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={{ padding: "13px 22px 10px", borderBottom: "1px solid #1a1f2e", textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "#4a6080", letterSpacing: 1, marginBottom: 5 }}>INVESTED</div>
              <div style={{ fontSize: 23, fontWeight: 700, color: "#c8d6e8", fontFamily: "monospace" }}>
                £{data.invested.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
            </div>
            <CashTile centered cashAccounts={data.cashAccounts} cash={data.cash} onChanged={load} />
          </div>
          <RiskMetric align="center" label="TOTAL P&L" value={`${data.pnl >= 0 ? "+" : ""}£${Math.abs(data.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
            sub={`${data.pnlPct >= 0 ? "+" : ""}${data.pnlPct.toFixed(1)}%`}
            color={data.pnl >= 0 ? "#00d4aa" : "#ff4757"} />
          <RiskMetric align="center" label="TODAY" value={`${data.dayChange >= 0 ? "+" : ""}£${Math.abs(data.dayChange).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
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
          action="+ ADD POSITION" onAction={() => setAddOpen(true)}
          extra={
            <button onClick={refreshNames} disabled={namesBusy} title="Look up a proper name and listing venue for any holding that's still showing its raw ticker"
              style={{
                background: "transparent", border: "1px solid #1a2535",
                color: namesBusy ? "#3a4558" : "#4a6080", fontSize: 12, padding: "5px 12px",
                borderRadius: 3, cursor: namesBusy ? "default" : "pointer", fontFamily: "monospace",
              }}>{namesBusy ? "RESOLVING…" : "↻ REFRESH NAMES"}</button>
          } />
        {namesMsg && (
          <div style={{ padding: "0 20px 10px", fontSize: 11, color: "#7a8ba0" }}>{namesMsg}</div>
        )}
        <div style={{
          display: "grid",
          gridTemplateColumns: HOLDINGS_GRID_COLUMNS,
          padding: "11px 20px", borderBottom: "1px solid #1a1f2e", gap: 8,
          fontSize: 11, color: "#4a6080", letterSpacing: 1,
        }}>
          <div /><div>NAME / SYMBOL</div>
          <div style={numCell}>QTY</div><div style={numCell}>AVG</div><div style={numCell}>PRICE</div>
          <div style={numCell}>VALUE</div><div style={numCell}>P&L</div><div style={numCell}>TODAY</div><div style={numCell}>WEIGHT</div><div />
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
        <div style={{ padding: "18px 22px", minHeight: 316, display: "flex", flexDirection: "column", justifyContent: "center" }}>
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
        <div style={{ padding: "18px 22px", minHeight: 280 }}>
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
        PHASE {["macro","research","portfolio","watchlist","screener","markets","calendar","news"].indexOf(title.toLowerCase().split(" ")[0]) + 3} — IN DEVELOPMENT
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
  const [activePage, setActivePage] = useState("changed");
  const { prices, feed, pulseCount, poll } = useMarketData();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("meridian_gemini_key") || GEMINI_API_KEY);

  // A key saved before news scoring existed lives only in the browser — hand
  // it to the backend once on load so ranking works without re-saving it.
  useEffect(() => { syncKeyToServerIfNeeded(); }, []);

  const pageDescriptions = {
    research: "Deep-dive asset analysis — candlestick charting, technicals, fundamentals, positioning, AI bull/bear/base case",
    portfolio: "Risk console — holdings, exposure breakdown, correlation clustering, heatmap, thesis cards, AI health check",
    watchlist: "Idea pipeline — 5 tiered lists, setup cards, alert flags, AI daily watchlist monitor",
    screener: "Opportunity scanner — equities/FX/commodities scans, strategy presets, composite scoring, AI setup commentary",
    markets: "Every quoted market — indices, FX, commodities, sectors, rates, crypto and central bank policy, with cross-asset ranking and AI session read",
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
          <PulseIndicator pulseCount={pulseCount} feed={feed} />
          <div style={{ fontSize: 11, color: "#3a4558", fontFamily: "monospace" }}>
            {new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
          </div>
        </div>
      </div>

      {/* Ticker tape */}
      <TickerTape prices={prices} feed={feed} />

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
          {activePage === "changed" && (
            <WhatChangedPage prices={prices} pulseCount={pulseCount} poll={poll} feed={feed} />
          )}
          {activePage === "risk" && (
            <RiskPage />
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
          {activePage === "markets" && (
            <MarketsPage prices={prices} />
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
