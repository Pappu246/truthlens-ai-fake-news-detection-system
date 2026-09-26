/**
 * V2 DENSE RETRIEVAL — EMBEDDING ADAPTER
 * =======================================
 * `EmbeddingModel` is the seam between the retrieval layer and whatever
 * produces a fixed-size semantic vector for a piece of text.
 *
 * DEFAULT IMPLEMENTATION (`HashingNgramEmbeddingModel`):
 * A deterministic, dependency-free, offline "semantic" embedding built from
 * hashed character n-grams (a signed hashing vectorizer, L2-normalised).
 * It captures sub-word / fuzzy lexical similarity (partial matches,
 * morphological variants, word-order-independent overlap) which is strictly
 * more than pure exact-token BM25 matching, so it is a legitimate second,
 * complementary retrieval channel. It requires no network access, no GPU,
 * and no proprietary API key, which is what "reproducible offline fixtures
 * for CI" requires.
 *
 * KNOWN LIMITATION (see docs/V2_KNOWN_LIMITATIONS.md): this is NOT a
 * pretrained transformer sentence embedding, so it will not capture
 * synonym-level semantics ("automobile" vs "car"). The adapter interface
 * below is intentionally the seam where a real pretrained sentence-embedding
 * model (e.g. a local ONNX/transformers.js sentence encoder) can be plugged
 * in for a future milestone without touching the rest of the retrieval or
 * reranking code — every caller only depends on `EmbeddingModel.embed()`.
 */

export interface EmbeddingModel {
  readonly name: string;
  readonly version: string;
  readonly dimensions: number;
  embed(text: string): number[];
}

function charNgrams(text: string, n = 3): string[] {
  const cleaned = `_${text.toLowerCase().replace(/\s+/g, ' ').trim()}_`;
  if (cleaned.length < n) return [cleaned];
  const grams: string[] = [];
  for (let i = 0; i <= cleaned.length - n; i++) grams.push(cleaned.slice(i, i + n));
  return grams;
}

// Simple deterministic string hash (FNV-1a).
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class HashingNgramEmbeddingModel implements EmbeddingModel {
  public readonly name = 'truthlens-hashing-ngram-embedding';
  public readonly version = 'v0.1.0-deterministic';
  public readonly dimensions: number;
  private readonly nGramSizes: number[];

  constructor(options?: { dimensions?: number; nGramSizes?: number[] }) {
    this.dimensions = options?.dimensions ?? 256;
    this.nGramSizes = options?.nGramSizes ?? [3, 4];
  }

  public embed(text: string): number[] {
    const vec = new Array(this.dimensions).fill(0);
    if (!text || !text.trim()) return vec;

    for (const n of this.nGramSizes) {
      for (const gram of charNgrams(text, n)) {
        const h = fnv1a(`${n}:${gram}`);
        const idx = h % this.dimensions;
        // Signed hashing trick (Weinberger et al.) reduces collision bias.
        const sign = (h & 0x1) === 0 ? 1 : -1;
        vec[idx] += sign;
      }
    }

    let normSq = 0;
    for (const v of vec) normSq += v * v;
    const norm = Math.sqrt(normSq) || 1;
    return vec.map(v => v / norm);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  // Both vectors are already L2-normalised by the embedding model, so the
  // dot product IS the cosine similarity; clamp for floating point drift.
  return Math.max(-1, Math.min(1, dot));
}

export const defaultEmbeddingModel: EmbeddingModel = new HashingNgramEmbeddingModel();

export interface DenseSearchResult {
  id: string;
  score: number;
}

/** One-shot dense search over a small candidate set, min-max normalised to [0,1]. */
export function denseSearch(
  query: string,
  documents: Array<{ id: string; text: string }>,
  model: EmbeddingModel = defaultEmbeddingModel,
  topK = 20
): DenseSearchResult[] {
  if (documents.length === 0) return [];
  const qVec = model.embed(query);
  const raw = documents.map(d => ({ id: d.id, score: cosineSimilarity(qVec, model.embed(d.text)) }));
  const positive = raw.filter(r => r.score > 0);
  if (positive.length === 0) return [];
  const max = Math.max(...positive.map(r => r.score));
  const min = Math.min(...positive.map(r => r.score));
  const range = max - min || 1;
  return positive
    .map(r => ({ id: r.id, score: (r.score - min) / range }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
