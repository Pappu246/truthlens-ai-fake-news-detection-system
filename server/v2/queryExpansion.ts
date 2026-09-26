/**
 * V2 QUERY EXPANSION
 * ==================
 * Reuses the existing claim extraction/normalisation logic
 * (`server/verification/claimExtractor.ts`) — no second claim parser is
 * introduced. On top of the existing `generateSearchQueries()` output this
 * module deterministically derives a support-oriented and a
 * contradiction-oriented query so retrieval can look for evidence on BOTH
 * sides of the claim, not only whatever confirms it.
 *
 * The expansion is template-based and fully deterministic (no LLM call),
 * which keeps it reproducible for CI and avoids depending on a paid API.
 */
import {
  extractClaimsHeuristic,
  generateSearchQueries,
  classifyClaimType,
  normalizeClaimText
} from '../verification/claimExtractor';
import { ExpandedQuerySet, ExtractedClaim } from './types';

const SUPPORT_CUES = ['confirmed', 'official data', 'fact check true'];
const CONTRADICTION_CUES = ['debunked', 'false claim', 'fact check false', 'denies'];

/** Builds an ExtractedClaim the same way the production evidence engine does. */
export function buildClaim(text: string): ExtractedClaim {
  const parsed = extractClaimsHeuristic('', text);
  if (parsed.length > 0) {
    const c = parsed[0];
    return {
      ...c,
      claimId: 'claim-1',
      importance: 'HIGH',
      searchQueries: c.searchQueries?.length ? c.searchQueries : generateSearchQueries(c)
    } as ExtractedClaim;
  }
  const base = {
    claimId: 'claim-1',
    originalText: text.trim(),
    normalizedText: normalizeClaimText(text) || text.trim(),
    claimType: classifyClaimType(text),
    importance: 'HIGH' as const,
    entities: [], dates: [], locations: [], numbers: [], keywords: []
  };
  return { ...base, searchQueries: generateSearchQueries(base) } as ExtractedClaim;
}

function coreQuery(claim: ExtractedClaim): string {
  const generated = claim.searchQueries?.[0];
  if (generated && generated.trim().length > 0) return generated.trim();
  return claim.normalizedText.replace(/[.?!]+$/, '').trim();
}

function withCue(base: string, cues: string[]): string {
  // Pick the first cue deterministically (no randomness) so results are
  // reproducible run over run.
  const cue = cues[0];
  const trimmed = base.trim();
  return `${trimmed} ${cue}`.trim();
}

/**
 * Generates the original / support-oriented / contradiction-oriented query
 * triple for a claim. Deterministic: same claim text always yields the same
 * three queries.
 */
export function expandQueries(claimText: string): ExpandedQuerySet {
  const claim = buildClaim(claimText);
  const original = coreQuery(claim);
  const support = withCue(original, SUPPORT_CUES);
  const contradiction = withCue(original, CONTRADICTION_CUES);

  const all = Array.from(new Set([original, support, contradiction].filter(q => q.length > 0)));

  return { claim: claim.normalizedText, original, support, contradiction, all };
}
