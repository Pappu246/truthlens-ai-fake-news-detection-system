/**
 * TruthLens V2 — AVeriTeC pinned-evidence end-to-end benchmark.
 *
 * Research-only: no production runtime/model/threshold/source changes.
 * Retrieval uses only the pinned dev knowledge store; reference gold
 * evidence is never read by the retriever or decision policy.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

import { verifyClaimV2 } from '../server/v2/pipeline.js';
import { TransformerEmbeddingModel } from '../server/v2/retrieval/transformerEmbeddingModel.js';
import { PretrainedNliAdapter } from '../server/v2/nli/pretrainedNliAdapter.js';
import { bm25Search } from '../server/v2/retrieval/bm25.js';
import type { EmbeddingModel } from '../server/v2/retrieval/embeddings.js';
import { RawDocument } from '../server/v2/types.js';
import { CorpusSource } from '../server/v2/retrieval/corpusSource.js';
import { ALL_MODEL_MANIFESTS, getV2ModelDir, verifyModelHashes } from '../server/v2/ml/modelManifest.js';
import { disposeMlWorker } from '../server/v2/ml/mlWorkerClient.js';

const DATA_SHA256 = '499793726b4a5406780928a3d9dedc48d6dd53de778f22437d129cacdb08e300';
const STORE_SHA256 = '021e258cd6fb5fe6d627a4667d663e95c184c966939c15124df9206142fc2212';
const STORE_REVISION = '26238ae';
const OFFICIAL_REPO_COMMIT = '7c62d1ec8df3fb560d6efe2b85fa191135636f81';
const DATA_URL = 'https://raw.githubusercontent.com/MichSchli/AVeriTeC/7c62d1ec8df3fb560d6efe2b85fa191135636f81/data/dev.json';
const STORE_URL = 'https://huggingface.co/chenxwh/AVeriTeC/resolve/26238ae/data_store/knowledge_store/dev_knowledge_store.zip';

type Claim = { claim: string; label: string; claim_date?: string | null };
type StoreRecord = {
  url?: string;
  source_url?: string;
  published_at?: string;
  publishedAt?: string;
  date?: string;
  url2text?: unknown;
  unique?: unknown;
  sentences?: unknown;
};

function arg(name: string): string | undefined {
  return process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function sha256FileAsync(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(file);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'unknown';
  }
}

function makeDoc(claimId: number, row: number, item: number, sentence: string, url: string, record: StoreRecord, retrievalTimestamp: string): RawDocument | null {
  const text = textOf(sentence);
  const cleanUrl = textOf(url);
  if (!text || !cleanUrl) return null;
  const publishedAt = textOf(record.published_at) || textOf(record.publishedAt) || textOf(record.date) || null;
  const domain = domainOf(cleanUrl);
  return {
    id: `averitec:${claimId}:${row}:${item}`,
    url: cleanUrl,
    title: `${domain} evidence`,
    snippet: text,
    contentType: 'SUMMARY',
    publisher: domain,
    publishedAt,
    retrievedAt: retrievalTimestamp,
    retrievalMethod: 'averitec_pinned_dev_evidence_store'
  };
}

function recordsToDocs(records: StoreRecord[], claimId: number, retrievalTimestamp: string): RawDocument[] {
  const docs: RawDocument[] = [];
  for (let row = 0; row < records.length; row++) {
    const r = records[row];

    if (Array.isArray(r.url2text)) {
      const url = textOf(r.url) || textOf(r.source_url);
      for (let i = 0; i < r.url2text.length; i++) {
        const doc = makeDoc(claimId, row, i, textOf(r.url2text[i]), url, r, retrievalTimestamp);
        if (doc) docs.push(doc);
      }
    }

    if (Array.isArray(r.unique)) {
      for (let i = 0; i < r.unique.length; i++) {
        const item = r.unique[i] as { sentence?: unknown; urls?: unknown };
        const sentence = textOf(item?.sentence);
        const urls = Array.isArray(item?.urls) ? item.urls.map(textOf).filter(Boolean) : [textOf(item?.urls)];
        for (let j = 0; j < urls.length; j++) {
          const doc = makeDoc(claimId, row, i * 1000 + j, sentence, urls[j], r, retrievalTimestamp);
          if (doc) docs.push(doc);
        }
      }
    }

    if (Array.isArray(r.sentences)) {
      const fallbackUrl = textOf(r.url) || textOf(r.source_url);
      for (let i = 0; i < r.sentences.length; i++) {
        const item = r.sentences[i];
        const sentence = typeof item === 'string' ? item : textOf((item as { text?: unknown })?.text);
        const url = typeof item === 'object' && item ? textOf((item as { url?: unknown }).url) || fallbackUrl : fallbackUrl;
        const doc = makeDoc(claimId, row, i, sentence, url, r, retrievalTimestamp);
        if (doc) docs.push(doc);
      }
    }
  }

  const seen = new Set<string>();
  return docs.filter(doc => {
    const key = `${doc.url.toLowerCase()}\n${doc.snippet.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectEntryPrefix(zipFile: string): string {
  const listed = spawnSync('unzip', ['-Z1', zipFile], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`Unable to list knowledge store zip (exit ${listed.status}).`);
  const sample = listed.stdout.split(/\r?\n/).find((entry: string) => /(?:^|\/)output_dev\/0\.json$/.test(entry));
  if (!sample) throw new Error('Pinned knowledge store does not contain output_dev/0.json.');
  return sample.slice(0, sample.lastIndexOf('output_dev/'));
}

async function readZipJsonl(zipFile: string, entry: string): Promise<StoreRecord[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-p', zipFile, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
    const rows: StoreRecord[] = [];
    let stderr = '';
    let failed = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', line => {
      if (failed || !line.trim()) return;
      try {
        rows.push(JSON.parse(line) as StoreRecord);
      } catch (error) {
        failed = true;
        child.kill('SIGTERM');
        reject(new Error(`Invalid JSONL in ${entry}: ${String(error)}`));
      }
    });

    child.on('error', error => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    });

    child.on('close', code => {
      rl.close();
      if (failed) return;
      if (code !== 0) {
        failed = true;
        reject(new Error(`unzip failed for ${entry} (exit ${code}): ${stderr.trim()}`));
        return;
      }
      resolve(rows);
    });
  });
}

class ChunkedEmbeddingModel implements EmbeddingModel {
  public readonly name: string;
  public readonly version: string;
  public readonly dimensions: number;

  constructor(private readonly base: TransformerEmbeddingModel, private readonly batchSize: number) {
    this.name = base.name;
    this.version = base.version;
    this.dimensions = base.dimensions;
  }

  public embed(text: string): number[] {
    return this.base.embed(text);
  }

  public embedBatch(texts: string[]): number[][] {
    if (texts.length === 0) return [];
    const size = Math.max(1, Math.min(this.batchSize, 256));
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += size) {
      vectors.push(...this.base.embedBatch(texts.slice(i, i + size)));
    }
    return vectors;
  }

  public clearCache(): void {
    this.base.clearCache();
  }
}

class AveritecStoreSource implements CorpusSource {
  public readonly name = 'averitec_pinned_dev_evidence_store';
  private readonly zipFile: string;
  private readonly entryPrefix: string;
  private readonly coarseBm25K: number;
  private activeClaimId: number | null = null;
  private activeCache: { id: number; docs: RawDocument[] } | null = null;
  private readonly retrievalTimestamp = new Date().toISOString();

  constructor(zipFile: string, coarseBm25K: number) {
    this.zipFile = zipFile;
    this.entryPrefix = detectEntryPrefix(zipFile);
    this.coarseBm25K = Math.max(100, Math.min(coarseBm25K, 10000));
  }

  public setActiveClaimId(id: number): void {
    if (this.activeClaimId !== id) this.activeCache = null;
    this.activeClaimId = id;
  }

  public clearActiveCache(): void {
    this.activeCache = null;
  }

  private async getAllDocs(id: number): Promise<RawDocument[]> {
    if (this.activeCache?.id === id) return this.activeCache.docs;
    const records = await readZipJsonl(this.zipFile, `${this.entryPrefix}output_dev/${id}.json`);
    const docs = recordsToDocs(records, id, this.retrievalTimestamp);
    this.activeCache = { id, docs };
    return docs;
  }

  public async fetchCandidates(query: string): Promise<RawDocument[]> {
    if (this.activeClaimId === null) throw new Error('AVeriTeC source has no active claim id.');
    const all = await this.getAllDocs(this.activeClaimId);
    if (all.length === 0) return [];
    const searchable = all.map(d => ({ id: d.id, text: `${d.title} ${d.snippet}` }));
    const hits = bm25Search(query, searchable, Math.min(this.coarseBm25K, searchable.length));
    const keep = new Set(hits.map(hit => hit.id));
    return all.filter(doc => keep.has(doc.id));
  }
}

function productionLabel(verdict: string): string {
  if (verdict === 'VERIFIED') return 'Supported';
  if (verdict === 'REFUTED') return 'Refuted';
  if (verdict === 'CONFLICTED') return 'Conflicting Evidence/Cherrypicking';
  return 'Not Enough Evidence';
}

function benchmarkLabel(result: Awaited<ReturnType<typeof verifyClaimV2>>): string {
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
  if (support <= 0 && refute <= 0) return 'Not Enough Evidence';
  return support > refute ? 'Supported' : refute > support ? 'Refuted' : 'Not Enough Evidence';
}

function evidenceFor(result: Awaited<ReturnType<typeof verifyClaimV2>>): string[] {
  return result.provenance.evidence
    .slice()
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, 10)
    .map(e => e.exact_passage.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function macroF1(gold: string[], predicted: string[], labels: string[]) {
  const perClass = labels.map(label => {
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < gold.length; i++) {
      if (gold[i] === label && predicted[i] === label) tp++;
      else if (gold[i] !== label && predicted[i] === label) fp++;
      else if (gold[i] === label && predicted[i] !== label) fn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { label, precision, recall, f1, support: tp + fn };
  });
  const accuracy = gold.length ? gold.reduce((n, g, i) => n + Number(g === predicted[i]), 0) / gold.length : 0;
  return { accuracy, macro_f1: perClass.reduce((s, x) => s + x.f1, 0) / labels.length, per_class: perClass };
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') || 'data/external/averitec');
  const claimsPath = path.join(dataDir, 'dev.json');
  const zipFile = path.resolve(arg('knowledge-store') || 'artifacts/phase2/averitec/dev_knowledge_store.zip');
  const outputDir = path.resolve(arg('output-dir') || 'artifacts/v2-averitec-e2e');
  fs.mkdirSync(outputDir, { recursive: true });

  const claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8')) as Claim[];
  if (!Array.isArray(claims) || claims.length !== 500) throw new Error('AVeriTeC dev split must contain exactly 500 claims.');
  const claimsSha = await sha256FileAsync(claimsPath);
  if (claimsSha !== DATA_SHA256) throw new Error(`AVeriTeC dev SHA-256 mismatch: ${claimsSha}`);
  const storeSha = await sha256FileAsync(zipFile);
  if (storeSha !== STORE_SHA256) throw new Error(`AVeriTeC evidence-store SHA-256 mismatch: ${storeSha}`);

  const modelDir = getV2ModelDir();
  for (const manifest of ALL_MODEL_MANIFESTS) {
    const verified = await verifyModelHashes(modelDir, manifest);
    if (!verified.ok) throw new Error(`Model seal verification failed for ${manifest.id}: ${verified.mismatches.join('; ')}`);
  }

  const startClaim = Math.max(0, Math.min(Number(arg('start-claim') || 0), 499));
  const maxClaims = Math.max(1, Math.min(Number(arg('max-claims') || 500), 500 - startClaim));
  const endClaimExclusive = startClaim + maxClaims;
  const coarseBm25K = Math.max(100, Math.min(Number(arg('coarse-bm25-k') || 2000), 10000));
  const finalTopK = Math.max(5, Math.min(Number(arg('final-k') || 10), 20));
  const embeddingBatchSize = Math.max(1, Math.min(Number(arg('embedding-batch') || 64), 256));

  let embeddingModel = new ChunkedEmbeddingModel(new TransformerEmbeddingModel(), embeddingBatchSize);
  let nliAdapter = new PretrainedNliAdapter({ embeddingModel });
  const source = new AveritecStoreSource(zipFile, coarseBm25K);
  // Long AVeriTeC runs can accumulate native/JS inference allocations inside
  // Transformers.js + ONNX Runtime. Recycle the research-only worker at a
  // fixed cadence so memory usage stays bounded while model bytes remain
  // exactly the same.
  const workerRecycleEvery = Math.max(1, Math.min(Number(arg('worker-recycle-every') || 10), 50));
  const predictions: Array<{ label: string; string_evidence: string[]; justification: string }> = [];
  const rows: Record<string, unknown>[] = [];
  const goldLabels: string[] = [];
  const benchmarkLabels: string[] = [];
  const productionLabels: string[] = [];

  try {
    for (let id = startClaim; id < endClaimExclusive; id++) {
      const relativeId = id - startClaim;
      const claim = claims[id];

      if (relativeId > 0 && relativeId % workerRecycleEvery === 0) {
        await disposeMlWorker();
        embeddingModel = new ChunkedEmbeddingModel(new TransformerEmbeddingModel(), embeddingBatchSize);
        nliAdapter = new PretrainedNliAdapter({ embeddingModel });
        console.log(`recycled V2 ML worker after ${id} claims`);
      }

      source.setActiveClaimId(id);
      const result = await verifyClaimV2(claim.claim, {
        corpus: source,
        nliAdapter,
        nliConcurrency: 4,
        retrieval: { embeddingModel, perQueryTopK: 15, finalTopK },
        enableFullTextEnrichment: false,
        minCandidatesExpectedWarning: 0,
        claimDate: claim.claim_date || null,
        enforceTemporalEvidence: true
      });
      const evidence = evidenceFor(result);
      const label = benchmarkLabel(result);
      const production = productionLabel(result.provenance.final_verdict);
      predictions.push({ label, string_evidence: evidence, justification: evidence.join(' ') });
      goldLabels.push(claim.label);
      benchmarkLabels.push(label);
      productionLabels.push(production);
      rows.push({
        id,
        gold_label: claim.label,
        prediction_label: label,
        production_prediction_label: production,
        claim_date: claim.claim_date || null,
        truthlens_verdict: result.provenance.final_verdict,
        confidence: result.provenance.final_confidence,
        abstained: result.provenance.abstained,
        evidence_count: result.provenance.evidence.length,
        retrieval_summary: result.provenance.retrieval_summary,
        evidence: result.provenance.evidence,
        limitations: [
          ...result.provenance.limitations,
          'Temporal filtering is enforced when evidence records expose a parseable published_at/publishedAt/date field; records without a parseable publication timestamp remain eligible and are explicitly reported in provenance.'
        ]
      });
      source.clearActiveCache();
      embeddingModel.clearCache();
      if ((relativeId + 1) % 10 === 0 || relativeId + 1 === maxClaims) {
        const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
        forceGc?.();
        const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`processed ${relativeId + 1}/${maxClaims} (global=${id + 1}/${claims.length}, heap=${heapMb}MB rss=${rssMb}MB)`);
      }
    }

    const expectedCount = endClaimExclusive - startClaim;
    const fullRun = startClaim === 0 && endClaimExclusive === 500;
    const labels = ['Supported', 'Refuted', 'Not Enough Evidence', 'Conflicting Evidence/Cherrypicking'];
    const benchmarkMetrics = macroF1(goldLabels, benchmarkLabels, labels);
    const productionMetrics = macroF1(goldLabels, productionLabels, labels);
    const productionAbstentionRate = productionLabels.length
      ? productionLabels.filter(label => label === 'Not Enough Evidence' || label === 'Conflicting Evidence/Cherrypicking').length / productionLabels.length
      : 0;
    const metadata = {
      protocol_version: 'truthlens-v2-averitec-e2e-v1',
      generated_at: new Date().toISOString(),
      benchmark: 'AVeriTeC',
      split: 'dev',
      evaluation_scope: fullRun ? 'full_500_claim_dev' : `shard_${startClaim}_${endClaimExclusive}`,
      official_data_url: DATA_URL,
      official_repo_commit: OFFICIAL_REPO_COMMIT,
      claims_sha256: DATA_SHA256,
      evidence_store: { source: STORE_URL, pinned_revision: STORE_REVISION, sha256: STORE_SHA256 },
      workflow_run_id: process.env.GITHUB_RUN_ID || null,
      git_sha: process.env.GITHUB_SHA || null,
      shard: {
        start_claim: startClaim,
        end_claim_exclusive: endClaimExclusive,
        evaluated_claims: expectedCount
      },
      runner: {
        coarse_bm25_k: coarseBm25K,
        per_query_top_k: 15,
        final_top_k: finalTopK,
        embedding_batch_size: embeddingBatchSize,
        retrieval_channels: ['LEXICAL_BM25', 'DENSE_EMBEDDING'],
        nli_concurrency: 4,
        worker_recycle_every: workerRecycleEvery,
        temporal_filtering: 'ENFORCED_WHEN_RECORD_TIMESTAMP_AVAILABLE_MISSING_OR_UNPARSEABLE_TIMESTAMPS_REMAIN_ELIGIBLE'
      },
      models: {
        nli: { name: nliAdapter.modelName, version: nliAdapter.modelVersion },
        embedding: { name: embeddingModel.name, version: embeddingModel.version }
      },
      research_metrics: {
        benchmark_directional: benchmarkMetrics,
        production_policy_mapped: {
          ...productionMetrics,
          abstention_or_conflict_rate: productionAbstentionRate
        }
      },
      prediction_contract: {
        label_key: 'label',
        evidence_key: 'string_evidence',
        max_evidence_items: 10,
        label_mapping: {
          benchmark_policy: 'weighted single-direction evidence vote (mirrors the SciFact research evaluator; production two-independent-source policy is reported separately)',
          VERIFIED: 'Supported',
          REFUTED: 'Refuted',
          INSUFFICIENT_EVIDENCE: 'Not Enough Evidence',
          CONFLICTED: 'Conflicting Evidence/Cherrypicking'
        }
      },
      production_boundary: 'research_only_no_production_model_threshold_or_runtime_change',
      claims: rows
    };

    const allowedLabels = new Set(['Supported', 'Refuted', 'Not Enough Evidence']);
    if (predictions.length !== expectedCount) {
      throw new Error(`Prediction count mismatch: ${predictions.length}; expected ${expectedCount}.`);
    }
    if (fullRun !== (predictions.length === 500)) {
      throw new Error('Full-run scope and prediction count are inconsistent.');
    }
    for (const [index, prediction] of predictions.entries()) {
      if (!allowedLabels.has(prediction.label)) throw new Error(`Unsupported benchmark label at row ${index}: ${prediction.label}`);
      if (!Array.isArray(prediction.string_evidence) || prediction.string_evidence.length > 10) {
        throw new Error(`Invalid evidence payload at row ${index}.`);
      }
      if (typeof prediction.justification !== 'string') {
        throw new Error(`Invalid justification payload at row ${index}.`);
      }
    }

    fs.writeFileSync(path.join(outputDir, 'predictions.json'), JSON.stringify(predictions, null, 2) + '\n');
    fs.writeFileSync(path.join(outputDir, 'provenance.json'), JSON.stringify(metadata, null, 2) + '\n');
    const bundleDigest = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(outputDir, 'predictions.json')))
      .update(fs.readFileSync(path.join(outputDir, 'provenance.json')))
      .digest('hex');
    fs.writeFileSync(path.join(outputDir, 'bundle-sha256.txt'), bundleDigest + '\n');
    console.log(JSON.stringify({ ok: true, evaluated_claims: maxClaims, bundle_sha256: bundleDigest }, null, 2));
  } finally {
    await disposeMlWorker();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
