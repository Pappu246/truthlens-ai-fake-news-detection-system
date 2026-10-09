import {
  ExtractedClaim,
  EvidenceItem,
  ClaimVerificationResult,
  SourceType
} from '../../src/types.js';
import { safeFetchHtml } from '../security/urlValidator.js';
import * as cheerio from 'cheerio';
import {
  determineSourceType,
  calculateRelevance,
  checkNumericalConsistency,
  checkTemporalConsistency,
  classifyEvidenceRelation,
  aggregateClaimAssessment
} from './evidenceAnalyzer.js';
import { refineEvidenceRelationSemantically } from './semanticRelation.js';

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
  stage?: 'SEARCH' | 'PUBLISHER_FETCH' | 'PROVENANCE';
}

export function verifyEvidenceProvenance(
  sourceName: string,
  originalUrl: string,
  finalUrl: string,
  originalType: SourceType
): boolean {
  try {
    const finalHost = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, '');
    const originalHost = new URL(originalUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (!finalHost || finalHost === 'news.google.com') return false;

    const samePublisherHost =
      originalHost !== 'news.google.com' &&
      (finalHost === originalHost ||
        finalHost.endsWith('.' + originalHost) ||
        originalHost.endsWith('.' + finalHost));

    const aliases: Record<string, string[]> = {
      reuters: ['reuters.com'], 'associated press': ['apnews.com'], ap: ['apnews.com'],
      bbc: ['bbc.com', 'bbc.co.uk'], npr: ['npr.org'], bloomberg: ['bloomberg.com'],
      afp: ['afp.com'], wikipedia: ['wikipedia.org', 'wikimedia.org']
    };
    const name = sourceName.toLowerCase();
    const matched = Object.entries(aliases).find(([alias]) => name.includes(alias));
    const aliasMatch = matched
      ? matched[1].some(domain => finalHost === domain || finalHost.endsWith('.' + domain))
      : false;

    const finalType = determineSourceType(finalUrl, sourceName);
    if (samePublisherHost) {
      return originalType === 'UNKNOWN'
        ? true
        : finalType === originalType || aliasMatch;
    }

    if (originalHost === 'news.google.com') return aliasMatch;
    return aliasMatch;
  } catch {
    return false;
  }
}

/**
 * Extract publisher article text from either visible HTML or publisher-authored
 * Schema.org JSON-LD. Some sites render the article body in JSON-LD even when
 * their HTML body is sparse, paywalled, or client-rendered.
 *
 * Only application/ld+json `articleBody` fields
 * are used as the structured-data fallback. We do not treat RSS headlines,
 * arbitrary scripts, or generic metadata descriptions as factual evidence.
 */
export function extractReadableArticleText(html: string): string {
  const $ = cheerio.load(html);
  const structuredBodies: string[] = [];

  const clean = (value: string): string =>
    value.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();

  const collectArticleBodies = (value: unknown, depth = 0): void => {
    if (depth > 16 || value == null) return;
    if (Array.isArray(value)) {
      for (const entry of value) collectArticleBodies(entry, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;

    const record = value as Record<string, unknown>;
    const articleBody = record.articleBody;
    if (typeof articleBody === 'string') {
      const normalised = clean(articleBody);
      if (normalised.length > 0) structuredBodies.push(normalised.slice(0, 50000));
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== 'articleBody') collectArticleBodies(child, depth + 1);
    }
  };

  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      collectArticleBodies(JSON.parse(raw));
    } catch {
      // A malformed structured-data block must not break ordinary HTML extraction.
    }
  });

  $('script,style,noscript,template,nav,header,footer,aside,form,svg').remove();
  const selectors = [
    'article', '[itemprop="articleBody"]', 'main', '.article-body',
    '.article__body', '.story-body', '.story__body', '.entry-content', '.post-content'
  ];
  let best = '';
  for (const selector of selectors) {
    $(selector).each((_i, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length > best.length) best = text;
    });
    if (best.length >= 500) break;
  }
  if (best.length < 200) {
    const paragraphs = $('p')
      .map((_i, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter((p: string) => p.length >= 40);
    const paragraphText = paragraphs.join(' ').replace(/\s+/g, ' ').trim();
    if (paragraphText.length > best.length) best = paragraphText;
  }

  const structuredBody = structuredBodies.sort((a, b) => b.length - a.length)[0] || '';
  // Prefer the longer candidate: this preserves existing full-text extraction
  // while recovering structured article text from sparse publisher HTML.
  return structuredBody.length > best.length ? structuredBody : best;
}

export class EvidenceProvider {
  private timeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs || 8000;
  }

  private extractReadableText(html: string): string {
    return extractReadableArticleText(html);
  }

  private selectEvidenceExcerpt(claim: ExtractedClaim, text: string, title: string): string {
    const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length >= 30);
    if (sentences.length === 0) return text.slice(0, 1600);
    const terms = [...claim.entities, ...claim.keywords, ...claim.numbers]
      .map(t => t.toLowerCase().replace(/[^a-z0-9%.-]/g, '')).filter(Boolean);
    const scored = sentences.map((sentence, index) => {
      const lower = sentence.toLowerCase();
      const hits = terms.reduce((n, term) => n + (lower.includes(term) ? 1 : 0), 0);
      const titleBoost = title && lower.includes(title.toLowerCase().slice(0, 24)) ? 1 : 0;
      return { sentence, index, score: hits + titleBoost };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = scored.slice(0, 3).sort((a, b) => a.index - b.index).map(x => x.sentence);
    return (selected.join(' ') || text.slice(0, 1600)).slice(0, 1800);
  }


  private async hydrateEvidenceItem(
    item: EvidenceItem,
    claim: ExtractedClaim,
    diagnostics?: RetrievalDiagnostic[]
  ): Promise<EvidenceItem> {
    try {
      const fetched = await safeFetchHtml(item.sourceUrl, {
        timeoutMs: this.timeoutMs,
        maxBytes: 2.5 * 1024 * 1024,
        maxRedirects: 5,
        userAgent: 'TruthLens-EvidenceBot/1.0 (academic; evidence retrieval)'
      });
      const body = this.extractReadableText(fetched.html);
      if (body.length < 120) throw new Error('Publisher page did not expose enough readable article text.');
      const excerpt = this.selectEvidenceExcerpt(claim, body, item.title);
      const { score, explanation } = calculateRelevance(claim, excerpt, item.title);
      const numericalConsistency = checkNumericalConsistency(claim, excerpt);
      const temporalConsistency = checkTemporalConsistency(claim, item.publishedAt);
      const lexicalRelation = classifyEvidenceRelation(claim, excerpt, score, numericalConsistency);
      const provenanceVerified = verifyEvidenceProvenance(item.sourceName, item.sourceUrl, fetched.finalUrl, item.sourceType);

      if (diagnostics && !provenanceVerified) {
        diagnostics.push({
          provider: 'publisher_provenance_verification',
          query: claim.normalizedText,
          attemptedAt: new Date().toISOString(),
          ok: true,
          resultCount: 0,
          error: 'Publisher identity did not match the discovered source after redirect verification.',
          stage: 'PROVENANCE'
        });
      }

      let relation = lexicalRelation;
      let finalExplanation = explanation;
      if (provenanceVerified && numericalConsistency.isConsistent) {
        const semantic = await refineEvidenceRelationSemantically(
          claim,
          excerpt,
          lexicalRelation,
          score
        );
        if (semantic && semantic.relation !== 'MIXED') {
          relation = semantic.relation;
          finalExplanation =
            explanation +
            ` | semantic NLI: ${semantic.relation} confidence=${semantic.confidence.toFixed(3)} margin=${semantic.margin.toFixed(3)} model=${semantic.modelName}`;
        } else if (semantic) {
          finalExplanation =
            explanation +
            ` | semantic NLI abstained confidence=${semantic.confidence.toFixed(3)} margin=${semantic.margin.toFixed(3)} model=${semantic.modelName}`;
        }
      } else if (!provenanceVerified) {
        relation = 'INSUFFICIENT';
        finalExplanation = 'Publisher provenance could not be verified; directional evidence was withheld.';
      }

      return {
        ...item,
        sourceFinalUrl: fetched.finalUrl,
        evidenceExcerpt: excerpt,
        sourceFetchStatus: 'FETCHED',
        sourceContentWordCount: body.split(/\s+/).filter(Boolean).length,
        provenanceVerified,
        relation,
        relevanceScore: score,
        relevanceExplanation: finalExplanation,
        numericalConsistency,
        temporalConsistency
      };
    } catch (err: any) {
      diagnostics?.push({
        provider: 'publisher_source_fetch',
        query: claim.normalizedText,
        attemptedAt: new Date().toISOString(),
        ok: false,
        resultCount: 0,
        error: err?.message || 'source fetch failed',
        stage: 'PUBLISHER_FETCH'
      });
      return {
        ...item,
        sourceFetchStatus: 'FAILED',
        provenanceVerified: false,
        relation: 'INSUFFICIENT',
        relevanceScore: 0,
        relevanceExplanation: 'Publisher page could not be fetched or parsed: ' + (err?.message || 'unknown error'),
        evidenceExcerpt: undefined
      };
    }
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
                 error: `HTTP ${res.status}`, stage: 'SEARCH' });
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
                 ok: true, httpStatus: res.status, resultCount: newsCount, stage: 'SEARCH' });
      }
    } catch (err: any) {
      console.warn(`[EvidenceProvider] News RSS search failed for query "${query}":`, err.message);
      record({ provider: 'google_news_rss', query, attemptedAt: new Date().toISOString(),
               ok: false, resultCount: 0, error: err.message || 'network error', stage: 'SEARCH' });
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
                   ok: false, httpStatus: res.status, resultCount: 0, error: `HTTP ${res.status}`, stage: 'SEARCH' });
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
                   ok: true, httpStatus: res.status, resultCount: results.length - newsCount, stage: 'SEARCH' });
        }
      } catch (err: any) {
        console.warn(`[EvidenceProvider] Wikipedia search failed for query "${query}":`, err.message);
        record({ provider: 'wikipedia_search', query, attemptedAt: new Date().toISOString(),
                 ok: false, resultCount: 0, error: err.message || 'network error', stage: 'SEARCH' });
      }
    }

    const hydrated: EvidenceItem[] = [];
    for (const item of results.slice(0, 6)) {
      hydrated.push(await this.hydrateEvidenceItem(item, claim, diagnostics));
    }
    results.splice(0, results.length, ...hydrated);

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
        if (item.sourceFetchStatus !== 'FETCHED' || item.provenanceVerified === false) continue;
        const dedupeUrl = item.sourceFinalUrl || item.sourceUrl;
        if (!seenUrls.has(dedupeUrl)) {
          seenUrls.add(dedupeUrl);
          allEvidence.push(item);
        }
      }
      if (allEvidence.length >= 6) break;
    }

    return allEvidence;
  }

  /**
   * Gathers evidence and classifies the retrieval outcome without collapsing
   * search failure, no-evidence, publisher-fetch failure, and provenance rejection.
   */
  public async searchEvidenceForClaimDetailed(
    claim: ExtractedClaim,
    diagnostics?: RetrievalDiagnostic[]
  ): Promise<{
    items: EvidenceItem[];
    status: 'AVAILABLE' | 'NO_EVIDENCE' | 'SEARCH_FAILED' | 'PUBLISHER_FETCH_FAILED' | 'PROVENANCE_REJECTED';
  }> {
    const allEvidence = await this.searchEvidenceForClaim(claim, diagnostics);
    const entries = diagnostics ?? [];
    const searchEntries = entries.filter(d => (d.stage ?? 'SEARCH') === 'SEARCH');
    const fetchFailures = entries.filter(d => d.stage === 'PUBLISHER_FETCH' && !d.ok);
    const provenanceRejections = entries.filter(d => d.stage === 'PROVENANCE' && d.ok);

    if (allEvidence.length > 0) {
      return { items: allEvidence, status: 'AVAILABLE' };
    }
    if (searchEntries.length > 0 && searchEntries.every(d => !d.ok)) {
      return { items: [], status: 'SEARCH_FAILED' };
    }
    if (fetchFailures.length > 0) {
      return { items: [], status: 'PUBLISHER_FETCH_FAILED' };
    }
    if (provenanceRejections.length > 0) {
      return { items: [], status: 'PROVENANCE_REJECTED' };
    }
    return { items: [], status: 'NO_EVIDENCE' };
  }

  /**
   * Verifies a batch of claims and aggregates verdicts.
   */
  public async verifyClaims(claims: ExtractedClaim[]): Promise<ClaimVerificationResult[]> {
    const results: ClaimVerificationResult[] = [];
    const importantClaims = claims.filter(c => c.importance === 'HIGH' || c.importance === 'MEDIUM');

    // First spend retrieval budget on the claims that can materially affect the
    // article verdict. Low-importance claims are only searched when the
    // important-claim pass does not establish enough evidence, avoiding a
    // large latency increase on normal articles.
    for (const claim of claims) {
      if (claim.importance !== 'HIGH' && claim.importance !== 'MEDIUM') {
        results.push(aggregateClaimAssessment(claim, []));
        continue;
      }
      const evidenceItems = await this.searchEvidenceForClaim(claim);
      results.push(aggregateClaimAssessment(claim, evidenceItems));
    }

    const importantResults = results.filter(r => r.claim.importance === 'HIGH' || r.claim.importance === 'MEDIUM');
    const importantCoverage = importantClaims.length > 0 &&
      importantResults.filter(r => r.assessment !== 'INSUFFICIENT').length === importantClaims.length;

    if (!importantCoverage) {
      for (let i = 0; i < results.length; i++) {
        const claim = results[i].claim;
        if (claim.importance !== 'LOW' || results[i].assessment !== 'INSUFFICIENT') continue;
        const evidenceItems = await this.searchEvidenceForClaim(claim);
        results[i] = aggregateClaimAssessment(claim, evidenceItems);
      }
    }

    return results;
  }
}

export const evidenceProvider = new EvidenceProvider();
