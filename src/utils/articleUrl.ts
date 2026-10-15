/**
 * Normalize HTTP(S) article URLs for cache identity only.
 * Keep path and query case/content intact; drop fragments and redundant trailing slashes.
 */
export function normalizeArticleUrlForCache(value: string): string | null {
  if (!value || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    parsed.hash = '';
    while (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/** A cached extraction may only be reused for the URL that produced it. */
export function cachedArticleMatchesTarget(cachedUrl: string, targetUrl: string): boolean {
  const cached = normalizeArticleUrlForCache(cachedUrl);
  const target = normalizeArticleUrlForCache(targetUrl);
  return Boolean(cached && target && cached === target);
}
