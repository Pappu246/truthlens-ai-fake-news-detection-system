/**
 * V2 QUERY EXPANSION
 * ==================
 * Reuses the existing claim extraction/normalisation logic
 * (server/verification/claimExtractor.ts) and preserves its diversified
 * search-query variants. Adds deterministic support and contradiction
 * variants without introducing a second claim parser.
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
    entities: [],
    dates: [],
    locations: [],
    numbers: [],
    keywords: []
  };

  return { ...base, searchQueries: generateSearchQueries(base) } as ExtractedClaim;
}

function fallbackCoreQuery(claim: ExtractedClaim): string {
  return claim.normalizedText.replace(/[.?!]+$/, '').trim();
}

function withCue(base: string, cues: string[]): string {
  const cue = cues[0];
  return base.trim() + ' ' + cue;
}

/**
 * Produces every useful base query from the shared extractor plus
 * support-oriented and contradiction-oriented variants of the strongest
 * base query. Deterministic and bounded.
 */
export function expandQueries(claimText: string): ExpandedQuerySet {
  const claim = buildClaim(claimText);
  const baseQueries = Array.from(new Set(
    (claim.searchQueries || [])
      .map(q => q.trim())
      .filter(q => q.length > 5)
  ));

  const original = baseQueries[0] || fallbackCoreQuery(claim);
  const support = withCue(original, SUPPORT_CUES);
  const contradiction = withCue(original, CONTRADICTION_CUES);

  const all = Array.from(new Set([
    ...baseQueries,
    original,
    support,
    contradiction
  ].filter(q => q.length > 0)));

  return {
    claim: claim.normalizedText,
    original,
    support,
    contradiction,
    all
  };
}
