/**
 * V2 CORPUS SOURCES
 * =================
 * A `CorpusSource` supplies the RAW candidate documents that lexical + dense
 * retrieval then rank. This is the ONLY place evidence enters the V2
 * pipeline; nothing downstream may invent a document.
 *
 * Two implementations are provided:
 *
 *  - `FixtureCorpusSource`  : a fixed, deterministic, offline document pool.
 *                             Used by tests, CI, and the evaluation harness
 *                             so results are 100% reproducible.
 *  - `LiveEvidenceProviderCorpusSource` : wraps the EXISTING, already-shipped
 *                             `evidenceProvider` (Google News RSS +
 *                             Wikipedia, SSRF-safe). No second retrieval
 *                             backend is introduced; this source just
 *                             re-shapes `EvidenceItem[]` into `RawDocument[]`.
 */
import { ExtractedClaim, EvidenceItem } from '../../../src/types';
import { evidenceProvider } from '../../verification/evidenceProvider';
import { RawDocument } from '../types';

export interface CorpusSource {
  readonly name: string;
  fetchCandidates(query: string, claim: ExtractedClaim): Promise<RawDocument[]>;
}

function evidenceItemToRawDocument(item: EvidenceItem, method: string): RawDocument {
  return {
    id: item.id,
    url: item.sourceUrl,
    title: item.title,
    // The live provider only ever returns a headline/snippet, never a
    // fetched article body — label it honestly rather than implying a full
    // article was read (see Phase 3 rule: never treat a headline as full
    // article evidence).
    snippet: item.snippet,
    contentType: item.snippet && item.snippet.length > (item.title || '').length + 20 ? 'SUMMARY' : 'HEADLINE_ONLY',
    publisher: item.sourceName,
    publishedAt: item.publishedAt ?? null,
    retrievedAt: item.retrievedAt,
    retrievalMethod: method
  };
}

/**
 * Wraps the existing production evidence provider (Google News RSS index +
 * Wikipedia search). Requires outbound network access; when unreachable it
 * returns an empty list rather than throwing, so the pipeline can fall back
 * to INSUFFICIENT_EVIDENCE / abstain instead of crashing.
 */
export class LiveEvidenceProviderCorpusSource implements CorpusSource {
  public readonly name = 'live_evidence_provider(google_news_rss+wikipedia)';

  public async fetchCandidates(query: string, claim: ExtractedClaim): Promise<RawDocument[]> {
    try {
      const items = await evidenceProvider.search(query, claim);
      return items.map(item => evidenceItemToRawDocument(item, this.name));
    } catch {
      return [];
    }
  }
}

/**
 * A fixed, hand-curated, deterministic document pool for offline/CI use.
 * `fetchCandidates` ignores the query and returns the whole pool — relevance
 * filtering/ranking is the job of the lexical + dense retrieval layers, not
 * the corpus source, which mirrors how a real search index would be queried
 * (index holds everything, the query decides what surfaces).
 */
export class FixtureCorpusSource implements CorpusSource {
  public readonly name = 'fixture_corpus(offline_deterministic)';
  private documents: RawDocument[];

  constructor(documents: RawDocument[]) {
    this.documents = documents;
  }

  public async fetchCandidates(): Promise<RawDocument[]> {
    return this.documents;
  }
}

/** Combines multiple corpus sources into one, tagging provenance per source. */
export class CompositeCorpusSource implements CorpusSource {
  public readonly name: string;
  private sources: CorpusSource[];

  constructor(sources: CorpusSource[]) {
    this.sources = sources;
    this.name = `composite(${sources.map(s => s.name).join('+')})`;
  }

  public async fetchCandidates(query: string, claim: ExtractedClaim): Promise<RawDocument[]> {
    const results = await Promise.all(this.sources.map(s => s.fetchCandidates(query, claim)));
    return results.flat();
  }
}
