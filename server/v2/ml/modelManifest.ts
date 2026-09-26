/**
 * TRUTHLENS V2.1 — PRETRAINED MODEL MANIFEST
 * ============================================
 * V2.1 replaces the V2 research placeholders (hashing n-gram embeddings,
 * rule-based heuristic NLI) with REAL pretrained models, run LOCALLY via
 * ONNX (no paid API, no network inference call).
 *
 * This module is the single source of truth for:
 *   - exactly WHICH models are used (name / base model / quantization),
 *   - exactly WHICH bytes are trusted (per-file size + SHA-256 seal, plus
 *     the git blob SHA-1 of the mirror repositories the files were fetched
 *     from — two integrity layers),
 *   - WHERE the bytes come from (canonical Hugging Face ids + pinned mirror
 *     commits; the download script tries sources in order and verifies the
 *     seals below before accepting a file),
 *   - resource requirements (see docs/V2_MODELS.md for the full runbook).
 *
 * MODEL 1 — embeddings (dense retrieval channel):
 *   id:        Xenova/all-MiniLM-L6-v2            (ONNX port, int8 dynamic)
 *   base:      sentence-transformers/all-MiniLM-L6-v2
 *   output:    384-dim, mean-pooled, L2-normalised sentence embedding
 *
 * MODEL 2 — evidence entailment / NLI:
 *   id:        Xenova/nli-deberta-v3-xsmall       (ONNX port, int8 dynamic)
 *   base:      cross-encoder/nli-deberta-v3-xsmall (trained on MNLI)
 *   labels:    read from the model's own config.json id2label at runtime
 *              (never hard-coded): {0: contradiction, 1: entailment, 2: neutral}
 *
 * VERSIONING POLICY: adapter-reported `version` strings are content-sealed:
 * `q8@<first8(sha256 of the ONNX weight file)>`. Two installations agree on
 * the "same model version" iff they hold byte-identical weights.
 *
 * INTEGRITY ATTESTATION: every file below was fetched as a raw git blob and
 * verified against the blob SHA-1 recorded here; the embedding model's main
 * ONNX tensor file is byte-identical across TWO independent mirror
 * repositories (NarrativeEngine-P and ai-agent-team share git blob
 * 712e070a96dae3668c2da046f2cdfd19ba9d4327), cross-attesting upstream
 * integrity. The canonical source of record remains the Hugging Face model
 * ids above; the mirrors exist because the CI/sandbox environment for this
 * project cannot reach huggingface.co — see docs/V2_MODELS.md.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface ModelFileSeal {
  /** Path relative to the model root, e.g. `onnx/model_quantized.onnx`. */
  path: string;
  bytes: number;
  sha256: string;
  /** git blob SHA-1 in the pinned mirror repositories (attestation layer). */
  gitBlobSha1?: string;
}

export interface ModelManifestEntry {
  kind: 'embedding' | 'nli';
  /** Model id as expected by transformers.js local loading (and as reported
   * in provenance as the model name). */
  id: string;
  /** Upstream model the ONNX port was made from. */
  baseModel: string;
  /** Quantization of the shipped ONNX weights. */
  quantization: 'int8-dynamic(q8)-onnx';
  /** Content-sealed version string: q8@<first8 of the ONNX sha256>. */
  versionSeal: string;
  files: ModelFileSeal[];
}

export const EMBEDDING_MODEL_MANIFEST: ModelManifestEntry = {
  kind: 'embedding',
  id: 'Xenova/all-MiniLM-L6-v2',
  baseModel: 'sentence-transformers/all-MiniLM-L6-v2',
  quantization: 'int8-dynamic(q8)-onnx',
  versionSeal: 'q8@afdb6f1a',
  files: [
    { path: 'onnx/model_quantized.onnx', bytes: 22972370, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1', gitBlobSha1: '712e070a96dae3668c2da046f2cdfd19ba9d4327' },
    { path: 'tokenizer.json', bytes: 711661, sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0', gitBlobSha1: 'c17ed520ed8438736732a54957a69306b8822215' },
    { path: 'tokenizer_config.json', bytes: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3', gitBlobSha1: '37fca74771bc76a8e01178ce3a6055a0995f8093' },
    { path: 'config.json', bytes: 650, sha256: '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7', gitBlobSha1: '72147e4ff4426ebedbfa2146c4a0999def51a313' },
    { path: 'vocab.txt', bytes: 231508, sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3', gitBlobSha1: 'fb140275c155a9c7c5a3b3e0e77a9e839594a938' },
    { path: 'special_tokens_map.json', bytes: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3', gitBlobSha1: 'a8b3208c2884c4efb86e49300fdd3dc877220cdf' }
  ]
};

export const NLI_MODEL_MANIFEST: ModelManifestEntry = {
  kind: 'nli',
  id: 'Xenova/nli-deberta-v3-xsmall',
  baseModel: 'cross-encoder/nli-deberta-v3-xsmall',
  quantization: 'int8-dynamic(q8)-onnx',
  versionSeal: 'q8@3fac2500',
  files: [
    { path: 'onnx/model_quantized.onnx', bytes: 87246587, sha256: '3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6', gitBlobSha1: 'b421281ae02ee9883e42ad72ecf92c6209f74a96' },
    { path: 'tokenizer.json', bytes: 8656551, sha256: 'a86f883318afa11c8c10466f1bf4efaeb6ded28a52cbe57217a8fa0d0a2a87df', gitBlobSha1: '9bbea7ec181466567dc3d7dfd8bc69fd537c3f7c' },
    { path: 'tokenizer_config.json', bytes: 384, sha256: 'd8d3bb123b99317634d5ee3d1d2d8b2ddb01510a0654687fc2639a5347a7291f', gitBlobSha1: 'efd11ae7133f17bc83a490f6e4d4ef468072abb6' },
    { path: 'config.json', bytes: 1038, sha256: 'ec0bd14cc28640326474399cd61d38ccd52b64900228799d0f81debda8c4bc53', gitBlobSha1: '9c906659502692f9b18a53be54b020bb91148c6a' },
    { path: 'added_tokens.json', bytes: 23, sha256: 'dc046d04c9b0ada7ae6f1dc89c465801799acdf0c9a6aab8c15a1b2d5ca4e91f', gitBlobSha1: '8ee2b3623dc526b123cde0aaa401755b82299af2' },
    { path: 'special_tokens_map.json', bytes: 173, sha256: '311de3f4eed9d76a43bf0d71f10e62e086ca65ccce9f15d5da0d2098bf519ecc', gitBlobSha1: 'e5cc7333cad21d1cec0eaded41e64d7eccf8230d' }
  ]
};

/** Adapter-reported model name/version strings (used in provenance). */
export const EMBEDDING_MODEL_NAME = EMBEDDING_MODEL_MANIFEST.id;
export const EMBEDDING_MODEL_VERSION = EMBEDDING_MODEL_MANIFEST.versionSeal;
export const EMBEDDING_MODEL_DIMENSIONS = 384;

export const NLI_MODEL_NAME = NLI_MODEL_MANIFEST.id;
export const NLI_MODEL_VERSION = NLI_MODEL_MANIFEST.versionSeal;

/** Pinned mirror repositories (used by scripts/v2DownloadModels.ts). */
export interface ModelMirrorSource {
  type: 'github-git-blob' | 'huggingface-resolve';
  note: string;
  /** github-git-blob fields */
  repo?: string;
  commit?: string;
  pathPrefix?: string;
  /** huggingface-resolve fields */
  urlTemplate?: string; // {file} placeholder
}

export const MIRROR_SOURCES: Record<string, ModelMirrorSource[]> = {
  [EMBEDDING_MODEL_MANIFEST.id]: [
    {
      type: 'huggingface-resolve',
      note: 'Canonical upstream ONNX port (Xenova). Preferred when huggingface.co is reachable.',
      urlTemplate: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/{file}'
    },
    {
      type: 'github-git-blob',
      note: 'Verified mirror #1 (full Xenova file set, git blob SHAs recorded in the manifest).',
      repo: 'Sagesheep/NarrativeEngine-P',
      commit: '463cdd7853954fb904e8bddf863001ae61726796',
      pathPrefix: 'mobile/public/models/Xenova/all-MiniLM-L6-v2'
    },
    {
      type: 'github-git-blob',
      note: 'Verified mirror #2 (byte-identical onnx blob to mirror #1: blob 712e070a96dae3668c2da046f2cdfd19ba9d4327).',
      repo: 'peterfei/ai-agent-team',
      commit: '9d85024fd5ba5b6f4357b602aca095ceb15d45a4',
      pathPrefix: '.claude/skills/thread-manager/models/Xenova/all-MiniLM-L6-v2'
    }
  ],
  [NLI_MODEL_MANIFEST.id]: [
    {
      type: 'huggingface-resolve',
      note: 'Canonical upstream ONNX port (Xenova). Preferred when huggingface.co is reachable.',
      urlTemplate: 'https://huggingface.co/Xenova/nli-deberta-v3-xsmall/resolve/main/{file}'
    },
    {
      type: 'github-git-blob',
      note: 'Verified mirror (full Xenova file set, git blob SHAs recorded in the manifest).',
      repo: 'ElicoftZ/CotoLyrics-alpha',
      commit: '487f0c6d1b2ec41ef8e7c1c2266515a2caeb9738',
      pathPrefix: 'models/Xenova/nli-deberta-v3-xsmall'
    }
  ]
};

export const V2_1_RUNTIME = '@huggingface/transformers@3.7.6 + onnxruntime-node@1.21.0 (Node, CPU)';

export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/** Root directory that holds `<modelDir>/Xenova/<model>/...` trees. */
export function getV2ModelDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRUTHLENS_V2_MODEL_DIR
    ? path.resolve(env.TRUTHLENS_V2_MODEL_DIR)
    : path.join(process.cwd(), 'models', 'v2');
}

export function modelRoot(modelDir: string, manifest: ModelManifestEntry): string {
  return path.join(modelDir, manifest.id);
}

export interface ModelFileReport {
  ok: boolean;
  root: string;
  missing: string[];
  wrongSize: Array<{ path: string; expected: number; actual: number }>;
}

/**
 * Fast presence/size check of every manifest file. Used by the mode resolver
 * before wiring the pretrained adapters; full hash verification is done by
 * the download script and the model test suite (it is IO-heavy).
 */
export function validateModelFiles(modelDir: string, manifest: ModelManifestEntry): ModelFileReport {
  const root = modelRoot(modelDir, manifest);
  const missing: string[] = [];
  const wrongSize: ModelFileReport['wrongSize'] = [];
  for (const f of manifest.files) {
    const p = path.join(root, f.path);
    try {
      const size = fs.statSync(p).size;
      if (size !== f.bytes) wrongSize.push({ path: f.path, expected: f.bytes, actual: size });
    } catch {
      missing.push(p);
    }
  }
  return { ok: missing.length === 0 && wrongSize.length === 0, root, missing, wrongSize };
}

/** Full SHA-256 verification of every manifest file (IO-heavy, explicit). */
export async function verifyModelHashes(modelDir: string, manifest: ModelManifestEntry): Promise<{ ok: boolean; mismatches: string[] }> {
  const root = modelRoot(modelDir, manifest);
  const mismatches: string[] = [];
  for (const f of manifest.files) {
    const p = path.join(root, f.path);
    try {
      const data = fs.readFileSync(p);
      const sha = crypto.createHash('sha256').update(data).digest('hex');
      if (sha !== f.sha256) mismatches.push(`${f.path}: sha256 ${sha} != sealed ${f.sha256}`);
    } catch (err: any) {
      mismatches.push(`${f.path}: unreadable (${err?.message || err})`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

export const ALL_MODEL_MANIFESTS: ModelManifestEntry[] = [EMBEDDING_MODEL_MANIFEST, NLI_MODEL_MANIFEST];
