/**
 * V2 OPTIONAL FULL-TEXT ENRICHMENT
 * ================================
 * Retrieval normally only has a headline/snippet for each candidate (see
 * `RawDocument.contentType`). This OPTIONAL step tries to fetch the actual
 * article body so classification can work over real article text instead of
 * a headline — but it must never become an SSRF vector and must never let a
 * hostile page's content escape "untrusted data" status.
 *
 * It is built ENTIRELY out of EXISTING, already-hardened primitives:
 *   - `validateUrlSecurity` / `safeFetchHtml` (server/security/urlValidator.ts)
 *     — blocks localhost/private/link-local/cloud-metadata IPs, disallowed
 *       protocols, oversized bodies, excessive redirects.
 *   - `extractArticleFromHtml` (server/extraction/articleExtractor.ts)
 *     — the existing readability-style extractor.
 *   - `sanitiseUntrustedEvidence` (server/verification/evidenceEngine.ts)
 *     — neutralises prompt-injection-shaped spans in fetched text.
 *
 * No second SSRF guard or HTML parser is introduced. Disabled by default —
 * the first vertical slice runs on snippets, which is honest about what it
 * has (see PHASE 3 rule: never treat a headline as a full article). This
 * module exists so a future milestone can flip it on for higher-fidelity
 * NLI classification without adding a new fetch path.
 */
import { validateUrlSecurity, safeFetchHtml } from '../../security/urlValidator';
import { extractArticleFromHtml } from '../../extraction/articleExtractor';
import { sanitiseUntrustedEvidence } from '../../verification/evidenceEngine';
import { RetrievedCandidate } from '../types';

export interface EnrichmentDiagnostic {
  url: string;
  attempted: boolean;
  ok: boolean;
  reason?: string;
}

export interface EnrichmentResult {
  candidates: RetrievedCandidate[];
  diagnostics: EnrichmentDiagnostic[];
}

export async function enrichWithFullText(
  candidates: RetrievedCandidate[],
  options?: { maxDocuments?: number; timeoutMs?: number }
): Promise<EnrichmentResult> {
  const maxDocuments = options?.maxDocuments ?? 5;
  const diagnostics: EnrichmentDiagnostic[] = [];
  const enriched: RetrievedCandidate[] = [];

  for (const candidate of candidates) {
    if (enriched.filter(c => c.contentType === 'FULL_ARTICLE').length >= maxDocuments) {
      enriched.push(candidate);
      continue;
    }

    const validation = await validateUrlSecurity(candidate.url);
    if (!validation.isValid) {
      diagnostics.push({ url: candidate.url, attempted: true, ok: false, reason: validation.error || 'blocked by SSRF/URL validation' });
      enriched.push(candidate); // keep the snippet-only candidate — never drop evidence, never crash
      continue;
    }

    try {
      const fetched = await safeFetchHtml(validation.normalizedUrl || candidate.url, { timeoutMs: options?.timeoutMs ?? 6000 });
      const extracted = extractArticleFromHtml({ html: fetched.html, url: fetched.finalUrl });
      if (extracted.success && extracted.content && extracted.content.length > candidate.snippet.length) {
        const sanitised = sanitiseUntrustedEvidence(extracted.content, 4000);
        diagnostics.push({ url: candidate.url, attempted: true, ok: true });
        enriched.push({ ...candidate, body: sanitised.text, contentType: 'FULL_ARTICLE' });
      } else {
        diagnostics.push({ url: candidate.url, attempted: true, ok: false, reason: 'extraction did not yield usable body text' });
        enriched.push(candidate);
      }
    } catch (err: any) {
      diagnostics.push({ url: candidate.url, attempted: true, ok: false, reason: err?.message || 'fetch failed' });
      enriched.push(candidate);
    }
  }

  return { candidates: enriched, diagnostics };
}
