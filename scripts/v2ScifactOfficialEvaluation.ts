/**
 * TruthLens V2 — official SciFact evaluator adapter.
 *
 * Retrieval and NLI are performed by the normal V2 research pipeline.
 * For each directional candidate abstract, rationale sentences are selected
 * from the full abstract by claim/sentence embedding cosine similarity.
 * Gold rationale labels/indices are never passed into retrieval or selection.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyClaimV2 } from '../server/v2/pipeline.js';
import { DEFAULT_DECISION_THRESHOLDS } from '../server/v2/decision/decisionPolicy.js';
import { PretrainedNliAdapter } from '../server/v2/nli/pretrainedNliAdapter.js';
import { TransformerEmbeddingModel } from '../server/v2/retrieval/transformerEmbeddingModel.js';
import { SciFactOpenCorpusSource, SciFactDocumentInput } from '../server/v2/retrieval/scifactCorpusSource.js';
import { disposeMlWorker } from '../server/v2/ml/mlWorkerClient.js';
import { ALL_MODEL_MANIFESTS, getV2ModelDir, verifyModelHashes } from '../server/v2/ml/modelManifest.js';
import { rankRationaleSentences } from './scifactRationaleSelector.js';

interface Rationale { label: 'SUPPORT' | 'CONTRADICT'; sentences: number[]; }
interface SciFactClaim {
  id: number;
  claim: string;
  evidence: Record<string, Rationale[]>;
  cited_doc_ids: number[];
}
interface Prediction {
  id: number;
  evidence: Record<string, { label: 'SUPPORT' | 'CONTRADICT'; sentences: number[] }>;
}
const EXPECTED_CLAIMS_SHA = '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217';
const EXPECTED_CORPUS_SHA = 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62';
const EVALUATOR_COMMIT = '66feffc5b2cc9e28e3ce3b8c9e824c3c642981eb';

function arg(name: string): string | undefined {
  return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}
function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}
function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(value));
}
function sealedModelManifest() {
  return ALL_MODEL_MANIFESTS.map(manifest => ({
    kind: manifest.kind, id: manifest.id, base_model: manifest.baseModel,
    quantization: manifest.quantization, version_seal: manifest.versionSeal,
    files: manifest.files.map(file => ({
      path: file.path, bytes: file.bytes, sha256: file.sha256,
      git_blob_sha1: file.gitBlobSha1 ?? null
    }))
  }));
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') || path.join('data', 'external', 'scifact'));
  const claimsPath = path.join(dataDir, 'claims_dev.jsonl');
  const corpusPath = path.join(dataDir, 'corpus.jsonl');
  if (!fs.existsSync(claimsPath) || !fs.existsSync(corpusPath)) throw new Error(`SciFact data missing under ${dataDir}`);
  const claimsBytes = fs.readFileSync(claimsPath);
  const corpusBytes = fs.readFileSync(corpusPath);
  const claimsSha = sha256(claimsBytes);
  const corpusSha = sha256(corpusBytes);
  if (claimsSha !== EXPECTED_CLAIMS_SHA || corpusSha !== EXPECTED_CORPUS_SHA) {
    throw new Error(`SciFact hash mismatch: claims=${claimsSha}, corpus=${corpusSha}`);
  }
  const claims = readJsonl<SciFactClaim>(claimsPath).sort((a, b) => a.id - b.id);
  const corpus = readJsonl<SciFactDocumentInput>(corpusPath);
  if (claims.length !== 300 || corpus.length !== 5183) throw new Error(`Unexpected SciFact counts: ${claims.length} claims, ${corpus.length} docs`);
  const docsById = new Map(corpus.map(document => [String(document.doc_id), document]));

  const modelDir = getV2ModelDir();
  for (const manifest of ALL_MODEL_MANIFESTS) {
    const verified = await verifyModelHashes(modelDir, manifest);
    if (!verified.ok) throw new Error(`Model seal verification failed: ${manifest.id}: ${verified.mismatches.join('; ')}`);
  }
  const modelManifest = sealedModelManifest();
  const modelManifestSha256 = sha256Json(modelManifest);
  const embeddingModel = new TransformerEmbeddingModel();
  const nliAdapter = new PretrainedNliAdapter({ embeddingModel, relatednessFloor: 0.15 });
  const source = new SciFactOpenCorpusSource(corpus, {
    topK: 100, denseEmbeddingModel: embeddingModel, denseTopK: 300,
    enableDenseRetrieval: true, denseBatchSize: 32
  });
  const config = {
    task: 'scifact_official_open_retrieval',
    candidate_pool_k: 100, dense_retrieval_k: 300, final_pipeline_k: 8,
    per_query_top_k: 15, nli_concurrency: 8, relatedness_floor: 0.15,
    rationale_selection: 'top 3 original abstract sentences by claim/sentence embedding cosine similarity',
    rationale_selector_model: embeddingModel.name,
    nli_model: nliAdapter.modelName,
    decision_thresholds: DEFAULT_DECISION_THRESHOLDS
  };
  const configSha256 = sha256Json(config);
  const sourceCommitSha = process.env.TRUTHLENS_EVALUATED_COMMIT_SHA || process.env.GITHUB_SHA || null;
  const predictions: Prediction[] = [];
  const traces: Array<Record<string, unknown>> = [];

  try {
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      source.resetCandidateIds();
      const result = await verifyClaimV2(claim.claim, {
        corpus: source,
        nliAdapter,
        nliConcurrency: 8,
        retrieval: { embeddingModel, perQueryTopK: 15, finalTopK: 8 },
        thresholds: DEFAULT_DECISION_THRESHOLDS,
        enableFullTextEnrichment: false,
        minCandidatesExpectedWarning: 0
      });

      const directionalEvidence = result.provenance.evidence.filter(e =>
        e.nli_label === 'SUPPORTS' || e.nli_label === 'REFUTES'
      );
      const sentenceRows: Array<{ docId: string; label: 'SUPPORT' | 'CONTRADICT'; index: number; text: string }> = [];
      for (const evidence of directionalEvidence) {
        const doc = docsById.get(evidence.evidence_id);
        if (!doc) throw new Error(`Retrieved SciFact doc ${evidence.evidence_id} is absent from the frozen corpus.`);
        for (let sentenceIndex = 0; sentenceIndex < doc.abstract.length; sentenceIndex++) {
          const text = (doc.abstract[sentenceIndex] || '').trim();
          if (!text) continue;
          sentenceRows.push({
            docId: evidence.evidence_id,
            label: evidence.nli_label === 'SUPPORTS' ? 'SUPPORT' : 'CONTRADICT',
            index: sentenceIndex,
            text
          });
        }
      }

      const prediction: Prediction = { id: claim.id, evidence: {} };
      const traceEvidence: Array<Record<string, unknown>> = [];
      if (sentenceRows.length) {
        const claimVector = embeddingModel.embed(claim.claim);
        const sentenceVectors = embeddingModel.embedBatch(sentenceRows.map(row => row.text));
        if (sentenceVectors.length !== sentenceRows.length) throw new Error('Rationale selector embedding count mismatch.');
        for (const evidence of directionalEvidence) {
          const rowsForDoc = sentenceRows.map((row, index) => ({ ...row, vector: sentenceVectors[index] }))
            .filter(row => row.docId === evidence.evidence_id);
          if (!rowsForDoc.length) continue;
          const ranked = rankRationaleSentences(claimVector, rowsForDoc.map(row => row.vector), 3);
          const selected = ranked.map(item => ({
            sentence_index: rowsForDoc[item.index].index,
            cosine_similarity: item.score
          }));
          prediction.evidence[evidence.evidence_id] = {
            label: evidence.nli_label === 'SUPPORTS' ? 'SUPPORT' : 'CONTRADICT',
            sentences: selected.map(item => item.sentence_index)
          };
          traceEvidence.push({
            evidence_id: evidence.evidence_id,
            nli_label: evidence.nli_label,
            nli_confidence: evidence.nli_confidence,
            rerank_score: evidence.rerank_score,
            selected_sentences: selected
          });
        }
      }
      predictions.push(prediction);
      traces.push({
        id: claim.id,
        retrieved_candidate_count: source.getCandidateIds().length,
        directional_evidence_count: directionalEvidence.length,
        predicted_evidence_count: Object.keys(prediction.evidence).length,
        evidence: traceEvidence
      });
      if ((i + 1) % 10 === 0 || i + 1 === claims.length) console.log(`processed ${i + 1}/${claims.length} SciFact claims`);
    }

    const outputDir = path.resolve(arg('output-dir') || path.join('artifacts', 'v2-scifact-official'));
    fs.mkdirSync(outputDir, { recursive: true });
    const predictionsPath = path.join(outputDir, 'scifact-official-predictions.jsonl');
    const predictionsText = predictions.map(row => JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(predictionsPath, predictionsText);
    const report = {
      protocol_version: 'truthlens-v2-scifact-official-evaluation-v1',
      benchmark: true,
      benchmark_id: 'scifact',
      gold_evidence_in_retrieval: false,
      generated_at: new Date().toISOString(),
      run_provenance: {
        source_commit_sha: sourceCommitSha,
        source_ref: process.env.GITHUB_REF || null,
        event_name: process.env.GITHUB_EVENT_NAME || 'local',
        workflow_run_id: process.env.GITHUB_RUN_ID || null,
        workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
        config_sha256: configSha256,
        model_manifest_sha256: modelManifestSha256
      },
      evaluator: {
        repository: 'allenai/scifact-evaluator',
        commit: EVALUATOR_COMMIT,
        official_metrics: ['abstract_label_only', 'abstract_rationalized', 'sentence_selection', 'sentence_label']
      },
      config,
      dataset: {
        name: 'SciFact', split: 'dev', claims_evaluated: claims.length,
        corpus_documents: corpus.length, claims_sha256: claimsSha, corpus_sha256: corpusSha
      },
      models: {
        nli: { name: nliAdapter.modelName, version: nliAdapter.modelVersion },
        embedding: { name: embeddingModel.name, version: embeddingModel.version },
        manifest_sha256: modelManifestSha256,
        sealed_manifest: modelManifest
      },
      predictions: {
        file: path.basename(predictionsPath),
        rows: predictions.length,
        sha256: sha256(predictionsText)
      },
      trace: traces
    };
    const reportPath = path.join(outputDir, 'scifact-official-provenance.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({
      protocol_version: report.protocol_version,
      dataset: report.dataset,
      source_commit_sha: sourceCommitSha,
      predictions: report.predictions,
      provenance_file: reportPath
    }, null, 2));
  } finally {
    await disposeMlWorker();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
