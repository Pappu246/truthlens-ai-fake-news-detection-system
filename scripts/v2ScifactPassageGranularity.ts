/**
 * Research-only paired SciFact passage-granularity diagnostic.
 *
 * For the SAME claim/document rationale pair, compare the model's prediction
 * on (A) the complete abstract used by the current end-to-end pipeline and
 * (B) the annotated rationale sentence(s). This isolates context dilution
 * from retrieval and verdict aggregation. Gold rationale text is an oracle
 * diagnostic input, never an open-retrieval benchmark result.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildClaim } from '../server/v2/queryExpansion.js';
import { PretrainedNliAdapter } from '../server/v2/nli/pretrainedNliAdapter.js';
import { TransformerEmbeddingModel } from '../server/v2/retrieval/transformerEmbeddingModel.js';
import { MlWorkerClient } from '../server/v2/ml/mlWorkerClient.js';
import { ALL_MODEL_MANIFESTS, getV2ModelDir, verifyModelHashes } from '../server/v2/ml/modelManifest.js';
import type { NliLabel } from '../server/v2/types.js';

type GoldLabel = 'SUPPORTS' | 'REFUTES' | 'NEUTRAL';
interface Rationale { label: 'SUPPORT' | 'CONTRADICT'; sentences: number[]; }
interface SciFactClaim { id: number; claim: string; evidence: Record<string, Rationale[]>; }
interface SciFactDocument { doc_id: number; title: string; abstract: string[]; structured?: boolean; }
interface Pair {
  claim_id: number;
  document_id: string;
  rationale_index: number;
  gold: GoldLabel;
  full_abstract: string;
  rationale_passage: string;
}

const EXPECTED_CLAIMS_SHA = '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217';
const EXPECTED_CORPUS_SHA = 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62';
const LABELS: GoldLabel[] = ['SUPPORTS', 'REFUTES', 'NEUTRAL'];
const OUTPUT_LABELS: NliLabel[] = ['SUPPORTS', 'REFUTES', 'NEUTRAL', 'UNCLEAR'];
const RELATEDNESS_FLOOR = 0.15;

function arg(name: string): string | undefined {
  return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}
function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function sha256File(file: string): string {
  return sha256(fs.readFileSync(file));
}
function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(value));
}
function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}
function modelSeal() {
  return ALL_MODEL_MANIFESTS.map(manifest => ({
    kind: manifest.kind,
    id: manifest.id,
    base_model: manifest.baseModel,
    quantization: manifest.quantization,
    version_seal: manifest.versionSeal,
    files: manifest.files.map(file => ({
      path: file.path, bytes: file.bytes, sha256: file.sha256, git_blob_sha1: file.gitBlobSha1 ?? null
    }))
  }));
}

export function calculateMetrics(predictions: NliLabel[], gold: GoldLabel[]) {
  if (predictions.length !== gold.length || gold.length === 0) {
    throw new Error('Passage-granularity metrics require equal non-empty prediction and gold arrays.');
  }
  const perClass = LABELS.map(label => {
    let tp = 0, fp = 0, fn = 0, support = 0;
    for (let i = 0; i < gold.length; i++) {
      if (gold[i] === label) support++;
      if (predictions[i] === label && gold[i] === label) tp++;
      if (predictions[i] === label && gold[i] !== label) fp++;
      if (predictions[i] !== label && gold[i] === label) fn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    return { label, precision, recall, f1, support };
  });
  const confusion = LABELS.map(goldLabel => ({
    gold: goldLabel,
    predicted: Object.fromEntries(OUTPUT_LABELS.map(predictedLabel => [
      predictedLabel,
      gold.reduce((count, actual, index) =>
        count + Number(actual === goldLabel && predictions[index] === predictedLabel), 0)
    ]))
  }));
  return {
    passages: gold.length,
    accuracy: predictions.reduce((count, prediction, index) =>
      count + Number(prediction === gold[index]), 0) / gold.length,
    macro_f1: perClass.reduce((sum, item) => sum + item.f1, 0) / LABELS.length,
    gold_label_counts: Object.fromEntries(LABELS.map(label => [label, gold.filter(value => value === label).length])),
    predicted_label_counts: Object.fromEntries(OUTPUT_LABELS.map(label => [label, predictions.filter(value => value === label).length])),
    per_class: perClass,
    confusion_matrix: confusion
  };
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') || process.env.TRUTHLENS_SCIFACT_DATA_DIR || '/tmp/truthlens-scifact/scifact');
  const claimsPath = path.join(dataDir, 'claims_dev.jsonl');
  const corpusPath = path.join(dataDir, 'corpus.jsonl');
  if (!fs.existsSync(claimsPath) || !fs.existsSync(corpusPath)) throw new Error(`SciFact data missing under ${dataDir}`);
  const claimsSha = sha256File(claimsPath);
  const corpusSha = sha256File(corpusPath);
  if (claimsSha !== EXPECTED_CLAIMS_SHA || corpusSha !== EXPECTED_CORPUS_SHA) {
    throw new Error(`SciFact hash mismatch: claims=${claimsSha}, corpus=${corpusSha}`);
  }

  const modelDir = getV2ModelDir();
  for (const manifest of ALL_MODEL_MANIFESTS) {
    const verified = await verifyModelHashes(modelDir, manifest);
    if (!verified.ok) throw new Error(`Model seal verification failed for ${manifest.id}: ${verified.mismatches.join('; ')}`);
  }

  const claims = readJsonl<SciFactClaim>(claimsPath).sort((a, b) => a.id - b.id);
  const corpus = readJsonl<SciFactDocument>(corpusPath);
  if (claims.length !== 300 || corpus.length !== 5183) {
    throw new Error(`Unexpected frozen SciFact counts: claims=${claims.length}, documents=${corpus.length}`);
  }
  const docsById = new Map(corpus.map(document => [String(document.doc_id), document]));
  const maxClaims = Math.max(1, Math.min(Number(arg('max-claims') || claims.length), claims.length));
  const pairs: Pair[] = [];

  for (const claim of claims.slice(0, maxClaims)) {
    for (const [docId, rationales] of Object.entries(claim.evidence || {})) {
      const doc = docsById.get(docId);
      if (!doc) throw new Error(`Missing SciFact document ${docId} for claim ${claim.id}`);
      const fullAbstract = doc.abstract.join(' ').trim();
      if (!fullAbstract) throw new Error(`Empty abstract for SciFact document ${docId}`);
      for (const [rationaleIndex, rationale] of rationales.entries()) {
        const rationalePassage = rationale.sentences.map(index => doc.abstract[index]).filter(Boolean).join(' ').trim();
        if (!rationalePassage) throw new Error(`Empty rationale passage for claim ${claim.id}, document ${docId}`);
        pairs.push({
          claim_id: claim.id,
          document_id: docId,
          rationale_index: rationaleIndex,
          gold: rationale.label === 'SUPPORT' ? 'SUPPORTS' : 'REFUTES',
          full_abstract: fullAbstract,
          rationale_passage: rationalePassage
        });
      }
    }
  }
  if (pairs.length === 0) throw new Error('No gold SciFact rationale pairs were materialized.');

  const client = new MlWorkerClient();
  const embedding = new TransformerEmbeddingModel(client);
  const adapter = new PretrainedNliAdapter({
    client,
    embeddingModel: embedding,
    relatednessFloor: RELATEDNESS_FLOOR,
    researchTrace: true
  });
  const fullPredictions: NliLabel[] = [];
  const rationalePredictions: NliLabel[] = [];
  const gold: GoldLabel[] = [];
  const rows: Array<Record<string, unknown>> = [];

  try {
    const pairsByClaim = new Map<number, Pair[]>();
    for (const pair of pairs) {
      const group = pairsByClaim.get(pair.claim_id) ?? [];
      group.push(pair);
      pairsByClaim.set(pair.claim_id, group);
    }
    let processed = 0;
    for (const [claimId, group] of pairsByClaim) {
      const sourceClaim = claims.find(item => item.id === claimId);
      if (!sourceClaim) throw new Error(`Missing claim ${claimId}`);
      const builtClaim = buildClaim(sourceClaim.claim);
      const fullResults = adapter.classifyBatch(builtClaim, group.map(item => item.full_abstract));
      const rationaleResults = adapter.classifyBatch(builtClaim, group.map(item => item.rationale_passage));
      if (fullResults.length !== group.length || rationaleResults.length !== group.length) {
        throw new Error(`NLI output count mismatch for claim ${claimId}`);
      }
      for (let index = 0; index < group.length; index++) {
        const pair = group[index];
        const full = fullResults[index];
        const rationale = rationaleResults[index];
        gold.push(pair.gold);
        fullPredictions.push(full.label);
        rationalePredictions.push(rationale.label);
        rows.push({
          claim_id: pair.claim_id,
          document_id: pair.document_id,
          rationale_index: pair.rationale_index,
          gold: pair.gold,
          full_abstract_prediction: full.label,
          rationale_sentence_prediction: rationale.label,
          full_abstract_confidence: full.confidence,
          rationale_sentence_confidence: rationale.confidence,
          full_abstract_relatedness: full.research_trace?.relatedness_cosine ?? null,
          rationale_relatedness: rationale.research_trace?.relatedness_cosine ?? null,
          full_abstract_raw_probabilities: full.research_trace?.raw_probabilities ?? null,
          rationale_raw_probabilities: rationale.research_trace?.raw_probabilities ?? null
        });
      }
      processed += group.length;
      if (processed % 50 < group.length || processed === pairs.length) {
        console.log(`processed ${processed}/${pairs.length} rationale pairs`);
      }
    }

    const fullMetrics = calculateMetrics(fullPredictions, gold);
    const rationaleMetrics = calculateMetrics(rationalePredictions, gold);
    const transitions = {
      full_abstract_correct_rationale_wrong: rows.filter(row =>
        row.full_abstract_prediction === row.gold && row.rationale_sentence_prediction !== row.gold).length,
      rationale_correct_full_abstract_wrong: rows.filter(row =>
        row.rationale_sentence_prediction === row.gold && row.full_abstract_prediction !== row.gold).length,
      both_correct: rows.filter(row =>
        row.full_abstract_prediction === row.gold && row.rationale_sentence_prediction === row.gold).length,
      both_wrong: rows.filter(row =>
        row.full_abstract_prediction !== row.gold && row.rationale_sentence_prediction !== row.gold).length
    };
    const config = {
      task: 'paired_scifact_passage_granularity',
      split: 'dev',
      relatedness_floor: RELATEDNESS_FLOOR,
      max_pair_tokens: 384,
      rationale_passage_source: 'official SciFact annotated evidence sentence indices',
      full_abstract_source: 'same SciFact document abstract used by current open-retrieval adapter',
      oracle_rationale_input: true
    };
    const manifest = modelSeal();
    const report = {
      protocol_version: 'truthlens-v2-scifact-passage-granularity-v1',
      generated_at: new Date().toISOString(),
      benchmark: false,
      analysis_only: true,
      task: 'Paired component diagnostic; not end-to-end accuracy, not open-retrieval performance, and not a production release gate.',
      run_provenance: {
        source_commit_sha: process.env.GITHUB_SHA || null,
        source_ref: process.env.GITHUB_REF || null,
        event_name: process.env.GITHUB_EVENT_NAME || 'local',
        workflow_run_id: process.env.GITHUB_RUN_ID || null,
        config_sha256: sha256Json(config),
        model_manifest_sha256: sha256Json(manifest)
      },
      config,
      dataset: {
        name: 'SciFact',
        split: 'dev',
        claims_evaluated: Math.min(maxClaims, claims.length),
        corpus_documents: corpus.length,
        rationale_pairs: pairs.length,
        claims_sha256: claimsSha,
        corpus_sha256: corpusSha
      },
      model: {
        name: adapter.modelName,
        version: adapter.modelVersion,
        manifest_sha256: sha256Json(manifest),
        sealed_manifest: manifest
      },
      paired_metrics: {
        full_abstract: fullMetrics,
        rationale_sentence: rationaleMetrics,
        delta_accuracy_rationale_minus_full: rationaleMetrics.accuracy - fullMetrics.accuracy,
        delta_macro_f1_rationale_minus_full: rationaleMetrics.macro_f1 - fullMetrics.macro_f1,
        paired_transitions: transitions
      },
      interpretation_limits: [
        'Each full-abstract and rationale-sentence prediction uses the same claim, document, model weights, relatedness floor, and model adapter.',
        'The rationale sentence is gold-annotated oracle evidence. Its result is a diagnostic upper-bound comparison, not an attainable open-retrieval score.',
        'A gain on rationale sentences would support a context-dilution hypothesis but would not alone prove that sentence segmentation improves end-to-end verification.',
        'No retrieval, production pipeline, decision policy, threshold, or model weight is changed.'
      ],
      rows
    };
    const outputPath = path.resolve(arg('output') || path.join('artifacts', 'v2-scifact-e2e', 'scifact-passage-granularity.json'));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({
      protocol_version: report.protocol_version,
      rationale_pairs: pairs.length,
      full_abstract: { accuracy: fullMetrics.accuracy, macro_f1: fullMetrics.macro_f1, per_class: fullMetrics.per_class },
      rationale_sentence: { accuracy: rationaleMetrics.accuracy, macro_f1: rationaleMetrics.macro_f1, per_class: rationaleMetrics.per_class },
      delta_accuracy_rationale_minus_full: report.paired_metrics.delta_accuracy_rationale_minus_full,
      delta_macro_f1_rationale_minus_full: report.paired_metrics.delta_macro_f1_rationale_minus_full,
      paired_transitions: transitions,
      artifact: outputPath
    }, null, 2));
  } finally {
    await client.dispose();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
