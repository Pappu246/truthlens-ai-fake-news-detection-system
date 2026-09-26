/**
 * TRUTHLENS V2.1 — ML WORKER (CommonJS, plain Node — no bundler hooks needed)
 * ===========================================================================
 * Runs the REAL pretrained models (via @huggingface/transformers +
 * onnxruntime-node, CPU) in a dedicated worker thread, serving a synchronous
 * SharedArrayBuffer/Atomics request-response protocol so that the EXISTING
 * synchronous V2 adapter interfaces (`EmbeddingModel.embed()`,
 * `NliAdapter.classify()`) can be preserved 1:1 (see mlWorkerClient.ts).
 *
 * HARD OFFLINE GUARANTEE: this worker never reaches the network. Models are
 * loaded from a LOCAL directory only (env.localModelPath), with
 * allowRemoteModels=false and HF_HUB_OFFLINE=1 set inside the worker process
 * BEFORE @huggingface/transformers is imported. Model files are provisioned
 * out-of-band by `npm run download:v2-models` (sealed, hash-verified).
 *
 * Loaded lazily (per first use), cached for the worker's lifetime — models
 * are loaded exactly once per server process, never per request.
 */
'use strict';

const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

/** @type {Int32Array|null} */
let ctrl = null;
/** @type {Uint8Array|null} */
let reqBytes = null;
/** @type {Uint8Array|null} */
let respBytes = null;

let transformers = null;
let extractorPromise = null;
let nliPromise = null;
let config = null; // { modelDir, embModelId, nliModelId }

function failHard(message) {
  // Cannot reply over the protocol (no request in flight): crash loudly.
  console.error('[v2-ml-worker] FATAL:', message);
  process.exit(2);
}

async function loadTransformers(modelDir) {
  if (transformers) return transformers;
  // Offline hard-guards, set before the library is imported.
  process.env.HF_HUB_OFFLINE = '1';
  process.env.TRANSFORMERS_OFFLINE = '1';
  const mod = await import('@huggingface/transformers');
  const env = mod.env;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelDir.endsWith('/') ? modelDir : modelDir + '/';
  env.useBrowserCache = false;
  env.useFSCache = false;
  transformers = mod;
  return mod;
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const mod = await loadTransformers(config.modelDir);
      return mod.pipeline('feature-extraction', config.embModelId, { dtype: 'q8' });
    })();
  }
  return extractorPromise;
}

async function getNli() {
  if (!nliPromise) {
    nliPromise = (async () => {
      const mod = await loadTransformers(config.modelDir);
      const [tokenizer, model] = await Promise.all([
        mod.AutoTokenizer.from_pretrained(config.nliModelId, { dtype: 'q8' }),
        mod.AutoModelForSequenceClassification.from_pretrained(config.nliModelId, { dtype: 'q8' })
      ]);
      return { tokenizer, model };
    })();
  }
  return nliPromise;
}

function readConfigFromDisk(modelId) {
  const p = path.join(config.modelDir, modelId, 'config.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

async function embed(body) {
  const extractor = await getExtractor();
  const out = await extractor(String(body.text || ''), { pooling: 'mean', normalize: true });
  return { vector: Array.from(out.data) };
}

async function classify(body) {
  const { tokenizer, model } = await getNli();
  const inputs = await tokenizer(String(body.premise || ''), {
    text_pair: String(body.hypothesis || ''),
    truncation: true,
    max_length: body.maxTokens || 384
  });
  const { logits } = await model(inputs);
  const raw = Array.from(logits.data);
  const id2label = model.config.id2label;
  const m = Math.max(...raw);
  const exps = raw.map(v => Math.exp(v - m));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  /** @type {Record<string, number>} */
  const probs = {};
  raw.forEach((v, i) => { probs[id2label[i]] = exps[i] / sum; });
  return { probs, id2label };
}

const OPS = { embed, classify };

async function meta() {
  const nliCfg = readConfigFromDisk(config.nliModelId);
  const embCfg = readConfigFromDisk(config.embModelId);
  return {
    nliId2Label: nliCfg.id2label,
    nliBaseModel: nliCfg._name_or_path || null,
    embeddingHiddenSize: embCfg.hidden_size || null,
    embeddingBaseModel: embCfg._name_or_path || null,
    remoteModelsDisabled: true
  };
}

function writeResponse(reqSeqSeen, obj) {
  const text = JSON.stringify(obj);
  const payload = Buffer.from(text, 'utf-8');
  if (payload.byteLength > respBytes.byteLength - 4) {
    const errPayload = Buffer.from(JSON.stringify({
      ok: false,
      error: `worker response too large (${payload.byteLength} bytes) for the shared response buffer`
    }), 'utf-8');
    respBytes.set(errPayload, 0);
    Atomics.store(ctrl, 2, errPayload.byteLength);
  } else {
    respBytes.set(payload, 0);
    Atomics.store(ctrl, 2, payload.byteLength);
  }
  // Publish response AFTER payload bytes are fully written.
  Atomics.store(ctrl, 1, reqSeqSeen);
  Atomics.notify(ctrl, 1);
}

let processingChain = Promise.resolve();

async function handleRequest() {
  const reqSeq = Atomics.load(ctrl, 0);
  const len = Atomics.load(ctrl, 2);
  let body;
  try {
    body = JSON.parse(Buffer.from(reqBytes.buffer, reqBytes.byteOffset, len).toString('utf-8'));
  } catch (err) {
    writeResponse(reqSeq, { ok: false, error: `malformed request payload (not JSON): ${err.message}` });
    return;
  }
  try {
    let result;
    if (body.op === 'ping') result = { pong: true, pid: process.pid };
    else if (body.op === 'meta') result = await meta();
    else if (OPS[body.op]) result = await OPS[body.op](body);
    else throw new Error(`unknown op: ${body.op}`);
    writeResponse(reqSeq, { ok: true, result });
  } catch (err) {
    writeResponse(reqSeq, {
      ok: false,
      error: `[v2-ml-worker] ${err && err.message ? err.message : String(err)}`,
      name: err && err.name ? err.name : 'Error'
    });
  }
}

parentPort.on('message', msg => {
  if (msg && msg.t === 'init') {
    try {
      ctrl = new Int32Array(msg.ctrl);
      reqBytes = new Uint8Array(msg.req);
      respBytes = new Uint8Array(msg.resp);
      config = { modelDir: msg.modelDir, embModelId: msg.embModelId, nliModelId: msg.nliModelId };
      if (!config.modelDir || !config.embModelId || !config.nliModelId) {
        failHard('init message missing modelDir/embModelId/nliModelId');
        return;
      }
      // Eagerly configure the offline environment now (before any import).
      loadTransformers(config.modelDir)
        .then(() => {
          Atomics.store(ctrl, 3, 1); // worker ready flag
          Atomics.notify(ctrl, 3);
        })
        .catch(err => failHard(`failed to initialise transformers runtime: ${err.message}`));
    } catch (err) {
      failHard(`init failed: ${err.message}`);
    }
    return;
  }
  if (msg && msg.t === 'req') {
    // Strict sequential processing: one inference at a time per worker.
    processingChain = processingChain.then(() => handleRequest()).catch(err => {
      console.error('[v2-ml-worker] request handler failed:', err);
    });
    return;
  }
  if (msg && msg.t === 'dispose') {
    process.exit(0);
  }
});
