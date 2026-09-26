/**
 * TRUTHLENS V2.1 — ML WORKER CLIENT (synchronous facade)
 * =======================================================
 * Why this exists: the V2 adapter contracts (`EmbeddingModel.embed()`,
 * `NliAdapter.classify()`) are SYNCHRONOUS — an explicit design decision of
 * the V2 first slice that keeps retrieval/reranking/pipeline code simple and
 * testable. Real pretrained inference (ONNX Runtime) is asynchronous in
 * JavaScript. Rather than rewriting every V2 interface to async (forbidden
 * by the V2.1 upgrade contract), the async runtimes live in a dedicated
 * worker thread (`mlWorker.cjs`) and this client exposes a blocking call via
 * `SharedArrayBuffer` + `Atomics.wait` — a standard, well-defined
 * synchronisation primitive (allowed on Node's main thread).
 *
 * Properties:
 *  - exactly one worker per server process; models load once (lazy on first
 *    use) and are re-used for the process lifetime — never per request;
 *  - worker runs fully offline (HF_HUB_OFFLINE=1, allowRemoteModels=false);
 *  - every call has a hard timeout; a dead/crashed worker makes calls throw a
 *    clear `ModelUnavailableError` (never a silent heuristic fallback);
 *  - the worker is `unref()`ed and `disposeMlWorker()` is exported so test
 *    scripts can exit cleanly.
 */
import { Worker } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import { ModelUnavailableError, getV2ModelDir, EMBEDDING_MODEL_MANIFEST, NLI_MODEL_MANIFEST } from './modelManifest';

const CTRL_INT32 = 8;
const REQ_SAB_BYTES = 1 << 20; // 1 MiB request payloads (premise+hypothesis, corpus doc text)
const RESP_SAB_BYTES = 1 << 22; // 4 MiB response payloads
const CTRL_REQ_SEQ = 0;
const CTRL_RESP_SEQ = 1;
const CTRL_LEN = 2;

export interface MlWorkerMeta {
  nliId2Label: Record<string, string>;
  nliBaseModel: string | null;
  embeddingHiddenSize: number | null;
  embeddingBaseModel: string | null;
  remoteModelsDisabled: boolean;
}

export class ModelInferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelInferenceError';
  }
}

function moduleRelativeWorkerPath(): string | null {
  try {
    // Direct eval keeps `import.meta` legal in ESM *and* absent-but-guarded in
    // the esbuild CJS bundle (evaluated only when this function is called).
    // eslint-disable-next-line no-eval
    const url = eval("(typeof import.meta !== 'undefined' && import.meta && import.meta.url) || ''") as string;
    if (url) return new URL('./mlWorker.cjs', url).pathname;
  } catch {
    /* import.meta unavailable in this runtime */
  }
  return null;
}

function candidateWorkerPaths(): string[] {
  const candidates: string[] = [];
  if (process.env.TRUTHLENS_V2_WORKER_PATH) candidates.push(process.env.TRUTHLENS_V2_WORKER_PATH);
  candidates.push(path.join(process.cwd(), 'server', 'v2', 'ml', 'mlWorker.cjs'));
  const rel = moduleRelativeWorkerPath();
  if (rel) candidates.push(rel);
  return candidates;
}

export class MlWorkerClient {
  private worker: Worker | null = null;
  private deadReason: string | null = null;
  private ctrl: Int32Array | null = null;
  private reqBytes: Uint8Array | null = null;
  private respBytes: Uint8Array | null = null;
  private reqSeq = 0;
  private metaCache: MlWorkerMeta | null = null;

  constructor(private options?: { modelDir?: string }) {}

  private ensureStarted(): void {
    if (this.deadReason) {
      throw new ModelUnavailableError(
        `TruthLens V2.1 ML worker is not running (${this.deadReason}). ` +
        'The pretrained adapters cannot run without it; fix the underlying error and restart the process.'
      );
    }
    if (this.worker) return;

    const candidates = candidateWorkerPaths();
    const found = candidates.find(c => {
      try { return Boolean(c) && fs.existsSync(c); } catch { return false; }
    });
    if (!found) {
      throw new ModelUnavailableError(
        `TruthLens V2.1 ML worker script not found. Looked in: ${candidates.join(', ')}. ` +
        'Set TRUTHLENS_V2_WORKER_PATH to the absolute path of server/v2/ml/mlWorker.cjs.'
      );
    }

    const ctrlSab = new SharedArrayBuffer(CTRL_INT32 * 4);
    const reqSab = new SharedArrayBuffer(REQ_SAB_BYTES);
    const respSab = new SharedArrayBuffer(RESP_SAB_BYTES);
    this.ctrl = new Int32Array(ctrlSab);
    this.reqBytes = new Uint8Array(reqSab);
    this.respBytes = new Uint8Array(respSab);

    const worker = new Worker(found);
    worker.unref();
    worker.on('error', err => {
      this.deadReason = `worker error: ${err.message}`;
    });
    worker.on('exit', code => {
      if (code !== 0 && !this.deadReason) this.deadReason = `worker exited with code ${code}`;
    });
    worker.postMessage({
      t: 'init',
      ctrl: ctrlSab,
      req: reqSab,
      resp: respSab,
      modelDir: this.options?.modelDir ?? getV2ModelDir(),
      embModelId: EMBEDDING_MODEL_MANIFEST.id,
      nliModelId: NLI_MODEL_MANIFEST.id
    });
    this.worker = worker;
  }

  /**
   * Synchronously executes an op in the ML worker and returns its result.
   * Blocks the calling thread with Atomics.wait — bounded by `timeoutMs`.
   */
  public call<T = unknown>(op: string, payload: Record<string, unknown>, timeoutMs?: number): T {
    const timeout = timeoutMs ?? Number(process.env.TRUTHLENS_V2_ML_CALL_TIMEOUT_MS ?? 120_000);
    this.ensureStarted();

    const body = Buffer.from(JSON.stringify({ op, ...payload }), 'utf-8');
    if (body.byteLength > REQ_SAB_BYTES - 8) {
      throw new ModelInferenceError(`ML worker request payload too large (${body.byteLength} bytes, max ${REQ_SAB_BYTES - 8}).`);
    }

    const ctrl = this.ctrl!;
    this.reqSeq += 1;
    this.reqBytes!.fill(0);
    this.reqBytes!.set(body, 0);
    Atomics.store(ctrl, CTRL_LEN, body.byteLength);
    Atomics.store(ctrl, CTRL_REQ_SEQ, this.reqSeq);
    this.worker!.postMessage({ t: 'req' });

    const deadline = Date.now() + timeout;
    for (;;) {
      const seen = Atomics.load(ctrl, CTRL_RESP_SEQ);
      if (seen === this.reqSeq) break;
      if (this.deadReason) {
        throw new ModelUnavailableError(`ML worker died while serving '${op}': ${this.deadReason}`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ModelUnavailableError(
          `ML worker call '${op}' timed out after ${timeout}ms. ` +
          'First-call model loading on CPU can be slow; if this is a cold environment, ' +
          'raise TRUTHLENS_V2_ML_CALL_TIMEOUT_MS and retry. No heuristic fallback was substituted.'
        );
      }
      Atomics.wait(ctrl, CTRL_RESP_SEQ, seen, Math.min(250, remaining));
    }

    const len = Atomics.load(ctrl, CTRL_LEN);
    const respText = Buffer.from(this.respBytes!.buffer, this.respBytes!.byteOffset, len).toString('utf-8');
    const parsed = JSON.parse(respText);
    if (!parsed.ok) {
      throw new ModelInferenceError(parsed.error || 'ML worker returned an unspecified error.');
    }
    return parsed.result as T;
  }

  /** Metadata about the local models (read from their on-disk config.json files). */
  public meta(): MlWorkerMeta {
    if (!this.metaCache) this.metaCache = this.call<MlWorkerMeta>('meta', {});
    return this.metaCache;
  }

  public async dispose(): Promise<void> {
    if (!this.worker) return;
    const w = this.worker;
    this.worker = null;
    this.ctrl = null;
    this.reqBytes = null;
    this.respBytes = null;
    try {
      w.postMessage({ t: 'dispose' });
      await w.terminate();
    } catch {
      /* best effort */
    }
  }
}

let sharedClient: MlWorkerClient | null = null;

/** One shared ML worker per process (models load once, reused everywhere). */
export function getMlWorkerClient(): MlWorkerClient {
  if (!sharedClient) sharedClient = new MlWorkerClient();
  return sharedClient;
}

export async function disposeMlWorker(): Promise<void> {
  if (sharedClient) {
    const c = sharedClient;
    sharedClient = null;
    await c.dispose();
  }
}
