/**
 * Sealed NLI candidate comparison on the exact SciFact dev evidence passages.
 *
 * This is a component diagnostic, not an end-to-end benchmark or release gate.
 * Both models receive identical premise/hypothesis pairs, and each candidate
 * must have a recorded content seal and pass local SHA-256 verification.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildClaim } from '../server/v2/queryExpansion.js';
import { PretrainedNliAdapter } from '../server/v2/nli/pretrainedNliAdapter.js';
import { TransformerEmbeddingModel } from '../server/v2/retrieval/transformerEmbeddingModel.js';
import { MlWorkerClient } from '../server/v2/ml/mlWorkerClient.js';
import {
  ALL_MODEL_MANIFESTS,
  DISTILBERT_MNLI_CANDIDATE,
  findExperimentalCandidate,
  getV2ModelDir,
  type ExperimentalNliCandidate,
  verifyCandidateHashes,
  verifyModelHashes
} from '../server/v2/ml/modelManifest.js';
import type { NliLabel } from '../server/v2/types.js';

type GoldLabel = 'SUPPORTS' | 'REFUTES' | 'NEUTRAL';
interface Rationale {
  label: 'SUPPORT' | 'CONTRADICT';
  sentences: number[];
}
interface SciFactClaim {
  id: number;
  claim: string;
  evidence: Record<string, Rationale[]>;
  cited_doc_ids: number[];
}
interface SciFactDocument {
  doc_id: number;
  title: string;
  abstract: string[];
  structured: boolean;
}

const EXPECTED_CLAIMS_SHA = '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217';
const EXPECTED_CORPUS_SHA = 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62';
const TARGET_LABELS: GoldLabel[] = ['SUPPORTS', 'REFUTES', 'NEUTRAL'];
const OUTPUT_LABELS: NliLabel[] = ['SUPPORTS', 'REFUTES', 'NEUTRAL', 'UNCLEAR'];
const RELATEDNESS_FLOOR = 0.15;

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}
function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function sha256File(file: string): string {
  return sha256(fs.readFileSync(file));
}
function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}
function metrics(predictions: NliLabel[], gold: GoldLabel[], confidences: number[]) {
  if (predictions.length !== gold.length || gold.length === 0 || confidences.length !== gold.length) {
    throw new Error('NLI comparison requires equal non-empty prediction, gold, and confidence arrays.');
  }
  const perClass = TARGET_LABELS.map(label => {
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
  const correct = predictions.reduce((n, prediction, i) => n + Number(prediction === gold[i]), 0);
  const covered = predictions.reduce((n, prediction) => n + Number(prediction !== 'UNCLEAR'), 0);
  const coveredCorrect = predictions.reduce((n, prediction, i) => n + Number(prediction !== 'UNCLEAR' && prediction === gold[i]), 0);
  const confusionMatrix = TARGET_LABELS.map(goldLabel => ({
    gold: goldLabel,
    predicted: Object.fromEntries(OUTPUT_LABELS.map(predictedLabel => [
      predictedLabel,
      gold.reduce((n, actual, i) => n + Number(actual === goldLabel && predictions[i] === predictedLabel), 0)
    ]))
  }));
  const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, accuracy: 0 }));
  for (let i = 0; i < predictions.length; i++) {
    const confidence = Math.max(0, Math.min(1, confidences[i]));
    const index = Math.min(9, Math.floor(Math.min(0.999999, confidence) * 10));
    bins[index].count++;
    bins[index].confidence += confidence;
    bins[index].accuracy += Number(predictions[i] === gold[i]);
  }
  const ece = bins.reduce((sum, bin) => {
    if (!bin.count) return sum;
    return sum + (bin.count / predictions.length) * Math.abs(
      bin.accuracy / bin.count - bin.confidence / bin.count
    );
  }, 0);
  return {
    passages: gold.length,
    accuracy: correct / gold.length,
    macro_f1: perClass.reduce((n, item) => n + item.f1, 0) / TARGET_LABELS.length,
    ece,
    coverage: covered / gold.length,
    unclear_rate: (gold.length - covered) / gold.length,
    selective_accuracy: covered ? coveredCorrect / covered : 0,
    gold_label_counts: Object.fromEntries(TARGET_LABELS.map(label => [label, gold.filter(value => value === label).length])),
    predicted_label_counts: Object.fromEntries(OUTPUT_LABELS.map(label => [label, predictions.filter(value => value === label).length])),
    per_class: perClass,
    confusion_matrix: confusionMatrix
  };
}

function percentile(values: number[], probability: number): number {
  if (!values.length) throw new Error('Bootstrap percentile requires non-empty samples.');
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, ordered.length - 1);
  const fraction = position - lower;
  return ordered[lower] * (1 - fraction) + ordered[upper] * fraction;
}

function bootstrapClaimClusterComparison(
  rows: Array<Record<string, unknown>>,
  resamples = 10_000,
  seed = 20_261_128
) {
  const clusters = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = String(row.claim_id);
    const group = clusters.get(key) ?? [];
    group.push(row);
    clusters.set(key, group);
  }
  const claimIds = [...clusters.keys()].sort();
  if (claimIds.length < 2) throw new Error('Claim-cluster bootstrap requires at least two distinct claims.');

  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const deltas = {
    accuracy: [] as number[],
    macro_f1: [] as number[],
    ece: [] as number[]
  };
  for (let iteration = 0; iteration < resamples; iteration++) {
    const sample: Array<Record<string, unknown>> = [];
    for (let draw = 0; draw < claimIds.length; draw++) {
      const selected = claimIds[Math.floor(random() * claimIds.length)];
      sample.push(...(clusters.get(selected) ?? []));
    }
    const gold = sample.map(row => row.gold as GoldLabel);
    const baselinePredictions = sample.map(row => row.baseline_prediction as NliLabel);
    const candidatePredictions = sample.map(row => row.candidate_prediction as NliLabel);
    const baselineConfidences = sample.map(row => Number(row.baseline_confidence));
    const candidateConfidences = sample.map(row => Number(row.candidate_confidence));
    const baselineMetrics = metrics(baselinePredictions, gold, baselineConfidences);
    const candidateMetrics = metrics(candidatePredictions, gold, candidateConfidences);
    deltas.accuracy.push(candidateMetrics.accuracy - baselineMetrics.accuracy);
    deltas.macro_f1.push(candidateMetrics.macro_f1 - baselineMetrics.macro_f1);
    deltas.ece.push(candidateMetrics.ece - baselineMetrics.ece);
  }
  const originalGold = rows.map(row => row.gold as GoldLabel);
  const originalBaseline = metrics(
    rows.map(row => row.baseline_prediction as NliLabel),
    originalGold,
    rows.map(row => Number(row.baseline_confidence))
  );
  const originalCandidate = metrics(
    rows.map(row => row.candidate_prediction as NliLabel),
    originalGold,
    rows.map(row => Number(row.candidate_confidence))
  );
  const summarize = (values: number[], estimate: number) => ({
    estimate,
    ci_95_percentile: [percentile(values, 0.025), percentile(values, 0.975)]
  });
  const goldCounts = Object.fromEntries(TARGET_LABELS.map(label => [
    label,
    rows.filter(row => row.gold === label).length
  ]));
  return {
    bootstrap_unit: 'claim_id; all evidence pairs for each sampled claim remain grouped',
    distinct_claim_clusters: claimIds.length,
    paired_rows: rows.length,
    resamples,
    seed,
    interval: 'two-sided 95% percentile interval; exploratory component diagnostic',
    delta_candidate_minus_baseline: {
      accuracy: summarize(deltas.accuracy, originalCandidate.accuracy - originalBaseline.accuracy),
      macro_f1: summarize(deltas.macro_f1, originalCandidate.macro_f1 - originalBaseline.macro_f1),
      ece: summarize(deltas.ece, originalCandidate.ece - originalBaseline.ece)
    },
    gold_label_counts: goldCounts
  };
}

function nliSeal() {
  return ALL_MODEL_MANIFESTS.map(manifest => ({
    kind: manifest.kind,
    id: manifest.id,
    base_model: manifest.baseModel,
    quantization: manifest.quantization,
    version_seal: manifest.versionSeal,
    files: manifest.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, git_blob_sha1: file.gitBlobSha1 ?? null }))
  }));
}
function candidateSeal(candidate: ExperimentalNliCandidate) {
  return {
    id: candidate.id,
    base_model: candidate.baseModel,
    revision: candidate.revision,
    quantization: candidate.quantization,
    version_seal: candidate.versionSeal,
    files: candidate.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, git_blob_sha1: file.gitBlobSha1 ?? null }))
  };
}

async function main(): Promise<void> {
  const explicitDataDir = arg('data-dir') || process.env.TRUTHLENS_SCIFACT_DATA_DIR;
  // Prefer an explicit caller path. For local CI workflows that download the
  // frozen data to a temporary directory, discover only known scratch paths
  // when no argument/environment override was supplied; never guess another
  // dataset or bypass the exact SHA-256 checks below.
  const defaultCandidates = [
    path.join('data', 'external', 'scifact'),
    '/tmp/truthlens-model-quality/scifact',
    '/tmp/truthlens-scifact/scifact'
  ];
  const selectedDataDir = explicitDataDir || defaultCandidates.find(candidate =>
    fs.existsSync(path.join(candidate, 'claims_dev.jsonl')) &&
    fs.existsSync(path.join(candidate, 'corpus.jsonl'))
  ) || defaultCandidates[0];
  const dataDir = path.resolve(selectedDataDir);
  const claimsPath = path.join(dataDir, 'claims_dev.jsonl');
  const corpusPath = path.join(dataDir, 'corpus.jsonl');
  if (!fs.existsSync(claimsPath) || !fs.existsSync(corpusPath)) throw new Error(`SciFact data missing under ${dataDir}; set --data-dir or TRUTHLENS_SCIFACT_DATA_DIR.`);
  const claimsSha = sha256File(claimsPath);
  const corpusSha = sha256File(corpusPath);
  if (claimsSha !== EXPECTED_CLAIMS_SHA || corpusSha !== EXPECTED_CORPUS_SHA) {
    throw new Error(`SciFact hash mismatch: claims=${claimsSha}, corpus=${corpusSha}`);
  }

  const candidateId = arg('candidate') || DISTILBERT_MNLI_CANDIDATE.id;
  const candidateModel = findExperimentalCandidate(candidateId);
  if (!candidateModel) throw new Error(`Unknown comparison candidate '${candidateId}'.`);

  const modelDir = getV2ModelDir();
  for (const manifest of ALL_MODEL_MANIFESTS) {
    const verified = await verifyModelHashes(modelDir, manifest);
    if (!verified.ok) throw new Error(`Baseline model seal failed for ${manifest.id}: ${verified.mismatches.join('; ')}`);
  }
  const candidateVerification = verifyCandidateHashes(candidateModel.id, modelDir);
  if (!candidateVerification.ok) {
    throw new Error(`Comparison candidate seal failed: ${candidateVerification.mismatches.join('; ')}. Provision it only via npm run download:v2-candidate.`);
  }

  const claims = readJsonl<SciFactClaim>(claimsPath).sort((a, b) => a.id - b.id);
  const corpus = readJsonl<SciFactDocument>(corpusPath);
  if (claims.length !== 300 || corpus.length !== 5183) throw new Error(`Unexpected frozen SciFact counts: claims=${claims.length}, docs=${corpus.length}`);
  const docsById = new Map(corpus.map(document => [String(document.doc_id), document]));

  type PassageEntry = { docId: string; rationaleIndex: number; text: string; gold: GoldLabel };
  type ClaimGroup = { claimId: number; builtClaim: ReturnType<typeof buildClaim>; passages: PassageEntry[] };
  const groups: ClaimGroup[] = [];
  const maxClaims = Math.max(1, Math.min(Number(arg('max-claims') || claims.length), claims.length));

  // Materialize one deterministic ordered list of the exact same claim/evidence
  // pairs before loading either cross-encoder. This also keeps row alignment
  // explicit when the two model passes run serially.
  for (const [claimIndex, claim] of claims.slice(0, maxClaims).entries()) {
    const builtClaim = buildClaim(claim.claim);
    const passages: PassageEntry[] = [];
    for (const [docId, rationales] of Object.entries(claim.evidence || {})) {
      const doc = docsById.get(docId);
      if (!doc) throw new Error(`Missing evidence doc ${docId} for claim ${claim.id}`);
      for (const [rationaleIndex, rationale] of rationales.entries()) {
        const text = rationale.sentences.map(index => doc.abstract[index]).filter(Boolean).join(' ').trim();
        if (!text) throw new Error(`Empty evidence passage for claim ${claim.id}, doc ${docId}`);
        passages.push({ docId, rationaleIndex, text, gold: rationale.label === 'SUPPORT' ? 'SUPPORTS' : 'REFUTES' });
      }
    }
    const goldDocIds = new Set(Object.keys(claim.evidence || {}));
    for (const citedId of claim.cited_doc_ids || []) {
      if (goldDocIds.has(String(citedId))) continue;
      const doc = docsById.get(String(citedId));
      if (!doc) throw new Error(`Missing cited document ${citedId} for claim ${claim.id}`);
      passages.push({ docId: String(citedId), rationaleIndex: -1, text: doc.abstract.join(' ').trim(), gold: 'NEUTRAL' });
    }
    if (passages.length) groups.push({ claimId: claim.id, builtClaim, passages });
    if ((claimIndex + 1) % 25 === 0 || claimIndex + 1 === Math.min(maxClaims, claims.length)) {
      console.log(`prepared ${claimIndex + 1}/${Math.min(maxClaims, claims.length)} claims`);
    }
  }

  const goldLabels: GoldLabel[] = groups.flatMap(group => group.passages.map(item => item.gold));
  const baselinePredictions: NliLabel[] = [];
  const baselineConfidences: number[] = [];
  const candidatePredictions: NliLabel[] = [];
  const candidateConfidences: number[] = [];
  const rows: Array<Record<string, unknown>> = groups.flatMap(group => group.passages.map(item => ({
    claim_id: group.claimId,
    document_id: item.docId,
    rationale_index: item.rationaleIndex,
    gold: item.gold
  })));
  // Keep one native ONNX worker for the full comparison. Recreating a second
  // worker in the same parent process can make onnxruntime-node fail native
  // module self-registration even after the first worker has been terminated.
  const comparisonClient = new MlWorkerClient();
  const sharedEmbeddingModel = new TransformerEmbeddingModel(comparisonClient);
  const baseline = new PretrainedNliAdapter({
    client: comparisonClient,
    embeddingModel: sharedEmbeddingModel,
    relatednessFloor: RELATEDNESS_FLOOR
  });
  let candidate: PretrainedNliAdapter | null = null;

  try {
    // Both models receive the exact same pre-materialized ordered evidence pairs.
    // Only the NLI sessions change; the shared embedding model remains fixed.
    let cursor = 0;
    for (const [groupIndex, group] of groups.entries()) {
      const baseResults = baseline.classifyBatch(group.builtClaim, group.passages.map(item => item.text));
      if (baseResults.length !== group.passages.length) {
        throw new Error(`Baseline classification count mismatch for SciFact claim ${group.claimId}`);
      }
      for (let i = 0; i < baseResults.length; i++) {
        const result = baseResults[i];
        baselinePredictions.push(result.label);
        baselineConfidences.push(result.confidence);
        Object.assign(rows[cursor + i], {
          baseline_prediction: result.label,
          baseline_confidence: result.confidence,
          baseline_correct: result.label === group.passages[i].gold
        });
      }
      cursor += group.passages.length;
      if ((groupIndex + 1) % 25 === 0 || groupIndex + 1 === groups.length) {
        console.log(`baseline NLI processed ${groupIndex + 1}/${groups.length} claims`);
      }
    }

    // Reuse the initialized native worker and embedding session. The worker
    // explicitly disposes the previous NLI ONNX sessions before loading the
    // already provisioned and hash-verified comparison-only candidate.
    comparisonClient.setNliModel(candidateModel.id);
    candidate = new PretrainedNliAdapter({
      client: comparisonClient,
      embeddingModel: sharedEmbeddingModel,
      relatednessFloor: RELATEDNESS_FLOOR,
      modelName: candidateModel.id,
      modelVersion: candidateModel.versionSeal ?? 'unsealed'
    });

    cursor = 0;
    for (const [groupIndex, group] of groups.entries()) {
      const candidateResults = candidate.classifyBatch(group.builtClaim, group.passages.map(item => item.text));
      if (candidateResults.length !== group.passages.length) {
        throw new Error(`Candidate classification count mismatch for SciFact claim ${group.claimId}`);
      }
      for (let i = 0; i < candidateResults.length; i++) {
        const result = candidateResults[i];
        candidatePredictions.push(result.label);
        candidateConfidences.push(result.confidence);
        Object.assign(rows[cursor + i], {
          candidate_prediction: result.label,
          candidate_confidence: result.confidence,
          candidate_correct: result.label === group.passages[i].gold
        });
      }
      cursor += group.passages.length;
      if ((groupIndex + 1) % 25 === 0 || groupIndex + 1 === groups.length) {
        console.log(`candidate NLI processed ${groupIndex + 1}/${groups.length} claims`);
      }
    }

    if (!candidate) throw new Error('Candidate NLI adapter was not initialized.');
    const activeCandidate = candidate;

    const models = {
      baseline: {
        name: baseline.modelName,
        version: baseline.modelVersion,
        nli_weight_sha256: nliSeal().find(manifest => manifest.kind === 'nli')?.files.find(file => file.path === 'onnx/model_quantized.onnx')?.sha256 ?? null
      },
      candidate: {
        name: activeCandidate.modelName,
        version: activeCandidate.modelVersion,
        nli_weight_sha256: candidateSeal(candidateModel).files.find(file => file.path === 'onnx/model_quantized.onnx')?.sha256 ?? null
      }
    };
    const config = {
      task: 'pairwise_scifact_evidence_nli',
      split: 'dev',
      relatedness_floor: RELATEDNESS_FLOOR,
      max_pair_tokens: 384,
      candidate_model_id: activeCandidate.modelName,
      candidate_model_revision: candidateModel.revision,
      scoring_labels: TARGET_LABELS,
      claim_cluster_bootstrap_resamples: 10000,
      claim_cluster_bootstrap_seed: 20261128
    };
    const sealedModels = { baseline: nliSeal(), candidate: candidateSeal(candidateModel) };
    const configSha256 = sha256(JSON.stringify(config));
    const modelManifestSha256 = sha256(JSON.stringify(sealedModels));
    const report = {
      protocol_version: 'truthlens-v2-nli-candidate-comparison-v1',
      generated_at: new Date().toISOString(),
      benchmark: false,
      task: 'Component-only pairwise NLI comparison; NOT end-to-end verdict accuracy and NOT a production release gate.',
      run_provenance: {
        source_commit_sha: process.env.GITHUB_SHA || null,
        source_ref: process.env.GITHUB_REF || null,
        event_name: process.env.GITHUB_EVENT_NAME || 'local',
        workflow_run_id: process.env.GITHUB_RUN_ID || null,
        workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
        config_sha256: configSha256,
        model_manifest_sha256: modelManifestSha256
      },
      config,
      dataset: {
        name: 'SciFact',
        split: 'dev',
        claims_evaluated: Math.min(maxClaims, claims.length),
        corpus_documents: corpus.length,
        claims_sha256: claimsSha,
        corpus_sha256: corpusSha,
        passages_evaluated: goldLabels.length
      },
      models,
      model_seals: sealedModels,
      paired_comparison: {
        baseline: metrics(baselinePredictions, goldLabels, baselineConfidences),
        candidate: metrics(candidatePredictions, goldLabels, candidateConfidences),
        delta_accuracy: metrics(candidatePredictions, goldLabels, candidateConfidences).accuracy - metrics(baselinePredictions, goldLabels, baselineConfidences).accuracy,
        delta_macro_f1: metrics(candidatePredictions, goldLabels, candidateConfidences).macro_f1 - metrics(baselinePredictions, goldLabels, baselineConfidences).macro_f1,
        delta_ece: metrics(candidatePredictions, goldLabels, candidateConfidences).ece - metrics(baselinePredictions, goldLabels, baselineConfidences).ece,
        same_prediction_rate: baselinePredictions.length
          ? baselinePredictions.reduce((n, value, index) => n + Number(value === candidatePredictions[index]), 0) / baselinePredictions.length
          : 0
,
        claim_cluster_bootstrap: bootstrapClaimClusterComparison(rows, 10000, 20261128)
      },
      interpretation: [
        'Every baseline/candidate prediction uses the same frozen SciFact claim/evidence pair and the same embedding-based relatedness gate.',
        'Unclear predictions count as incorrect for full coverage accuracy and are also reported separately in coverage/selective metrics.',
        'The comparison is restricted to the explicitly selected, content-sealed experimental NLI candidate. No production model weights or settings are changed.',
        'This component comparison does not replace the full retrieval/reranking/evidence/decision benchmark and does not establish world-level accuracy.'
      ],
      rows
    };
    const output = path.resolve(arg('output') || path.join('artifacts', 'v2-model-quality', 'nli-candidate-comparison.json'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({
      protocol_version: report.protocol_version,
      benchmark: report.benchmark,
      dataset: report.dataset,
      candidate: models.candidate,
      baseline: { accuracy: report.paired_comparison.baseline.accuracy, macro_f1: report.paired_comparison.baseline.macro_f1, ece: report.paired_comparison.baseline.ece },
      comparison: { accuracy: report.paired_comparison.candidate.accuracy, macro_f1: report.paired_comparison.candidate.macro_f1, ece: report.paired_comparison.candidate.ece, delta_accuracy: report.paired_comparison.delta_accuracy, delta_macro_f1: report.paired_comparison.delta_macro_f1, delta_ece: report.paired_comparison.delta_ece },
      artifact: output
    }, null, 2));
  } finally {
    await comparisonClient.dispose();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
