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
import { EmbeddingModel } from './embeddings.js';
import {
  EMBEDDING_MODEL_DIMENSIONS,
  EMBEDDING_MODEL_NAME,
  EMBEDDING_MODEL_VERSION
} from '../ml/modelManifest.js';
import { getMlWorkerClient, MlWorkerClient } from '../ml/mlWorkerClient.js';

export class TransformerEmbeddingModel implements EmbeddingModel {
  public readonly name = EMBEDDING_MODEL_NAME;
  public readonly version = EMBEDDING_MODEL_VERSION;
  public readonly dimensions = EMBEDDING_MODEL_DIMENSIONS;

  private readonly cache = new Map<string, number[]>();

  constructor(private client: MlWorkerClient = getMlWorkerClient()) {}

  public embed(text: string): number[] {
    const input = (text || '').trim();
    if (!input) return new Array(this.dimensions).fill(0);

    const cached = this.cache.get(input);
    if (cached) return cached.slice();

    const res = this.client.call<{ vector: number[] }>('embed', { text: input });
    const normalized = this.normalizeVector(res.vector);
    this.cache.set(input, normalized);
    return normalized.slice();
  }

  public embedBatch(texts: string[]): number[][] {
    if (texts.length === 0) return [];

    const normalizedInputs = texts.map(text => (text || '').trim());
    const results: Array<number[] | null> = new Array(normalizedInputs.length).fill(null);
    const missingTexts: string[] = [];
    const missingSeen = new Map<string, number[]>();

    for (let i = 0; i < normalizedInputs.length; i++) {
      const input = normalizedInputs[i];
      const cached = this.cache.get(input);
      if (cached) {
        results[i] = cached.slice();
        continue;
      }

      const priorMissing = missingSeen.get(input);
      if (priorMissing) {
        priorMissing.push(i);
      } else {
        missingSeen.set(input, [i]);
        missingTexts.push(input);
      }
    }

    if (missingTexts.length > 0) {
      const vectors = this.client.embedBatch(missingTexts);
      if (!Array.isArray(vectors) || vectors.length !== missingTexts.length) {
        throw new Error(
          `TransformerEmbeddingModel: worker returned ${Array.isArray(vectors) ? vectors.length : 'non-array'} vectors for ${missingTexts.length} uncached inputs.`
        );
      }

      for (let i = 0; i < missingTexts.length; i++) {
        const normalized = this.normalizeVector(vectors[i]);
        const input = missingTexts[i];
        this.cache.set(input, normalized);
        for (const outputIndex of missingSeen.get(input) ?? []) {
          results[outputIndex] = normalized.slice();
        }
      }
    }

    return results.map((vector, index) => {
      if (!vector) {
        throw new Error(`TransformerEmbeddingModel: missing cached/worker vector at index ${index}.`);
      }
      return vector;
    });
  }

  /**
   * Clears only the in-process embedding cache. The sealed model and worker
   * remain unchanged. Research benchmarks use this between claims so cached
   * vectors accelerate repeated retrieval/NLI passes for the current claim
   * without retaining the full benchmark corpus in memory.
   */
  public clearCache(): void {
    this.cache.clear();
  }

  private normalizeVector(vector: number[]): number[] {
    if (!Array.isArray(vector) || vector.length !== this.dimensions) {
      throw new Error(
        `TransformerEmbeddingModel: worker returned an embedding of length ${Array.isArray(vector) ? vector.length : 'non-array'}, ` +
        `expected ${this.dimensions} (${this.name}).`
      );
    }
    // Defensive re-normalisation (pipeline already returns L2-normalised
    // vectors; downstream cosineSimilarity assumes unit vectors).
    let normSq = 0;
    for (const v of vector) normSq += v * v;
    const norm = Math.sqrt(normSq) || 1;
    return vector.map(v => v / norm);
  }
}
