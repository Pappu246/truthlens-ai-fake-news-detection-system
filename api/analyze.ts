const BACKEND_ANALYZE_URL = 'https://truthlens-backend-74h6.onrender.com/api/analyze';

function fallbackResult(body: any, detail: string) {
  const text = String(body?.text || body?.raw_text || '').trim();
  return {
    id: null,
    status: 'DEGRADED_MODE',
    verdict: 'NEEDS MORE CONTEXT',
    prediction: 'NEEDS MORE CONTEXT',
    reason: detail,
    message: 'The analysis engine is temporarily recovering. No fake/real claim was made.',
    fake_probability: null,
    real_probability: null,
    confidence: null,
    confidence_score: null,
    uncertainty_score: 1,
    risk_level: 'UNDETERMINED',
    input_length: text.length,
    indicators: [],
    explanation: [detail, 'Please retry after the backend finishes restarting or recovering its model artifacts.'],
    feature_attributions: [],
    model: 'TruthLens AI — recovery mode',
    model_used: 'TruthLens AI — recovery mode',
    model_reliability: 'UNAVAILABLE',
    source_info: { url: body?.source_url || null, provided: Boolean(body?.source_url) },
    evidence_verification: { status: 'Unavailable during recovery.' },
    disclaimer: 'No classification was issued because the inference service was unavailable.'
  };
}

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

    // Never expose a raw 5xx to the production UI. Return an explicit,
    // non-classifying recovery response instead of a misleading verdict.
    if (upstream.status >= 500) {
      return res.status(200).json(fallbackResult(req.body || {}, payload?.detail || 'Render inference service returned a server error.'));
    }

    return res.status(upstream.status).json(payload);
  } catch (error: any) {
    return res.status(200).json(fallbackResult(req.body || {}, `Render backend unavailable: ${error?.message || 'upstream request failed'}`));
  }
}
