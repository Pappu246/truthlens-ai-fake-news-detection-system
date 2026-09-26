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

/* ==========================================================================
 * V2.2 — OPTIONAL EXPERIMENTAL NLI CANDIDATES (evaluation only)
 * ==========================================================================
 * Everything below is ADDITIVE. It does not appear in ALL_MODEL_MANIFESTS,
 * the default resolver never reads it, and no entry here can become the
 * production/default adapter through any code path in this repository:
 * `resolveDefaultNliAdapter()` continues to return the sealed
 * `Xenova/nli-deberta-v3-xsmall` adapter.
 *
 * Each candidate is a CONTENT-SEALED provisioning record:
 *   - canonical model id + the upstream base model it was exported from,
 *   - the pinned upstream revision (Hugging Face commit) when it is KNOWN,
 *   - per-file byte size + SHA-256, plus the git blob SHA-1 of the pinned
 *     mirror commit the bytes were fetched from,
 *   - `sealState` — 'sealed' (bytes are pinned and verifiable) or
 *     'unsealed'  (identity is pinned, bytes are NOT yet attested here).
 *
 * FAIL-CLOSED CONTRACT: an 'unsealed' candidate cannot be provisioned or
 * loaded. Downloading, resolving, or evaluating it throws
 * `ModelUnavailableError`. Seals are never inferred, guessed, or filled in
 * from an unverified source, and an incomplete/size-mismatched local copy is
 * rejected rather than used. This is what keeps "we evaluated model X" a
 * checkable statement about exact bytes.
 */

export type CandidateSealState = 'sealed' | 'unsealed';

export interface ExperimentalNliCandidate {
  kind: 'nli';
  /** Local/Transformers.js model id (also the on-disk directory name). */
  id: string;
  /** Upstream model the ONNX port was exported from. */
  baseModel: string;
  /** Pinned upstream revision (HF commit sha) — null when not yet attested. */
  revision: string | null;
  quantization: 'int8-dynamic(q8)-onnx' | 'fp32-onnx';
  /** Content seal: `<dtype>@<first8 of the ONNX sha256>`; null when unsealed. */
  versionSeal: string | null;
  sealState: CandidateSealState;
  /** Purpose/notes recorded in the evaluation report. */
  purpose: string;
  /** Sealed files (empty when `sealState === 'unsealed'`). */
  files: ModelFileSeal[];
  /** Pinned source(s) the sealed bytes were fetched from. */
  sources: ModelMirrorSource[];
  /** Why an unsealed candidate is unsealed (provisioning blocker), if any. */
  unsealedReason?: string;
  /** Expected id2label class names (validated at load time, never assumed). */
  expectedLabels: string[];
}

/**
 * CANDIDATE UNDER EVALUATION (V2.2): the MNLI+FEVER+ANLI DeBERTa-v3-base
 * cross-encoder recommended as the next evidence-only experiment by
 * docs/V2_1_RESEARCH_REVIEW.md §7.
 *
 * Identity is pinned; the BYTES ARE NOT SEALED HERE because no verified copy
 * of the ONNX export was obtainable from any host reachable by this
 * environment (see docs/V2_2_MODEL_COMPARISON.md §2 for the full attempt
 * log). Recording a plausible-looking sha256/revision without having the
 * bytes would be a fabricated attestation, so the entry stays 'unsealed' and
 * every code path that would load it fails closed.
 *
 * To complete provisioning from a network-enabled environment:
 *   1. obtain the files listed in `EXPECTED_CANDIDATE_FILES` for this id;
 *   2. run `npm run seal:v2-candidate -- --model=<id> --dir=<path>` to print
 *      the seal block (sizes + SHA-256 + revision);
 *   3. paste it here, flip `sealState` to 'sealed', then
 *      `npm run download:v2-candidate -- --model=<id>` and
 *      `npm run test:v2-candidate`.
 */
export const DEBERTA_V3_BASE_MNLI_FEVER_ANLI_CANDIDATE: ExperimentalNliCandidate = {
  kind: 'nli',
  id: 'Xenova/DeBERTa-v3-base-mnli-fever-anli',
  baseModel: 'MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli',
  revision: null,
  quantization: 'int8-dynamic(q8)-onnx',
  versionSeal: null,
  sealState: 'unsealed',
  purpose:
    'V2.2 evaluation candidate: MNLI+FEVER+ANLI training is the evidence-verification ' +
    'task-fit hypothesis raised by the V2.1 review; evaluated on SciFact (not a FEVER-family ' +
    'benchmark) through the unchanged V2.1 pipeline. Evaluation only — never a default.',
  files: [],
  sources: [
    {
      type: 'huggingface-resolve',
      note: 'Canonical upstream ONNX port (Xenova). Unreachable from this environment (huggingface.co is not in the egress allowlist).',
      urlTemplate: 'https://huggingface.co/Xenova/DeBERTa-v3-base-mnli-fever-anli/resolve/main/{file}'
    }
  ],
  unsealedReason:
    'No content-sealed copy of Xenova/DeBERTa-v3-base-mnli-fever-anli was obtainable: huggingface.co and every ' +
    'tested mirror host are outside this environment\'s egress allowlist, and an exhaustive GitHub code/repo ' +
    'search found no repository vendoring these ONNX weights (the q8 export is ~185 MB, above GitHub\'s 100 MB ' +
    'non-LFS blob limit, and no LFS mirror exists). Bytes therefore cannot be hashed, pinned, or run here.',
  expectedLabels: ['entailment', 'neutral', 'contradiction']
};

/**
 * Comparison-only DistilBERT MNLI model already used by the V2.1 external
 * report. Moved into this registry so every experimental model shares ONE
 * sealed provisioning path; the byte seals are unchanged.
 */
export const DISTILBERT_MNLI_CANDIDATE: ExperimentalNliCandidate = {
  kind: 'nli',
  id: 'Xenova/distilbert-base-uncased-mnli',
  baseModel: 'typeform/distilbert-base-uncased-mnli',
  revision: null,
  quantization: 'int8-dynamic(q8)-onnx',
  versionSeal: 'q8@5b7e374d',
  sealState: 'sealed',
  purpose: 'V2.1 comparison-only generic MNLI baseline (recorded in docs/V2_1_RESEARCH_REVIEW.md §4).',
  files: [
    { path: 'config.json', bytes: 753, sha256: '7d897374b56613fb8579c623dd89bbc01ab9795612b3d1d546cd5658232a5c7a', gitBlobSha1: '8c9d46fe6cf23ab39dd6fbad2e4d0640397c4faa' },
    { path: 'onnx/model_quantized.onnx', bytes: 67581975, sha256: '5b7e374d8d1e44149fafa498efe80166f740914b3e53bcfa6115fb3ecaca0945', gitBlobSha1: '63946d67f70fe7c975b801ee5d5e23cd27492db6' },
    { path: 'tokenizer.json', bytes: 711396, sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66', gitBlobSha1: '688882a79f44442ddc1f60d70334a7ff5df0fb47' },
    { path: 'tokenizer_config.json', bytes: 372, sha256: '2bbf2ea55c232406706144b907ca020cd7528a78e3e4741115be3b3566542b0b', gitBlobSha1: '1ccca247a6bf76cfc977ce13c570f541c984ca94' }
  ],
  sources: [
    {
      type: 'github-git-blob',
      note: 'Pinned mirror used by the V2.1 external comparison run.',
      repo: 'ramcsamal/MLNodeJSParser',
      commit: 'b8f11993a2bcb4412fe7328a613e0ddb3c12f214',
      pathPrefix: 'models/Xenova/distilbert-base-uncased-mnli'
    }
  ],
  expectedLabels: ['entailment', 'neutral', 'contradiction']
};

export const EXPERIMENTAL_NLI_CANDIDATES: ExperimentalNliCandidate[] = [
  DEBERTA_V3_BASE_MNLI_FEVER_ANLI_CANDIDATE,
  DISTILBERT_MNLI_CANDIDATE
];

/** Files a Transformers.js NLI candidate must provide to run offline. */
export const EXPECTED_CANDIDATE_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx'
] as const;

export function findExperimentalCandidate(id: string): ExperimentalNliCandidate | undefined {
  return EXPERIMENTAL_NLI_CANDIDATES.find(candidate => candidate.id === id);
}

/** True when `id` is a sealed, provisionable experimental candidate. */
export function isSealedCandidate(id: string): boolean {
  return findExperimentalCandidate(id)?.sealState === 'sealed';
}

export interface CandidateReadiness {
  ok: boolean;
  candidate: ExperimentalNliCandidate;
  root: string;
  /** Reasons the candidate cannot be used right now (empty when ok). */
  problems: string[];
}

/**
 * Fail-closed readiness check for an experimental candidate: the seal must
 * exist in the registry AND every sealed file must be present with the exact
 * sealed byte size. Hash verification is a separate, explicit step
 * (`verifyCandidateHashes`) because it is IO-heavy.
 */
export function candidateReadiness(
  id: string,
  modelDir: string = getV2ModelDir()
): CandidateReadiness {
  const candidate = findExperimentalCandidate(id);
  if (!candidate) {
    throw new ModelUnavailableError(
      `'${id}' is not a registered TruthLens V2 experimental NLI candidate. ` +
      `Registered: ${EXPERIMENTAL_NLI_CANDIDATES.map(c => c.id).join(', ')}. ` +
      'Add a sealed entry to EXPERIMENTAL_NLI_CANDIDATES before evaluating a new model.'
    );
  }
  const root = path.join(modelDir, candidate.id);
  const problems: string[] = [];

  if (candidate.sealState !== 'sealed' || candidate.files.length === 0) {
    problems.push(
      `candidate '${candidate.id}' is registered but UNSEALED — no byte seals are recorded, so its weights ` +
      'cannot be attested. ' + (candidate.unsealedReason ?? 'No reason recorded.')
    );
    return { ok: false, candidate, root, problems };
  }

  const sealedPaths = new Set(candidate.files.map(file => file.path));
  for (const required of EXPECTED_CANDIDATE_FILES) {
    if (!sealedPaths.has(required)) {
      problems.push(`seal is incomplete: required file '${required}' has no recorded size/SHA-256.`);
    }
  }
  for (const file of candidate.files) {
    const full = path.join(root, file.path);
    try {
      const size = fs.statSync(full).size;
      if (size !== file.bytes) {
        problems.push(`${file.path}: ${size} bytes on disk, sealed size is ${file.bytes} (corrupt or tampered).`);
      }
    } catch {
      problems.push(`${file.path}: missing under ${root}.`);
    }
  }
  return { ok: problems.length === 0, candidate, root, problems };
}

/** Full SHA-256 verification of a sealed candidate's local files. */
export function verifyCandidateHashes(
  id: string,
  modelDir: string = getV2ModelDir()
): { ok: boolean; mismatches: string[] } {
  const candidate = findExperimentalCandidate(id);
  if (!candidate || candidate.sealState !== 'sealed') {
    return { ok: false, mismatches: [`'${id}' is not a sealed experimental candidate; refusing to verify.`] };
  }
  const root = path.join(modelDir, candidate.id);
  const mismatches: string[] = [];
  for (const file of candidate.files) {
    const full = path.join(root, file.path);
    try {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      if (sha !== file.sha256) mismatches.push(`${file.path}: sha256 ${sha} != sealed ${file.sha256}`);
    } catch (err: any) {
      mismatches.push(`${file.path}: unreadable (${err?.message || err})`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Throws unless `id` is a registered, sealed candidate whose local files are
 * complete and correctly sized. The single enforcement point used by the
 * candidate downloader, the candidate adapter resolver, and the external
 * evaluation harness.
 */
export function assertCandidateUsable(id: string, modelDir: string = getV2ModelDir()): ExperimentalNliCandidate {
  const readiness = candidateReadiness(id, modelDir);
  if (!readiness.ok) {
    throw new ModelUnavailableError(
      `Experimental NLI candidate '${id}' is NOT usable (fail-closed):\n` +
      readiness.problems.map(problem => `  - ${problem}`).join('\n') + '\n' +
      `  -> Provision it with \`npm run download:v2-candidate -- --model=${id}\` (requires a sealed registry entry), ` +
      'or record seals first with `npm run seal:v2-candidate`. No unsealed or partial model is ever loaded.'
    );
  }
  return readiness.candidate;
}
