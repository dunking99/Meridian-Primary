const API = 'http://localhost:3001';

/**
 * Fetch quotes from the local API.
 *
 * Always resolves to an envelope rather than throwing or returning a bare
 * object, because the caller has to be able to tell three cases apart that
 * used to collapse into one empty object: the API is not running, the API is
 * running but has no prices, and the API returned prices. Rendering a number
 * requires knowing which of those happened.
 */
export async function fetchLivePrices() {
  try {
    const res = await fetch(`${API}/prices`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, prices: {}, count: 0, reason: `API returned ${res.status}` };
    const data = await res.json();
    return {
      ok: true,
      prices: data.prices ?? {},
      count: data.count ?? 0,
      // When the server last successfully reached Yahoo — distinct from when
      // the browser last called the server. A stale upstream behind a
      // responsive API is exactly the case a single timestamp would hide.
      lastFetch: data.lastFetch || null,
      status: data.status ?? null,
      reason: (data.count ?? 0) === 0 ? 'API is running but holds no prices' : null,
    };
  } catch (e) {
    return {
      ok: false, prices: {}, count: 0,
      reason: e.name === 'TimeoutError' ? 'API did not respond within 5s' : 'API unreachable — is it running?',
    };
  }
}

export async function fetchFearAndGreed() {
  try {
    const res = await fetch(`${API}/feargreed`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const d = await res.json();
    return d && d.score != null ? d : null;
  } catch {
    return null;
  }
}
