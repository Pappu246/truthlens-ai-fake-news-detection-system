/**
 * TRUTHLENS V2 — MODEL QUALITY / CALIBRATION TESTS
 * =================================================
 * Offline by default. Remote adapter checks use mocked fetch implementations,
 * so CI never needs an API token or network access.
 */
import { verifyClaimV2 } from '../server/v2/pipeline';
import { decideVerdict } from '../server/v2/decision/decisionPolicy';
import { FixtureCorpusSource } from '../server/v2/retrieval/corpusSource';
import { HuggingFaceNliAdapter } from '../server/v2/nli/huggingFaceNliAdapter';
import { PretrainedNliAdapter } from '../server/v2/nli/pretrainedNliAdapter';
import { HuggingFaceEmbeddingModel } from '../server/v2/retrieval/huggingFaceEmbeddingModel';
import { denseSearch } from '../server/v2/retrieval/embeddings';
import { rerankEvidence } from '../server/v2/rerank/reranker';
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

  console.log('\\n1. Asymmetric but material conflict -> CONFLICTED');
  {
    const evidence = [
      {
        id: 'support', url: 'https://www.bbc.com/festival-cancelled', domainClusterId: 'bbc.com',
        rerankScore: 1, isDuplicateCluster: false,
        nli: { label: 'SUPPORTS', confidence: 0.90, scores: { supports: 0.90, refutes: 0.05, neutral: 0.05, unclear: 0 } }
      },
      {
        id: 'refute', url: 'https://apnews.com/festival-postponed', domainClusterId: 'apnews.com',
        rerankScore: 0.80, isDuplicateCluster: false,
        nli: { label: 'REFUTES', confidence: 0.90, scores: { supports: 0.05, refutes: 0.90, neutral: 0.05, unclear: 0 } }
      }
    ] as any;

    const decision = decideVerdict(evidence, {
      available: false,
      probabilityTrue: null,
      label: null,
      modelVersion: null
    });

    check('asymmetric but material support/refutation yields CONFLICTED', decision.verdict === 'CONFLICTED', decision.verdict);
    check('conflict decision trace is explicit', decision.ruleTrace.some((trace: any) => trace.rule === 'independent_material_conflict'));
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
    let capturedBody = '';
    const fakeFetch: typeof fetch = (async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        labels: ['supports the claim', 'refutes the claim', 'does not determine the claim'],
        scores: [0.88, 0.08, 0.04]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

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
    check('remote adapter sends the actual claim in the NLI hypothesis', capturedBody.includes('The office confirmed the number.'));
  }



  console.log('\n3b. Batched pretrained NLI collapses repeated whitespace consistently');
  {
    let capturedHypothesis = '';
    const fakeClient = {
      classifyBatch: (inputs: Array<{ premise: string; hypothesis: string; maxTokens: number }>) => {
        capturedHypothesis = inputs[0]?.hypothesis || '';
        return inputs.map(() => ({
          probs: { entailment: 0.70, contradiction: 0.10, neutral: 0.20 }
        }));
      }
    } as any;
    const fakeEmbedding = {
      name: 'test-embedding',
      version: 'test',
      dimensions: 3,
      embed: () => [1, 0, 0],
      embedBatch: (texts: string[]) => texts.map(() => [1, 0, 0])
    } as any;
    const adapter = new PretrainedNliAdapter({
      client: fakeClient,
      embeddingModel: fakeEmbedding,
      relatednessFloor: 0
    });
    const result = adapter.classifyBatch(
      {
        normalizedText: 'Office   confirmed   the   number.',
        entities: [],
        keywords: ['office', 'confirmed', 'number']
      } as any,
      ['The office confirmed the number according to the official statement.']
    );
    check('batch NLI receives normalized whitespace', capturedHypothesis === 'Office confirmed the number.');
    check('batch NLI still returns a classification', result.length === 1 && result[0].label === 'SUPPORTS');
  }

  console.log('\n4. Hugging Face embedding adapter contract works without network');
  {
    let embeddingRequestInputs: unknown = null;
    let firstBatchInputCount = 0;
    const fakeFetch: typeof fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { inputs?: unknown };
      if (firstBatchInputCount === 0 && Array.isArray(body.inputs)) {
        firstBatchInputCount = body.inputs.length;
      }
      embeddingRequestInputs = body.inputs;
      const count = Array.isArray(body.inputs) ? body.inputs.length : 1;
      const vectors = Array.from({ length: count }, (_value, index) => {
        if (index === 0) return [1, 0, 0, 0];
        if (index === 1) return [1, 0, 0, 0];
        return [0.5, 0.5, 0, 0];
      });
      return new Response(JSON.stringify(Array.isArray(body.inputs) ? vectors : [1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

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

    const vector = await model.embed('semantic test');
    check('remote embedding returns ranked search results', results.length === 2);
    check('remote embedding batches query + documents in one request', firstBatchInputCount === 3);
    check('remote embedding returns a numeric vector', vector.length === 4 && vector.every(Number.isFinite));
    check('dense search scores are normalised', results.every(item => item.score >= 0 && item.score <= 1));
  }

  console.log('\n5. Synthetic benchmark documents retain document-level independence');
  {
    const candidates = [
      {
        ...doc('1', 'https://scifact.local/document/1', 'SciFact corpus', 'Paper one', 'supports the scientific claim'),
        canonicalUrl: 'https://scifact.local/document/1', foundBy: [], lexicalScore: 1, denseScore: 1, fusionScore: 1
      },
      {
        ...doc('2', 'https://scifact.local/document/2', 'SciFact corpus', 'Paper two', 'supports the scientific claim differently'),
        canonicalUrl: 'https://scifact.local/document/2', foundBy: [], lexicalScore: 0.9, denseScore: 0.9, fusionScore: 0.9
      }
    ] as any;
    const ranked = rerankEvidence(candidates);
    check('first synthetic document is independent', ranked.find(e => e.id === '1')?.isDuplicateCluster === false);
    check('second synthetic document is not falsely treated as same-domain duplicate', ranked.find(e => e.id === '2')?.isDuplicateCluster === false);
    check('synthetic source cluster keeps document identity',
      new Set(ranked.map(e => e.domainClusterId)).size === 2,
      ranked.map(e => e.domainClusterId).join(' | '));
  }

  console.log('\n6. Temperature calibration utilities are stable');
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
