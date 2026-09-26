/**
 * TRUTHLENS V2.1 — ADAPTER RESOLUTION (fixture vs pretrained)
 * ============================================================
 * The V2.1 DEFAULT adapters are the real pretrained ONNX models. Two modes:
 *
 *   - 'pretrained' (default): Xenova/all-MiniLM-L6-v2 (embeddings) +
 *     Xenova/nli-deberta-v3-xsmall (NLI), running locally and offline.
 *     Requires the sealed model files on disk (see `npm run download:v2-models`).
 *   - 'fixture': the V2 first-slice research adapters (hashing n-gram
 *     embeddings + rule-based heuristic NLI). INTENDED ONLY for lightweight,
 *     deterministic tests/CI and the recorded V2 baseline. It must be
 *     requested EXPLICITLY via TRUTHLENS_V2_MODEL_MODE=fixture; every result
 *     produced in fixture mode carries the research-adapter model names in
 *     provenance, so it can never be silently mistaken for the real models.
 *
 * FAIL-CLOSED POLICY (per the V2.1 contract): when pretrained mode is
 * requested (or defaulted to) but the model files are absent/corrupt, this
 * module throws `ModelUnavailableError` with exact remediation steps. It
 * NEVER silently swaps in the heuristic adapters.
 */
import { EmbeddingModel } from '../retrieval/embeddings';
import { HashingNgramEmbeddingModel } from '../retrieval/embeddings';
import { TransformerEmbeddingModel } from '../retrieval/transformerEmbeddingModel';
import { NliAdapter } from '../nli/nliAdapter';
import { defaultNliAdapter } from '../nli/heuristicNliAdapter';
import { PretrainedNliAdapter } from '../nli/pretrainedNliAdapter';
import {
  ALL_MODEL_MANIFESTS,
  ModelUnavailableError,
  getV2ModelDir,
  validateModelFiles
} from './modelManifest';

export type V2ModelMode = 'pretrained' | 'fixture';

export interface PretrainedReadinessProblem {
  model: string;
  root: string;
  missing: string[];
  wrongSize: Array<{ path: string; expected: number; actual: number }>;
}

/** Fast presence+size check of all sealed model files. */
export function pretrainedReadinessProblems(modelDir: string = getV2ModelDir()): PretrainedReadinessProblem[] {
  const problems: PretrainedReadinessProblem[] = [];
  for (const manifest of ALL_MODEL_MANIFESTS) {
    const report = validateModelFiles(modelDir, manifest);
    if (!report.ok) {
      problems.push({ model: manifest.id, root: report.root, missing: report.missing, wrongSize: report.wrongSize });
    }
  }
  return problems;
}

function remediationText(modelDir: string): string {
  return (
    `\n  -> Run \`npm run download:v2-models\` to fetch the sealed, hash-verified model files into '${modelDir}' ` +
    '(or set TRUTHLENS_V2_MODEL_DIR).\n' +
    '  -> For LIGHTWEIGHT TESTS/CI only, set TRUTHLENS_V2_MODEL_MODE=fixture to use the V2 research adapters ' +
    '(hashing embeddings + heuristic NLI) — deterministic but NOT equivalent to the real pretrained models.'
  );
}

/**
 * Resolves the active adapter mode. `TRUTHLENS_V2_MODEL_MODE` explicitly
 * selects a mode; when unset, the mode is 'pretrained' if all sealed model
 * files are present, and a hard, actionable error otherwise.
 */
export function resolveModelMode(env: NodeJS.ProcessEnv = process.env): V2ModelMode {
  const requested = (env.TRUTHLENS_V2_MODEL_MODE || '').trim().toLowerCase();
  if (requested === 'fixture') return 'fixture';
  if (requested && requested !== 'pretrained') {
    throw new ModelUnavailableError(
      `Unknown TRUTHLENS_V2_MODEL_MODE='${env.TRUTHLENS_V2_MODEL_MODE}' — expected 'pretrained' or 'fixture'.`
    );
  }
  const modelDir = getV2ModelDir(env);
  const problems = pretrainedReadinessProblems(modelDir);
  if (problems.length === 0) return 'pretrained';
  const details = problems
    .map(p => {
      if (p.missing.length > 0) return `  - ${p.model}: ${p.missing.length} missing file(s) under ${p.root}`;
      const w = p.wrongSize[0];
      return `  - ${p.model}: size mismatch for ${w.path} (expected ${w.expected} bytes, found ${w.actual}); the file is corrupt or tampered`;
    })
    .join('\n');
  throw new ModelUnavailableError(
    'TruthLens V2.1 default adapters are REAL pretrained ONNX models (Xenova/all-MiniLM-L6-v2 embeddings, ' +
    'Xenova/nli-deberta-v3-xsmall NLI), but the sealed model files are not available:\n' + details + '\n' +
    'Per policy the pipeline REFUSES to silently fall back to heuristic inference.' + remediationText(modelDir)
  );
}

let cachedEmbeddingModel: EmbeddingModel | null = null;
let cachedNliAdapter: NliAdapter | null = null;

/** The default embedding model for V2.1 (pretrained) or fixture mode. */
export function resolveDefaultEmbeddingModel(env?: NodeJS.ProcessEnv): EmbeddingModel {
  if (cachedEmbeddingModel) return cachedEmbeddingModel;
  const mode = resolveModelMode(env);
  cachedEmbeddingModel = mode === 'fixture' ? new HashingNgramEmbeddingModel() : new TransformerEmbeddingModel();
  return cachedEmbeddingModel;
}

/** The default NLI adapter for V2.1 (pretrained) or fixture mode. */
export function resolveDefaultNliAdapter(env?: NodeJS.ProcessEnv): NliAdapter {
  if (cachedNliAdapter) return cachedNliAdapter;
  const mode = resolveModelMode(env);
  cachedNliAdapter = mode === 'fixture' ? defaultNliAdapter : new PretrainedNliAdapter();
  return cachedNliAdapter;
}

/** Human-readable description of the active adapters (pipeline limitations/provenance). */
export function describeActiveAdapters(env?: NodeJS.ProcessEnv): { mode: V2ModelMode; description: string } {
  const mode = resolveModelMode(env);
  if (mode === 'fixture') {
    return {
      mode,
      description:
        'TRUTHLENS_V2_MODEL_MODE=fixture (explicit test/CI mode): dense retrieval uses the deterministic hashing ' +
        'n-gram research placeholder and evidence classification uses the rule-based heuristic NLI research ' +
        'placeholder. These are NOT the real pretrained models and results are not comparable to V2.1 pretrained runs.'
    };
  }
  return {
    mode,
    description:
      'V2.1 pretrained adapters active: embeddings=Xenova/all-MiniLM-L6-v2 (q8@afdb6f1a, 384-dim, mean-pooled, ' +
      'L2-normalised); NLI/evidence classification=Xenova/nli-deberta-v3-xsmall (q8@3fac2500, MNLI cross-encoder). ' +
      'Local, offline ONNX inference. See docs/V2_MODELS.md.'
  };
}

/** Test hook: clears resolution caches so env changes take effect. */
export function _resetModelResolutionCacheForTests(): void {
  cachedEmbeddingModel = null;
  cachedNliAdapter = null;
}

/* ==========================================================================
 * V2.2 — EXPLICIT EXPERIMENTAL CANDIDATE RESOLUTION (evaluation only)
 * ==========================================================================
 * Model selection stays EXPLICIT and goes through this one interface. The
 * default resolver above is untouched: `resolveDefaultNliAdapter()` still
 * returns the sealed xsmall adapter, and nothing calls the function below
 * unless a caller names a candidate id on purpose (an evaluation harness
 * flag). The returned object is an ordinary `NliAdapter` — the interface
 * itself is unchanged — so the rest of the V2.1 pipeline cannot tell the
 * difference, which is exactly what makes the comparison valid.
 */
import { MlWorkerClient } from './mlWorkerClient';
import {
  ExperimentalNliCandidate,
  assertCandidateUsable,
  findExperimentalCandidate
} from './modelManifest';

export interface CandidateAdapterResolution {
  adapter: NliAdapter;
  candidate: ExperimentalNliCandidate;
  client: MlWorkerClient;
}

/**
 * Resolves an experimental NLI adapter by candidate id, fail-closed.
 *
 * Throws `ModelUnavailableError` when the id is unknown, unsealed, or the
 * local files are missing/wrong-sized — it never falls back to the default
 * model, because a silent fallback would mean reporting xsmall numbers under
 * a candidate's name.
 */
export function resolveExperimentalNliAdapter(
  id: string,
  options?: { modelDir?: string; embeddingModel?: EmbeddingModel; client?: MlWorkerClient }
): CandidateAdapterResolution {
  const modelDir = options?.modelDir ?? getV2ModelDir();
  const candidate = assertCandidateUsable(id, modelDir);
  const client = options?.client ?? new MlWorkerClient({ modelDir, nliModelId: candidate.id, nliDtype: 'q8' });
  const embeddingModel = options?.embeddingModel ?? new TransformerEmbeddingModel(client);
  const adapter = new PretrainedNliAdapter({
    client,
    embeddingModel,
    modelName: candidate.id,
    modelVersion: candidate.versionSeal ?? 'unsealed'
  });
  return { adapter, candidate, client };
}

/** Registry-aware description used by evaluation reports. */
export function describeCandidate(id: string): string {
  const candidate = findExperimentalCandidate(id);
  if (!candidate) return `${id} (not a registered experimental candidate)`;
  return (
    `${candidate.id} [base=${candidate.baseModel}, revision=${candidate.revision ?? 'UNPINNED'}, ` +
    `${candidate.quantization}, seal=${candidate.versionSeal ?? 'NONE (' + candidate.sealState + ')'}]`
  );
}
