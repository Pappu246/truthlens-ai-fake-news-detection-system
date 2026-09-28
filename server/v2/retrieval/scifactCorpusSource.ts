/**
 * TruthLens V2 — SciFact open-retrieval corpus source
 * ----------------------------------------------------
 * Research-only benchmark adapter. It searches the COMPLETE 5,183-document
 * SciFact development corpus with a cached BM25 index and returns a bounded
 * candidate pool to the normal V2 pipeline. This keeps retrieval open rather
 * than leaking the gold evidence documents into the candidate set.
 */
import { ExtractedClaim } from '../../../src/types';
import { CorpusSource } from './corpusSource';
import { Bm25Index } from './bm25';
import { RawDocument } from '../types';

export interface SciFactDocumentInput {
  doc_id: number;
  title: string;
  abstract: string[];
  structured?: boolean;
}

export class SciFactOpenCorpusSource implements CorpusSource {
  public readonly name = 'scifact_open_full_corpus_bm25';
  private readonly documents: RawDocument[];
  private readonly byId = new Map<string, RawDocument>();
  private readonly index: Bm25Index;
  private readonly topK: number;
  private readonly candidateIdsSeen = new Set<string>();

  constructor(documents: SciFactDocumentInput[], topK = 100) {
    if (!documents.length) throw new Error('SciFact corpus source requires at least one document.');
    this.topK = Math.max(1, topK);

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

  public async fetchCandidates(query: string, _claim: ExtractedClaim): Promise<RawDocument[]> {
    const hits = this.index.search(query, this.topK);
    const results: RawDocument[] = [];
    for (const hit of hits) {
      const doc = this.byId.get(hit.id);
      if (!doc) continue;
      this.candidateIdsSeen.add(doc.id);
      results.push(doc);
    }
    return results;
  }

  public getCandidateIds(): string[] {
    return Array.from(this.candidateIdsSeen);
  }
}
