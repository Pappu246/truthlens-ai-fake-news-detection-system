/**
 * Shared, sealed local-NLI configuration for Phase 2 public benchmarks.
 * This keeps FEVER, FEVEROUS, SciFact and AVeriTeC on the same local model
 * family and exposes exact model artifact hashes in every report.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PretrainedNliAdapter } from '../../server/v2/nli/pretrainedNliAdapter.js';
import { TransformerEmbeddingModel } from '../../server/v2/retrieval/transformerEmbeddingModel.js';
import type { EmbeddingModel } from '../../server/v2/retrieval/embeddings.js';
import type { NliAdapter } from '../../server/v2/nli/nliAdapter.js';
import type { V2VerificationResult } from '../../server/v2/types.js';
import {
  ALL_MODEL_MANIFESTS,
  getV2ModelDir,
  verifyModelHashes
} from '../../server/v2/ml/modelManifest.js';
import { disposeMlWorker } from '../../server/v2/ml/mlWorkerClient.js';

export const LOCAL_ML_RUNTIME = {
  node_major: 22,
  transformers_js: '3.7.6',
  onnxruntime_node: '1.21.0'
} as const;

export function verifyRuntimeVersions() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor !== LOCAL_ML_RUNTIME.node_major) {
    throw new Error(`Node runtime mismatch: expected ${LOCAL_ML_RUNTIME.node_major}.x, got ${process.versions.node}`);
  }
  const packageVersion = (packagePath: string): string => {
    const fullPath = path.resolve('node_modules', packagePath, 'package.json');
    if (!fs.existsSync(fullPath)) throw new Error(`Required local ML runtime package is missing: ${packagePath}`);
    return (JSON.parse(fs.readFileSync(fullPath, 'utf8')) as { version?: string }).version || '';
  };
  const transformersVersion = packageVersion('@huggingface/transformers');
  const onnxVersion = packageVersion('onnxruntime-node');
  if (transformersVersion !== LOCAL_ML_RUNTIME.transformers_js) {
    throw new Error(`Transformers.js version mismatch: expected ${LOCAL_ML_RUNTIME.transformers_js}, got ${transformersVersion}`);
  }
  if (onnxVersion !== LOCAL_ML_RUNTIME.onnxruntime_node) {
    throw new Error(`ONNX Runtime version mismatch: expected ${LOCAL_ML_RUNTIME.onnxruntime_node}, got ${onnxVersion}`);
  }
  return { ...LOCAL_ML_RUNTIME, node_version: process.versions.node };
}

export function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function sealedModelManifest() {
  return ALL_MODEL_MANIFESTS.map(manifest => ({
    kind: manifest.kind,
    id: manifest.id,
    base_model: manifest.baseModel,
    quantization: manifest.quantization,
    version_seal: manifest.versionSeal,
    files: manifest.files.map(file => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      git_blob_sha1: file.gitBlobSha1 ?? null
    }))
  }));
}

export async function verifySealedModels(): Promise<void> {
  verifyRuntimeVersions();
  const modelDir = getV2ModelDir();
  for (const manifest of ALL_MODEL_MANIFESTS) {
    const result = await verifyModelHashes(modelDir, manifest);
    if (!result.ok) {
      throw new Error(`Model seal verification failed for ${manifest.id}: ${result.mismatches.join('; ')}`);
    }
  }
}

export function modelMetadata(
  nliAdapter: Pick<NliAdapter, 'modelName' | 'modelVersion'>,
  embeddingModel: EmbeddingModel
) {
  const manifest = sealedModelManifest();
  return {
    runtime: verifyRuntimeVersions(),
    nli: {
      name: nliAdapter.modelName,
      version: nliAdapter.modelVersion,
      artifact_sha256: manifest.find(item => item.kind === 'nli')?.files.find(file => file.path === 'onnx/model_quantized.onnx')?.sha256 ?? null
    },
    embedding: {
      name: embeddingModel.name,
      version: embeddingModel.version,
      artifact_sha256: manifest.find(item => item.kind === 'embedding')?.files.find(file => file.path === 'onnx/model_quantized.onnx')?.sha256 ?? null
    },
    manifest_sha256: sha256Json(manifest),
    sealed_manifest: manifest
  };
}

export async function createLocalNliContext(relatednessFloor = 0.15) {
  await verifySealedModels();
  const embeddingModel = new TransformerEmbeddingModel();
  const nliAdapter = new PretrainedNliAdapter({ embeddingModel, relatednessFloor });
  return {
    embeddingModel,
    nliAdapter,
    models: modelMetadata(nliAdapter, embeddingModel)
  };
}

export function benchmarkDirection(result: V2VerificationResult): 'SUPPORTS' | 'REFUTES' | 'NOT ENOUGH INFO' {
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
  if (support <= 0 && refute <= 0) return 'NOT ENOUGH INFO';
  if (support > refute) return 'SUPPORTS';
  if (refute > support) return 'REFUTES';
  return 'NOT ENOUGH INFO';
}

export function productionDirection(verdict: string): 'SUPPORTS' | 'REFUTES' | 'NOT ENOUGH INFO' {
  if (verdict === 'VERIFIED') return 'SUPPORTS';
  if (verdict === 'REFUTED') return 'REFUTES';
  return 'NOT ENOUGH INFO';
}

export async function disposeLocalNliContext(): Promise<void> {
  await disposeMlWorker();
}
