const BACKEND_ANALYZE_URL = 'https://truthlens-backend-74h6.onrender.com/api/analyze';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ detail: 'Method not allowed' });
  }

  try {
    const upstream = await fetch(BACKEND_ANALYZE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });

    const text = await upstream.text();
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { detail: text || 'Backend returned an invalid response.' };
    }

    return res.status(upstream.status).json(payload);
  } catch (error: any) {
    return res.status(502).json({
      detail: `Render backend unavailable: ${error?.message || 'upstream request failed'}`
    });
  }
}
