/**
 * Research-only SciFact matched-context NLI diagnostic.
 *
 * For each gold rationale, compare:
 * 1) the annotated rationale sentences alone;
 * 2) a contiguous rationale-centered abstract window (up to max-context-chars);
 * 3) a same-character-length local context-only control excluding gold sentences.
 *
 * This is an oracle component diagnostic, not open-retrieval or end-to-end accuracy.
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

type GoldLabel = 'SUPPORTS' | 'REFUTES';
interface Rationale { label: 'SUPPORT' | 'CONTRADICT'; sentences: number[]; }
interface SciFactClaim { id: number; claim: string; evidence: Record<string, Rationale[]>; }
interface SciFactDocument { doc_id: number; title: string; abstract: string[]; structured?: boolean; }
interface Pair {
  claim_id: number;
  document_id: string;
  rationale_index: number;
  gold: GoldLabel;
  rationale: string;
  context_window: string;
  context_only_control: string | null;
}

const EXPECTED_CLAIMS_SHA = '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217';
const EXPECTED_CORPUS_SHA = 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62';
const LABELS: GoldLabel[] = ['SUPPORTS', 'REFUTES'];
const OUTPUT_LABELS: NliLabel[] = ['SUPPORTS', 'REFUTES', 'NEUTRAL', 'UNCLEAR'];
const RELATEDNESS_FLOOR = 0.15;

function arg(name: string): string | undefined {
  const prefix = '--' + name + '=';
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
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

/** Builds the smallest contiguous abstract window that contains every gold sentence,
 * then adds nearest left/right context while staying within maxChars where possible.
 * Gold rationale text is never dropped to satisfy the character budget.
 */
export function buildRationaleContextWindow(
  sentences: string[],
  rationaleIndices: number[],
  maxChars = 800
): string {
  if (!Array.isArray(sentences) || sentences.length === 0) throw new Error('Abstract sentences must be non-empty.');
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer.');
  const indices = [...new Set(rationaleIndices)].sort((a, b) => a - b);
  if (indices.length === 0) throw new Error('At least one rationale sentence index is required.');
  if (indices.some(index => !Number.isInteger(index) || index < 0 || index >= sentences.length)) {
    throw new Error('Rationale sentence index is outside the abstract.');
  }
  let start = indices[0];
  let end = indices[indices.length - 1];
  const textFor = (left: number, right: number) => sentences.slice(left, right + 1).join(' ').trim();
  let current = textFor(start, end);
  while (current.length <= maxChars) {
    const options: Array<{ side: 'left' | 'right'; text: string; length: number }> = [];
    if (start > 0) options.push({ side: 'left', text: textFor(start - 1, end), length: String(sentences[start - 1] || '').length });
    if (end < sentences.length - 1) options.push({ side: 'right', text: textFor(start, end + 1), length: String(sentences[end + 1] || '').length });
    options.sort((a, b) => a.length - b.length || (a.side === 'left' ? -1 : 1));
    const next = options.find(option => option.text.length <= maxChars);
    if (!next) break;
    if (next.side === 'left') start--;
    else end++;
    current = next.text;
    if (start === 0 && end === sentences.length - 1) break;
  }
  return current;
}

/** Creates a same-length control from nearest non-gold sentences in this abstract.
 * Returns null rather than padding or borrowing text from another document.
 */
export function buildMatchedLocalContextControl(
  sentences: string[],
  rationaleIndices: number[],
  targetChars: number
): string | null {
  if (!Number.isInteger(targetChars) || targetChars < 1) throw new Error('targetChars must be a positive integer.');
  const excluded = new Set(rationaleIndices);
  const valid = [...excluded].every(index => Number.isInteger(index) && index >= 0 && index < sentences.length);
  if (!valid || excluded.size === 0) throw new Error('Control requires valid gold rationale indices.');
  const ordered = sentences
    .map((text, index) => ({ text: String(text || '').trim(), index }))
    .filter(item => !excluded.has(item.index) && item.text.length > 0)
    .sort((a, b) => {
      const da = Math.min(...[...excluded].map(index => Math.abs(index - a.index)));
      const db = Math.min(...[...excluded].map(index => Math.abs(index - b.index)));
      return da - db || a.index - b.index;
    });
  const available = ordered.map(item => item.text).join(' ');
  return available.length >= targetChars ? available.slice(0, targetChars) : null;
}

export function calculateMetrics(predictions: NliLabel[], gold: GoldLabel[]) {
  if (predictions.length !== gold.length || gold.length === 0) {
    throw new Error('Matched-context metrics require equal non-empty prediction and gold arrays.');
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
      gold.reduce((count, actual, index) => count + Number(actual === goldLabel && predictions[index] === predictedLabel), 0)
    ]))
  }));
  return {
    passages: gold.length,
    accuracy: predictions.reduce((count, prediction, index) => count + Number(prediction === gold[index]), 0) / gold.length,
    macro_f1: perClass.reduce((sum, item) => sum + item.f1, 0) / LABELS.length,
    predicted_label_counts: Object.fromEntries(OUTPUT_LABELS.map(label => [label, predictions.filter(value => value === label).length])),
    per_class: perClass,
    confusion_matrix: confusion
  };
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') || process.env.TRUTHLENS_SCIFACT_DATA_DIR || '/tmp/truthlens-scifact/scifact');
  const claimsPath = path.join(dataDir, 'claims_dev.jsonl');
  const corpusPath = path.join(dataDir, 'corpus.jsonl');
  if (!fs.existsSync(claimsPath) || !fs.existsSync(corpusPath)) throw new Error('SciFact data missing under ' + dataDir);
  const claimsSha = sha256File(claimsPath);
  const corpusSha = sha256File(corpusPath);
  if (claimsSha !== EXPECTED_CLAIMS_SHA || corpusSha !== EXPECTED_CORPUS_SHA) {
    throw new Error('SciFact hash mismatch: claims=' + claimsSha + ', corpus=' + corpusSha);
  }
  const modelDir = getV2ModelDir();
  for (const manifest of ALL_MODEL_MANIFESTS) {
    const verified = await verifyModelHashes(modelDir, manifest);
    if (!verified.ok) throw new Error('Model seal verification failed for ' + manifest.id + ': ' + verified.mismatches.join('; '));
  }
  const claims = readJsonl<SciFactClaim>(claimsPath).sort((a, b) => a.id - b.id);
  const corpus = readJsonl<SciFactDocument>(corpusPath);
  if (claims.length !== 300 || corpus.length !== 5183) throw new Error('Unexpected frozen SciFact counts.');
  const docsById = new Map(corpus.map(document => [String(document.doc_id), document]));
  const maxClaims = Math.max(1, Math.min(Number(arg('max-claims') || claims.length), claims.length));
  const maxContextChars = Number(arg('max-context-chars') || 800);
  if (!Number.isInteger(maxContextChars) || maxContextChars < 1 || maxContextChars > 8000) {
    throw new Error('max-context-chars must be an integer from 1 to 8000.');
  }
  const pairs: Pair[] = [];
  for (const claim of claims.slice(0, maxClaims)) {
    for (const [docId, rationales] of Object.entries(claim.evidence || {})) {
      const doc = docsById.get(docId);
      if (!doc) throw new Error('Missing SciFact document ' + docId + ' for claim ' + claim.id);
      for (const [rationaleIndex, rationale] of rationales.entries()) {
        const selected = [...new Set(rationale.sentences)].sort((a, b) => a - b);
        const rationaleText = selected.map(index => doc.abstract[index]).filter(Boolean).join(' ').trim();
        if (!rationaleText) throw new Error('Empty rationale for claim ' + claim.id + ', document ' + docId);
        const contextWindow = buildRationaleContextWindow(doc.abstract, selected, maxContextChars);
        const control = buildMatchedLocalContextControl(doc.abstract, selected, contextWindow.length);
        pairs.push({
          claim_id: claim.id,
          document_id: docId,
          rationale_index: rationaleIndex,
          gold: rationale.label === 'SUPPORT' ? 'SUPPORTS' : 'REFUTES',
          rationale: rationaleText,
          context_window: contextWindow,
          context_only_control: control
        });
      }
    }
  }
  if (pairs.length === 0) throw new Error('No SciFact rationale pairs were materialized.');

  const client = new MlWorkerClient();
  const embedding = new TransformerEmbeddingModel(client);
  const adapter = new PretrainedNliAdapter({
    client,
    embeddingModel: embedding,
    relatednessFloor: RELATEDNESS_FLOOR,
    researchTrace: true
  });
  const rationalePredictions: NliLabel[] = [];
  const contextPredictions: NliLabel[] = [];
  const controlPredictions: NliLabel[] = [];
  const rationaleGold: GoldLabel[] = [];
  const contextGold: GoldLabel[] = [];
  const controlConfidences: number[] = [];
  const rows: Array<Record<string, unknown>> = [];
  try {
    const byClaim = new Map<number, Pair[]>();
    for (const pair of pairs) {
      const group = byClaim.get(pair.claim_id) ?? [];
      group.push(pair);
      byClaim.set(pair.claim_id, group);
    }
    let processed = 0;
    for (const [claimId, group] of byClaim) {
      const sourceClaim = claims.find(item => item.id === claimId);
      if (!sourceClaim) throw new Error('Missing claim ' + claimId);
      const builtClaim = buildClaim(sourceClaim.claim);
      const rationaleResults = adapter.classifyBatch(builtClaim, group.map(item => item.rationale));
      const contextResults = adapter.classifyBatch(builtClaim, group.map(item => item.context_window));
      const controlIndices = group.map((item, index) => item.context_only_control === null ? -1 : index).filter(index => index >= 0);
      const controlResults = controlIndices.length
        ? adapter.classifyBatch(builtClaim, controlIndices.map(index => group[index].context_only_control as string))
        : [];
      if (rationaleResults.length !== group.length || contextResults.length !== group.length) {
        throw new Error('NLI output count mismatch for claim ' + claimId);
      }
      const controlsByIndex = new Map(controlIndices.map((index, i) => [index, controlResults[i]]));
      for (let i = 0; i < group.length; i++) {
        const pair = group[i];
        const rationaleResult = rationaleResults[i];
        const contextResult = contextResults[i];
        const controlResult = controlsByIndex.get(i);
        rationaleGold.push(pair.gold);
        contextGold.push(pair.gold);
        rationalePredictions.push(rationaleResult.label);
        contextPredictions.push(contextResult.label);
        if (controlResult) {
          controlPredictions.push(controlResult.label);
          controlConfidences.push(controlResult.confidence);
        }
        rows.push({
          claim_id: pair.claim_id,
          document_id: pair.document_id,
          rationale_index: pair.rationale_index,
          gold: pair.gold,
          rationale_chars: pair.rationale.length,
          context_window_chars: pair.context_window.length,
          context_added_chars: Math.max(0, pair.context_window.length - pair.rationale.length),
          context_control_chars: pair.context_only_control?.length ?? null,
          rationale_prediction: rationaleResult.label,
          rationale_confidence: rationaleResult.confidence,
          context_window_prediction: contextResult.label,
          context_window_confidence: contextResult.confidence,
          context_only_control_prediction: controlResult?.label ?? null,
          context_only_control_confidence: controlResult?.confidence ?? null,
          rationale_trace: rationaleResult.research_trace ?? null,
          context_window_trace: contextResult.research_trace ?? null,
          context_only_control_trace: controlResult?.research_trace ?? null
        });
      }
      processed += group.length;
      if (processed % 50 < group.length || processed === pairs.length) {
        console.log('processed ' + processed + '/' + pairs.length + ' rationale pairs');
      }
    }

    const rationaleMetrics = calculateMetrics(rationalePredictions, rationaleGold);
    const contextMetrics = calculateMetrics(contextPredictions, contextGold);
    const controlSummary = controlPredictions.length ? {
      passages: controlPredictions.length,
      predicted_label_counts: Object.fromEntries(OUTPUT_LABELS.map(label => [label, controlPredictions.filter(value => value === label).length])),
      mean_confidence: controlConfidences.reduce((sum, value) => sum + value, 0) / controlConfidences.length
    } : null;
    const transitions = {
      context_correct_rationale_wrong: rows.filter(row => row.context_window_prediction === row.gold && row.rationale_prediction !== row.gold).length,
      rationale_correct_context_wrong: rows.filter(row => row.rationale_prediction === row.gold && row.context_window_prediction !== row.gold).length,
      both_correct: rows.filter(row => row.rationale_prediction === row.gold && row.context_window_prediction === row.gold).length,
      both_wrong: rows.filter(row => row.rationale_prediction !== row.gold && row.context_window_prediction !== row.gold).length
    };
    const config = {
      task: 'paired_scifact_rationale_context_window',
      split: 'dev',
      relatedness_floor: RELATEDNESS_FLOOR,
      max_pair_tokens: 384,
      max_context_chars: maxContextChars,
      control_policy: 'nearest non-rationale sentences from the same abstract, exact character-length match; insufficient controls are excluded, never padded',
      oracle_rationale_input: true
    };
    const manifest = modelSeal();
    const report = {
      protocol_version: 'truthlens-v2-scifact-matched-context-v1',
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
        matched_context_controls: controlPredictions.length,
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
        rationale_only: rationaleMetrics,
        rationale_centered_context: contextMetrics,
        matched_length_context_only_control: controlSummary,
        delta_accuracy_context_minus_rationale: contextMetrics.accuracy - rationaleMetrics.accuracy,
        delta_macro_f1_context_minus_rationale: contextMetrics.macro_f1 - rationaleMetrics.macro_f1,
        context_vs_rationale_transitions: transitions
      },
      interpretation_limits: [
        'Rationale text is gold-annotated oracle evidence; all conditions are component diagnostics, not open-retrieval results.',
        'The rationale-centered context condition preserves all annotated rationale sentences and adds nearest abstract context up to the configured character budget where possible.',
        'The context-only control is drawn from non-rationale sentences in the same abstract and exactly matches the rationale-centered window character count; pairs without enough control text are excluded from that control metric.',
        'The context-only control has no gold label; report only its prediction distribution and confidence, never accuracy or F1.',
        'Character lengths are recorded, but tokenizer truncation and token-count behavior remain governed by the fixed 384-token model input limit.',
        'No retrieval, production pipeline, model, threshold, decision policy, or source rule is changed.'
      ],
      rows
    };
    const output = path.resolve(arg('output') || path.join('artifacts', 'v2-scifact-e2e', 'scifact-matched-context.json'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({
      protocol_version: report.protocol_version,
      rationale_pairs: pairs.length,
      matched_context_controls: controlPredictions.length,
      rationale_only: { accuracy: rationaleMetrics.accuracy, macro_f1: rationaleMetrics.macro_f1 },
      rationale_centered_context: { accuracy: contextMetrics.accuracy, macro_f1: contextMetrics.macro_f1 },
      context_only_control: controlSummary,
      artifact: output
    }, null, 2));
  } finally {
    await client.dispose();
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
