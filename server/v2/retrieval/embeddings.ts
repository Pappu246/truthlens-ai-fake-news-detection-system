/**
 * V2 DENSE RETRIEVAL — EMBEDDING ADAPTERS
 * =======================================
 * The adapter contract supports synchronous offline embeddings and asynchronous
 * remote/pretrained embeddings. The deterministic hashing model remains the
 * CI-safe default; the optional Hugging Face model is opt-in through
 * TRUTHLENS_ENABLE_REMOTE_EMBEDDINGS=true plus HF_TOKEN.
 */

export interface EmbeddingModel {
  readonly name: string;
  readonly version: string;
  readonly dimensions: number;
  embed(text: string): number[] | Promise<number[]>;
}

function charNgrams(text: string, n = 3): string[] {
  const cleaned = `_${text.toLowerCase().replace(/\s+/g, ' ').trim()}_`;
  if (cleaned.length < n) return [cleaned];
  const grams: string[] = [];
  for (let i = 0; i <= cleaned.length - n; i++) grams.push(cleaned.slice(i, i + n));
  return grams;
}

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
  return Math.max(-1, Math.min(1, dot));
}

export const defaultEmbeddingModel: EmbeddingModel = new HashingNgramEmbeddingModel();

export interface DenseSearchResult {
  id: string;
  score: number;
}

export async function denseSearch(
  query: string,
  documents: Array<{ id: string; text: string }>,
  model: EmbeddingModel = defaultEmbeddingModel,
  topK = 20
): Promise<DenseSearchResult[]> {
  if (documents.length === 0) return [];
  const qVec = await model.embed(query);
  const raw = await Promise.all(
    documents.map(async d => ({
      id: d.id,
      score: cosineSimilarity(qVec, await model.embed(d.text))
    }))
  );

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
