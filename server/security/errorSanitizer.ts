/**
 * Keep internal exception details out of public API responses.
 *
 * Route handlers may use the original error for server-side logging and
 * status classification, but callers receive only an authored safe fallback.
 */
export function safePublicErrorMessage(_error: unknown, fallback: string): string {
  const safeFallback = typeof fallback === 'string' ? fallback.trim() : '';
  return safeFallback || 'The request could not be completed.';
}
