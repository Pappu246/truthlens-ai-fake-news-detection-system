/**
 * V2 LEXICAL RETRIEVAL — BM25
 * ===========================
 * A small, dependency-free, deterministic BM25 (Okapi) implementation.
 * No external search index is required, which keeps retrieval reproducible
 * for offline fixtures and CI.
 */

export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Result {
  id: string;
  score: number;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'was', 'are', 'were', 'to', 'in', 'of', 'and', 'for', 'by', 'on',
  'with', 'from', 'at', 'that', 'this', 'it', 'as', 'be', 'has', 'have', 'had', 'but', 'or',
  'not', 'will', 'would', 'could', 'should', 'their', 'its', 'his', 'her', 'they', 'he', 'she'
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:[.'][a-z0-9]+)*/g) || [])
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

interface IndexedDoc {
  id: string;
  terms: string[];
  termCounts: Map<string, number>;
  length: number;
}

/**
 * Stateless-per-call BM25 index. Rebuilt for every retrieval since the
 * corpus of candidate documents is small (per-claim, not a global index) —
 * appropriate for a first vertical slice; a persistent inverted index is a
 * future optimisation, not a correctness requirement.
 */
export class Bm25Index {
  private docs: IndexedDoc[] = [];
  private df = new Map<string, number>();
  private avgDocLen = 0;
  private k1: number;
  private b: number;

  constructor(documents: Bm25Document[], options?: { k1?: number; b?: number }) {
    this.k1 = options?.k1 ?? 1.5;
    this.b = options?.b ?? 0.75;

    let totalLen = 0;
    for (const doc of documents) {
      const terms = tokenize(doc.text);
      const termCounts = new Map<string, number>();
      for (const t of terms) termCounts.set(t, (termCounts.get(t) || 0) + 1);
      for (const t of termCounts.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      this.docs.push({ id: doc.id, terms, termCounts, length: terms.length });
      totalLen += terms.length;
    }
    this.avgDocLen = documents.length > 0 ? totalLen / documents.length : 0;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) || 0;
    // BM25 idf with +1 smoothing to keep it non-negative for common terms.
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  public search(query: string, topK = 20): Bm25Result[] {
    const qTerms = Array.from(new Set(tokenize(query)));
    if (qTerms.length === 0 || this.docs.length === 0) return [];

    const scores: Bm25Result[] = this.docs.map(doc => {
      let score = 0;
      for (const term of qTerms) {
        const tf = doc.termCounts.get(term) || 0;
        if (tf === 0) continue;
        const idf = this.idf(term);
        const denom = tf + this.k1 * (1 - this.b + (this.b * doc.length) / (this.avgDocLen || 1));
        score += idf * ((tf * (this.k1 + 1)) / (denom || 1));
      }
      return { id: doc.id, score };
    });

    return scores
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

/** Convenience one-shot search that also min-max normalises scores to [0,1]. */
export function bm25Search(query: string, documents: Bm25Document[], topK = 20): Bm25Result[] {
  const index = new Bm25Index(documents);
  const raw = index.search(query, topK);
  if (raw.length === 0) return raw;
  const max = Math.max(...raw.map(r => r.score));
  const min = Math.min(...raw.map(r => r.score));
  const range = max - min || 1;
  return raw.map(r => ({ id: r.id, score: (r.score - min) / range }));
}
