const BACKEND_URL = 'https://truthlens-backend-74h6.onrender.com/api/news/latest';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ detail: 'Method not allowed' });
  }
  try {
    const query = new URLSearchParams(req.query || {}).toString();
    const upstream = await fetch(`${BACKEND_URL}${query ? `?${query}` : ''}`);
    const raw = await upstream.text();
    let payload: any;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!upstream.ok || !payload) {
      return res.status(200).json({ articles: [], fetchedAt: new Date().toISOString(), provider: 'RSSNewsProvider', categories: [], warnings: ['Live news service is temporarily unavailable.'] });
    }
    return res.status(200).json(payload);
  } catch {
    return res.status(200).json({ articles: [], fetchedAt: new Date().toISOString(), provider: 'RSSNewsProvider', categories: [], warnings: ['Live news service is temporarily unavailable.'] });
  }
}
