// CNN Fear & Greed — the one component in v1 that always worked. Preserved
// exactly, including the full browser header set needed to pass bot detection.
import https from 'https';

function get(url, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-GB,en;q=0.9',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
        'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site',
        ...headers,
      },
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        try { resolve({ ok: true, data: JSON.parse(Buffer.concat(c).toString()) }); }
        catch { resolve({ ok: false }); }
      });
    }).on('error', () => resolve({ ok: false }));
  });
}

export async function fetchFearAndGreed() {
  const res = await get('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    Origin: 'https://edition.cnn.com', Referer: 'https://edition.cnn.com/markets/fear-and-greed',
  });
  if (!res.ok) return null;
  try {
    const fg = res.data?.fear_and_greed;
    const hist = res.data?.fear_and_greed_historical?.data ?? [];
    return {
      score: Math.round(fg.score),
      rating: fg.rating.replace(/_/g, ' ').toUpperCase(),
      prevClose: Math.round(fg.previous_close),
      weekAgo: hist.length >= 5 ? Math.round(hist[hist.length - 5]?.y) : null,
      monthAgo: hist.length >= 21 ? Math.round(hist[hist.length - 21]?.y) : null,
      history: hist.slice(-90).map(h => ({ t: h.x, v: Math.round(h.y) })),
    };
  } catch { return null; }
}

export { get as httpsGetJson };
