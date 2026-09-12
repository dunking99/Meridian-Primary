// Meridian — macro regime overlay
//
// Stage D. The purpose here is narrow and deliberately limited.
//
// It is very easy to build something that reads the current market, decides
// it knows what happens next, and rewrites a long-horizon portfolio around
// that view every time it runs. That is not analysis, it is a machine for
// buying whatever went up last month. A five-year mandate should not be
// repositioned by this quarter's VIX print.
//
// So regime does exactly two things:
//
//   1. It sets how much the short-horizon timing signal is trusted. Momentum
//      is a real effect in a trending market and close to noise in a choppy
//      or falling one, so a technical score earned in a downtrend is
//      discounted rather than taken at face value. The size of that
//      adjustment is capped by the mandate's own regimeSensitivity, which for
//      a long horizon is deliberately small.
//   2. It supplies context for the report, so a recommendation made in a
//      risk-off tape says so.
//
// It never vetoes a candidate, never sets a weight, and never overrides the
// mandate. Those are decisions the evidence on the individual holding should
// drive, not a market-wide mood reading.

import * as analyst from '../analyst.js';
import * as memory from '../memory.js';

/**
 * @param {Object} prices  live price cache (state.prices)
 * @param {Object} mandate resolved mandate — supplies regimeSensitivity
 */
export function readRegime(prices, mandate) {
  let regime = null;
  try {
    regime = analyst.computeRegime(prices ?? {});
  } catch (e) {
    regime = null;
  }

  // computeRegime returns 'unknown' rather than throwing when the benchmark
  // has no stored history, which is a different thing from a failure and is
  // reported as such.
  const known = regime && regime.trend !== 'unknown';

  let rotation = null;
  try {
    const lead = memory.leadership({ window: 21, prior: 21 });
    if (lead?.available) {
      rotation = {
        date: lead.date,
        priorDate: lead.priorDate,
        leading: lead.groups.slice(0, 3).map(g => ({
          group: g.group, ret: +(g.ret * 100).toFixed(2), rankChange: g.rankChange,
        })),
        lagging: lead.groups.slice(-3).reverse().map(g => ({
          group: g.group, ret: +(g.ret * 100).toFixed(2), rankChange: g.rankChange,
        })),
      };
    }
  } catch { rotation = null; }

  const sensitivity = mandate?.regimeSensitivity ?? 0.25;
  const trustMultiplier = timingTrust(regime, known, sensitivity);

  return {
    available: !!known,
    label: known ? regime.label : 'Unknown',
    score: known ? regime.score : null,
    trend: regime?.trend ?? 'unknown',
    volatility: regime?.volatility ?? 'unknown',
    yieldCurve: regime?.yieldCurve ?? 'unknown',
    inputs: regime?.inputs ?? null,
    rotation,
    timingTrust: +trustMultiplier.toFixed(3),
    explain: explain(regime, known, trustMultiplier, sensitivity),
    // Said plainly so the influence of this stage is never larger than it
    // looks: this is the only number regime contributes to the outcome.
    role: 'Regime scales how far the short-horizon timing signal is trusted. It does not veto candidates, set weights, or override the mandate.',
  };
}

/**
 * Multiplier applied to the technical/timing component of conviction.
 *
 * Base sits at 1.0 (take the signal as scored). A downtrend or a stressed
 * tape pulls it down, a clean uptrend nudges it up, and the whole adjustment
 * is then scaled by the mandate's regime sensitivity — so a long-horizon
 * mandate moves a quarter as far as a short-horizon one from the same tape.
 */
function timingTrust(regime, known, sensitivity) {
  if (!known) return 1;

  let raw = 1;
  if (regime.trend === 'uptrend') raw += 0.20;
  else if (regime.trend === 'downtrend') raw -= 0.35;

  if (regime.volatility === 'stressed') raw -= 0.25;
  else if (regime.volatility === 'elevated') raw -= 0.10;
  else if (regime.volatility === 'complacent') raw -= 0.05;   // late-cycle calm is not a green light

  // Scale the deviation from neutral, not the multiplier itself.
  const scaled = 1 + (raw - 1) * sensitivity;
  return Math.max(0.5, Math.min(1.3, scaled));
}

function explain(regime, known, trust, sensitivity) {
  if (!known) {
    return 'No regime read available — the benchmark has no stored history, so timing signals are taken at face value.';
  }
  const dir = trust > 1.02 ? 'trusted slightly more than usual'
            : trust < 0.98 ? 'discounted' : 'taken at face value';
  return `${regime.label}: ${regime.trend}, volatility ${regime.volatility}, yield curve ${regime.yieldCurve}. `
       + `Timing signals are ${dir} (x${trust.toFixed(2)}), scaled by this mandate's regime sensitivity of ${sensitivity}.`;
}
