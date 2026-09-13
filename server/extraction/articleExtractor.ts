import * as cheerio from 'cheerio';
import { ExtractedArticle } from '../../src/types';

export interface RawExtractionOptions {
  url: string;
  html: string;
  fallbackTitle?: string;
}

/**
 * Extracts structured metadata and cleans main article body text from HTML.
 */
export function extractArticleFromHtml(options: RawExtractionOptions): ExtractedArticle {
  const { url, html, fallbackTitle } = options;
  const warnings: string[] = [];

  const $ = cheerio.load(html);

  // 1. Extract JSON-LD structured data if present
  let jsonLdHeadline = '';
  let jsonLdAuthor = '';
  let jsonLdDate = '';
  let jsonLdPublisher = '';
  let jsonLdDescription = '';
  let jsonLdArticleBody = '';

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const text = $(el).text().trim();
      if (!text) return;
      const data = JSON.parse(text);

      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const type = String(item['@type'] || '').toLowerCase();
        if (
          type.includes('newsarticle') ||
          type.includes('article') ||
          type.includes('blogposting') ||
          type.includes('report') ||
          type.includes('webpage')
        ) {
          if (item.headline && !jsonLdHeadline) jsonLdHeadline = String(item.headline).trim();
          if (item.description && !jsonLdDescription) jsonLdDescription = String(item.description).trim();
          if (item.datePublished && !jsonLdDate) jsonLdDate = String(item.datePublished).trim();

          // Author parsing
          if (!jsonLdAuthor) {
            if (typeof item.author === 'string') {
              jsonLdAuthor = item.author.trim();
            } else if (Array.isArray(item.author) && item.author[0]) {
              jsonLdAuthor = String(item.author[0].name || item.author[0]).trim();
            } else if (item.author && typeof item.author === 'object') {
              jsonLdAuthor = String(item.author.name || '').trim();
            }
          }

          // Publisher parsing
          if (!jsonLdPublisher) {
            if (typeof item.publisher === 'string') {
              jsonLdPublisher = item.publisher.trim();
            } else if (item.publisher && typeof item.publisher === 'object') {
              jsonLdPublisher = String(item.publisher.name || '').trim();
            }
          }

          // Article body in JSON-LD
          if (item.articleBody && typeof item.articleBody === 'string' && !jsonLdArticleBody) {
            jsonLdArticleBody = item.articleBody.trim();
          }
        }
      }
    } catch {
      // Ignore JSON-LD parse errors
    }
  });

  // 2. Canonical URL
  let canonicalUrl = $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content') || '';
  if (canonicalUrl) {
    try {
      canonicalUrl = new URL(canonicalUrl, url).toString();
    } catch {
      // Keep as-is if resolution fails
    }
  }

  // 3. Title resolution hierarchy
  const ogTitle = $('meta[property="og:title"]').attr('content');
  const twitterTitle = $('meta[name="twitter:title"]').attr('content');
  const h1Title = $('h1').first().text().trim();
  const docTitle = $('title').text().trim();

  let title = jsonLdHeadline || ogTitle || twitterTitle || h1Title || docTitle || fallbackTitle || '';
  // Clean title: remove trailing pipe or dash site names (e.g. "News Title | BBC News" -> "News Title")
  if (title.includes(' | ')) {
    title = title.split(' | ')[0].trim();
  } else if (title.includes(' - ')) {
    const parts = title.split(' - ');
    if (parts.length === 2 && parts[1].length < 30) {
      title = parts[0].trim();
    }
  }

  // 4. Author resolution
  const metaAuthor =
    $('meta[name="author"]').attr('content') ||
    $('meta[property="article:author"]').attr('content') ||
    $('meta[name="twitter:creator"]').attr('content') ||
    $('[rel="author"]').first().text().trim() ||
    $('.author-name, .byline, [itemprop="author"]').first().text().trim();
  const author = jsonLdAuthor || metaAuthor || undefined;

  // 5. Published Date resolution
  const metaDate =
    $('meta[property="article:published_time"]').attr('content') ||
    $('meta[name="pubdate"]').attr('content') ||
    $('meta[name="publish-date"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    $('time').first().text().trim();
  const publishedAt = jsonLdDate || metaDate || undefined;

  // 6. Source / Publisher resolution
  let sourceName =
    jsonLdPublisher ||
    $('meta[property="og:site_name"]').attr('content') ||
    $('meta[name="application-name"]').attr('content') ||
    $('meta[name="publisher"]').attr('content') ||
    '';

  if (!sourceName) {
    try {
      const parsedUrl = new URL(url);
      sourceName = parsedUrl.hostname.replace(/^www\./i, '');
    } catch {
      sourceName = 'Web Source';
    }
  }

  // 7. Description resolution
  const description =
    jsonLdDescription ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content') ||
    '';

  // 8. Body Text Extraction: Strip boilerplate, navigation, ads, comments
  const elementsToRemove = [
    'script',
    'style',
    'noscript',
    'iframe',
    'svg',
    'canvas',
    'nav',
    'header',
    'footer',
    'aside',
    'form',
    'button',
    'input',
    'select',
    'textarea',
    'dialog',
    '.ad',
    '.ads',
    '.advertisement',
    '.social-share',
    '.social-links',
    '.cookie-banner',
    '.cookie-notice',
    '.newsletter-signup',
    '.subscribe-prompt',
    '.related-articles',
    '.sidebar',
    '.comments',
    '#comments',
    '[role="navigation"]',
    '[role="complementary"]',
    '[aria-hidden="true"]'
  ];

  elementsToRemove.forEach((selector) => {
    $(selector).remove();
  });

  // Candidate semantic content containers
  const containerCandidates = [
    'article',
    '[role="main"]',
    'main',
    '.article-body',
    '.article__body',
    '.story-body',
    '.story-content',
    '.post-content',
    '.entry-content',
    '#article-body',
    '#story-text'
  ];

  let $targetContainer: ReturnType<typeof $> | null = null;
  for (const sel of containerCandidates) {
    const el = $(sel);
    if (el.length > 0 && el.text().trim().length > 150) {
      $targetContainer = el.first();
      break;
    }
  }

  // Fallback to body if no semantic article container found
  if (!$targetContainer) {
    $targetContainer = $('body');
  }

  // Extract paragraphs
  const paragraphs: string[] = [];
  $targetContainer.find('p').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    // Filter out common non-content boilerplate paragraphs
    if (
      text.length > 25 &&
      !/cookie|subscribe|all rights reserved|terms of service|privacy policy|sign up for|advertisement/i.test(
        text
      )
    ) {
      paragraphs.push(text);
    }
  });

  let extractedBody = paragraphs.join('\n\n');

  // Fallback to JSON-LD articleBody if HTML paragraph extraction yielded very little
  if (extractedBody.split(/\s+/).length < 40 && jsonLdArticleBody.split(/\s+/).length > 40) {
    extractedBody = jsonLdArticleBody;
  }

  // If still empty, fall back to cleaned container text
  if (!extractedBody.trim() && $targetContainer) {
    const rawText = $targetContainer.text().replace(/\s+/g, ' ').trim();
    if (rawText.length > 40) {
      extractedBody = rawText;
    }
  }

  // Combine title + body for full article context
  let fullArticleText = '';
  if (title && extractedBody) {
    // If title isn't already the first line of the body
    if (!extractedBody.startsWith(title)) {
      fullArticleText = `${title}\n\n${extractedBody}`;
    } else {
      fullArticleText = extractedBody;
    }
  } else if (extractedBody) {
    fullArticleText = extractedBody;
  } else if (title) {
    fullArticleText = title;
  }

  // Calculate metrics
  const cleanTokens = fullArticleText
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  const wordCount = cleanTokens.length;
  const characterCount = fullArticleText.length;
  const paragraphCount = paragraphs.length > 0 ? paragraphs.length : fullArticleText ? 1 : 0;

  // Quality check & classifications
  let extractionStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' = 'SUCCESS';
  let isHeadlineOnly = false;

  if (wordCount === 0 || characterCount < 15) {
    extractionStatus = 'FAILED';
    warnings.push('No readable article content could be extracted.');
  } else if (wordCount < 30 || (!extractedBody && title)) {
    extractionStatus = 'PARTIAL';
    isHeadlineOnly = true;
    warnings.push(
      'HEADLINE-ONLY ANALYSIS: Only a headline or brief statement could be extracted. Statistical accuracy is limited.'
    );
  }

  // Short text length warning from ISOT external validation findings
  if (wordCount > 0 && wordCount < 80) {
    warnings.push(
      'Short text may reduce model reliability. This classifier was trained primarily on longer news articles.'
    );
  }

  return {
    success: extractionStatus !== 'FAILED',
    url,
    canonicalUrl: canonicalUrl || undefined,
    normalizedUrl: url,
    title,
    author,
    publishedAt,
    sourceName,
    description: description || undefined,
    content: fullArticleText,
    wordCount,
    characterCount,
    paragraphCount,
    extractionMethod: jsonLdHeadline ? 'JSON-LD + Semantic DOM' : 'Heuristic Semantic DOM',
    extractionStatus,
    warnings,
    isHeadlineOnly
  };
}
