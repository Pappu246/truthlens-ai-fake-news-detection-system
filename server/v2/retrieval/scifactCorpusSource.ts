/**
 * TruthLens V2 — SciFact open-retrieval corpus source
 * ----------------------------------------------------
 * Research-only benchmark adapter. It searches the COMPLETE 5,183-document
 * SciFact development corpus with a cached BM25 index and returns a bounded
 * candidate pool to the normal V2 pipeline. This keeps retrieval open rather
 * than leaking the gold evidence documents into the candidate set.
 */
import { ExtractedClaim } from '../../../src/types.js';
import { CorpusSource } from './corpusSource.js';
import { Bm25Index } from './bm25.js';
import { RawDocument } from '../types.js';
import { EmbeddingModel, cosineSimilarity } from './embeddings.js';

export interface SciFactDocumentInput {
  doc_id: number;
  title: string;
  abstract: string[];
  structured?: boolean;
}

export interface SciFactOpenCorpusOptions {
  topK?: number;
  denseEmbeddingModel?: EmbeddingModel;
  denseTopK?: number;
  enableDenseRetrieval?: boolean;
  denseBatchSize?: number;
}

export class SciFactOpenCorpusSource implements CorpusSource {
  public readonly name = 'scifact_open_full_corpus_bm25';
  private readonly documents: RawDocument[];
  private readonly byId = new Map<string, RawDocument>();
  private readonly index: Bm25Index;
  private readonly topK: number;
  private readonly denseEmbeddingModel?: EmbeddingModel;
  private readonly denseTopK: number;
  private readonly enableDenseRetrieval: boolean;
  private readonly denseBatchSize: number;
  private denseVectors: number[][] | null = null;
  private denseBuildPromise: Promise<void> | null = null;
  private readonly candidateIdsSeen = new Set<string>();

  constructor(documents: SciFactDocumentInput[], options?: number | SciFactOpenCorpusOptions) {
    if (!documents.length) throw new Error('SciFact corpus source requires at least one document.');
    const normalized = typeof options === 'number' ? { topK: options } : (options || {});
    this.topK = Math.max(1, normalized.topK ?? 100);
    this.denseEmbeddingModel = normalized.denseEmbeddingModel;
    this.denseTopK = Math.max(1, normalized.denseTopK ?? this.topK);
    this.enableDenseRetrieval = Boolean(normalized.enableDenseRetrieval && this.denseEmbeddingModel);
    this.denseBatchSize = Math.max(1, normalized.denseBatchSize ?? 32);

    this.documents = documents.map(doc => ({
      id: String(doc.doc_id),
      url: `https://scifact.local/document/${doc.doc_id}`,
      title: doc.title,
      snippet: doc.abstract.join(' '),
      body: doc.abstract.join(' '),
      contentType: 'SUMMARY',
      publisher: 'SciFact corpus',
      publishedAt: null,
      retrievedAt: new Date().toISOString(),
      retrievalMethod: this.name
    }));

    for (const doc of this.documents) this.byId.set(doc.id, doc);
    this.index = new Bm25Index(this.documents.map(doc => ({
      id: doc.id,
      text: `${doc.title} ${doc.snippet}`
    })));
  }

  private async ensureDenseIndex(): Promise<void> {
    if (!this.enableDenseRetrieval || !this.denseEmbeddingModel || this.denseVectors) return;
    if (!this.denseBuildPromise) {
      this.denseBuildPromise = (async () => {
        const texts = this.documents.map(doc => (doc.title + ' ' + doc.snippet).trim());
        const vectors: number[][] = new Array(texts.length);
        for (let start = 0; start < texts.length; start += this.denseBatchSize) {
          const chunk = texts.slice(start, start + this.denseBatchSize);
          const batch = this.denseEmbeddingModel.embedBatch;
          if (typeof batch === 'function') {
            const encoded = await batch.call(this.denseEmbeddingModel, chunk);
            if (encoded.length !== chunk.length) {
              throw new Error('SciFact dense index: embedding model returned an unexpected batch length.');
            }
            for (let i = 0; i < encoded.length; i++) vectors[start + i] = encoded[i];
          } else {
            const encoded = await Promise.all(chunk.map(text => this.denseEmbeddingModel!.embed(text)));
            for (let i = 0; i < encoded.length; i++) vectors[start + i] = encoded[i];
          }
        }
        this.denseVectors = vectors;
      })();
    }
    await this.denseBuildPromise;
  }

  private async denseSearch(query: string): Promise<Array<{ id: string; score: number }>> {
    if (!this.enableDenseRetrieval || !this.denseEmbeddingModel) return [];
    await this.ensureDenseIndex();
    if (!this.denseVectors) return [];
    const queryVector = await this.denseEmbeddingModel.embed(query);
    return this.denseVectors
      .map((vector, index) => ({ id: this.documents[index].id, score: cosineSimilarity(queryVector, vector) }))
      .filter(hit => hit.score > 0)
      .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
      .slice(0, this.denseTopK);
  }

  public async fetchCandidates(query: string, _claim: ExtractedClaim): Promise<RawDocument[]> {
    const lexicalHits = this.index.search(query, this.topK);
    const denseHits = await this.denseSearch(query);
    const fused = new Map<string, number>();
    for (let rank = 0; rank < lexicalHits.length; rank++) {
      const hit = lexicalHits[rank];
      fused.set(hit.id, (fused.get(hit.id) || 0) + 1 / (60 + rank + 1));
    }
    for (let rank = 0; rank < denseHits.length; rank++) {
      const hit = denseHits[rank];
      fused.set(hit.id, (fused.get(hit.id) || 0) + 1 / (60 + rank + 1));
    }
    const ordered = Array.from(fused.entries())
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, this.topK);
    const results: RawDocument[] = [];
    for (const entry of ordered) {
      const doc = this.byId.get(entry[0]);
      if (!doc) continue;
      this.candidateIdsSeen.add(doc.id);
      results.push(doc);
    }
    return results;
  }

  public resetCandidateIds(): void {
    this.candidateIdsSeen.clear();
  }

  public getCandidateIds(): string[] {
    return Array.from(this.candidateIdsSeen);
  }
}
