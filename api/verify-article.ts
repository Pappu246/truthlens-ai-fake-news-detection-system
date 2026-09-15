const BACKEND_URL = 'https://truthlens-backend-74h6.onrender.com/api/verify-claim';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ detail: 'Method not allowed' });
  }
  try {
    const body = req.body || {};
    const upstream = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body.text || body.claim || '', source_url: body.source_url || '' })
    });
    const raw = await upstream.text();
    let payload: any;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!upstream.ok || !payload) {
      return res.status(200).json({ status: 'UNAVAILABLE', verified: false, claims: [], evidence: [], message: 'Independent verification is temporarily unavailable.' });
    }
    return res.status(200).json(payload);
  } catch {
    return res.status(200).json({ status: 'UNAVAILABLE', verified: false, claims: [], evidence: [], message: 'Independent verification is temporarily unavailable.' });
  }
}
