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
import { CorpusSource, RawDocument } from '../server/v2/types.js';
import { buildClaim } from '../server/v2/queryExpansion.js';
import { ALL_MODEL_MANIFESTS, getV2ModelDir, verifyModelHashes } from '../server/v2/ml/modelManifest.js';
import { disposeMlWorker } from '../server/v2/ml/mlWorkerClient.js';

const DATA_SHA256 = '499793726b4a5406780928a3d9dedc48d6dd53de778f22437d129cacdb08e300';
const STORE_SHA256 = '021e258cd6fb5fe6d627a4667d663e95c184c966939c15124df9206142fc2212';
const STORE_REVISION = '26238ae';
const OFFICIAL_REPO_COMMIT = '7c62d1ec8df3fb560d6efe2b85fa191135636f81';
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
  return process.argv.find(v => v.startsWith(\`--\${name}=\`))?.slice(name.length + 3);
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
    return new URL(url).hostname.replace(/^www\\./, '').toLowerCase();
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
    id: \`averitec:\${claimId}:\${row}:\${item}\`,
    url: cleanUrl,
    title: \`\${domain} evidence\`,
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
    const key = \`\${doc.url.toLowerCase()}\\n\${doc.snippet.replace(/\\s+/g, ' ').trim().toLowerCase()}\`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectEntryPrefix(zipFile: string): string {
  const listed = spawnSync('unzip', ['-Z1', zipFile], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(\`Unable to list knowledge store zip (exit \${listed.status}).\`);
  const sample = listed.stdout.split(/\\r?\\n/).find((entry: string) => /(?:^|\\/)output_dev\\/0\\.json$/.test(entry));
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
        reject(new Error(\`Invalid JSONL in \${entry}: \${String(error)}\`));
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
        reject(new Error(\`unzip failed for \${entry} (exit \${code}): \${stderr.trim()}\`));
        return;
      }
      resolve(rows);
    });
  });
}

class AveritecStoreSource implements CorpusSource {
  public readonly name = 'averitec_pinned_dev_evidence_store';
  private readonly zipFile: string;
  private readonly entryPrefix: string;
  private readonly coarseBm25K: number;
  private readonly cache = new Map<number, RawDocument[]>();
  private activeClaimId: number | null = null;
  private readonly retrievalTimestamp = new Date().toISOString();

  constructor(zipFile: string, coarseBm25K: number) {
    this.zipFile = zipFile;
    this.entryPrefix = detectEntryPrefix(zipFile);
    this.coarseBm25K = Math.max(100, Math.min(coarseBm25K, 10000));
  }

  public setActiveClaimId(id: number): void {
    this.activeClaimId = id;
  }

  private async getAllDocs(id: number): Promise<RawDocument[]> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const records = await readZipJsonl(this.zipFile, \`\${this.entryPrefix}output_dev/\${id}.json\`);
    const docs = recordsToDocs(records, id, this.retrievalTimestamp);
    this.cache.set(id, docs);
    return docs;
  }

  public async fetchCandidates(query: string): Promise<RawDocument[]> {
    if (this.activeClaimId === null) throw new Error('AVeriTeC source has no active claim id.');
    const all = await this.getAllDocs(this.activeClaimId);
    if (all.length === 0) return [];
    const searchable = all.map(d => ({ id: d.id, text: \`\${d.title} \${d.snippet}\` }));
    const hits = bm25Search(query, searchable, Math.min(this.coarseBm25K, searchable.length));
    const keep = new Set(hits.map(hit => hit.id));
    return all.filter(doc => keep.has(doc.id));
  }
}

function mapVerdict(verdict: string): string {
  if (verdict === 'VERIFIED') return 'Supported';
  if (verdict === 'REFUTED') return 'Refuted';
  if (verdict === 'CONFLICTED') return 'Conflicting Evidence/Cherrypicking';
  return 'Not Enough Evidence';
}

function evidenceFor(result: Awaited<ReturnType<typeof verifyClaimV2>>): string[] {
  return result.provenance.evidence
    .slice()
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, 10)
    .map(e => e.exact_passage.replace(/\\s+/g, ' ').trim())
    .filter(Boolean);
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
  if (claimsSha !== DATA_SHA256) throw new Error(\`AVeriTeC dev SHA-256 mismatch: \${claimsSha}\`);
  const storeSha = await sha256FileAsync(zipFile);
  if (storeSha !== STORE_SHA256) throw new Error(\`AVeriTeC evidence-store SHA-256 mismatch: \${storeSha}\`);

  const modelDir = getV2ModelDir();
  for (const manifest of ALL_MODEL_MANIFESTS) {
    const verified = await verifyModelHashes(modelDir, manifest);
    if (!verified.ok) throw new Error(\`Model seal verification failed for \${manifest.id}: \${verified.mismatches.join('; ')}\`);
  }

  const maxClaims = Math.max(1, Math.min(Number(arg('max-claims') || 500), 500));
  const coarseBm25K = Math.max(100, Math.min(Number(arg('coarse-bm25-k') || 2000), 10000));
  const finalTopK = Math.max(5, Math.min(Number(arg('final-k') || 10), 20));

  const embeddingModel = new TransformerEmbeddingModel();
  const nliAdapter = new PretrainedNliAdapter({ embeddingModel });
  const source = new AveritecStoreSource(zipFile, coarseBm25K);
  const predictions: Array<{ label: string; string_evidence: string[]; justification: string }> = [];
  const rows: Record<string, unknown>[] = [];

  try {
    for (let id = 0; id < maxClaims; id++) {
      const claim = claims[id];
      const built = buildClaim(claim.claim);
      source.setActiveClaimId(id);
      const result = await verifyClaimV2(built.normalizedText, {
        corpus: source,
        nliAdapter,
        nliConcurrency: 8,
        retrieval: { embeddingModel, perQueryTopK: 15, finalTopK },
        enableFullTextEnrichment: false,
        minCandidatesExpectedWarning: 0,
        claimDate: claim.claim_date || null,
        enforceTemporalEvidence: false
      });
      const evidence = evidenceFor(result);
      const label = mapVerdict(result.provenance.final_verdict);
      predictions.push({ label, string_evidence: evidence, justification: evidence.join(' ') });
      rows.push({
        id,
        gold_label: claim.label,
        prediction_label: label,
        claim_date: claim.claim_date || null,
        truthlens_verdict: result.provenance.final_verdict,
        confidence: result.provenance.final_confidence,
        abstained: result.provenance.abstained,
        evidence_count: result.provenance.evidence.length,
        retrieval_summary: result.provenance.retrieval_summary,
        evidence: result.provenance.evidence,
        limitations: [
          ...result.provenance.limitations,
          'Temporal filtering was not enforced because the baseline url2text evidence-store records do not expose per-sentence publication timestamps.'
        ]
      });
      if ((id + 1) % 10 === 0 || id + 1 === maxClaims) console.log(\`processed \${id + 1}/\${maxClaims}\`);
    }

    const fullRun = maxClaims === 500;
    const metadata = {
      protocol_version: 'truthlens-v2-averitec-e2e-v1',
      generated_at: new Date().toISOString(),
      benchmark: 'AVeriTeC',
      split: 'dev',
      evaluation_scope: fullRun ? 'full_500_claim_dev' : \`smoke_\${maxClaims}_claims\`,
      official_data_url: OFFICIAL_DATA_URL,
      official_repo_commit: OFFICIAL_REPO_COMMIT,
      claims_sha256: DATA_SHA256,
      evidence_store: { source: STORE_URL, pinned_revision: STORE_REVISION, sha256: STORE_SHA256 },
      workflow_run_id: process.env.GITHUB_RUN_ID || null,
      git_sha: process.env.GITHUB_SHA || null,
      runner: {
        coarse_bm25_k: coarseBm25K,
        per_query_top_k: 15,
        final_top_k: finalTopK,
        retrieval_channels: ['LEXICAL_BM25', 'DENSE_EMBEDDING'],
        nli_concurrency: 8,
        temporal_filtering: 'NOT_ENFORCED_BASELINE_STORE_HAS_NO_PER_SENTENCE_PUBLICATION_TIMESTAMPS'
      },
      models: {
        nli: { name: nliAdapter.modelName, version: nliAdapter.modelVersion },
        embedding: { name: embeddingModel.name, version: embeddingModel.version }
      },
      prediction_contract: {
        label_key: 'label',
        evidence_key: 'string_evidence',
        max_evidence_items: 10,
        label_mapping: {
          VERIFIED: 'Supported',
          REFUTED: 'Refuted',
          INSUFFICIENT_EVIDENCE: 'Not Enough Evidence',
          CONFLICTED: 'Conflicting Evidence/Cherrypicking'
        }
      },
      production_boundary: 'research_only_no_production_model_threshold_or_runtime_change',
      claims: rows
    };

    fs.writeFileSync(path.join(outputDir, 'predictions.json'), JSON.stringify(predictions, null, 2) + '\\n');
    fs.writeFileSync(path.join(outputDir, 'provenance.json'), JSON.stringify(metadata, null, 2) + '\\n');
    const bundleDigest = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(outputDir, 'predictions.json')))
      .update(fs.readFileSync(path.join(outputDir, 'provenance.json')))
      .digest('hex');
    fs.writeFileSync(path.join(outputDir, 'bundle-sha256.txt'), bundleDigest + '\\n');
    console.log(JSON.stringify({ ok: true, evaluated_claims: maxClaims, bundle_sha256: bundleDigest }, null, 2));
  } finally {
    await disposeMlWorker();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
