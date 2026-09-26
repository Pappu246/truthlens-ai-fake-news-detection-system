/**
 * TRUTHLENS V2.1 — PRETRAINED TRANSFORMER EMBEDDING MODEL
 * =========================================================
 * Drop-in replacement for the V2 first-slice placeholder
 * (`HashingNgramEmbeddingModel`) behind the UNCHANGED `EmbeddingModel`
 * interface (see ./embeddings.ts — the interface itself is not modified).
 *
 *   model:      Xenova/all-MiniLM-L6-v2  (ONNX port of
 *               sentence-transformers/all-MiniLM-L6-v2)
 *   weights:    int8 dynamic quantization (q8), byte-sealed in
 *               server/v2/ml/modelManifest.ts
 *   output:     384-dim sentence embedding, mean-pooled over unmasked tokens
 *               and L2-normalised by the model pipeline (then re-normalised
 *               here defensively so cosine == dot product, as the retrieval
 *               layer assumes)
 *   runtime:    @huggingface/transformers + onnxruntime-node on CPU, running
 *               fully offline inside mlWorker.cjs (no network, no paid API)
 *
 * DETERMINISM: same weights + same runtime + same input give identical
 * vectors (asserted bit-exact within a process by scripts/v2ModelTests.ts;
 * cross-machine build drift is the only expected residual, see
 * docs/V2_MODELS.md).
 */
import { EmbeddingModel } from './embeddings';
import {
  EMBEDDING_MODEL_DIMENSIONS,
  EMBEDDING_MODEL_NAME,
  EMBEDDING_MODEL_VERSION
} from '../ml/modelManifest';
import { getMlWorkerClient, MlWorkerClient } from '../ml/mlWorkerClient';

export class TransformerEmbeddingModel implements EmbeddingModel {
  public readonly name = EMBEDDING_MODEL_NAME;
  public readonly version = EMBEDDING_MODEL_VERSION;
  public readonly dimensions = EMBEDDING_MODEL_DIMENSIONS;

  constructor(private client: MlWorkerClient = getMlWorkerClient()) {}

  public embed(text: string): number[] {
    const input = (text || '').trim();
    if (!input) return new Array(this.dimensions).fill(0);
    const res = this.client.call<{ vector: number[] }>('embed', { text: input });
    const vec = res.vector;
    if (!Array.isArray(vec) || vec.length !== this.dimensions) {
      throw new Error(
        `TransformerEmbeddingModel: worker returned an embedding of length ${Array.isArray(vec) ? vec.length : 'non-array'}, ` +
        `expected ${this.dimensions} (${this.name}).`
      );
    }
    // Defensive re-normalisation (pipeline already returns L2-normalised
    // vectors; downstream cosineSimilarity assumes unit vectors).
    let normSq = 0;
    for (const v of vec) normSq += v * v;
    const norm = Math.sqrt(normSq) || 1;
    return vec.map(v => v / norm);
  }
}
