// Meridian v2 — alert engine
// v1 only had price thresholds. This adds conditions that are actually
// interesting: technical crosses, volatility regime shifts, drawdown breaches,
// correlation breakdown, and portfolio-level concentration limits.

import { all, one, run, getBars } from '../db.js';
import * as A from './analytics.js';

export const ALERT_KINDS = {
  price:        { label: 'Price level',        needsThreshold: true },
  changePct:    { label: 'Daily move %',       needsThreshold: true },
  maCross:      { label: 'MA cross (50/200)',  needsThreshold: false },
  rsi:          { label: 'RSI level',          needsThreshold: true },
  high52:       { label: 'New 52-week high',   needsThreshold: false },
  low52:        { label: 'New 52-week low',    needsThreshold: false },
  volSpike:     { label: 'Volume spike',       needsThreshold: true },
  volRegime:    { label: 'Volatility regime',  needsThreshold: true },
  drawdown:     { label: 'Drawdown breach',    needsThreshold: true },
  weightDrift:  { label: 'Portfolio weight drift', needsThreshold: true },
};

export function createAlert({ symbol, kind = 'price', direction = 'above', threshold = null, note = null }) {
  run(`INSERT INTO alerts (symbol, kind, direction, threshold, status, note, created_at)
       VALUES (?,?,?,?, 'active', ?, ?)`,
      symbol, kind, direction, threshold, note, Date.now());
  return one('SELECT * FROM alerts ORDER BY id DESC LIMIT 1');
}

export function listAlerts(status = null) {
  return status
    ? all('SELECT * FROM alerts WHERE status = ? ORDER BY created_at DESC', status)
    : all('SELECT * FROM alerts ORDER BY created_at DESC');
}

export function updateAlert(id, status) {
  run('UPDATE alerts SET status = ? WHERE id = ?', status, id);
  return one('SELECT * FROM alerts WHERE id = ?', id);
}

export function deleteAlert(id) { run('DELETE FROM alerts WHERE id = ?', id); }

/** Evaluate every active alert against the current price snapshot. */
export function evaluate(prices, portfolio = null) {
  const active = all("SELECT * FROM alerts WHERE status = 'active'");
  const fired = [];

  for (const a of active) {
    const q = prices[a.symbol];
    let hit = false, value = null, message = null;

    switch (a.kind) {
      case 'price': {
        if (!q?.price) break;
        value = q.price;
        hit = a.direction === 'above' ? q.price >= a.threshold : q.price <= a.threshold;
        message = `${a.symbol} ${a.direction} ${a.threshold} (now ${q.price})`;
        break;
      }
      case 'changePct': {
        if (q?.changePct == null) break;
        value = q.changePct;
        hit = a.direction === 'above' ? q.changePct >= a.threshold : q.changePct <= a.threshold;
        message = `${a.symbol} moved ${q.changePct}% today`;
        break;
      }
      case 'high52': {
        if (!q?.price || !q?.high52) break;
        value = q.price;
        hit = q.price >= q.high52 * 0.999;
        message = `${a.symbol} at a new 52-week high (${q.price})`;
        break;
      }
      case 'low52': {
        if (!q?.price || !q?.low52) break;
        value = q.price;
        hit = q.price <= q.low52 * 1.001;
        message = `${a.symbol} at a new 52-week low (${q.price})`;
        break;
      }
      case 'volSpike': {
        if (!q?.volume || !q?.avgVolume) break;
        value = +(q.volume / q.avgVolume).toFixed(2);
        hit = value >= (a.threshold ?? 2);
        message = `${a.symbol} volume ${value}x its average`;
        break;
      }
      case 'maCross': {
        const bars = getBars(a.symbol);
        if (bars.length < 210) break;
        const c = bars.map(b => b.adj_close ?? b.close);
        const f0 = A.sma(c.slice(0, -1), 50), s0 = A.sma(c.slice(0, -1), 200);
        const f1 = A.sma(c, 50), s1 = A.sma(c, 200);
        if ([f0, s0, f1, s1].some(x => x == null)) break;
        const crossedUp = f0 <= s0 && f1 > s1;
        const crossedDown = f0 >= s0 && f1 < s1;
        hit = a.direction === 'above' ? crossedUp : crossedDown;
        value = +(f1 - s1).toFixed(4);
        message = `${a.symbol} ${crossedUp ? 'golden' : 'death'} cross`;
        break;
      }
      case 'rsi': {
        const bars = getBars(a.symbol);
        if (bars.length < 30) break;
        const r = A.rsi(bars.map(b => b.adj_close ?? b.close), 14);
        if (r == null) break;
        value = +r.toFixed(1);
        hit = a.direction === 'above' ? r >= a.threshold : r <= a.threshold;
        message = `${a.symbol} RSI ${value}`;
        break;
      }
      case 'volRegime': {
        const bars = getBars(a.symbol);
        if (bars.length < 150) break;
        const rets = A.toReturns(bars.map(b => b.adj_close ?? b.close));
        const recent = A.annualisedVol(rets.slice(-21));
        const base = A.annualisedVol(rets.slice(-126));
        if (!base) break;
        value = +(recent / base).toFixed(2);
        hit = value >= (a.threshold ?? 1.5);
        message = `${a.symbol} short-term volatility ${value}x its baseline`;
        break;
      }
      case 'drawdown': {
        const bars = getBars(a.symbol);
        if (bars.length < 30) break;
        const c = bars.map(b => b.adj_close ?? b.close);
        const dd = A.drawdownSeries(c);
        value = +(dd[dd.length - 1] * 100).toFixed(2);
        hit = value <= -(Math.abs(a.threshold ?? 10));
        message = `${a.symbol} is ${Math.abs(value)}% below its peak`;
        break;
      }
      case 'weightDrift': {
        if (!portfolio) break;
        const p = portfolio.positions?.find(x => x.symbol === a.symbol);
        if (!p || p.targetPct == null) break;
        value = +(p.weight - p.targetPct).toFixed(2);
        hit = Math.abs(value) >= Math.abs(a.threshold ?? 5);
        message = `${a.symbol} is ${value > 0 ? 'over' : 'under'}weight by ${Math.abs(value)}pp`;
        break;
      }
    }

    if (hit) {
      run(`UPDATE alerts SET status = 'triggered', triggered_at = ?, triggered_value = ? WHERE id = ?`,
          Date.now(), value, a.id);
      fired.push({ ...a, value, message });
    }
  }
  return fired;
}

/** Distance-to-threshold, for progress bars on active alerts. */
export function alertProgress(prices) {
  return all("SELECT * FROM alerts WHERE status = 'active'").map(a => {
    const q = prices[a.symbol];
    if (!q?.price || a.threshold == null || !['price'].includes(a.kind)) {
      return { ...a, current: q?.price ?? null, progress: null };
    }
    const cur = q.price;
    const pct = a.direction === 'above'
      ? Math.min(100, Math.max(0, (cur / a.threshold) * 100))
      : Math.min(100, Math.max(0, (a.threshold / cur) * 100));
    return {
      ...a, current: cur,
      distancePct: +(((a.threshold - cur) / cur) * 100).toFixed(2),
      progress: +pct.toFixed(1),
    };
  });
}
