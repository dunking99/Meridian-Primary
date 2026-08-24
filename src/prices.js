export async function fetchLivePrices() {
  try {
    const res = await fetch('http://localhost:3001/prices', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Proxy returned ${res.status}`);
    const data = await res.json();
    if (data.count === 0) throw new Error('Proxy returned no prices');
    return data.prices;
  } catch (e) {
    console.warn('Price proxy not reachable:', e.message);
    return {};
  }
}

export async function fetchFearAndGreed() {
  try {
    const res = await fetch('http://localhost:3001/feargreed', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('No fear/greed data');
    return await res.json();
  } catch {
    return null;
  }
}

export const FALLBACK_PRICES = {
  '^GSPC': 5600, '^IXIC': 17500, 'VUSA.L': 102,
  '^FTSE': 7900, '^STOXX50E': 4800, 'VDPG.L': 50, 'EEM': 42,
  '^VIX': 18,
  'GC=F': 2910, 'SGLN.L': 28,
  'CL=F': 67, 'BZ=F': 71, 'NG=F': 4.1,
  'GBPUSD=X': 1.2940, 'EURUSD=X': 1.0850,
};
