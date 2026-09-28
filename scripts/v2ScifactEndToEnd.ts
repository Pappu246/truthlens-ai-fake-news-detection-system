/**
 * TruthLens V2 — END-TO-END SciFact benchmark
 * --------------------------------------------
 * Runs the actual V2 research pipeline against the FULL SciFact dev corpus:
 *
 *   claim -> open BM25 candidate retrieval -> V2 hybrid lexical+dense retrieval
 *   -> reranking -> pretrained NLI -> benchmark decision + production decision
 *
 * IMPORTANT:
 * - The benchmark adapter uses a single directional vote because classic
 *   SciFact provides a single-paper evidence setup; this does NOT replace
 *   TruthLens' production two-independent-source policy.
 * - Production-policy metrics are therefore reported separately and are not
 *   presented as SciFact task accuracy.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { buildClaim } from '../server/v2/queryExpansion';
import { verifyClaimV2 } from '../server/v2/pipeline';
import { PretrainedNliAdapter } from '../server/v2/nli/pretrainedNliAdapter';
import { TransformerEmbeddingModel } from '../server/v2/retrieval/transformerEmbeddingModel';
import { SciFactOpenCorpusSource, SciFactDocumentInput } from '../server/v2/retrieval/scifactCorpusSource';
import { disposeMlWorker } from '../server/v2/ml/mlWorkerClient';
import { ALL_MODEL_MANIFESTS, getV2ModelDir, verifyModelHashes } from '../server/v2/ml/modelManifest';

type GoldLabel = 'SUPPORT' | 'CONTRADICT' | 'NOT_ENOUGH_INFO';

interface SciFactRationale {
  label: 'SUPPORT' | 'CONTRADICT';
  sentences: number[];
}
interface SciFactClaim {
  id: number;
  claim: string;
  evidence: Record<string, SciFactRationale[]>;
  cited_doc_ids: number[];
}

const EXPECTED_CLAIMS_SHA = '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217';
const EXPECTED_CORPUS_SHA = 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62';

function arg(name: string): string | undefined {
  return process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function macroF1(predictions: string[], gold: string[], labels: string[]) {
  const perClass = labels.map(label => {
    let tp = 0, fp = 0, fn = 0, support = 0;
    for (let i = 0; i < gold.length; i++) {
      if (gold[i] === label) support++;
      if (predictions[i] === label && gold[i] === label) tp++;
      if (predictions[i] === label && gold[i] !== label) fp++;
      if (predictions[i] !== label && gold[i] === label) fn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { label, precision, recall, f1, support };
  });
  const accuracy = gold.length ? gold.reduce((n, g, i) => n + Number(predictions[i] === g), 0) / gold.length : 0;
  return { accuracy, macroF1: perClass.reduce((s, x) => s + x.f1, 0) / labels.length, perClass };
}

function goldLabel(claim: SciFactClaim): GoldLabel {
  const rationaleLabels = Object.values(claim.evidence || {}).flat().map(r => r.label);
  if (!rationaleLabels.length) return 'NOT_ENOUGH_INFO';
  const first = rationaleLabels[0];
  if (rationaleLabels.some(label => label !== first)) {
    throw new Error(`SciFact claim ${claim.id} has mixed rationale labels; benchmark adapter expects a single gold direction.`);
  }
  return first === 'SUPPORT' ? 'SUPPORT' : 'CONTRADICT';
}

function benchmarkDirection(result: Awaited<ReturnType<typeof verifyClaimV2>>): GoldLabel {
  let support = 0;
  let refute = 0;

  for (const evidence of result.provenance.evidence) {
    const vote = evidence.nli_label === 'SUPPORTS' ? 1 : evidence.nli_label === 'REFUTES' ? -1 : 0;
    if (!vote) continue;
    const duplicatePenalty = evidence.is_duplicate_cluster ? 0.35 : 1;
    const weight = evidence.nli_confidence * evidence.rerank_score * duplicatePenalty;
    if (vote > 0) support += weight;
    else refute += weight;
  }

  if (support <= 0 && refute <= 0) return 'NOT_ENOUGH_INFO';
  if (support > refute) return 'SUPPORT';
  if (refute > support) return 'CONTRADICT';
  return 'NOT_ENOUGH_INFO';
}

function productionMappedDirection(verdict: string): GoldLabel {
  if (verdict === 'VERIFIED') return 'SUPPORT';
  if (verdict === 'REFUTED') return 'CONTRADICT';
  return 'NOT_ENOUGH_INFO';
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') || path.join('data', 'external', 'scifact'));
  const claimsPath = path.join(dataDir, 'claims_dev.jsonl');
  const corpusPath = path.join(dataDir, 'corpus.jsonl');
  if (!fs.existsSync(claimsPath) || !fs.existsSync(corpusPath)) {
    throw new Error(`SciFact data missing under ${dataDir}`);
  }

  const claimsSha = sha256(claimsPath);
  const corpusSha = sha256(corpusPath);
  if (claimsSha !== EXPECTED_CLAIMS_SHA || corpusSha !== EXPECTED_CORPUS_SHA) {
    throw new Error(`SciFact hash mismatch: claims=${claimsSha}, corpus=${corpusSha}`);
  }

  const modelDir = getV2ModelDir();
  for (const manifest of ALL_MODEL_MANIFESTS) {
    const verified = await verifyModelHashes(modelDir, manifest);
    if (!verified.ok) throw new Error(`Model seal verification failed: ${manifest.id}: ${verified.mismatches.join('; ')}`);
  }

  const allClaims = readJsonl<SciFactClaim>(claimsPath).sort((a, b) => a.id - b.id);
  const corpus = readJsonl<SciFactDocumentInput>(corpusPath);
  if (allClaims.length !== 300) throw new Error(`Expected 300 SciFact dev claims, got ${allClaims.length}`);
  if (corpus.length !== 5183) throw new Error(`Expected 5,183 SciFact corpus docs, got ${corpus.length}`);

  const maxClaims = Math.max(1, Math.min(Number(arg('max-claims') || allClaims.length), allClaims.length));
  const claims = allClaims.slice(0, maxClaims);
  const topCandidates = Math.max(20, Math.min(Number(arg('candidate-k') || 100), corpus.length));
  const finalTopK = Math.max(5, Math.min(Number(arg('final-k') || 8), 20));

  const embeddingModel = new TransformerEmbeddingModel();
  const nliAdapter = new PretrainedNliAdapter({ embeddingModel });

  const goldPredictions: string[] = [];
  const benchmarkPredictions: string[] = [];
  const productionPredictions: string[] = [];

  let candidateRecall = 0;
  let evidenceRecallAt5 = 0;
  let evidenceRecallDenominator = 0;
  let pipelineAbstentions = 0;
  let productionCorrectNonAbstain = 0;
  let productionNonAbstain = 0;
  let conflicted = 0;

  const rows: Array<Record<string, unknown>> = [];

  try {
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      const gold = goldLabel(claim);
      goldPredictions.push(gold);

      const source = new SciFactOpenCorpusSource(corpus, topCandidates);
      const result = await verifyClaimV2(claim.claim, {
        corpus: source,
        nliAdapter,
        nliConcurrency: 4,
        retrieval: {
          embeddingModel,
          perQueryTopK: 15,
          finalTopK
        },
        enableFullTextEnrichment: false,
        minCandidatesExpectedWarning: 0
      });

      const candidateIds = new Set(source.getCandidateIds());
      const goldEvidenceIds = new Set(Object.keys(claim.evidence || {}));
      const candidateHit = goldEvidenceIds.size > 0 && Array.from(goldEvidenceIds).some(id => candidateIds.has(id));
      if (candidateHit) candidateRecall++;

      const topEvidenceIds = result.provenance.evidence
        .slice()
        .sort((a, b) => b.rerank_score - a.rerank_score)
        .slice(0, 5)
        .map(e => e.url.split('/').pop() || '');
      const evidenceHit = goldEvidenceIds.size > 0 && Array.from(goldEvidenceIds).some(id => topEvidenceIds.includes(id));
      if (goldEvidenceIds.size > 0) {
        evidenceRecallDenominator++;
        if (evidenceHit) evidenceRecallAt5++;
      }

      const benchmarkPrediction = benchmarkDirection(result);
      const productionPrediction = productionMappedDirection(result.provenance.final_verdict);
      benchmarkPredictions.push(benchmarkPrediction);
      productionPredictions.push(productionPrediction);

      if (result.provenance.abstained) pipelineAbstentions++;
      if (result.provenance.final_verdict === 'CONFLICTED') conflicted++;
      if (result.provenance.final_verdict !== 'INSUFFICIENT_EVIDENCE' && result.provenance.final_verdict !== 'CONFLICTED') {
        productionNonAbstain++;
        if (productionPrediction === gold) productionCorrectNonAbstain++;
      }

      rows.push({
        id: claim.id,
        gold,
        benchmark_prediction: benchmarkPrediction,
        production_verdict: result.provenance.final_verdict,
        production_prediction: productionPrediction,
        candidate_pool_recall_hit: candidateHit,
        gold_evidence_ids: Array.from(goldEvidenceIds),
        retrieved_evidence_ids_top5: topEvidenceIds,
        final_confidence: result.provenance.final_confidence,
        abstained: result.provenance.abstained,
        nli_model: nliAdapter.modelName,
        embedding_model: embeddingModel.name
      });

      if ((i + 1) % 10 === 0 || i + 1 === claims.length) {
        console.log(`processed ${i + 1}/${claims.length} claims`);
      }
    }

    const benchmarkMetrics = macroF1(benchmarkPredictions, goldPredictions, ['SUPPORT', 'CONTRADICT', 'NOT_ENOUGH_INFO']);
    const productionMetrics = macroF1(productionPredictions, goldPredictions, ['SUPPORT', 'CONTRADICT', 'NOT_ENOUGH_INFO']);
    const evidenceRecall = evidenceRecallDenominator ? evidenceRecallAt5 / evidenceRecallDenominator : null;

    const output = {
      protocol_version: 'truthlens-v2-scifact-end-to-end-v1',
      generated_at: new Date().toISOString(),
      benchmark: true,
      dataset: {
        name: 'SciFact',
        split: 'dev',
        claims_evaluated: claims.length,
        corpus_documents: corpus.length,
        claims_sha256: claimsSha,
        corpus_sha256: corpusSha,
        candidate_pool_k: topCandidates,
        final_pipeline_k: finalTopK
      },
      models: {
        nli: { name: nliAdapter.modelName, version: nliAdapter.modelVersion },
        embedding: { name: embeddingModel.name, version: embeddingModel.version }
      },
      end_to_end: {
        open_candidate_recall: candidateRecall / claims.length,
        gold_evidence_recall_at_5: evidenceRecall,
        benchmark_directional_accuracy: benchmarkMetrics.accuracy,
        benchmark_directional_macro_f1: benchmarkMetrics.macroF1,
        benchmark_directional_per_class: benchmarkMetrics.perClass
      },
      production_policy_view: {
        mapped_accuracy: productionMetrics.accuracy,
        mapped_macro_f1: productionMetrics.macroF1,
        mapped_per_class: productionMetrics.perClass,
        abstention_rate: pipelineAbstentions / claims.length,
        conflicted_rate: conflicted / claims.length,
        non_abstain_coverage: productionNonAbstain / claims.length,
        non_abstain_accuracy: productionNonAbstain ? productionCorrectNonAbstain / productionNonAbstain : 0
      },
      interpretation: [
        'This is an end-to-end retrieval + reranking + NLI benchmark over the full SciFact dev corpus, not a synthetic fixture.',
        'The benchmark directional decision is a single-source-compatible research evaluator because classic SciFact provides evidence from cited papers; it does not replace the production two-independent-source policy.',
        'Production-policy metrics are reported separately to expose the cost of the policy/dataset mismatch rather than hiding it.',
        'No production thresholds, source rules, abstention rules, or production models were changed.',
        'This benchmark does not by itself establish world-leading performance; it establishes a reproducible external end-to-end measurement.'
      ],
      rows
    };

    const outputPath = path.resolve(arg('output') || path.join('artifacts', 'v2-scifact-e2e', 'scifact-end-to-end.json'));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await disposeMlWorker();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
