// Meridian v2 — data integrity
//
// Written after two production bugs that had the same root cause: a price bar
// arrived ~100x wrong (a pence/pounds mismatch mid-fix) and was written to the
// database without question. One bad bar out of 3,000 was enough to produce
// 4,402% volatility, a beta of -3.2, and a correlation matrix of forced 1.0s.
//
// The lesson is not "fix that bar". It is that a store which accepts any number
// it is handed will eventually be handed a wrong one. Everything here exists to
// make that class of failure detectable at write time rather than weeks later
// in a risk figure nobody can explain.

const MAD_SCALE = 1.4826;   // makes MAD a consistent estimator of sigma for normal data

/** Median absolute deviation — robust to the very outliers we're hunting,
 *  unlike standard deviation, which the outlier itself inflates. */
export function medianAbsoluteDeviation(values) {
  if (values.length < 3) return { median: values[0] ?? 0, mad: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const devs = values.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const dmid = Math.floor(devs.length / 2);
  const mad = devs.length % 2 ? devs[dmid] : (devs[dmid - 1] + devs[dmid]) / 2;
  return { median, mad: mad * MAD_SCALE };
}

/**
 * Flag bars whose close is implausible relative to its local neighbourhood.
 *
 * Two independent tests, because they catch different faults:
 *   1. Ratio test — is this bar a suspiciously round multiple (10x/100x/1000x)
 *      of its neighbours? This is the currency-mismatch signature specifically.
 *   2. Robust z-score — is it simply far outside the local distribution?
 *
 * Genuine market crashes are gradual across bars and do not revert the next
 * day; a unit error is a single isolated spike that snaps straight back. The
 * `reverts` check is what distinguishes them, so a real -20% day is never
 * flagged while a 100x error always is.
 */
export function findOutliers(bars, opts = {}) {
  const {
    window = 11,          // odd, centred
    zThreshold = 8,       // deliberately high: only egregious values
    ratioTolerance = 0.15,
  } = opts;

  const closes = bars.map(b => b.close ?? b.adj_close).map(Number);
  const flagged = [];
  const half = Math.floor(window / 2);

  for (let i = 0; i < closes.length; i++) {
    const v = closes[i];
    if (!isFinite(v) || v <= 0) {
      flagged.push({ index: i, date: bars[i].date, close: v, reason: 'non-positive or non-finite', severity: 'fatal' });
      continue;
    }

    const lo = Math.max(0, i - half), hi = Math.min(closes.length, i + half + 1);
    const neighbours = [];
    for (let j = lo; j < hi; j++) if (j !== i && isFinite(closes[j]) && closes[j] > 0) neighbours.push(closes[j]);
    // The ratio test is meaningful with very little context — a 100x gap is a
    // 100x gap even against two neighbours. The z-test needs more to estimate
    // a spread. Requiring the larger sample for both meant thin series were
    // skipped silently, which is precisely the failure mode this file exists
    // to prevent, so the two now have separate thresholds.
    if (neighbours.length < 2) continue;

    const { median, mad } = medianAbsoluteDeviation(neighbours);
    if (!median) continue;

    const ratio = median / v;
    const scaleHit = [1000, 100, 10, 0.1, 0.01, 0.001]
      .find(m => Math.abs(ratio - m) / m < ratioTolerance);

    // does the series return to the prior level immediately after? unit errors do.
    const before = i > 0 ? closes[i - 1] : null;
    const after = i < closes.length - 1 ? closes[i + 1] : null;
    const reverts = before && after &&
      Math.abs(after - before) / before < 0.25 &&
      Math.abs(v - before) / before > 0.75;

    // An isolated bar at the very start or end has no "after" to revert to, so
    // fall back to sheer implausibility against neighbours rather than skipping.
    const extremeVsNeighbours = Math.abs(median - v) / median > 0.9;

    if (scaleHit && (reverts || extremeVsNeighbours)) {
      flagged.push({
        index: i, date: bars[i].date, close: v,
        expected: +median.toFixed(4),
        scaleFactor: scaleHit,
        reason: `off by ~${scaleHit >= 1 ? scaleHit + 'x' : '1/' + Math.round(1 / scaleHit) + 'x'} vs neighbours${reverts ? ' and reverts next bar' : ''} — unit mismatch`,
        severity: 'fatal',
      });
      continue;
    }

    if (mad > 0 && neighbours.length >= 4) {
      const z = Math.abs(v - median) / mad;
      if (z > zThreshold && reverts) {
        flagged.push({
          index: i, date: bars[i].date, close: v,
          expected: +median.toFixed(4),
          zScore: +z.toFixed(1),
          reason: `${z.toFixed(0)} robust deviations from local median and reverts next bar`,
          severity: 'suspect',
        });
      }
    }
  }
  return flagged;
}

/**
 * Validate a batch before it is written. Returns clean bars plus a report.
 * Called by saveBars, so nothing reaches the database unexamined.
 */
export function validateBars(symbol, bars, opts = {}) {
  const { rejectFatal = true } = opts;
  if (!bars?.length) return { clean: [], rejected: [], report: null };

  const normalised = bars.map(b => ({
    ...b,
    date: typeof b.date === 'string' ? b.date.slice(0, 10)
        : new Date(b.date).toISOString().slice(0, 10),
  })).sort((a, b) => a.date.localeCompare(b.date));

  const outliers = findOutliers(normalised, opts);
  const fatalIdx = new Set(outliers.filter(o => o.severity === 'fatal').map(o => o.index));

  const clean = rejectFatal ? normalised.filter((_, i) => !fatalIdx.has(i)) : normalised;
  const rejected = normalised.filter((_, i) => fatalIdx.has(i))
    .map((b, k) => ({ ...b, ...outliers.filter(o => o.severity === 'fatal')[k] }));

  return {
    clean,
    rejected,
    report: outliers.length ? {
      symbol,
      total: normalised.length,
      flagged: outliers.length,
      fatal: outliers.filter(o => o.severity === 'fatal').length,
      suspect: outliers.filter(o => o.severity === 'suspect').length,
      details: outliers.slice(0, 20),
    } : null,
  };
}

/**
 * Scan everything already stored and report (or repair) corruption.
 * This is what would have caught the 19 August bars across all 53 symbols in
 * one pass, instead of finding them one holding at a time as they surfaced.
 */
export function auditStored(getAllSymbols, getBars, opts = {}) {
  const symbols = getAllSymbols();
  const findings = [];
  for (const symbol of symbols) {
    const bars = getBars(symbol);
    if (bars.length < 12) continue;
    const outliers = findOutliers(bars, opts);
    if (outliers.length) {
      findings.push({
        symbol,
        bars: bars.length,
        flagged: outliers.length,
        dates: outliers.map(o => o.date),
        details: outliers.slice(0, 5),
      });
    }
  }

  // A date appearing across many symbols indicates a systemic write fault
  // (a bad deploy, a mid-flight code change) rather than a data-provider glitch.
  const byDate = {};
  for (const f of findings) for (const d of f.dates) byDate[d] = (byDate[d] ?? 0) + 1;
  const systemic = Object.entries(byDate)
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([date, count]) => ({ date, symbolsAffected: count }));

  return {
    scanned: symbols.length,
    symbolsAffected: findings.length,
    totalFlagged: findings.reduce((a, f) => a + f.flagged, 0),
    systemicDates: systemic,
    verdict: systemic.length
      ? `${systemic.length} date(s) corrupted across multiple symbols — indicates a write-side fault, not bad source data.`
      : findings.length
        ? 'Isolated anomalies only. Likely genuine source-data glitches.'
        : 'No anomalies detected.',
    findings,
  };
}
