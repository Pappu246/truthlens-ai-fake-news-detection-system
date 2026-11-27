import type { EmbeddingModel } from '../../server/v2/retrieval/embeddings.js';

type Vector = number[];

/**
 * Bounded process-local LRU cache for deterministic sealed embeddings.
 * It changes runtime cost only: cached vectors are the exact underlying model
 * outputs and are never quantized, rounded, or recomputed differently.
 */
export class LruEmbeddingModel implements EmbeddingModel {
  public readonly name: string;
  public readonly version: string;
  public readonly dimensions: number;
  private readonly cache = new Map<string, Vector>();
  private hits = 0;
  private misses = 0;
  private batchDedupHits = 0;
  private evictions = 0;

  constructor(
    private readonly underlying: EmbeddingModel,
    private readonly maxEntries = 25_000
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('Embedding cache maxEntries must be a positive safe integer');
    }
    this.name = underlying.name;
    this.version = underlying.version;
    this.dimensions = underlying.dimensions;
  }

  private getCached(key: string): Vector | undefined {
    const value = this.cache.get(key);
    if (!value) return undefined;
    this.cache.delete(key);
    this.cache.set(key, value);
    this.hits += 1;
    return value;
  }

  private setCached(key: string, vector: Vector): void {
    if (!Array.isArray(vector) || vector.length !== this.dimensions ||
        vector.some(value => !Number.isFinite(value))) {
      throw new Error('Embedding cache received an invalid vector');
    }
    this.cache.delete(key);
    this.cache.set(key, vector);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.evictions += 1;
    }
  }

  public embed(text: string): number[] | Promise<number[]> {
    const key = (text || '').trim();
    const cached = this.getCached(key);
    if (cached) return cached;
    this.misses += 1;
    const result = this.underlying.embed(key);
    if (result instanceof Promise) {
      return result.then(vector => {
        this.setCached(key, vector);
        return vector;
      });
    }
    this.setCached(key, result);
    return result;
  }

  public embedBatch(texts: string[]): number[][] | Promise<number[][]> {
    if (texts.length === 0) return [];
    const keys = texts.map(text => (text || '').trim());
    const result = new Array<Vector>(keys.length);
    const missing = new Map<string, number[]>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const cached = this.getCached(key);
      if (cached) {
        result[index] = cached;
        continue;
      }
      const positions = missing.get(key);
      if (positions) {
        positions.push(index);
        this.batchDedupHits += 1;
      } else {
        missing.set(key, [index]);
      }
    }

    if (missing.size === 0) return result;

    const uniqueKeys = [...missing.keys()];
    this.misses += uniqueKeys.length;
    const complete = (vectors: number[][]): number[][] => {
      if (!Array.isArray(vectors) || vectors.length !== uniqueKeys.length) {
        throw new Error('Underlying embedding batch returned an unexpected vector count');
      }
      for (let index = 0; index < uniqueKeys.length; index += 1) {
        const key = uniqueKeys[index];
        const vector = vectors[index];
        this.setCached(key, vector);
        for (const position of missing.get(key) || []) result[position] = vector;
      }
      return result;
    };

    const batchEmbedder = this.underlying.embedBatch;
    if (batchEmbedder) {
      const vectors = batchEmbedder.call(this.underlying, uniqueKeys);
      return vectors instanceof Promise ? vectors.then(complete) : complete(vectors);
    }

    const individual = uniqueKeys.map(key => this.underlying.embed(key));
    if (individual.some(value => value instanceof Promise)) {
      return Promise.all(individual).then(complete);
    }
    return complete(individual as number[][]);
  }

  public stats() {
    return {
      capacity: this.maxEntries,
      entries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      batch_dedup_hits: this.batchDedupHits,
      evictions: this.evictions
    };
  }
}
