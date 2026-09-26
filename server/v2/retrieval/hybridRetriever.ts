/**
 * V2 HYBRID EVIDENCE RETRIEVAL
 * ============================
 * For every expanded query (original / support-oriented / contradiction-
 * oriented): runs BM25 lexical search AND dense (embedding cosine) search
 * over the candidate pool returned by the `CorpusSource`, then fuses the two
 * rankings with reciprocal-rank fusion (RRF) — a standard, parameter-light,
 * reproducible hybrid-retrieval fusion method.
 *
 * Results across all queries and channels are merged and deduplicated by
 * CANONICAL URL (reusing the existing `normalizeUrl` from
 * `server/security/urlValidator.ts` — no second URL-canonicalisation
 * routine is introduced).
 *
 * Nothing here fabricates a document: every `RetrievedCandidate` traces back
 * to a `RawDocument` that a `CorpusSource` actually returned.
 */
import { ExtractedClaim } from '../../../src/types';
import { normalizeUrl } from '../../security/urlValidator';
import { bm25Search } from './bm25';
import { defaultEmbeddingModel, denseSearch, EmbeddingModel } from './embeddings';
import { createConfiguredEmbeddingModel } from './huggingFaceEmbeddingModel';
import { CorpusSource } from './corpusSource';
import { ExpandedQuerySet, RawDocument, RetrievedCandidate, RetrievalChannel } from '../types';

export interface HybridRetrievalOptions {
  embeddingModel?: EmbeddingModel;
  perQueryTopK?: number;
  finalTopK?: number;
}

export interface HybridRetrievalResult {
  candidates: RetrievedCandidate[];
  totalRetrievedBeforeDedup: number;
  channelsUsed: RetrievalChannel[];
}

function docText(doc: RawDocument): string {
  return `${doc.title} ${doc.snippet} ${doc.body || ''}`.trim();
}

function canonicalUrlOf(url: string): string {
  if (!url) return '';
  try {
    return normalizeUrl(url).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Reciprocal Rank Fusion: score = sum over channels of 1 / (K_CONST + rank). */
const RRF_K = 60;

export async function hybridRetrieve(
  claim: ExtractedClaim,
  queries: ExpandedQuerySet,
  corpus: CorpusSource,
  options?: HybridRetrievalOptions
): Promise<HybridRetrievalResult> {
  const embeddingModel = options?.embeddingModel ?? createConfiguredEmbeddingModel() ?? defaultEmbeddingModel;
  const perQueryTopK = options?.perQueryTopK ?? 15;
  const finalTopK = options?.finalTopK ?? 12;

  const byCanonicalUrl = new Map<string, RetrievedCandidate>();
  let totalRetrievedBeforeDedup = 0;
  const channelsUsed = new Set<RetrievalChannel>();

  for (const query of queries.all) {
    const docs = await corpus.fetchCandidates(query, claim);
    if (docs.length === 0) continue;
    totalRetrievedBeforeDedup += docs.length;

    const docById = new Map(docs.map(d => [d.id, d]));
    const searchable = docs.map(d => ({ id: d.id, text: docText(d) }));

    const lexicalHits = bm25Search(query, searchable, perQueryTopK);
    const denseHits = await denseSearch(query, searchable, embeddingModel, perQueryTopK);

    if (lexicalHits.length > 0) channelsUsed.add('LEXICAL_BM25');
    if (denseHits.length > 0) channelsUsed.add('DENSE_EMBEDDING');

    const rrfScores = new Map<string, number>();
    const lexicalScoreById = new Map<string, number>();
    const denseScoreById = new Map<string, number>();

    lexicalHits.forEach((hit, rank) => {
      rrfScores.set(hit.id, (rrfScores.get(hit.id) || 0) + 1 / (RRF_K + rank + 1));
      lexicalScoreById.set(hit.id, hit.score);
    });
    denseHits.forEach((hit, rank) => {
      rrfScores.set(hit.id, (rrfScores.get(hit.id) || 0) + 1 / (RRF_K + rank + 1));
      denseScoreById.set(hit.id, hit.score);
    });

    for (const [id, fusionScore] of rrfScores.entries()) {
      const doc = docById.get(id);
      if (!doc || !doc.url) continue;
      const canonicalUrl = canonicalUrlOf(doc.url);
      if (!canonicalUrl) continue;

      const lexRank = lexicalHits.findIndex(h => h.id === id);
      const denseRank = denseHits.findIndex(h => h.id === id);
      const foundBy: RetrievedCandidate['foundBy'] = [];
      if (lexRank >= 0) foundBy.push({ channel: 'LEXICAL_BM25', query, rank: lexRank, score: lexicalScoreById.get(id) || 0 });
      if (denseRank >= 0) foundBy.push({ channel: 'DENSE_EMBEDDING', query, rank: denseRank, score: denseScoreById.get(id) || 0 });

      const existing = byCanonicalUrl.get(canonicalUrl);
      if (!existing) {
        byCanonicalUrl.set(canonicalUrl, {
          ...doc,
          canonicalUrl,
          foundBy,
          lexicalScore: lexicalScoreById.get(id) || 0,
          denseScore: denseScoreById.get(id) || 0,
          fusionScore
        });
      } else {
        // Same document reached via a different query/channel: merge scores
        // (take the max lexical/dense score, sum RRF contribution) instead of
        // creating a duplicate row.
        existing.foundBy.push(...foundBy);
        existing.lexicalScore = Math.max(existing.lexicalScore, lexicalScoreById.get(id) || 0);
        existing.denseScore = Math.max(existing.denseScore, denseScoreById.get(id) || 0);
        existing.fusionScore += fusionScore;
      }
    }
  }

  const candidates = Array.from(byCanonicalUrl.values())
    .sort((a, b) => b.fusionScore - a.fusionScore)
    .slice(0, finalTopK);

  return {
    candidates,
    totalRetrievedBeforeDedup,
    channelsUsed: Array.from(channelsUsed)
  };
}
