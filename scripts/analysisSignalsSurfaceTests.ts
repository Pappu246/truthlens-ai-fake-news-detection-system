import assert from 'node:assert/strict';
import { analyzeUrlApi, executeNewsAnalysis } from '../src/services/analysisEngine';
import { getCalibratedProbabilityPresentation } from '../src/utils/calibratedProbabilityPresentation';

const claimModel = {
  status: 'AVAILABLE',
  source: 'primary claim extracted from the submitted text',
  claim_text: 'The unemployment rate for college graduates is 4.4 percent.',
  model_role: 'claim_model',
  model_name: 'TruthLens LIAR Claim Model',
  model_version: 'v1.1.0-liar-claim',
  variant_used: 'text_only',
  metadata_available: false,
  metadata_fields_used: [],
  probability_true: 0.6272,
  probability_false: 0.3728,
  decision_threshold: 0.5,
  label: 'LIKELY TRUE',
  confidence: 0.6272,
  limitations: ['Short political claims only; may not generalize to science and other domains.'],
  benchmark: {
    dataset: 'LIAR',
    split: 'TEST',
    n: 802,
    accuracy: 0.6272,
    macro_f1: 0.6153,
    note: 'Held-out claim benchmark; not a guarantee for the current claim.'
  },
  scored_at: '2026-10-19T00:00:00.000Z'
} as const;

const evidenceVerification = {
  available: true,
  status: 'SUPPORTED',
  claim_text: claimModel.claim_text,
  claim_type: 'STATISTICAL',
  evidence_queries: ['graduate unemployment rate'],
  evidence: [{
    evidence_id: 'ev-1',
    retrieved_source: 'Example agency',
    source_title: 'Employment statistics',
    source_url: 'https://example.gov/employment',
    source_final_url: 'https://example.gov/employment',
    source_domain: 'example.gov',
    provenance_verified: true,
    source_fetch_status: 'FETCHED',
    evidence_excerpt: 'Example evidence excerpt.',
    stance: 'SUPPORT',
    relevance_signal: { score: 0.92, band: 'HIGH', explanation: 'Claim terms match the evidence.' }
  }],
  counts: { total: 1, support: 1, contradict: 0, unclear: 0 },
  source_diversity: { independentSourcesCount: 1, domains: ['example.gov'] },
  verification_signal: { direction: 'TOWARD_TRUE', strength: 0.8, basis: 'Fixture for UI mapping only.' },
  final_interpretation: 'Fixture: evidence supports the claim.',
  evidence_outcome: { status: 'AVAILABLE', detail: 'Fixture retrieval completed.' },
  retrieval: { attempted: true, all_providers_failed: false, duration_ms: 100 },
  limitations: ['Fixture results are not real evidence.'],
  generated_at: '2026-10-19T00:00:00.000Z'
} as const;

function backendPayload() {
  return {
    id: 42,
    status: 'INSUFFICIENT_INFORMATION',
    verdict: 'NEEDS MORE CONTEXT',
    prediction: 'NEEDS MORE CONTEXT',
    reason: 'The article probability was withheld by the safety policy.',
    risk_level: 'UNDETERMINED',
    fake_probability: null,
    real_probability: null,
    confidence_score: null,
    model_inference_mode: 'calibrated_ensemble',
    calibration_status: 'EXACT_CALIBRATED_ENSEMBLE',
    model: 'Linear SVM (Calibrated)',
    explanation: ['The article model abstained.'],
    detected_claim: claimModel.claim_text,
    indicators: [],
    feature_attributions: [],
    claim_model: claimModel,
    evidence_verification: evidenceVerification
  };
}

async function main() {
  // A calibrated article can abstain inside the uncertainty zone without
  // withholding its probabilities. Show both percentages only for successful,
  // exact-calibrated, complementary outputs; never infer or invent values.
  assert.deepEqual(
    getCalibratedProbabilityPresentation({
      status: 'SUCCESS',
      model_inference_mode: 'calibrated_ensemble',
      calibration_status: 'EXACT_CALIBRATED_ENSEMBLE',
      fake_probability: 0.6272,
      real_probability: 0.3728
    }),
    { fakeProbability: 0.6272, realProbability: 0.3728, fakePercent: 63, realPercent: 37 }
  );
  assert.equal(
    getCalibratedProbabilityPresentation({
      status: 'INSUFFICIENT_INFORMATION',
      model_inference_mode: 'calibrated_ensemble',
      calibration_status: 'EXACT_CALIBRATED_ENSEMBLE',
      fake_probability: 0.62,
      real_probability: 0.38
    }),
    null,
    'Unsafe/insufficient input must not expose model probabilities.'
  );
  assert.equal(
    getCalibratedProbabilityPresentation({
      status: 'SUCCESS',
      model_inference_mode: 'legacy_single_svm',
      calibration_status: 'LEGACY_UNCALIBRATED_MARGIN',
      fake_probability: 0.9,
      real_probability: 0.1
    }),
    null,
    'An uncalibrated margin must not be presented as probability.'
  );
  assert.equal(
    getCalibratedProbabilityPresentation({
      status: 'SUCCESS',
      model_inference_mode: 'calibrated_ensemble',
      calibration_status: 'EXACT_CALIBRATED_ENSEMBLE',
      fake_probability: 0.62,
      real_probability: 0.2
    }),
    null,
    'Inconsistent/non-complementary scores must be withheld.'
  );
  assert.equal(
    getCalibratedProbabilityPresentation({
      status: 'SUCCESS',
      model_inference_mode: 'calibrated_ensemble',
      calibration_status: 'EXACT_CALIBRATED_ENSEMBLE',
      fake_probability: Number.NaN,
      real_probability: 0
    }),
    null,
    'Non-finite probabilities must be withheld.'
  );
  console.log('Calibrated abstention probability display: PASS');

  const originalFetch = globalThis.fetch;
  try {
    let observedPath = '';
    const payload = backendPayload();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      observedPath = String(input);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;

    const textResult = await executeNewsAnalysis(
      'The unemployment rate for college graduates is 4.4 percent.'
    );
    assert.equal(observedPath, '/api/analyze');
    assert.equal(textResult.fake_probability, null, 'Withheld article probability must stay null.');
    assert.equal(textResult.real_probability, null, 'Withheld article probability must stay null.');
    assert.equal(textResult.claim_model?.status, 'AVAILABLE');
    assert.equal(textResult.claim_model?.model_version, 'v1.1.0-liar-claim');
    assert.equal(textResult.claim_model?.probability_true, 0.6272);
    assert.equal(textResult.claim_model?.probability_false, 0.3728);
    assert.equal(textResult.evidence_verification?.status, 'SUPPORTED');
    assert.equal(textResult.evidence_verification?.evidence?.[0]?.provenance_verified, true);

    observedPath = '';
    const urlResult = await analyzeUrlApi('https://example.gov/article');
    assert.equal(observedPath, '/api/analyze-url');
    assert.equal(urlResult.fake_probability, null, 'URL analysis must preserve withheld article probabilities.');
    assert.equal(urlResult.claim_model?.status, 'AVAILABLE', 'URL route must preserve the specialist claim signal.');
    assert.equal(urlResult.claim_model?.probability_true, 0.6272);
    assert.equal(urlResult.evidence_verification?.status, 'SUPPORTED');
    assert.equal(urlResult.evidence_verification?.counts?.support, 1);

    console.log('Analysis independent-signal mapping: PASS');
    console.log('- Text and URL flows preserve claim-model probabilities separately.');
    console.log('- Evidence status/counts/provenance survive service mapping.');
    console.log('- Withheld article probabilities remain null (no fabricated percent).');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch(error => {
  console.error('Analysis independent-signal mapping: FAIL');
  console.error(error);
  process.exitCode = 1;
});
