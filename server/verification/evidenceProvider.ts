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

// GDELT's document index is slower than RSS feeds. Keep its timeout explicit,
// bounded, and separate from the shorter publisher/RSS timeout so a 2s abort
// does not silently prevent the fallback from returning usable discovery hits.
export const GDELT_SEARCH_TIMEOUT_MS = 4_500;

export interface EvidenceSearchOptions {
  maxResultsPerClaim?: number;
  timeoutMs?: number;
}

/** Parse a feed date without allowing one malformed item to abort the search. */
export function parsePublicationDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

/**
 * Fall back to Wikipedia when too few Google News results survive publisher
 * fetching and provenance verification. Search-result count alone is not
 * usable evidence: RSS can return headlines for pages blocked to server fetch.
 */
export function shouldSearchWikipediaForEvidence(
  verifiedNewsCount: number,
  claimType: ExtractedClaim['claimType']
): boolean {
  return verifiedNewsCount < 3 ||
    ['Science', 'Historical', 'Environment', 'Statistics'].includes(claimType);
}

export interface BingNewsRssItem {
  title: string;
  url: string;
  publishedAt?: string;
  sourceName: string;
}

export interface GdeltArticleItem {
  title: string;
  url: string;
  publishedAt?: string;
  sourceName: string;
}

/**
 * Build a bounded historical GDELT DOC query. The default short horizon missed
 * relevant follow-up coverage for official science/health articles. DOC search
 * supports a one-year window, while results still must pass the same publisher
 * fetch, provenance, and relevance checks.
 */
export function buildGdeltArticleSearchUrl(query: string): string {
  const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  url.searchParams.set('query', (query || '').slice(0, 240));
  url.searchParams.set('mode', 'ArtList');
  url.searchParams.set('format', 'json');
  url.searchParams.set('maxrecords', '5');
  url.searchParams.set('timespan', '1y');
  url.searchParams.set('sort', 'HybridRel');
  return url.toString();
}

/** GDELT emits compact UTC timestamps such as 20261015T141500Z. */
function parseGdeltPublicationDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = raw.trim();
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact) {
    const [, year, month, day, hour, minute, second] = compact;
    const time = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    const date = new Date(time);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return parsePublicationDate(value);
}

/**
 * Parse only GDELT article-list metadata. A search hit is never evidence until
 * its actual publisher page is fetched, the final domain is verified, and the
 * article excerpt passes relevance checks.
 */
export function parseGdeltArticleList(payload: unknown): GdeltArticleItem[] {
  if (!payload || typeof payload !== 'object') return [];
  const articles = (payload as { articles?: unknown }).articles;
  if (!Array.isArray(articles)) return [];

  const parsed: GdeltArticleItem[] = [];
  const seen = new Set<string>();
  for (const candidate of articles.slice(0, 10)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const row = candidate as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    if (!title || !url) continue;

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname) continue;
      const canonicalUrl = parsedUrl.href;
      if (seen.has(canonicalUrl)) continue;
      seen.add(canonicalUrl);
      const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
      parsed.push({
        title: title.slice(0, 500),
        url: canonicalUrl,
        publishedAt: parseGdeltPublicationDate(row.seendate),
        sourceName: host.slice(0, 120)
      });
    } catch {
      // Ignore malformed URLs; never turn API metadata into an evidence link.
    }
  }
  return parsed;
}

/**
 * Evidence is only admissible when the publisher page was actually fetched,
 * its final URL was independently matched to the claimed publisher, and its
 * text was relevant enough to the extracted claim. A fetched but unrelated
 * Wikipedia article is not evidence.
 */
export function isAdmissibleEvidence(
  item: Pick<EvidenceItem, 'sourceFetchStatus' | 'provenanceVerified' | 'relevanceScore' | 'relation'>
): boolean {
  return item.sourceFetchStatus === 'FETCHED' &&
    item.provenanceVerified === true &&
    Number.isFinite(item.relevanceScore) &&
    item.relevanceScore >= 0.22 &&
    item.relation !== 'IRRELEVANT';
}

function isWikipediaEvidence(item: Pick<EvidenceItem, 'sourceUrl' | 'sourceFinalUrl'>): boolean {
  try {
    const host = new URL(item.sourceFinalUrl || item.sourceUrl).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'wikipedia.org' || host.endsWith('.wikipedia.org') ||
      host === 'wikimedia.org' || host.endsWith('.wikimedia.org');
  } catch {
    return false;
  }
}

/**
 * Prefer actual publisher pages whenever any are available. Wikipedia is a
 * last-resort discovery source: multiple encyclopedia pages must not crowd
 * out publisher evidence or masquerade as independent news corroboration.
 */
export function preferPublisherEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const publisherItems = items.filter(item => !isWikipediaEvidence(item));
  if (publisherItems.length > 0) return publisherItems.slice(0, 6);
  return items.filter(isWikipediaEvidence).slice(0, 3);
}

/** Parse a small, bounded set of Bing News RSS results without trusting feed markup. */
export function parseBingNewsRss(xml: string): BingNewsRssItem[] {
  const decodeXml = (raw: string): string => raw
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim();
  const readTag = (item: string, tag: string): string => {
    const match = item.match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${tag}\\s*>`, 'i'));
    return match ? decodeXml(match[1]) : '';
  };
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const parsed: BingNewsRssItem[] = [];
  for (const item of items.slice(0, 10)) {
    const rawTitle = readTag(item, 'title');
    const url = readTag(item, 'link');
    const rawDate = readTag(item, 'pubDate');
    const sourceTag = item.match(/<(?:news:)?source\b[^>]*>([\s\S]*?)<\/(?:news:)?source\s*>/i);
    const sourceName = sourceTag
      ? decodeXml(sourceTag[1])
      : (rawTitle.match(/\s+-\s+([^-]{2,60})$/)?.[1]?.trim() || 'Unknown publisher');
    const title = rawTitle.replace(/\s+-\s+[^-]+$/, '').trim();
    if (!title || !url) continue;
    let safeHttpUrl = false;
    try {
      const parsedUrl = new URL(url);
      safeHttpUrl = parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    } catch {
      safeHttpUrl = false;
    }
    if (!safeHttpUrl) continue;
    parsed.push({
      title: title.slice(0, 500),
      url,
      publishedAt: parsePublicationDate(rawDate),
      sourceName: sourceName.slice(0, 100)
    });
  }
  return parsed;
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
    const originalParsed = new URL(originalUrl);
    const originalHost = originalParsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!finalHost || finalHost === 'news.google.com') return false;
    const isGoogleNewsWrapper = originalHost === 'news.google.com';
    const isBingNewsWrapper = originalHost === 'bing.com' && /\/news\/apiclick\.aspx$/i.test(originalParsed.pathname);
    const isNewsWrapper = isGoogleNewsWrapper || isBingNewsWrapper;

    const samePublisherHost =
      !isNewsWrapper &&
      (finalHost === originalHost ||
        finalHost.endsWith('.' + originalHost) ||
        originalHost.endsWith('.' + finalHost));

    const aliases: Record<string, string[]> = {
      reuters: ['reuters.com'], 'associated press': ['apnews.com'], ap: ['apnews.com'],
      bbc: ['bbc.com', 'bbc.co.uk'], npr: ['npr.org'], bloomberg: ['bloomberg.com'],
      afp: ['afp.com'], wikipedia: ['wikipedia.org', 'wikimedia.org'],
      nasa: ['nasa.gov'], nih: ['nih.gov', 'ncbi.nlm.nih.gov'],
      'national institutes of health': ['nih.gov', 'ncbi.nlm.nih.gov'],
      'the guardian': ['theguardian.com'], cnn: ['cnn.com'], cnbc: ['cnbc.com'],
      'new york times': ['nytimes.com'], nyt: ['nytimes.com'],
      'washington post': ['washingtonpost.com'], 'wall street journal': ['wsj.com'],
      nature: ['nature.com'], 'science magazine': ['science.org'], politico: ['politico.com'],
      'the verge': ['theverge.com'], wired: ['wired.com'], nbc: ['nbcnews.com'],
      abc: ['abcnews.go.com', 'abc.net.au'], euronews: ['euronews.com']
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

    if (isNewsWrapper) return aliasMatch;
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
  // Wikimedia places sidebars, page navigation, table-of-contents links and
  // article-to-article navboxes inside ordinary div/table elements. These can
  // concatenate unrelated missions, dates and navigation labels into one long
  // pseudo-sentence, so remove them before selecting readable article text.
  $([
    '#mw-panel',
    '#mw-navigation',
    '#mw-head',
    '#vector-toc',
    '#toc',
    '#siteSub',
    '#contentSub',
    '.vector-toc',
    '.vector-header-container',
    '.vector-page-toolbar',
    '.vector-menu',
    '.mw-portlet',
    'table.sidebar',
    '.sidebar-heading',
    '.sidebar-content',
    '.sidebar-list',
    '.sidebar-above',
    '.sidebar-below',
    '.navbox',
    '.vertical-navbox',
    '.sistersitebox',
    '.portalbox',
    '.mw-editsection',
    '.mw-indicators',
    '.mw-jump-link'
  ].join(',')).remove();
  const selectors = [
    'article', '[itemprop="articleBody"]', 'main', '.article-body',
    '.article__body', '.story-body', '.story__body', '.entry-content', '.post-content'
  ];
  const extractBlockAwareText = (element: any): string => {
    const copy = $(element).clone();
    // Preserve boundaries for paragraphs, list items and table rows. Otherwise
    // facts about different missions/dates can collapse into one pseudo-sentence.
    copy.find('p,li,dt,dd,tr,blockquote,h1,h2,h3,h4,h5,h6').each((_i, block) => {
      $(block).prepend('\n').append('\n');
    });
    return copy.text()
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  };

  let best = '';
  for (const selector of selectors) {
    $(selector).each((_i, el) => {
      const text = extractBlockAwareText(el);
      if (text.length > best.length) best = text;
    });
    if (best.length >= 500) break;
  }
  if (best.length < 200) {
    const paragraphs = $('p')
      .map((_i, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter((p: string) => p.length >= 40);
    const paragraphText = paragraphs.join('\n').trim();
    if (paragraphText.length > best.length) best = paragraphText;
  }

  const structuredBody = structuredBodies.sort((a, b) => b.length - a.length)[0] || '';
  // Prefer the longer candidate: this preserves existing full-text extraction
  // while recovering structured article text from sparse publisher HTML.
  return structuredBody.length > best.length ? structuredBody : best;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export class EvidenceProvider {
  private timeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    // Keep one live claim-verification request within the API's 12s budget.
    // A blocked publisher is a failed candidate, not a reason to stall all other sources.
    this.timeoutMs = options?.timeoutMs || 3000;
  }

  private extractReadableText(html: string): string {
    return extractReadableArticleText(html);
  }

  private selectEvidenceExcerpt(claim: ExtractedClaim, text: string, title: string): string {
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length >= 30);
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
    return (selected.join('\n') || text.slice(0, 1600)).slice(0, 1800);
  }


  private async hydrateEvidenceItem(
    item: EvidenceItem,
    claim: ExtractedClaim,
    diagnostics?: RetrievalDiagnostic[],
    timeoutMs = this.timeoutMs
  ): Promise<EvidenceItem> {
    try {
      const fetched = await safeFetchHtml(item.sourceUrl, {
        timeoutMs,
        maxBytes: 2.5 * 1024 * 1024,
        maxRedirects: 5,
        // Use the same ordinary browser UA as direct extraction. Some publishers
        // reject an identifiable bot UA even for public, non-paywalled pages.
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
      });
      const body = this.extractReadableText(fetched.html);
      if (body.length < 120) throw new Error('Publisher page did not expose enough readable article text.');
      const excerpt = this.selectEvidenceExcerpt(claim, body, item.title);
      const { score, explanation } = calculateRelevance(claim, excerpt, item.title);
      const numericalConsistency = checkNumericalConsistency(claim, excerpt);
      const temporalConsistency = checkTemporalConsistency(claim, item.publishedAt);
      const lexicalRelation = classifyEvidenceRelation(claim, excerpt, score, numericalConsistency);
      const provenanceVerified = verifyEvidenceProvenance(item.sourceName, item.sourceUrl, fetched.finalUrl, item.sourceType);
      diagnostics?.push({
        provider: 'publisher_source_fetch',
        query: claim.normalizedText,
        attemptedAt: new Date().toISOString(),
        ok: true,
        resultCount: 1,
        stage: 'PUBLISHER_FETCH'
      });

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
    diagnostics?: RetrievalDiagnostic[],
    runGdeltInParallel = false
  ): Promise<EvidenceItem[]> {
    const searchStartedAt = Date.now();
    const results: EvidenceItem[] = [];
    const seenUrls = new Set<string>();
    const record = (d: RetrievalDiagnostic) => { if (diagnostics) diagnostics.push(d); };
    // Start the slower publisher-index fallback concurrently with Google News,
    // rather than waiting until after Bing + Wikipedia have exhausted the request
    // budget. It is only started for the first query of a claim.
    const gdeltPromise: Promise<EvidenceItem[]> = runGdeltInParallel
      ? this.searchGdeltForClaim(query, claim, diagnostics, new Set())
      : Promise.resolve([]);
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
          const parsedPubDate = rawPubDate ? new Date(rawPubDate) : null;
          const publishedAt = parsedPubDate && Number.isFinite(parsedPubDate.getTime())
            ? parsedPubDate.toISOString()
            : undefined;
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
              publishedAt,
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

    // Hydrate news candidates before deciding whether Wikipedia fallback is needed.
    // Raw RSS hit counts are not an evidence count; publisher pages can fail to fetch.
    const newsCandidates = results.splice(0, results.length).slice(0, 2);
    const hydratedNews = await Promise.all(
      newsCandidates.map(item => this.hydrateEvidenceItem(item, claim, diagnostics))
    );
    results.push(...hydratedNews);
    let verifiedNewsCount = hydratedNews.filter(
      item => item.sourceFetchStatus === 'FETCHED' && item.provenanceVerified === true
    ).length;

    const gdeltItems = runGdeltInParallel ? await gdeltPromise : [];
    if (gdeltItems.length > 0) {
      const existingUrls = new Set(results.map(item => item.sourceFinalUrl || item.sourceUrl));
      for (const item of gdeltItems) {
        const url = item.sourceFinalUrl || item.sourceUrl;
        if (existingUrls.has(url)) continue;
        existingUrls.add(url);
        results.push(item);
        if (!isWikipediaEvidence(item)) verifiedNewsCount++;
      }
    }

    // If GDELT supplied verified publisher pages, don't spend the remaining
    // request budget on another broad RSS/Wikipedia cascade. The next claim query
    // can add corroboration if enough budget remains.
    const canTryBing = verifiedNewsCount < 3 &&
      !(runGdeltInParallel && gdeltItems.length > 0) &&
      Date.now() - searchStartedAt < 7500;
    if (canTryBing) {
      try {
        const bingUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=en-us`;
        const bingResponse = await fetch(bingUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36' },
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!bingResponse.ok) {
          record({ provider: 'bing_news_rss', query, attemptedAt: new Date().toISOString(),
            ok: false, httpStatus: bingResponse.status, resultCount: 0,
            error: `HTTP ${bingResponse.status}`, stage: 'SEARCH' });
        } else {
          const hits = parseBingNewsRss(await bingResponse.text());
          const bingCandidates: EvidenceItem[] = [];
          for (const hit of hits.slice(0, 4)) {
            if (seenUrls.has(hit.url)) continue;
            seenUrls.add(hit.url);
            const sourceType = determineSourceType(hit.url, hit.sourceName);
            const { score, explanation } = calculateRelevance(claim, hit.title, hit.title);
            const numConsistency = checkNumericalConsistency(claim, hit.title);
            const tempConsistency = checkTemporalConsistency(claim, hit.publishedAt);
            bingCandidates.push({
              id: `bing-ev-${bingCandidates.length + 1}`,
              sourceName: hit.sourceName,
              sourceUrl: hit.url,
              title: hit.title,
              publishedAt: hit.publishedAt,
              retrievedAt: new Date().toISOString(),
              sourceType,
              snippet: hit.title,
              relation: classifyEvidenceRelation(claim, hit.title, score, numConsistency),
              relevanceScore: score,
              relevanceExplanation: explanation,
              numericalConsistency: numConsistency,
              temporalConsistency: tempConsistency
            });
          }

          const hydratedBing = await Promise.all(
            bingCandidates.slice(0, 2).map(item => this.hydrateEvidenceItem(item, claim, diagnostics))
          );
          results.push(...hydratedBing);
          verifiedNewsCount += hydratedBing.filter(
            item => item.sourceFetchStatus === 'FETCHED' && item.provenanceVerified === true
          ).length;
          record({ provider: 'bing_news_rss', query, attemptedAt: new Date().toISOString(),
            ok: true, httpStatus: bingResponse.status, resultCount: hits.length, stage: 'SEARCH' });
        }
      } catch (err: any) {
        record({ provider: 'bing_news_rss', query, attemptedAt: new Date().toISOString(),
          ok: false, resultCount: 0, error: err?.message || 'network error', stage: 'SEARCH' });
      }
    }

    const newsResultCount = results.length;

    // Search Wikipedia when fewer than three publisher pages actually survive
    // fetch and provenance checks, or when the claim type requires that source.
    if (
      shouldSearchWikipediaForEvidence(verifiedNewsCount, claim.claimType) &&
      !(runGdeltInParallel && gdeltItems.length > 0) &&
      Date.now() - searchStartedAt < 6500
    ) {
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
                   ok: true, httpStatus: res.status, resultCount: results.length - newsResultCount, stage: 'SEARCH' });
        }
      } catch (err: any) {
        console.warn(`[EvidenceProvider] Wikipedia search failed for query "${query}":`, err.message);
        record({ provider: 'wikipedia_search', query, attemptedAt: new Date().toISOString(),
                 ok: false, resultCount: 0, error: err.message || 'network error', stage: 'SEARCH' });
      }
    }

    // Only Wikipedia candidates remain unhydrated at this point. Keep the
    // existing total candidate bound per provider while allowing fallback
    // evidence to survive even when every news publisher fetch failed.
    const firstUnhydratedIndex = results.findIndex(item => item.sourceFetchStatus === undefined);
    if (firstUnhydratedIndex >= 0) {
      const wikiCandidates = results.slice(firstUnhydratedIndex);
      const hydratedWiki = await Promise.all(
        wikiCandidates.slice(0, 2).map(item => this.hydrateEvidenceItem(item, claim, diagnostics))
      );
      results.splice(firstUnhydratedIndex, wikiCandidates.length, ...hydratedWiki);
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
   * Supplement Google/Bing News with GDELT's public DOC article index when the
   * first query has produced too little relevant, fetched evidence. This is
   * source discovery only: every candidate must still pass the same publisher
   * fetch, provenance, and relevance gates as other providers.
   */
  private async searchGdeltForClaim(
    query: string,
    claim: ExtractedClaim,
    diagnostics: RetrievalDiagnostic[] | undefined,
    seenUrls: Set<string>
  ): Promise<EvidenceItem[]> {
    const startedAt = new Date().toISOString();
    const diagnostic: RetrievalDiagnostic = {
      provider: 'gdelt_doc_api', query, attemptedAt: startedAt, ok: false,
      resultCount: 0, error: 'GDELT request started; result not yet available.', stage: 'SEARCH'
    };
    diagnostics?.push(diagnostic);
    try {
      const searchUrl = buildGdeltArticleSearchUrl(query);

      const response = await fetch(searchUrl, {
        headers: { 'User-Agent': 'TruthLens-EvidenceBot/1.0 (academic; fact-checking)' },
        signal: AbortSignal.timeout(GDELT_SEARCH_TIMEOUT_MS)
      });
      if (!response.ok) {
        Object.assign(diagnostic, {
          httpStatus: response.status,
          error: `HTTP ${response.status}`
        });
        return [];
      }

      const body = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error('GDELT returned a non-JSON response.');
      }

      const candidates = parseGdeltArticleList(payload)
        .filter(candidate => !seenUrls.has(candidate.url))
        .slice(0, 2);

      // Publisher fetches run concurrently but remain strictly bounded.
      const hydrated = await Promise.all(candidates.map(async (candidate, index) => {
        const sourceType = determineSourceType(candidate.url, candidate.sourceName);
        const { score, explanation } = calculateRelevance(claim, candidate.title, candidate.title);
        const base: EvidenceItem = {
          id: `gdelt-ev-${index + 1}`,
          sourceName: candidate.sourceName,
          sourceUrl: candidate.url,
          title: candidate.title,
          publishedAt: candidate.publishedAt,
          retrievedAt: new Date().toISOString(),
          sourceType,
          snippet: candidate.title,
          relation: classifyEvidenceRelation(claim, candidate.title, score, { isConsistent: true }),
          relevanceScore: score,
          relevanceExplanation: explanation,
          numericalConsistency: checkNumericalConsistency(claim, candidate.title),
          temporalConsistency: checkTemporalConsistency(claim, candidate.publishedAt)
        };
        return this.hydrateEvidenceItem(base, claim, diagnostics, Math.min(this.timeoutMs, 2500));
      }));

      const admissible = hydrated.filter(isAdmissibleEvidence);
      // The caller owns seenUrls and adds returned sources to its evidence list.
      // Do not mark returned items as seen here or the caller would skip them.
      Object.assign(diagnostic, { ok: true, resultCount: admissible.length });
      delete diagnostic.error;
      return admissible;
    } catch (err: any) {
      Object.assign(diagnostic, {
        ok: false, resultCount: 0, error: err?.message || 'GDELT search failed'
      });
      return [];
    }
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

    const publisherDomains = new Set<string>();
    const totalBudgetMs = 10_500;
    const retrievalStartedAt = Date.now();

    const addAdmissibleItems = (items: EvidenceItem[]) => {
      for (const item of items) {
        if (!isAdmissibleEvidence(item)) continue;
        const dedupeUrl = item.sourceFinalUrl || item.sourceUrl;
        if (seenUrls.has(dedupeUrl)) continue;
        seenUrls.add(dedupeUrl);
        allEvidence.push(item);

        if (!isWikipediaEvidence(item)) {
          try {
            publisherDomains.add(new URL(item.sourceFinalUrl || item.sourceUrl).hostname.toLowerCase().replace(/^www\./, ''));
          } catch {
            // A malformed URL will already have failed the source-fetch/provenance gates.
          }
        }
      }
    };

    for (const [queryIndex, q] of queriesToRun.entries()) {
      const elapsed = Date.now() - retrievalStartedAt;
      const remaining = totalBudgetMs - elapsed;
      if (remaining < 3000) break;

      const items = await this.search(q, claim, diagnostics, queryIndex === 0);
      addAdmissibleItems(items);

      if (publisherDomains.size >= 3) break;
      // One parallel Google/GDELT/Bing pass is preferred to repeatedly issuing
      // near-identical queries after most of the 12s route budget is consumed.
      if (Date.now() - retrievalStartedAt >= 7500) break;
    }

    return preferPublisherEvidence(allEvidence);
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
    const importantClaims = claims.filter(c => c.importance === 'HIGH' || c.importance === 'MEDIUM');

    // Keep low-importance claims in the response, but prioritize important claims.
    // Two bounded workers avoid serial network waits without fanning every claim
    // out simultaneously and exhausting the serverless request's time budget.
    const importantResults = await mapWithConcurrency(importantClaims, 2, async claim => {
      const evidenceItems = await this.searchEvidenceForClaim(claim);
      return aggregateClaimAssessment(claim, evidenceItems);
    });
    const resultById = new Map(importantResults.map(result => [result.claim.claimId, result]));
    const results: ClaimVerificationResult[] = claims.map(claim =>
      resultById.get(claim.claimId) || aggregateClaimAssessment(claim, [])
    );
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
