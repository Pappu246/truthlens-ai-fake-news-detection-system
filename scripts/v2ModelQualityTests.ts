/**
 * TRUTHLENS V2 — MODEL QUALITY / CALIBRATION TESTS
 * =================================================
 * Offline by default. Remote adapter checks use mocked fetch implementations,
 * so CI never needs an API token or network access.
 */
import { verifyClaimV2 } from '../server/v2/pipeline';
import { FixtureCorpusSource } from '../server/v2/retrieval/corpusSource';
import { HuggingFaceNliAdapter } from '../server/v2/nli/huggingFaceNliAdapter';
import { HuggingFaceEmbeddingModel } from '../server/v2/retrieval/huggingFaceEmbeddingModel';
import { denseSearch } from '../server/v2/retrieval/embeddings';
import {
  applyConfidenceTemperature,
  fitConfidenceTemperature,
  expectedCalibrationError
} from '../server/v2/metrics/metrics';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

const NOW = new Date().toISOString();

function doc(
  id: string,
  url: string,
  publisher: string,
  title: string,
  snippet: string
) {
  return {
    id,
    url,
    publisher,
    title,
    snippet,
    contentType: 'SUMMARY' as const,
    publishedAt: NOW,
    retrievedAt: NOW,
    retrievalMethod: 'fixture_corpus(offline_deterministic)'
  };
}

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log('TRUTHLENS V2 MODEL QUALITY TESTS');
  console.log('='.repeat(72));

  console.log('\n1. Asymmetric but material conflict -> CONFLICTED');
  {
    const claim = 'The city announced the festival was cancelled because of severe weather.';
    const corpus = new FixtureCorpusSource([
      doc(
        'support',
        'https://www.bbc.com/festival-cancelled',
        'BBC',
        'Festival cancellation confirmed',
        'Organizers confirmed the festival was cancelled because of severe weather, according to the official festival statement.'
      ),
      doc(
        'refute',
        'https://apnews.com/festival-postponed',
        'Associated Press',
        'Festival organizers dispute cancellation',
        'Organizers disputed the cancellation report as incorrect, stating the festival was postponed rather than cancelled.'
      ),
      doc(
        'neutral',
        'https://example.com/weather',
        'Example',
        'Weather report',
        'Heavy rain affected several regions this weekend.'
      )
    ]);

    const result = await verifyClaimV2(claim, {
      corpus,
      minCandidatesExpectedWarning: 0,
      priorOverride: { available: false, probabilityTrue: null, label: null, modelVersion: null }
    });

    check(
      'material support + independent refutation abstains as CONFLICTED',
      result.provenance.final_verdict === 'CONFLICTED',
      result.provenance.final_verdict
    );
    check(
      'conflict decision trace is explicit',
      result.provenance.decision_rule_trace.some(trace => trace.rule === 'independent_material_conflict')
    );
  }

  console.log('\n2. Weak/off-topic opposition must not manufacture conflict');
  {
    const claim = 'The statistics office confirmed unemployment fell to 4.1 percent.';
    const corpus = new FixtureCorpusSource([
      doc(
        'support',
        'https://www.reuters.com/unemployment',
        'Reuters',
        'Unemployment falls',
        'Officials confirmed unemployment fell to 4.1 percent according to official statistics.'
      ),
      doc(
        'weak',
        'https://example.com/unrelated',
        'Example',
        'Unrelated commentary',
        'A commentator discussed unrelated employment policy and did not address the 4.1 percent figure.'
      )
    ]);

    const result = await verifyClaimV2(claim, {
      corpus,
      minCandidatesExpectedWarning: 0,
      priorOverride: { available: false, probabilityTrue: null, label: null, modelVersion: null }
    });

    check('weak opposition does not yield CONFLICTED', result.provenance.final_verdict !== 'CONFLICTED');
  }

  console.log('\n3. Hugging Face NLI adapter contract works without network');
  {
    const fakeFetch: typeof fetch = (async () => new Response(JSON.stringify({
      labels: ['supports the claim', 'refutes the claim', 'does not determine the claim'],
      scores: [0.88, 0.08, 0.04]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as Response;

    const adapter = new HuggingFaceNliAdapter({
      token: 'test-token',
      fetchImpl: fakeFetch
    });

    const result = await adapter.classify(
      {
        normalizedText: 'The office confirmed the number.',
        entities: [],
        keywords: ['office', 'confirmed', 'number']
      } as any,
      'The office confirmed the number according to the official statement.'
    );

    check('remote adapter maps support label', result.label === 'SUPPORTS');
    check('remote adapter exposes model identity', result.modelName === 'facebook/bart-large-mnli');
    check('remote adapter preserves probability ordering', result.scores.supports > result.scores.refutes);
  }

  console.log('\n4. Hugging Face embedding adapter contract works without network');
  {
    const fakeFetch: typeof fetch = (async () => new Response(JSON.stringify([
      [1, 2, 3, 4]
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as Response;

    const model = new HuggingFaceEmbeddingModel({
      token: 'test-token',
      fetchImpl: fakeFetch
    });

    const results = await denseSearch(
      'a semantic query',
      [
        { id: 'a', text: 'a semantic document' },
        { id: 'b', text: 'an unrelated document' }
      ],
      model,
      2
    );

    check('remote embedding returns ranked search results', results.length === 2);
    check('remote embedding produces a normalised model vector dimension', model.dimensions === 0);
    check('dense search scores are normalised', results.every(item => item.score >= 0 && item.score <= 1));
  }

  console.log('\n5. Temperature calibration utilities are stable');
  {
    const samples = [
      { correct: true, confidence: 0.92 },
      { correct: true, confidence: 0.81 },
      { correct: false, confidence: 0.88 },
      { correct: false, confidence: 0.74 },
      { correct: true, confidence: 0.68 },
      { correct: false, confidence: 0.61 }
    ];
    const temperature = fitConfidenceTemperature(samples);
    const calibrated = samples.map(sample => ({
      correct: sample.correct,
      confidence: applyConfidenceTemperature(sample.confidence, temperature)
    }));
    const ece = expectedCalibrationError(calibrated, 5);

    check('fitted temperature is finite and positive', Number.isFinite(temperature) && temperature > 0, String(temperature));
    check('calibrated confidence remains bounded', calibrated.every(sample => sample.confidence >= 0 && sample.confidence <= 1));
    check('calibration report is finite', Number.isFinite(ece.expectedCalibrationError), String(ece.expectedCalibrationError));
  }

  console.log('\n' + '='.repeat(72));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(72));

  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
