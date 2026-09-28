/**
 * TruthLens V2 — external model-quality harness smoke test
 * ---------------------------------------------------------
 * Token-free validation of the frozen SciFact inputs plus the remote-adapter
 * request/response contracts. This is a harness test, not a model-quality
 * benchmark and must never be reported as pretrained-model evaluation.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { buildClaim } from '../server/v2/queryExpansion';
import { HuggingFaceNliAdapter } from '../server/v2/nli/huggingFaceNliAdapter';
import { HuggingFaceEmbeddingModel } from '../server/v2/retrieval/huggingFaceEmbeddingModel';

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
interface SciFactDocument {
  doc_id: number;
  title: string;
  abstract: string[];
  structured: boolean;
}

const EXPECTED_CLAIMS_SHA = '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217';
const EXPECTED_CORPUS_SHA = 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') || path.join('data', 'external', 'scifact'));
  const claimsPath = path.join(dataDir, 'claims_dev.jsonl');
  const corpusPath = path.join(dataDir, 'corpus.jsonl');

  if (!fs.existsSync(claimsPath) || !fs.existsSync(corpusPath)) {
    throw new Error(`SciFact data missing under ${dataDir}`);
  }

  const claimsSha = sha256File(claimsPath);
  const corpusSha = sha256File(corpusPath);
  if (claimsSha !== EXPECTED_CLAIMS_SHA || corpusSha !== EXPECTED_CORPUS_SHA) {
    throw new Error(`SciFact hash mismatch: claims=${claimsSha}, corpus=${corpusSha}`);
  }

  const allClaims = readJsonl<SciFactClaim>(claimsPath).sort((a, b) => a.id - b.id);
  const corpus = readJsonl<SciFactDocument>(corpusPath);
  if (allClaims.length !== 300) throw new Error(`Expected 300 claims, got ${allClaims.length}`);
  if (corpus.length !== 5183) throw new Error(`Expected 5183 corpus documents, got ${corpus.length}`);

  const maxClaims = Math.max(1, Math.min(Number(arg('max-claims') || 3), allClaims.length));
  const claims = allClaims.filter(claim => Object.keys(claim.evidence || {}).length > 0).slice(0, maxClaims);
  if (claims.length < maxClaims) throw new Error(`Could only select ${claims.length} claims with gold evidence for smoke validation.`);
  const docsById = new Map(corpus.map(doc => [String(doc.doc_id), doc]));

  let nliCalls = 0;
  let embeddingCalls = 0;

  const fakeFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

    if (body.parameters && typeof body.parameters === 'object') {
      nliCalls++;
      return new Response(JSON.stringify({
        labels: ['supports the claim', 'refutes the claim', 'does not determine the claim'],
        scores: [0.76, 0.14, 0.10]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    embeddingCalls++;
    const inputs = Array.isArray(body.inputs) ? body.inputs : [body.inputs];
    const vectors = inputs.map((_input, index) => {
      const value = index === 0 ? 1 : 0.5;
      return [value, 1 - value, 0.25, 0.75];
    });
    return new Response(JSON.stringify(vectors), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const nli = new HuggingFaceNliAdapter({
    token: 'offline-smoke-token',
    fetchImpl: fakeFetch
  });
  const embedding = new HuggingFaceEmbeddingModel({
    token: 'offline-smoke-token',
    fetchImpl: fakeFetch
  });

  for (const claim of claims) {
    const builtClaim = buildClaim(claim.claim);
    const docIds = Object.keys(claim.evidence || {});
    if (docIds.length === 0) throw new Error(`Claim ${claim.id} has no gold evidence for smoke validation`);

    const doc = docsById.get(docIds[0]);
    if (!doc) throw new Error(`Missing document ${docIds[0]} for claim ${claim.id}`);

    const rationale = claim.evidence[docIds[0]][0];
    const passage = rationale.sentences.map(index => doc.abstract[index]).filter(Boolean).join(' ').trim();
    if (!passage) throw new Error(`Empty rationale for claim ${claim.id}`);

    const nliResult = await nli.classify(builtClaim, passage);
    if (nliResult.modelName !== 'facebook/bart-large-mnli' || !['SUPPORTS', 'REFUTES', 'NEUTRAL'].includes(nliResult.label)) {
      throw new Error(`Unexpected NLI adapter result for claim ${claim.id}`);
    }

    const vectors = await embedding.embedBatch([claim.claim, passage]);
    if (vectors.length !== 2 || vectors.some(vector => vector.length !== 4)) {
      throw new Error(`Unexpected embedding adapter result for claim ${claim.id}`);
    }
  }

  const output = {
    protocol_version: 'truthlens-v2-model-quality-external-smoke-v1',
    status: 'PASS',
    benchmark: false,
    model_quality_result: false,
    claims_checked: claims.length,
    corpus_documents: corpus.length,
    claims_sha256: claimsSha,
    corpus_sha256: corpusSha,
    nli_requests: nliCalls,
    embedding_requests: embeddingCalls,
    note: 'Token-free harness validation only. No pretrained-model quality metric was computed.'
  };

  const outputPath = path.resolve(arg('output') || path.join('artifacts', 'v2-model-quality', 'external-harness-smoke.json'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
