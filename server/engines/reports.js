// Meridian v2 — periodic reports
//
// Stock Rover emails you a performance report on a schedule. The value in that
// is not the email; it is that the report exists without you remembering to go
// and look, and that last month's version is still there when you want to
// compare. That is what this builds.
//
// ─── On not sending email ─────────────────────────────────────
//
// Delivery by SMTP is deliberately not implemented here, and the reason is the
// project's own testing rule rather than laziness. This sandbox cannot reach a
// mail server, so an SMTP client written here could be checked for syntax and
// for its behaviour against a fake socket, and nothing more — the parts that
// actually break in practice (a provider's TLS quirks, app-password auth,
// whether a given host wants implicit TLS on 465 or STARTTLS on 587) would
// ship unverified, on the user's real credentials. This project has a specific
// history of exactly that failure: things that passed every check available in
// the sandbox and broke on the machine that mattered.
//
// So reports are generated, stored and archived, and exported as a single
// self-contained HTML file the user can open, print or attach. The scheduling
// half — the part that makes a report appear without being asked for — is
// real. The transport is left to the user, and said plainly rather than
// half-built.
//
// ─── What a report is ─────────────────────────────────────────
//
// A snapshot of every engine's answer at a moment, stored as JSON so it can be
// re-rendered later, plus the rendered HTML. Storing the numbers rather than
// only the document matters: a report generated in March should still say what
// March said, even after the engines that produced it have changed.

import { all, one, run, db } from '../db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  period      TEXT NOT NULL,          -- weekly | monthly | quarterly | manual
  period_key  TEXT NOT NULL,          -- 2026-W38, 2026-09, 2026-Q3
  from_date   TEXT,
  to_date     TEXT,
  generated_at INTEGER NOT NULL,
  payload     TEXT NOT NULL,          -- the engines' answers, as JSON
  html        TEXT,                   -- rendered at generation time
  UNIQUE(period, period_key)
);
CREATE INDEX IF NOT EXISTS idx_reports_generated ON reports(generated_at DESC);
`);

export const PERIODS = ['weekly', 'monthly', 'quarterly'];

// ─── Period arithmetic ────────────────────────────────────────

/** ISO week number, so a weekly report has a stable, sortable key. */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday of this week determines the year, per ISO 8601.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** The key identifying the period a moment falls in. */
export function periodKey(period, at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  const y = d.getUTCFullYear();
  if (period === 'weekly') {
    const { year, week } = isoWeek(d);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }
  if (period === 'monthly') return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  if (period === 'quarterly') return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  return d.toISOString().slice(0, 10);
}

/** Inclusive date range covered by a period key. */
export function periodRange(period, at = new Date()) {
  const d = at instanceof Date ? new Date(at) : new Date(at);
  const iso = x => x.toISOString().slice(0, 10);

  if (period === 'weekly') {
    const day = d.getUTCDay() || 7;                 // Monday = 1
    const start = new Date(d); start.setUTCDate(d.getUTCDate() - day + 1);
    const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
    return { from: iso(start), to: iso(end) };
  }
  if (period === 'monthly') {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return { from: iso(start), to: iso(end) };
  }
  if (period === 'quarterly') {
    const q = Math.floor(d.getUTCMonth() / 3);
    const start = new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0));
    return { from: iso(start), to: iso(end) };
  }
  return { from: iso(d), to: iso(d) };
}

/** Trading-day lookback that roughly covers a period, for engines that take one. */
function lookbackFor(period) {
  return period === 'weekly' ? 10 : period === 'monthly' ? 30 : 95;
}

// ─── Assembly ─────────────────────────────────────────────────

/**
 * Gather every engine's answer for a period.
 *
 * Each engine is called behind its own try/catch and records its own failure.
 * A report that omits a section because an engine threw, without saying so,
 * would read as "nothing to report there" — which is the one thing this
 * codebase refuses to let a gap look like.
 */
export function assemble({ period = 'monthly', at = new Date(), engines = {}, prices = {} } = {}) {
  const key = periodKey(period, at);
  const range = periodRange(period, at);
  const lookback = lookbackFor(period);

  const section = (name, fn) => {
    try {
      const value = fn();
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: e.message, note: `The ${name} section could not be built.` };
    }
  };

  const out = {
    period, periodKey: key,
    from: range.from, to: range.to,
    generatedAt: new Date().toISOString(),
    sections: {},
  };

  if (engines.portfolio) out.sections.portfolio = section('portfolio', () => engines.portfolio(prices));
  if (engines.performance) out.sections.performance = section('performance', () => engines.performance(prices));
  if (engines.attribution) out.sections.attribution = section('attribution', () => engines.attribution(prices, { lookback }));
  if (engines.correlation) out.sections.correlation = section('correlation', () => engines.correlation(prices));
  if (engines.xray) out.sections.xray = section('x-ray', () => engines.xray(prices));
  if (engines.risk) out.sections.risk = section('risk', () => engines.risk(prices));

  const failedSections = Object.entries(out.sections).filter(([, s]) => !s.ok).map(([k]) => k);
  out.failedSections = failedSections;
  out.complete = failedSections.length === 0;
  return out;
}

// ─── Rendering ────────────────────────────────────────────────

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const pct = v => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
const money = v => (v == null || !isFinite(v) ? '—' : `£${Math.round(v).toLocaleString('en-GB')}`);

/**
 * Render to one self-contained HTML document.
 *
 * No external stylesheet, font or script, because the whole point is a file
 * that still renders years later from a folder, with no server running and no
 * network. Printing is the likeliest thing anyone does with it, so it is laid
 * out for paper rather than for a dark terminal.
 */
export function render(payload) {
  const s = payload?.sections ?? {};
  const val = k => (s[k]?.ok ? s[k].value : null);

  const perf = val('performance');
  const attr = val('attribution');
  const corr = val('correlation');
  const xr = val('xray');
  const pf = val('portfolio');

  const rows = [];
  const card = (label, value, sub = '') => `
    <div class="card">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(value)}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
    </div>`;

  if (pf) rows.push(card('Portfolio value', money(pf.total), `${pf.positions?.length ?? 0} holdings`));
  if (attr?.available) rows.push(card('Return over period', pct(attr.totalReturn), `${attr.days} trading days`));
  if (attr?.benchmark?.available) {
    rows.push(card(`Against ${attr.benchmark.symbol}`, pct(attr.benchmark.excess), `index ${pct(attr.benchmark.benchmarkReturn)}`));
  }
  if (perf?.moneyWeighted?.available) {
    rows.push(card('Money-weighted', `${perf.moneyWeighted.annualisedPct?.toFixed(2) ?? '—'}%`, 'annualised, your timing included'));
  }
  if (corr?.available && corr.independence?.available) {
    rows.push(card('Independent bets', corr.independence.effectiveBets ?? '—',
      `of ${corr.independence.holdingsCount} holdings`));
  }
  if (xr?.available) {
    rows.push(card('Looked through', `${((xr.coverage?.seen ?? 0) * 100).toFixed(0)}%`,
      `${xr.distinctNames} companies disclosed`));
  }

  const contributors = attr?.available
    ? [...(attr.winners ?? []), ...(attr.losers ?? [])]
        .sort((a, b) => b.contribution - a.contribution)
    : [];

  const failed = (payload?.failedSections ?? []);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Meridian — ${esc(payload.periodKey)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px; background:#fff; color:#111;
         font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  .wrap { max-width: 820px; margin: 0 auto; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-0.01em; }
  .period { color:#666; font-size:13px; margin-bottom:24px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:28px; }
  .card { border:1px solid #e2e2e2; border-radius:6px; padding:12px 14px; }
  .label { font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:#777; margin-bottom:6px; }
  .value { font-size:21px; font-weight:600; font-variant-numeric:tabular-nums; }
  .sub { font-size:11px; color:#777; margin-top:4px; }
  h2 { font-size:13px; letter-spacing:.06em; text-transform:uppercase; color:#555;
       border-bottom:1px solid #e2e2e2; padding-bottom:6px; margin:26px 0 12px; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th { text-align:left; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:#777;
       padding:5px 8px 5px 0; font-weight:600; }
  td { padding:6px 8px 6px 0; border-top:1px solid #f0f0f0; font-size:13px; }
  td.num { text-align:right; }
  .pos { color:#0a7a54; } .neg { color:#b3261e; }
  .note { font-size:11.5px; color:#666; line-height:1.6; margin-top:10px; }
  .warn { border-left:3px solid #c98a00; background:#fff9ec; padding:10px 12px;
          font-size:12px; color:#5c4300; margin:14px 0; border-radius:0 4px 4px 0; }
  footer { margin-top:34px; padding-top:14px; border-top:1px solid #e2e2e2;
           font-size:11px; color:#888; line-height:1.6; }
  @media print { body { padding:0; } .card { break-inside:avoid; } }
</style></head>
<body><div class="wrap">
  <h1>Meridian report</h1>
  <div class="period">${esc(payload.period)} · ${esc(payload.periodKey)} · ${esc(payload.from)} to ${esc(payload.to)}</div>

  ${rows.length ? `<div class="cards">${rows.join('')}</div>` : '<p class="note">No section produced a headline figure for this period.</p>'}

  ${failed.length ? `<div class="warn">These sections could not be built and are absent rather than empty:
    ${esc(failed.join(', '))}.</div>` : ''}

  ${contributors.length ? `
  <h2>What moved the return</h2>
  <table>
    <tr><th>Holding</th><th>Group</th><th class="num">Avg weight</th><th class="num">Contribution</th></tr>
    ${contributors.map(h => `<tr>
      <td>${esc(h.name ?? h.symbol)}</td>
      <td>${esc(h.group ?? '—')}</td>
      <td class="num">${((h.averageWeight ?? 0) * 100).toFixed(1)}%</td>
      <td class="num ${h.contribution >= 0 ? 'pos' : 'neg'}">${pct(h.contribution)}</td>
    </tr>`).join('')}
  </table>
  <div class="note">${esc(attr?.caveat ?? '')}</div>` : ''}

  ${corr?.available && corr.redundancies?.pairs?.length ? `
  <h2>Holdings that duplicate each other</h2>
  <table>
    <tr><th>Pair</th><th class="num">Correlation</th><th class="num">Combined weight</th></tr>
    ${corr.redundancies.pairs.slice(0, 6).map(p => `<tr>
      <td>${esc(p.nameA ?? p.a)} + ${esc(p.nameB ?? p.b)}</td>
      <td class="num">${p.correlation.toFixed(2)}</td>
      <td class="num">${p.combinedWeight == null ? '—' : (p.combinedWeight * 100).toFixed(1) + '%'}</td>
    </tr>`).join('')}
  </table>` : ''}

  ${xr?.available && xr.underlyings?.length ? `
  <h2>Largest underlying companies</h2>
  <table>
    <tr><th>Company</th><th class="num">Held via</th><th class="num">Weight</th></tr>
    ${xr.underlyings.slice(0, 8).map(u => `<tr>
      <td>${esc(u.name ?? u.symbol)}</td>
      <td class="num">${u.viaCount}</td>
      <td class="num">${u.exact ? '' : '≥'}${(u.weight * 100).toFixed(2)}%</td>
    </tr>`).join('')}
  </table>
  <div class="note">${esc(xr.basis ?? '')}</div>` : ''}

  <footer>
    Generated ${esc(payload.generatedAt)} by Meridian from stored data only.
    Figures carry the same caveats as the pages they came from; nothing here was
    estimated to fill a gap. This file is self-contained and needs no network to open.
  </footer>
</div></body></html>`;
}

// ─── Storage ──────────────────────────────────────────────────

export function saveReport(payload, html) {
  run(`INSERT INTO reports (period, period_key, from_date, to_date, generated_at, payload, html)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(period, period_key) DO UPDATE SET
         from_date = excluded.from_date, to_date = excluded.to_date,
         generated_at = excluded.generated_at,
         payload = excluded.payload, html = excluded.html`,
    payload.period, payload.periodKey, payload.from, payload.to,
    Date.now(), JSON.stringify(payload), html ?? null);
  return one('SELECT id FROM reports WHERE period = ? AND period_key = ?', payload.period, payload.periodKey);
}

export function listReports({ limit = 50 } = {}) {
  return all(`SELECT id, period, period_key, from_date, to_date, generated_at
              FROM reports ORDER BY generated_at DESC LIMIT ?`, limit)
    .map(r => ({
      id: r.id, period: r.period, periodKey: r.period_key,
      from: r.from_date, to: r.to_date,
      generatedAt: new Date(r.generated_at).toISOString(),
    }));
}

export function getReport(id) {
  const r = one('SELECT * FROM reports WHERE id = ?', id);
  if (!r) return null;
  return {
    id: r.id, period: r.period, periodKey: r.period_key,
    from: r.from_date, to: r.to_date,
    generatedAt: new Date(r.generated_at).toISOString(),
    payload: JSON.parse(r.payload),
    html: r.html,
  };
}

export function deleteReport(id) {
  run('DELETE FROM reports WHERE id = ?', id);
  return { ok: true };
}

/** Has this period already been reported on? */
export function hasReport(period, key) {
  return !!one('SELECT id FROM reports WHERE period = ? AND period_key = ?', period, key);
}

// ─── Scheduling ───────────────────────────────────────────────

/**
 * Generate any report that is due and not yet written.
 *
 * Due means: the period that has just CLOSED has no report. Reporting on the
 * period still running would produce a partial figure labelled as a full one,
 * and then overwrite it repeatedly as the week went on — so the report for a
 * period is written once, after it ends, and not touched again.
 *
 * Driven by what is in the table rather than by a timer's memory, so the app
 * being closed over a weekend does not lose that week's report: the next run
 * finds it missing and writes it.
 */
export function generateDue({ now = new Date(), periods = PERIODS, engines = {}, prices = {}, enabled = null } = {}) {
  const want = enabled ?? periods;
  const written = [], skipped = [];

  for (const period of periods) {
    if (!want.includes(period)) { skipped.push({ period, reason: 'not enabled' }); continue; }

    // Step back one period to find the most recently completed one.
    const prev = new Date(now);
    if (period === 'weekly') prev.setUTCDate(prev.getUTCDate() - 7);
    else if (period === 'monthly') prev.setUTCMonth(prev.getUTCMonth() - 1);
    else prev.setUTCMonth(prev.getUTCMonth() - 3);

    const key = periodKey(period, prev);
    if (hasReport(period, key)) { skipped.push({ period, periodKey: key, reason: 'already written' }); continue; }

    const payload = assemble({ period, at: prev, engines, prices });
    const html = render(payload);
    const saved = saveReport(payload, html);
    written.push({ period, periodKey: key, id: saved?.id ?? null, complete: payload.complete });
  }

  return { written, skipped, checkedAt: new Date().toISOString() };
}
