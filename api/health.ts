const BACKEND_URL = 'https://truthlens-backend-74h6.onrender.com/api/health';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ detail: 'Method not allowed' });
  }
  try {
    const upstream = await fetch(BACKEND_URL);
    const raw = await upstream.text();
    let payload: any;
    try { payload = JSON.parse(raw); } catch { payload = { detail: raw || 'Health check failed.' }; }
    return res.status(upstream.status >= 500 ? 200 : upstream.status).json(
      upstream.status >= 500 ? { status: 'degraded', service: 'TruthLens AI Detection Engine' } : payload
    );
  } catch {
    return res.status(200).json({ status: 'degraded', service: 'TruthLens AI Detection Engine' });
  }
}
