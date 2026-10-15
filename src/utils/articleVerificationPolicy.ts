import type { ContentSource } from '../types';

/**
 * Decide whether content is substantive enough for a claim-level evidence
 * check. Partial publisher summaries may be checked, but they must remain
 * clearly labelled as partial; headline-only and extraction-blocked items
 * must never masquerade as a full article.
 */
export function shouldAutoVerifyArticleContent(
  content: string,
  contentSource?: ContentSource,
  isHeadlineOnly = false
): boolean {
  const text = (content || '').trim();
  const words = text.split(/\\s+/).filter(Boolean).length;
  if (isHeadlineOnly || text.length < 300 || words < 40) return false;

  return contentSource === 'FULL_ARTICLE_EXTRACTED' ||
    contentSource === 'TEXT_DIRECT' ||
    contentSource === 'PARTIAL_ARTICLE_EXTRACTED' ||
    contentSource === 'RSS_SUMMARY_ONLY';
}
