import * as cheerio from 'cheerio';
import { ExtractedArticle } from '../../src/types.js';

const ABP_HOSTS = new Set([
  'abplive.com',
  'www.abplive.com',
  'news.abplive.com',
  'bengali.abplive.com'
]);

function parseAbpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!ABP_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    return parsed;
  } catch {
    return null;
  }
}

function articlePath(value: string): string | null {
  const parsed = parseAbpUrl(value);
  return parsed ? parsed.pathname.replace(/\\/+$/, '').toLowerCase() : null;
}

/**
 * Build a small allowlisted set of ABP's official RSS feed URLs. The article URL
 * is used only to choose among fixed routes; user-controlled hosts are never
 * used as fetch destinations.
 */
export function buildAbpRssFeedUrls(articleUrl: string): string[] {
  const article = parseAbpUrl(articleUrl);
  if (!article) return [];

  const host = article.hostname.toLowerCase();
  const routes = host === 'bengali.abplive.com'
    ? ['/home/feed', '/news/india/feed', '/district/feed', '/news/kolkata/feed', '/news/world/feed']
    : host === 'www.abplive.com'
      ? ['/home/feed', '/news/india/feed', '/news/world/feed', '/technology/feed', '/lifestyle/health/feed', '/fact-check/feed']
      : ['/home/feed', '/news/india/feed', '/news/world/feed', '/technology/feed', '/health/feed', '/fact-check/feed', '/business/feed'];

  const path = article.pathname.toLowerCase();
  let priority = '/home/feed';
  if (path.includes('/news/india/')) priority = '/news/india/feed';
  else if (path.includes('/news/world/')) priority = '/news/world/feed';
  else if (path.includes('/technology/')) priority = '/technology/feed';
  else if (path.includes('/business/')) priority = '/business/feed';
  else if (path.includes('/health/')) priority = host === 'www.abplive.com' ? '/lifestyle/health/feed' : '/health/feed';
  else if (path.includes('/fact-check/')) priority = '/fact-check/feed';

  const ordered = [priority, ...routes.filter(route => route !== priority)];
  return Array.from(new Set(ordered)).slice(0, 5).map(route => `https://${host}${route}`);
}

/**
 * Match a target article to an official ABP RSS item. The RSS description is
 * explicitly labelled PARTIAL; headlines alone or thin snippets are rejected.
 */
export function parseAbpRssSummary(
  xml: string,
  requestedUrl: string,
  reason = 'the publisher page could not be fetched'
): ExtractedArticle | null {
  const targetPath = articlePath(requestedUrl);
  if (!targetPath) return null;

  try {
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = $('item');
    for (let i = 0; i < items.length; i++) {
      const item = $(items[i]);
      const itemUrl = item.find('link').first().text().trim() || item.find('guid').first().text().trim();
      if (!itemUrl || articlePath(itemUrl) !== targetPath) continue;

      const title = item.find('title').first().text().trim();
      const pubDate = item.find('pubDate').first().text().trim();
      const rawDescription = item.find('description').first().text().trim() ||
        item.find('content\\:encoded').first().text().trim();
      const summary = cheerio.load(rawDescription).text()
        .replace(/\\s*(?:read more|read full story)\\s*$/i, '')
        .replace(/\\s+/g, ' ')
        .trim();
      const words = summary.split(/\\s+/).filter(Boolean);
      // A headline or tiny summary cannot safely start claim verification.
      if (!title || summary.length < 300 || words.length < 40) return null;

      const parsedDate = pubDate ? new Date(pubDate) : null;
      const publishedAt = parsedDate && Number.isFinite(parsedDate.getTime())
        ? parsedDate.toISOString()
        : undefined;
      const host = new URL(itemUrl).hostname.toLowerCase();
      const sourceName = host === 'news.abplive.com' ? 'ABP Live English' :
        host === 'bengali.abplive.com' ? 'ABP Ananda' : 'ABP News';

      return {
        success: true,
        url: requestedUrl,
        canonicalUrl: itemUrl,
        normalizedUrl: itemUrl,
        title,
        publishedAt,
        sourceName,
        description: summary,
        content: summary,
        wordCount: words.length,
        characterCount: summary.length,
        paragraphCount: 1,
        extractionMethod: 'ABP_OFFICIAL_RSS_SUMMARY',
        extractionStatus: 'PARTIAL',
        warnings: [
          `Publisher article extraction was blocked or incomplete (${reason}).`,
          'Only the matching official ABP RSS summary was available; this is partial content, not the full article body.'
        ],
        isHeadlineOnly: false
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Attempt a bounded fallback only for ABP-owned domains. Public RSS summaries
 * remain partial content; this never bypasses paywalls or invents article text.
 */
export async function fetchAbpRssSummary(
  articleUrl: string,
  reason: string,
  fetchImpl: typeof fetch = fetch
): Promise<ExtractedArticle | null> {
  const feedUrls = buildAbpRssFeedUrls(articleUrl);
  if (feedUrls.length === 0) return null;

  const candidates = await Promise.all(feedUrls.map(async feedUrl => {
    try {
      const response = await fetchImpl(feedUrl, {
        headers: {
          'User-Agent': 'TruthLens-ABP-RSS-Fallback/1.0',
          Accept: 'application/rss+xml, application/xml, text/xml;q=0.9'
        },
        signal: AbortSignal.timeout(3500)
      });
      if (!response.ok) return null;
      const xml = await response.text();
      if (xml.length > 1024 * 1024) return null;
      return parseAbpRssSummary(xml, articleUrl, reason);
    } catch {
      return null;
    }
  }));

  return candidates.find((candidate): candidate is ExtractedArticle => candidate !== null) || null;
}
