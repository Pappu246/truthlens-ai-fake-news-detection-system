const BACKEND_URL = 'https://truthlens-backend-74h6.onrender.com/api/article/extract';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ detail: 'Method not allowed' });
  }
  try {
    const upstream = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });
    const raw = await upstream.text();
    let payload: any;
    try { payload = JSON.parse(raw); } catch { payload = { error: raw || 'Article extraction failed.' }; }
    return res.status(upstream.status >= 500 ? 200 : upstream.status).json(
      upstream.status >= 500
        ? { success: false, error: 'Article extraction service is temporarily unavailable.' }
        : payload
    );
  } catch {
    return res.status(200).json({ success: false, error: 'Article extraction service is temporarily unavailable.' });
  }
}
