/**
 * Research-only SciFact real-text contamination diagnostic.
 *
 * Uses frozen SciFact claim/abstract text and the sealed local NLI model.
 * It duplicates already-retrieved NON-GOLD abstracts under simulated
 * publisher metadata, comparing same-domain replicas with cross-domain
 * replicas. No gold evidence is inserted into either retrieval pool.
 *
 * This is not an external benchmark: SciFact contains no publisher metadata,
 * so replica hostnames are explicitly simulated. It tests source-cluster
 * sensitivity and duplicate-content amplification on real corpus text.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FixtureCorpusSource } from '../server/v2/retrieval/corpusSource.js';
import { verifyClaimV2 } from '../server/v2/pipeline.js';
import { PretrainedNliAdapter } from '../server/v2/nli/pretrainedNliAdapter.js';
import { TransformerEmbeddingModel } from '../server/v2/retrieval/transformerEmbeddingModel.js';
import type { EmbeddingModel } from '../server/v2/retrieval/embeddings.js';
import type { RawDocument, V2VerificationResult } from '../server/v2/types.js';
import {
  benchmarkDirection,
  modelMetadata,
  productionDirection,
  verifySealedModels,
  disposeLocalNliContext,
  sha256Json
} from './benchmarks/v3LocalNli.js';

type GoldLabel = 'SUPPORT' | 'CONTRADICT' | 'NOT_ENOUGH_INFO';
interface Rationale { label: 'SUPPORT' | 'CONTRADICT'; sentences: number[]; }
interface SciFactClaim { id: number; claim: string; evidence: Record<string, Rationale[]>; }
interface SciFactDocument { doc_id: number; title: string; abstract: string[]; structured?: boolean; }

const EXPECTED_CLAIMS_SHA = '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217';
const EXPECTED_CORPUS_SHA = 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62';
const RELATEDNESS_FLOOR = 0.15;
const PER_QUERY_TOP_K = 15;
const FINAL_TOP_K = 8;
const NLI_CONCURRENCY = 8;
const REPLICAS_PER_SOURCE = 3;

function arg(name: string): string | undefined {
  return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}
function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function sha256File(file: string): string {
  return sha256(fs.readFileSync(file));
}
function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}
function goldLabel(claim: SciFactClaim): GoldLabel {
  const labels = Object.values(claim.evidence || {}).flat().map(item => item.label);
  if (labels.length === 0) return 'NOT_ENOUGH_INFO';
  const first = labels[0];
  if (labels.some(label => label !== first)) throw new Error(`SciFact claim ${claim.id} has mixed gold directions.`);
  return first === 'SUPPORT' ? 'SUPPORT' : 'CONTRADICT';
}

export function selectStratifiedClaims(claims: SciFactClaim[], maxClaims: number): SciFactClaim[] {
  const perClass = Math.max(1, Math.ceil(maxClaims / 3));
  const groups: Record<GoldLabel, SciFactClaim[]> = {
    SUPPORT: [], CONTRADICT: [], NOT_ENOUGH_INFO: []
  };
  for (const claim of [...claims].sort((a, b) => a.id - b.id)) {
    const label = goldLabel(claim);
    if (groups[label].length < perClass) groups[label].push(claim);
  }
  return [...groups.SUPPORT, ...groups.CONTRADICT, ...groups.NOT_ENOUGH_INFO].slice(0, maxClaims);
}

export function buildReplicaDocuments(
  originals: RawDocument[],
  claimId: number,
  mode: 'same_domain' | 'cross_domain',
  replicasPerSource = REPLICAS_PER_SOURCE
): RawDocument[] {
  const replicas: RawDocument[] = [];
  for (let sourceIndex = 0; sourceIndex < originals.length; sourceIndex++) {
    const original = originals[sourceIndex];
    for (let replicaIndex = 0; replicaIndex < replicasPerSource; replicaIndex++) {
      const id = `00-replica-${claimId}-${mode}-${sourceIndex}-${replicaIndex}`;
      const host = mode === 'same_domain'
        ? new URL(original.url).hostname
        : `replica-${claimId}-${sourceIndex}-${replicaIndex}.example`;
      replicas.push({
        ...original,
        id,
        url: `https://${host}/repost/${encodeURIComponent(original.id)}/${replicaIndex}`,
        publisher: original.publisher,
        retrievalMethod: `scifact_controlled_${mode}_replica`
      });
    }
  }
  return replicas;
}

class CachedEmbeddingModel implements EmbeddingModel {
  public readonly name: string;
  public readonly version: string;
  public readonly dimensions: number;
  private readonly cache = new Map<string, number[]>();
  constructor(private readonly base: EmbeddingModel) {
    this.name = base.name;
    this.version = base.version;
    this.dimensions = base.dimensions;
  }
  public embed(text: string): number[] {
    const key = (text || '').trim();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const vector = this.base.embed(key);
    if (vector instanceof Promise) throw new Error('CachedEmbeddingModel requires synchronous local embeddings.');
    this.cache.set(key, vector);
    return vector;
  }
  public embedBatch(texts: string[]): number[][] {
    const keys = texts.map(text => (text || '').trim());
    const missing = [...new Set(keys.filter(key => !this.cache.has(key)))];
    if (missing.length) {
      let encoded: number[][];
      if (typeof this.base.embedBatch === 'function') {
        const batch = this.base.embedBatch(missing);
        if (batch instanceof Promise) throw new Error('CachedEmbeddingModel requires synchronous batch embeddings.');
        encoded = batch;
      } else {
        const vectors: number[][] = [];
        for (const key of missing) {
          const vector = this.base.embed(key);
          if (vector instanceof Promise) throw new Error('CachedEmbeddingModel requires synchronous local embeddings.');
          vectors.push(vector);
        }
        encoded = vectors;
      }
      if (encoded.length !== missing.length) throw new Error('CachedEmbeddingModel received an unexpected vector count.');
      for (let index = 0; index < missing.length; index++) this.cache.set(missing[index], encoded[index]);
    }
    return keys.map(key => {
      const vector = this.cache.get(key);
      if (!vector) throw new Error('CachedEmbeddingModel lost a requested vector.');
      return vector;
    });
  }
  public get cacheSize(): number { return this.cache.size; }
}

function rawDocuments(corpus: SciFactDocument[]): RawDocument[] {
  return corpus.map(document => ({
    id: String(document.doc_id),
    url: `https://scifact-paper-${document.doc_id}.example/document/${document.doc_id}`,
    title: document.title,
    snippet: document.abstract.join(' '),
    contentType: 'SUMMARY',
    publisher: 'SciFact frozen corpus (publisher metadata unavailable)',
    publishedAt: null,
    retrievedAt: '2026-11-02T00:00:00.000Z',
    retrievalMethod: 'scifact_frozen_full_corpus'
  }));
}

async function runVerification(
  claim: SciFactClaim,
  docs: RawDocument[],
  nliAdapter: PretrainedNliAdapter,
  embeddingModel: CachedEmbeddingModel
): Promise<V2VerificationResult> {
  return verifyClaimV2(claim.claim, {
    corpus: new FixtureCorpusSource(docs),
    nliAdapter,
    nliConcurrency: NLI_CONCURRENCY,
    retrieval: { embeddingModel, perQueryTopK: PER_QUERY_TOP_K, finalTopK: FINAL_TOP_K },
    enableFullTextEnrichment: false,
    minCandidatesExpectedWarning: 0,
    priorOverride: { available: false, probabilityTrue: null, label: null, modelVersion: null }
  });
}

function recallAt(evidenceIds: string[], goldIds: Set<string>, k: number): number {
  return evidenceIds.slice(0, k).some(id => goldIds.has(id)) ? 1 : 0;
}
function directionalVoteCounts(result: V2VerificationResult) {
  const evidence = result.provenance.evidence;
  return {
    supports: evidence.filter(item => item.nli_label === 'SUPPORTS').length,
    refutes: evidence.filter(item => item.nli_label === 'REFUTES').length,
    neutral_or_unclear: evidence.filter(item => item.nli_label === 'NEUTRAL' || item.nli_label === 'UNCLEAR').length,
    weighted_support: evidence.reduce((sum, item) => sum + (item.nli_label === 'SUPPORTS'
      ? item.nli_confidence * item.rerank_score * (item.is_duplicate_cluster ? 0.35 : 1) : 0), 0),
    weighted_refute: evidence.reduce((sum, item) => sum + (item.nli_label === 'REFUTES'
      ? item.nli_confidence * item.rerank_score * (item.is_duplicate_cluster ? 0.35 : 1) : 0), 0)
  };
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') || '/tmp/truthlens-scifact/scifact');
  const claimsPath = path.join(dataDir, 'claims_dev.jsonl');
  const corpusPath = path.join(dataDir, 'corpus.jsonl');
  if (!fs.existsSync(claimsPath) || !fs.existsSync(corpusPath)) throw new Error(`SciFact data missing under ${dataDir}`);
  const claimsSha = sha256File(claimsPath);
  const corpusSha = sha256File(corpusPath);
  if (claimsSha !== EXPECTED_CLAIMS_SHA || corpusSha !== EXPECTED_CORPUS_SHA) throw new Error('Frozen SciFact dataset hash mismatch.');
  const allClaims = readJsonl<SciFactClaim>(claimsPath);
  const corpus = readJsonl<SciFactDocument>(corpusPath);
  if (allClaims.length !== 300 || corpus.length !== 5183) throw new Error('Unexpected SciFact frozen dataset counts.');

  const requestedClaims = Number(arg('max-claims') || 12);
  if (!Number.isSafeInteger(requestedClaims) || requestedClaims < 3 || requestedClaims > 30 || requestedClaims % 3 !== 0) {
    throw new Error('--max-claims must be a multiple of 3 between 3 and 30 for balanced label strata.');
  }
  const maxClaims = requestedClaims;
  const selectedClaims = selectStratifiedClaims(allClaims, maxClaims);
  if (selectedClaims.length !== maxClaims) throw new Error(`Expected ${maxClaims} stratified claims, selected ${selectedClaims.length}.`);

  await verifySealedModels();
  const baseEmbedding = new TransformerEmbeddingModel();
  const embeddingModel = new CachedEmbeddingModel(baseEmbedding);
  const nliAdapter = new PretrainedNliAdapter({ embeddingModel, relatednessFloor: RELATEDNESS_FLOOR });
  const models = modelMetadata(nliAdapter, embeddingModel);
  const originalDocs = rawDocuments(corpus);
  const docsById = new Map(originalDocs.map(document => [document.id, document]));
  const rows: Array<Record<string, unknown>> = [];

  try {
    for (const claim of selectedClaims) {
      const gold = goldLabel(claim);
      const goldIds = new Set(Object.keys(claim.evidence || {}));
      const baseline = await runVerification(claim, originalDocs, nliAdapter, embeddingModel);
      const hardNegativeSources = baseline.provenance.evidence
        .filter(item => !goldIds.has(item.evidence_id))
        .slice(0, 2)
        .map(item => docsById.get(item.evidence_id))
        .filter((item): item is RawDocument => Boolean(item));

      if (hardNegativeSources.length === 0) {
        rows.push({
          claim_id: claim.id, gold, skipped: true,
          skip_reason: 'No non-gold evidence document available among the baseline top-eight.'
        });
        continue;
      }

      const baselineEvidenceIds = baseline.provenance.evidence.map(item => item.evidence_id);
      const baselineBenchmarkLabel = benchmarkDirection(baseline);
      const baselineProductionLabel = productionDirection(baseline.provenance.final_verdict);
      const scenarios: Array<Record<string, unknown>> = [];

      for (const mode of ['same_domain', 'cross_domain'] as const) {
        const replicas = buildReplicaDocuments(hardNegativeSources, claim.id, mode);
        const attacked = await runVerification(claim, [...originalDocs, ...replicas], nliAdapter, embeddingModel);
        const attackedEvidence = attacked.provenance.evidence;
        const attackedEvidenceIds = attackedEvidence.map(item => item.evidence_id);
        const replicaEvidence = attackedEvidence.filter(item => item.evidence_id.startsWith(`00-replica-${claim.id}-`));
        scenarios.push({
          mode,
          injected_replica_count: replicas.length,
          replicas_in_final_evidence: replicaEvidence.length,
          replica_nli_labels: replicaEvidence.map(item => item.nli_label),
          replica_duplicate_flags: replicaEvidence.map(item => item.is_duplicate_cluster),
          replica_domains: replicaEvidence.map(item => item.domain),
          source_diversity: attacked.provenance.source_diversity,
          benchmark_label: benchmarkDirection(attacked),
          production_verdict: attacked.provenance.final_verdict,
          benchmark_label_flipped: benchmarkDirection(attacked) !== baselineBenchmarkLabel,
          production_verdict_flipped: attacked.provenance.final_verdict !== baseline.provenance.final_verdict,
          evidence_votes: directionalVoteCounts(attacked),
          gold_evidence_recall_at_5: recallAt(attackedEvidenceIds, goldIds, 5),
          gold_evidence_recall_at_8: recallAt(attackedEvidenceIds, goldIds, 8),
          temporal_candidates_excluded: attacked.provenance.retrieval_summary.temporal_candidates_excluded
        });
      }

      rows.push({
        claim_id: claim.id,
        gold,
        gold_evidence_count: goldIds.size,
        baseline: {
          benchmark_label: baselineBenchmarkLabel,
          production_verdict: baseline.provenance.final_verdict,
          production_confidence: baseline.provenance.final_confidence,
          evidence_ids: baselineEvidenceIds,
          evidence_votes: directionalVoteCounts(baseline),
          source_diversity: baseline.provenance.source_diversity,
          gold_evidence_recall_at_5: recallAt(baselineEvidenceIds, goldIds, 5),
          gold_evidence_recall_at_8: recallAt(baselineEvidenceIds, goldIds, 8)
        },
        selected_hard_negative_ids: hardNegativeSources.map(item => item.id),
        scenarios
      });
      console.log(`processed SciFact contamination claim ${claim.id} (${rows.length}/${selectedClaims.length})`);
    }

    const completedRows = rows.filter(row => row.skipped !== true);
    const scenarioRows = completedRows.flatMap(row => row.scenarios as Array<Record<string, unknown>>);
    const flips = (key: string) => scenarioRows.filter(row => row[key] === true).length;
    const runtimeConfig = {
      selected_claims: selectedClaims.map(claim => claim.id),
      max_claims: maxClaims,
      relatedness_floor: RELATEDNESS_FLOOR,
      per_query_top_k: PER_QUERY_TOP_K,
      final_pipeline_k: FINAL_TOP_K,
      nli_concurrency: NLI_CONCURRENCY,
      replicas_per_non_gold_source: REPLICAS_PER_SOURCE,
      hard_negative_sources_per_claim: 2,
      replica_modes: ['same_domain', 'cross_domain'],
      liAR_prior: 'disabled'
    };
    const report = {
      protocol_version: 'truthlens-v2-scifact-real-text-contamination-v1',
      generated_at: new Date().toISOString(),
      benchmark: false,
      analysis_only: true,
      status: completedRows.length === selectedClaims.length ? 'COMPLETED' : 'PARTIAL',
      task: 'Controlled contamination sensitivity test using frozen real SciFact claims/abstracts and simulated publisher host metadata.',
      run_provenance: {
        source_commit_sha: process.env.TRUTHLENS_EVALUATED_COMMIT_SHA || process.env.GITHUB_SHA || null,
        source_ref: process.env.GITHUB_REF || null,
        workflow_run_id: process.env.GITHUB_RUN_ID || null,
        config_sha256: sha256Json(runtimeConfig),
        model_manifest_sha256: models.manifest_sha256
      },
      dataset: {
        name: 'SciFact', split: 'dev', claims_evaluated: selectedClaims.length,
        corpus_documents: corpus.length, claims_sha256: claimsSha, corpus_sha256: corpusSha
      },
      models,
      runtime_config: runtimeConfig,
      summary: {
        claims_completed: completedRows.length,
        claims_skipped: rows.length - completedRows.length,
        attacked_scenarios: scenarioRows.length,
        benchmark_label_flip_count: flips('benchmark_label_flipped'),
        production_verdict_flip_count: flips('production_verdict_flipped'),
        cross_domain_replica_scenarios: scenarioRows.filter(row => row.mode === 'cross_domain').length,
        same_domain_replica_scenarios: scenarioRows.filter(row => row.mode === 'same_domain').length,
        cross_domain_replica_evidence_total: scenarioRows.filter(row => row.mode === 'cross_domain')
          .reduce((sum, row) => sum + Number(row.replicas_in_final_evidence || 0), 0),
        same_domain_replica_evidence_total: scenarioRows.filter(row => row.mode === 'same_domain')
          .reduce((sum, row) => sum + Number(row.replicas_in_final_evidence || 0), 0)
      },
      interpretation_limits: [
        'The text comes from the frozen SciFact dev corpus, but SciFact has no publisher/source metadata; all replica hostnames are simulated.',
        'This is a controlled duplicate-content sensitivity diagnostic, not an external benchmark, production accuracy result, or real-world publisher contamination study.',
        'Gold IDs are used only by the harness to select non-gold source documents and score recall; gold labels/IDs are never passed to the retrieval or NLI pipeline.',
        'The sample is stratified and deterministic (up to 30 claims); it is not an independently human-adjudicated holdout.',
        'No model weights, production thresholds, source policies, abstention rules, or decision policies are changed.'
      ],
      production_promotion_allowed: false,
      rows
    };
    const output = path.resolve(arg('output') || 'artifacts/v2-scifact-e2e/scifact-real-text-contamination.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({
      status: report.status,
      claims_completed: report.summary.claims_completed,
      attacked_scenarios: report.summary.attacked_scenarios,
      benchmark_label_flip_count: report.summary.benchmark_label_flip_count,
      production_verdict_flip_count: report.summary.production_verdict_flip_count,
      cache_size: embeddingModel.cacheSize,
      model_manifest_sha256: models.manifest_sha256,
      artifact: output
    }, null, 2));
  } finally {
    await disposeLocalNliContext();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exit(1); });
}
