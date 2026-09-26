/**
 * TruthLens V2 external evaluation on the untouched SciFact development set.
 *
 * This is deliberately separate from the 56-fixture development harness.
 * It preserves the EmbeddingModel and NliAdapter interfaces, keeps every V2
 * decision threshold unchanged, and records retrieval, per-passage NLI,
 * final-verdict, calibration, coverage, abstention, runtime, and memory.
 *
 * Data: npm run external:v2-data
 * Run:  npm run eval:v2-external
 * Swap: npm run eval:v2-external -- --nli-model-id=Xenova/nli-deberta-v3-base
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import type { ExtractedClaim } from '../src/types';
import { verifyClaimV2 } from '../server/v2/pipeline';
import { expectedCalibrationError } from '../server/v2/metrics/metrics';
import { Bm25Index } from '../server/v2/retrieval/bm25';
import type { CorpusSource } from '../server/v2/retrieval/corpusSource';
import { TransformerEmbeddingModel } from '../server/v2/retrieval/transformerEmbeddingModel';
import type { EmbeddingModel } from '../server/v2/retrieval/embeddings';
import type { RawDocument } from '../server/v2/types';
import { MlWorkerClient } from '../server/v2/ml/mlWorkerClient';
import {
  assertCandidateUsable,
  findExperimentalCandidate,
  getV2ModelDir,
  verifyCandidateHashes,
  NLI_MODEL_NAME,
  NLI_MODEL_VERSION
} from '../server/v2/ml/modelManifest';
import { PretrainedNliAdapter } from '../server/v2/nli/pretrainedNliAdapter';

const DATASET_NOTE =
  'External evaluation on the untouched SciFact development split. SciFact scientific abstracts differ from live-news web evidence; synthetic .test document locators represent independent papers and are not real URLs.';
const CLAIMS_SHA256 = '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217';
const CORPUS_SHA256 = 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62';
const RETRIEVAL_CANDIDATES_PER_QUERY = 25;
const EVIDENCE_K = 5;
const HC_THRESHOLD = 0.75;
const FIXED_RETRIEVED_AT = '2026-09-26T00:00:00.000Z';
/**
 * RESEARCH-INTEGRITY FIX (V2.1 review, MEDIUM finding "evaluation freshness
 * is wall-clock dependent"): the rerank freshness signal used Date.now(), so
 * scores drifted with the day the benchmark was executed. Every V2.2
 * evaluation run pins the clock to the same instant as the frozen
 * `retrievedAt` stamp, making runs comparable across dates. Thresholds,
 * weights, the freshness formula and the decision policy are UNCHANGED.
 */
const FROZEN_EVALUATION_NOW = FIXED_RETRIEVED_AT;
const FROZEN_EVALUATION_NOW_MS = Date.parse(FROZEN_EVALUATION_NOW);

type SciFactEvidenceLabel = 'SUPPORT' | 'CONTRADICT';
type NliGold = 'SUPPORTS' | 'REFUTES' | 'NEUTRAL';
type FinalGold = 'VERIFIED' | 'REFUTED' | 'INSUFFICIENT_EVIDENCE';

interface SciFactRationale { label: SciFactEvidenceLabel; sentences: number[] }
interface SciFactClaim {
  id: number;
  claim: string;
  evidence: Record<string, SciFactRationale[]>;
  cited_doc_ids: number[];
}
interface SciFactDocument {
  doc_id: number;
  title: string;
  abstract: string[];
  structured: boolean;
}
interface ClassMetric { label: string; precision: number; recall: number; f1: number; support: number }

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Prefix(file: string): string {
  return sha256File(file).slice(0, 8);
}

function modelFileName(dtype: 'q8' | 'fp32' | 'fp16'): string {
  if (dtype === 'q8') return 'model_quantized.onnx';
  if (dtype === 'fp16') return 'model_fp16.onnx';
  return 'model.onnx';
}

function documentUrl(id: number | string): string {
  // Every SciFact paper is an independent evidence unit. The reserved .test
  // locator gives each paper a distinct domain cluster without pretending it
  // is a real publisher URL. This mapping is frozen and disclosed.
  return `https://scifact-${id}.test/abstract`;
}

function claimGold(claim: SciFactClaim): { nli: NliGold; verdict: FinalGold } {
  const rationales = Object.values(claim.evidence || {}).flat();
  if (rationales.length === 0) return { nli: 'NEUTRAL', verdict: 'INSUFFICIENT_EVIDENCE' };
  const labels = new Set(rationales.map(rationale => rationale.label));
  if (labels.size !== 1) throw new Error(`SciFact claim ${claim.id} has mixed evidence labels; protocol has no silent tie rule.`);
  return labels.has('SUPPORT')
    ? { nli: 'SUPPORTS', verdict: 'VERIFIED' }
    : { nli: 'REFUTES', verdict: 'REFUTED' };
}

function fixedClassReport(predictions: string[], gold: string[], labels: string[]): {
  accuracy: number;
  macroF1: number;
  perClass: ClassMetric[];
} {
  if (predictions.length !== gold.length) throw new Error('Prediction/gold length mismatch.');
  const perClass = labels.map(label => {
    let tp = 0, fp = 0, fn = 0, support = 0;
    for (let i = 0; i < gold.length; i++) {
      if (gold[i] === label) support++;
      if (predictions[i] === label && gold[i] === label) tp++;
      if (predictions[i] === label && gold[i] !== label) fp++;
      if (predictions[i] !== label && gold[i] === label) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
    return { label, precision, recall, f1, support };
  });
  const correct = gold.reduce((sum, label, i) => sum + Number(predictions[i] === label), 0);
  return {
    accuracy: gold.length === 0 ? 0 : correct / gold.length,
    macroF1: perClass.reduce((sum, metric) => sum + metric.f1, 0) / labels.length,
    perClass
  };
}

function sumDirectoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    bytes += entry.isDirectory() ? sumDirectoryBytes(full) : fs.statSync(full).size;
  }
  return bytes;
}

class MemoizedEmbeddingModel implements EmbeddingModel {
  public readonly name: string;
  public readonly version: string;
  public readonly dimensions: number;
  private readonly cache = new Map<string, number[]>();

  constructor(private readonly delegate: EmbeddingModel) {
    this.name = delegate.name;
    this.version = delegate.version;
    this.dimensions = delegate.dimensions;
  }

  public embed(text: string): number[] {
    const cached = this.cache.get(text);
    if (cached) return cached;
    const vector = this.delegate.embed(text);
    this.cache.set(text, vector);
    return vector;
  }

  public get size(): number { return this.cache.size; }
}

class SciFactLexicalCorpusSource implements CorpusSource {
  public readonly name = 'scifact_dev_bm25_candidate_source';
  public readonly surfacedIds = new Set<string>();
  private readonly index: Bm25Index;
  private readonly rawById: Map<string, RawDocument>;

  constructor(documents: SciFactDocument[]) {
    this.rawById = new Map(documents.map(document => {
      const id = String(document.doc_id);
      const abstract = document.abstract.join(' ');
      const raw: RawDocument = {
        id,
        url: documentUrl(id),
        title: document.title,
        snippet: abstract,
        contentType: 'SUMMARY',
        publisher: `SciFact paper ${id}`,
        publishedAt: null,
        retrievedAt: FIXED_RETRIEVED_AT,
        retrievalMethod: `scifact_global_bm25_top_${RETRIEVAL_CANDIDATES_PER_QUERY}`
      };
      return [id, raw];
    }));
    this.index = new Bm25Index(documents.map(document => ({
      id: String(document.doc_id),
      text: `${document.title} ${document.abstract.join(' ')}`
    })));
  }

  public async fetchCandidates(query: string, _claim: ExtractedClaim): Promise<RawDocument[]> {
    const hits = this.index.search(query, RETRIEVAL_CANDIDATES_PER_QUERY);
    for (const hit of hits) this.surfacedIds.add(hit.id);
    return hits.map(hit => this.rawById.get(hit.id)).filter((doc): doc is RawDocument => Boolean(doc));
  }
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') || path.join('data', 'external', 'scifact'));
  const claimsPath = path.join(dataDir, 'claims_dev.jsonl');
  const corpusPath = path.join(dataDir, 'corpus.jsonl');
  if (!fs.existsSync(claimsPath) || !fs.existsSync(corpusPath)) {
    throw new Error(`SciFact data missing under ${dataDir}. Run \`npm run external:v2-data\` first.`);
  }
  const actualClaimsHash = sha256File(claimsPath);
  const actualCorpusHash = sha256File(corpusPath);
  if (actualClaimsHash !== CLAIMS_SHA256 || actualCorpusHash !== CORPUS_SHA256) {
    throw new Error(
      `SciFact hash mismatch; refusing evaluation. claims=${actualClaimsHash}, corpus=${actualCorpusHash}`
    );
  }

  const modelDir = path.resolve(arg('model-dir') || getV2ModelDir());
  const nliModelId = arg('nli-model-id') || NLI_MODEL_NAME;
  const nliDtype = (arg('nli-dtype') || 'q8') as 'q8' | 'fp32' | 'fp16';
  if (!['q8', 'fp32', 'fp16'].includes(nliDtype)) throw new Error(`Unsupported --nli-dtype=${nliDtype}`);
  const nliOnnx = path.join(modelDir, nliModelId, 'onnx', modelFileName(nliDtype));
  const required = [
    path.join(modelDir, nliModelId, 'config.json'),
    path.join(modelDir, nliModelId, 'tokenizer.json'),
    nliOnnx
  ];
  const missing = required.filter(file => !fs.existsSync(file));
  if (missing.length) {
    throw new Error(
      `Candidate ${nliModelId} is not locally provisioned for ${nliDtype}:\n` +
      missing.map(file => `  - ${file}`).join('\n')
    );
  }
  // Any NLI model other than the sealed V2.1 default must be a REGISTERED,
  // SEALED experimental candidate whose local bytes verify — fail closed, so
  // a run can never report numbers for weights nobody can identify.
  const registryCandidate = findExperimentalCandidate(nliModelId);
  if (nliModelId !== NLI_MODEL_NAME) {
    if (!registryCandidate) {
      throw new Error(
        `NLI model '${nliModelId}' is not the sealed default and is not a registered experimental candidate ` +
        '(server/v2/ml/modelManifest.ts -> EXPERIMENTAL_NLI_CANDIDATES). Register and seal it first; ' +
        'unidentifiable weights are never evaluated.'
      );
    }
    assertCandidateUsable(nliModelId, modelDir);
    const candidateHashes = verifyCandidateHashes(nliModelId, modelDir);
    if (!candidateHashes.ok) {
      throw new Error(
        `Candidate '${nliModelId}' failed SHA-256 seal verification; refusing to evaluate:\n` +
        candidateHashes.mismatches.map(mismatch => `  - ${mismatch}`).join('\n')
      );
    }
  }

  const nliVersion = arg('nli-version') ||
    (nliModelId === NLI_MODEL_NAME && nliDtype === 'q8' ? NLI_MODEL_VERSION : `${nliDtype}@${sha256Prefix(nliOnnx)}`);

  const allClaims = readJsonl<SciFactClaim>(claimsPath).sort((a, b) => a.id - b.id);
  const corpus = readJsonl<SciFactDocument>(corpusPath);
  const docsById = new Map(corpus.map(document => [String(document.doc_id), document]));
  const maxClaims = Number(arg('max-claims') || allClaims.length);
  if (!Number.isInteger(maxClaims) || maxClaims < 1) throw new Error('--max-claims must be a positive integer.');
  const claims = allClaims.slice(0, maxClaims);

  const client = new MlWorkerClient({ modelDir, nliModelId, nliDtype });
  // Exact-text memoization changes no scores. It avoids re-running the same
  // abstract through the bi-encoder across three expanded queries/claims.
  const embeddingModel = new MemoizedEmbeddingModel(new TransformerEmbeddingModel(client));
  const nliAdapter = new PretrainedNliAdapter({
    client,
    embeddingModel,
    modelName: nliModelId,
    modelVersion: nliVersion
  });

  console.log('='.repeat(78));
  console.log('TRUTHLENS V2 EXTERNAL EVALUATION — SciFact development split');
  console.log(`Claims: ${claims.length}/${allClaims.length}; corpus documents: ${corpus.length}`);
  console.log(`NLI candidate: ${nliModelId} (${nliVersion}, dtype=${nliDtype})`);
  console.log('Decision thresholds: UNCHANGED defaults. No fixture tuning.');
  console.log(`Frozen evaluation clock: ${FROZEN_EVALUATION_NOW} (freshness signal is date-independent)`);
  console.log('='.repeat(78));

  const startedAt = new Date().toISOString();
  const totalStart = performance.now();
  const meta = client.meta(); // fail before scoring if model/config cannot load
  const id2Labels = Object.values(meta.nliId2Label).map(label => String(label).toLowerCase());
  for (const expected of ['entailment', 'contradiction', 'neutral']) {
    if (!id2Labels.includes(expected)) throw new Error(`${nliModelId} id2label lacks '${expected}': ${JSON.stringify(meta.nliId2Label)}`);
  }

  // ---- Per-passage gold NLI ----------------------------------------------
  const passageStart = performance.now();
  const passagePredictions: string[] = [];
  const passageGold: string[] = [];
  const passageCalibration: Array<{ correct: boolean; confidence: number }> = [];
  const passageRows: Array<Record<string, unknown>> = [];

  for (const claim of claims) {
    const builtClaim = (await import('../server/v2/queryExpansion')).buildClaim(claim.claim);
    for (const [docId, rationales] of Object.entries(claim.evidence || {})) {
      const document = docsById.get(docId);
      if (!document) throw new Error(`SciFact claim ${claim.id}: missing evidence document ${docId}`);
      for (let rationaleIndex = 0; rationaleIndex < rationales.length; rationaleIndex++) {
        const rationale = rationales[rationaleIndex];
        const passage = rationale.sentences.map(index => document.abstract[index]).filter(Boolean).join(' ');
        if (!passage) throw new Error(`SciFact claim ${claim.id}/${docId}: empty gold rationale ${rationaleIndex}`);
        const goldLabel: NliGold = rationale.label === 'SUPPORT' ? 'SUPPORTS' : 'REFUTES';
        const prediction = nliAdapter.classify(builtClaim, passage);
        passagePredictions.push(prediction.label);
        passageGold.push(goldLabel);
        passageCalibration.push({ correct: prediction.label === goldLabel, confidence: prediction.confidence });
        passageRows.push({
          claim_id: claim.id, doc_id: Number(docId), rationale_index: rationaleIndex,
          source: 'gold_rationale', gold: goldLabel, prediction: prediction.label,
          confidence: prediction.confidence, passage
        });
      }
    }
    // SciFact explicitly records cited papers for which annotators found no
    // evidence. Those are the only passages assigned NEUTRAL; arbitrary
    // retrieval negatives are not silently treated as gold neutral.
    for (const citedId of claim.cited_doc_ids || []) {
      if (Object.prototype.hasOwnProperty.call(claim.evidence || {}, String(citedId))) continue;
      const document = docsById.get(String(citedId));
      if (!document) throw new Error(`SciFact claim ${claim.id}: missing cited document ${citedId}`);
      const passage = document.abstract.join(' ');
      const prediction = nliAdapter.classify(builtClaim, passage);
      passagePredictions.push(prediction.label);
      passageGold.push('NEUTRAL');
      passageCalibration.push({ correct: prediction.label === 'NEUTRAL', confidence: prediction.confidence });
      passageRows.push({
        claim_id: claim.id, doc_id: citedId, rationale_index: null,
        source: 'cited_no_evidence', gold: 'NEUTRAL', prediction: prediction.label,
        confidence: prediction.confidence, passage
      });
    }
  }
  const passageRuntimeSeconds = (performance.now() - passageStart) / 1000;
  const nliReport = fixedClassReport(passagePredictions, passageGold, ['SUPPORTS', 'REFUTES', 'NEUTRAL']);
  const nliCalibration = expectedCalibrationError(passageCalibration, 5);

  // ---- Retrieval + current final decision policy -------------------------
  const pipelineStart = performance.now();
  const finalPredictions: string[] = [];
  const finalGold: string[] = [];
  const finalCalibration: Array<{ correct: boolean; confidence: number }> = [];
  const perClaim: Array<Record<string, unknown>> = [];
  let lexicalGoldHits = 0;
  let lexicalGoldClaims = 0;
  let retrievalGoldClaims = 0;
  let recallAt5Hits = 0;
  let evidenceRelevantAt5 = 0;
  let evidenceRetrievedAt5 = 0;
  let highConfidenceN = 0;
  let highConfidenceCorrect = 0;
  let abstentions = 0;

  for (let index = 0; index < claims.length; index++) {
    const claim = claims[index];
    const gold = claimGold(claim);
    const source = new SciFactLexicalCorpusSource(corpus);
    const result = await verifyClaimV2(claim.claim, {
      corpus: source,
      nliAdapter,
      retrieval: { embeddingModel },
      priorOverride: { available: false, probabilityTrue: null, label: null, modelVersion: null },
      minCandidatesExpectedWarning: 0,
      evaluationDatasetNote: DATASET_NOTE,
      nowMs: FROZEN_EVALUATION_NOW_MS
    });
    const predicted = result.provenance.final_verdict;
    const correct = predicted === gold.verdict;
    finalPredictions.push(predicted);
    finalGold.push(gold.verdict);
    finalCalibration.push({ correct, confidence: result.provenance.final_confidence });
    if (result.provenance.abstained) abstentions++;
    if (result.provenance.final_confidence >= HC_THRESHOLD) {
      highConfidenceN++;
      if (correct) highConfidenceCorrect++;
    }

    const goldDocIds = Object.keys(claim.evidence || {});
    const topEvidence = result.provenance.evidence.slice(0, EVIDENCE_K);
    const topIds = topEvidence.map(evidence => {
      const match = evidence.url.match(/^https:\/\/scifact-(\d+)\.test\//);
      return match?.[1] || '';
    });
    if (goldDocIds.length > 0) {
      retrievalGoldClaims++;
      lexicalGoldClaims++;
      const lexicalHit = goldDocIds.some(id => source.surfacedIds.has(id));
      if (lexicalHit) lexicalGoldHits++;
      const topHit = goldDocIds.some(id => topIds.includes(id));
      if (topHit) recallAt5Hits++;
      evidenceRelevantAt5 += topIds.filter(id => goldDocIds.includes(id)).length;
      evidenceRetrievedAt5 += topIds.length;
    }

    perClaim.push({
      claim_id: claim.id,
      claim: claim.claim,
      gold_verdict: gold.verdict,
      predicted_verdict: predicted,
      correct,
      confidence: result.provenance.final_confidence,
      abstained: result.provenance.abstained,
      abstention_reason: result.provenance.abstention_reason,
      gold_evidence_doc_ids: goldDocIds.map(Number),
      lexical_candidate_hit: goldDocIds.length ? goldDocIds.some(id => source.surfacedIds.has(id)) : null,
      retrieved_top5_doc_ids: topIds.filter(Boolean).map(Number),
      evidence: topEvidence.map(evidence => ({
        doc_id: Number((evidence.url.match(/^https:\/\/scifact-(\d+)\.test\//) || [])[1]),
        nli_label: evidence.nli_label,
        nli_confidence: evidence.nli_confidence,
        rerank_score: evidence.rerank_score
      })),
      decision_rule_trace: result.provenance.decision_rule_trace
    });
    if ((index + 1) % 10 === 0 || index + 1 === claims.length) {
      console.log(`  pipeline ${index + 1}/${claims.length}`);
    }
  }

  const pipelineRuntimeSeconds = (performance.now() - pipelineStart) / 1000;
  const finalReport = fixedClassReport(
    finalPredictions,
    finalGold,
    ['VERIFIED', 'REFUTED', 'INSUFFICIENT_EVIDENCE']
  );
  const finalEce = expectedCalibrationError(finalCalibration, 5);
  const totalRuntimeSeconds = (performance.now() - totalStart) / 1000;
  const coverage = claims.length === 0 ? 0 : (claims.length - abstentions) / claims.length;
  const highConfidenceCoverage = claims.length === 0 ? 0 : highConfidenceN / claims.length;
  const highConfidencePrecision = highConfidenceN === 0 ? 0 : highConfidenceCorrect / highConfidenceN;

  const output = {
    protocol_version: 'truthlens-v2-external-scifact-v1',
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    dataset: {
      name: 'SciFact',
      split: 'dev',
      untouched: true,
      claims_evaluated: claims.length,
      claims_available: allClaims.length,
      corpus_documents: corpus.length,
      claims_sha256: actualClaimsHash,
      corpus_sha256: actualCorpusHash,
      selection: claims.length === allClaims.length
        ? 'all 300 dev claims, sorted by numeric claim id'
        : `first ${claims.length} dev claims sorted by numeric claim id (explicit --max-claims smoke/subset run)`,
      label_mapping: {
        SUPPORT: 'VERIFIED / SUPPORTS',
        CONTRADICT: 'REFUTED / REFUTES',
        empty_evidence: 'INSUFFICIENT_EVIDENCE / NEUTRAL'
      }
    },
    frozen_policy: {
      decision_thresholds: 'DEFAULT_DECISION_THRESHOLDS (unchanged)',
      frozen_evaluation_clock: FROZEN_EVALUATION_NOW,
      research_integrity_fixes: [
        'freshness/provenance clock frozen (no Date.now() dependence in scored signals)',
        'NLI 4-way score vectors sum to exactly 1.000 (largest-remainder rounding)',
        'NLI basis text states "no directional majority" instead of an impossible maxP<0.5 condition'
      ],
      lexical_candidates_per_expanded_query: RETRIEVAL_CANDIDATES_PER_QUERY,
      evidence_k: EVIDENCE_K,
      high_confidence_threshold: HC_THRESHOLD,
      independence_mapping: 'one reserved .test domain per SciFact paper',
      prior: 'disabled/unavailable so the LIAR prior cannot affect external calibration'
    },
    model: {
      nli: {
        id: nliModelId,
        version: nliVersion,
        dtype: nliDtype,
        onnx_sha256: sha256File(nliOnnx),
        registry: registryCandidate
          ? {
              base_model: registryCandidate.baseModel,
              revision: registryCandidate.revision,
              seal_state: registryCandidate.sealState,
              version_seal: registryCandidate.versionSeal
            }
          : { base_model: 'cross-encoder/nli-deberta-v3-xsmall', revision: null, seal_state: 'sealed-default', version_seal: NLI_MODEL_VERSION }
      },
      embedding: { id: embeddingModel.name, version: embeddingModel.version, dimensions: embeddingModel.dimensions },
      id2label: meta.nliId2Label,
      runtime: '@huggingface/transformers@3.7.6 + onnxruntime-node@1.21.0 (Node, CPU)'
    },
    metrics: {
      accuracy: finalReport.accuracy,
      macro_f1: finalReport.macroF1,
      final_per_class: finalReport.perClass,
      nli_accuracy: nliReport.accuracy,
      nli_f1: nliReport.macroF1,
      nli_per_class: nliReport.perClass,
      nli_gold_passages: passageGold.length,
      nli_ece: nliCalibration.expectedCalibrationError,
      lexical_candidate_recall: lexicalGoldClaims === 0 ? null : lexicalGoldHits / lexicalGoldClaims,
      evidence_recall_at_5: retrievalGoldClaims === 0 ? null : recallAt5Hits / retrievalGoldClaims,
      evidence_recall_at_5_claims: retrievalGoldClaims,
      evidence_precision_at_5: evidenceRetrievedAt5 === 0 ? null : evidenceRelevantAt5 / evidenceRetrievedAt5,
      high_confidence_precision: highConfidencePrecision,
      high_confidence_coverage: highConfidenceCoverage,
      high_confidence_n: highConfidenceN,
      coverage,
      abstention: claims.length === 0 ? 0 : abstentions / claims.length,
      ece: finalEce.expectedCalibrationError
    },
    resources: {
      total_runtime_seconds: totalRuntimeSeconds,
      passage_nli_runtime_seconds: passageRuntimeSeconds,
      retrieval_pipeline_runtime_seconds: pipelineRuntimeSeconds,
      peak_rss_mb: process.resourceUsage().maxRSS / 1024,
      ending_rss_mb: process.memoryUsage().rss / (1024 * 1024),
      nli_model_disk_mb: sumDirectoryBytes(path.join(modelDir, nliModelId)) / (1024 * 1024),
      embedding_model_disk_mb: sumDirectoryBytes(path.join(modelDir, embeddingModel.name)) / (1024 * 1024),
      memoized_embedding_texts: embeddingModel.size,
      cpu_count: (await import('os')).cpus().length,
      node: process.version,
      platform: `${process.platform}/${process.arch}`
    },
    calibration_bins: { final: finalEce.bins, nli: nliCalibration.bins },
    per_passage: passageRows,
    per_claim: perClaim,
    limitations: [
      'SciFact is scientific-abstract verification, not live-news verification.',
      'Most directional SciFact claims have one gold paper, while the unchanged TruthLens policy requires two independent directional sources; final-verdict coverage therefore measures this policy/task interaction as well as NLI quality.',
      'The corpus-source stage uses global BM25 top-25 per expanded query before the unchanged hybrid retriever, matching the candidate-provider boundary but not an exhaustive dense index over all 5,183 abstracts.',
      'NEUTRAL per-passage gold is assigned only to cited papers with no annotated evidence; unjudged retrieval negatives are never assumed neutral.',
      'Reserved .test locators are synthetic provenance keys, not browsable source URLs.'
    ]
  };

  const defaultName = nliModelId.replace(/[^a-z0-9._-]+/gi, '_');
  const outputPath = path.resolve(arg('output') || path.join('artifacts', 'v2-review', `external-scifact-${defaultName}.json`));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');

  console.log('-'.repeat(78));
  console.log(`Final accuracy: ${(finalReport.accuracy * 100).toFixed(1)}%`);
  console.log(`Final macro-F1: ${finalReport.macroF1.toFixed(3)}`);
  console.log(`NLI macro-F1: ${nliReport.macroF1.toFixed(3)} (${passageGold.length} gold passages)`);
  console.log(`Evidence Recall@5: ${retrievalGoldClaims ? (100 * recallAt5Hits / retrievalGoldClaims).toFixed(1) + '%' : 'N/A'}`);
  console.log(`Evidence precision@5: ${evidenceRetrievedAt5 ? (100 * evidenceRelevantAt5 / evidenceRetrievedAt5).toFixed(1) + '%' : 'N/A'}`);
  console.log(`HC precision/coverage: ${(100 * highConfidencePrecision).toFixed(1)}% / ${(100 * highConfidenceCoverage).toFixed(1)}%`);
  console.log(`Coverage/abstention: ${(100 * coverage).toFixed(1)}% / ${(100 * abstentions / claims.length).toFixed(1)}%`);
  console.log(`ECE: ${finalEce.expectedCalibrationError.toFixed(3)}`);
  console.log(`Runtime: ${totalRuntimeSeconds.toFixed(1)}s; peak RSS: ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MB`);
  console.log(`Wrote ${outputPath}`);
  console.log('='.repeat(78));

  await client.dispose();
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
