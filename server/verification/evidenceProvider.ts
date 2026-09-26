import {
  ExtractedClaim,
  EvidenceItem,
  ClaimVerificationResult,
  SourceType
} from '../../src/types';
import { safeFetchHtml } from '../security/urlValidator';
import {
  determineSourceType,
  calculateRelevance,
  checkNumericalConsistency,
  checkTemporalConsistency,
  classifyEvidenceRelation,
  aggregateClaimAssessment
} from './evidenceAnalyzer';

export interface EvidenceSearchOptions {
  maxResultsPerClaim?: number;
  timeoutMs?: number;
}

/**
 * Per-provider retrieval outcome. This exists so the evidence engine can tell
 * the difference between "we searched and found nothing" and "the search
 * backend was unreachable". Those two cases must never produce the same
 * verification status.
 */
export interface RetrievalDiagnostic {
  provider: string;
  query: string;
  attemptedAt: string;
  ok: boolean;
  httpStatus?: number;
  resultCount: number;
  error?: string;
}

export class EvidenceProvider {
  private timeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs || 8000;
  }

  /**
   * Safe fetch of an external source page
   */
  public async fetchSource(url: string): Promise<string> {
    try {
      const res = await safeFetchHtml(url, { timeoutMs: this.timeoutMs });
      return res.html;
    } catch (err: any) {
      console.warn(`[EvidenceProvider] Failed to fetch source ${url}:`, err.message);
      return '';
    }
  }

  /**
   * Searches live web news and knowledge indexes for authentic sources.
   * Real sources only. Absolutely zero fabricated results.
   */
  public async search(
    query: string,
    claim: ExtractedClaim,
    diagnostics?: RetrievalDiagnostic[]
  ): Promise<EvidenceItem[]> {
    const results: EvidenceItem[] = [];
    const seenUrls = new Set<string>();
    const record = (d: RetrievalDiagnostic) => { if (diagnostics) diagnostics.push(d); };
    let newsCount = 0;

    // 1. Search Google News RSS live index
    try {
      const encodedQuery = encodeURIComponent(query);
      const newsUrl = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`;
      
      const res = await fetch(newsUrl, {
        headers: { 'User-Agent': 'TruthLens-EvidenceBot/1.0 (academic; fact-checking)' },
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!res.ok) {
        record({ provider: 'google_news_rss', query, attemptedAt: new Date().toISOString(),
                 ok: false, httpStatus: res.status, resultCount: 0,
                 error: `HTTP ${res.status}` });
      }
      if (res.ok) {
        const text = await res.text();
        const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];

        for (const itemXml of items.slice(0, 5)) {
          const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/);
          const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/);
          const pubMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
          const sourceMatch = itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/);

          const rawTitle = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
          const rawLink = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
          const rawPubDate = pubMatch ? pubMatch[1].trim() : undefined;
          const rawSourceName = sourceMatch ? sourceMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : 'News Outlet';

          if (rawLink && !seenUrls.has(rawLink)) {
            seenUrls.add(rawLink);

            // Clean title and snippet
            const cleanTitle = rawTitle.replace(/ - [^-]+$/, '');
            const snippet = rawTitle; // RSS title often contains headline + publisher summary
            const sourceType = determineSourceType(rawLink, rawSourceName);

            // Calculate transparent relevance
            const { score: relevanceScore, explanation: relExplanation } = calculateRelevance(claim, snippet, cleanTitle);
            const numConsistency = checkNumericalConsistency(claim, snippet);
            const tempConsistency = checkTemporalConsistency(claim, rawPubDate);
            const relation = classifyEvidenceRelation(claim, snippet, relevanceScore, numConsistency);

            // Check for syndicated wire story reproduction
            const isSyndicated = /\b(?:AP|Associated Press|Reuters|AFP|Agence France-Presse|Bloomberg)\b/i.test(snippet) ||
                                /\b(?:AP|Reuters|AFP)\b/i.test(rawSourceName);

            results.push({
              id: `ev-${results.length + 1}`,
              sourceName: rawSourceName,
              sourceUrl: rawLink,
              title: cleanTitle || rawTitle,
              publishedAt: rawPubDate ? new Date(rawPubDate).toISOString() : undefined,
              retrievedAt: new Date().toISOString(),
              sourceType,
              snippet,
              relation,
              relevanceScore,
              relevanceExplanation: relExplanation,
              numericalConsistency: numConsistency,
              temporalConsistency: tempConsistency,
              isSyndicated
            });
          }
        }
        newsCount = results.length;
        record({ provider: 'google_news_rss', query, attemptedAt: new Date().toISOString(),
                 ok: true, httpStatus: res.status, resultCount: newsCount });
      }
    } catch (err: any) {
      console.warn(`[EvidenceProvider] News RSS search failed for query "${query}":`, err.message);
      record({ provider: 'google_news_rss', query, attemptedAt: new Date().toISOString(),
               ok: false, resultCount: 0, error: err.message || 'network error' });
    }

    // 2. If claim is Science / Historical / Statistics or if news hits were low, check Wikipedia
    if (results.length < 3 || ['Science', 'Historical', 'Environment', 'Statistics'].includes(claim.claimType)) {
      try {
        const wikiQuery = encodeURIComponent(query);
        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${wikiQuery}&format=json&origin=*`;
        
        const res = await fetch(wikiUrl, {
          headers: { 'User-Agent': 'TruthLens-EvidenceBot/1.0 (academic; fact-checking)' },
          signal: AbortSignal.timeout(this.timeoutMs)
        });

        if (!res.ok) {
          record({ provider: 'wikipedia_search', query, attemptedAt: new Date().toISOString(),
                   ok: false, httpStatus: res.status, resultCount: 0, error: `HTTP ${res.status}` });
        }
        if (res.ok) {
          const data = await res.json();
          const searchHits = data.query?.search || [];

          for (const hit of searchHits.slice(0, 3)) {
            const hitTitle = hit.title;
            const snippetRaw = (hit.snippet || '').replace(/<[^>]+>/g, '');
            const wikiArticleUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(hitTitle.replace(/\s+/g, '_'))}`;

            if (!seenUrls.has(wikiArticleUrl)) {
              seenUrls.add(wikiArticleUrl);
              const { score: relevanceScore, explanation: relExplanation } = calculateRelevance(claim, snippetRaw, hitTitle);
              const numConsistency = checkNumericalConsistency(claim, snippetRaw);
              const tempConsistency = checkTemporalConsistency(claim);
              const relation = classifyEvidenceRelation(claim, snippetRaw, relevanceScore, numConsistency);

              results.push({
                id: `ev-${results.length + 1}`,
                sourceName: 'Wikipedia / Wikimedia Foundation',
                sourceUrl: wikiArticleUrl,
                title: hitTitle,
                retrievedAt: new Date().toISOString(),
                sourceType: 'REPUTABLE_SOURCE',
                snippet: snippetRaw,
                relation,
                relevanceScore,
                relevanceExplanation: relExplanation,
                numericalConsistency: numConsistency,
                temporalConsistency: tempConsistency
              });
            }
          }
          record({ provider: 'wikipedia_search', query, attemptedAt: new Date().toISOString(),
                   ok: true, httpStatus: res.status, resultCount: results.length - newsCount });
        }
      } catch (err: any) {
        console.warn(`[EvidenceProvider] Wikipedia search failed for query "${query}":`, err.message);
        record({ provider: 'wikipedia_search', query, attemptedAt: new Date().toISOString(),
                 ok: false, resultCount: 0, error: err.message || 'network error' });
      }
    }

    // Sort results by relevance score descending and source priority
    results.sort((a, b) => {
      // Prioritize official or major news
      const priorityOrder: Record<SourceType, number> = {
        OFFICIAL_GOVERNMENT: 5,
        OFFICIAL_ORGANIZATION: 4,
        PRIMARY_SCIENTIFIC: 3,
        MAJOR_NEWS: 2,
        REPUTABLE_SOURCE: 1,
        UNKNOWN: 0
      };
      const pDiff = (priorityOrder[b.sourceType] || 0) - (priorityOrder[a.sourceType] || 0);
      if (pDiff !== 0) return pDiff;
      return b.relevanceScore - a.relevanceScore;
    });

    return results;
  }

  /**
   * Gathers evidence across all generated search queries for a claim.
   */
  public async searchEvidenceForClaim(
    claim: ExtractedClaim,
    diagnostics?: RetrievalDiagnostic[]
  ): Promise<EvidenceItem[]> {
    const allEvidence: EvidenceItem[] = [];
    const seenUrls = new Set<string>();

    const queriesToRun = claim.searchQueries.length > 0 
      ? claim.searchQueries 
      : [claim.normalizedText];

    for (const q of queriesToRun) {
      const items = await this.search(q, claim, diagnostics);
      for (const item of items) {
        if (!seenUrls.has(item.sourceUrl)) {
          seenUrls.add(item.sourceUrl);
          allEvidence.push(item);
        }
      }
      if (allEvidence.length >= 6) break;
    }

    return allEvidence;
  }

  /**
   * Verifies a batch of claims and aggregates verdicts.
   */
  public async verifyClaims(claims: ExtractedClaim[]): Promise<ClaimVerificationResult[]> {
    const results: ClaimVerificationResult[] = [];

    for (const claim of claims) {
      // Only prioritize search for HIGH and MEDIUM claims to conserve network, but evaluate all
      let evidenceItems: EvidenceItem[] = [];
      if (claim.importance === 'HIGH' || claim.importance === 'MEDIUM') {
        evidenceItems = await this.searchEvidenceForClaim(claim);
      }

      const claimResult = aggregateClaimAssessment(claim, evidenceItems);
      results.push(claimResult);
    }

    return results;
  }
}

export const evidenceProvider = new EvidenceProvider();
