/** Research-only evidence presentation helpers for V2.3.
 * These functions only rearrange text already present in the claim/document;
 * they never infer or add facts. The raw mode remains the default. */
import { ExtractedClaim } from '../../src/types';
import { RetrievedCandidate } from './types';

export type EvidencePresentation = 'raw' | 'enriched';

function tokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 2));
}

/** Select a deterministic sentence window around the most claim-related
 * sentence. Ties resolve toward the earlier sentence. */
export function relevantSentenceWindow(text: string, claim: ExtractedClaim, radius = 1): string {
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map(s => s.trim()).filter(Boolean) || [text.trim()];
  const claimTerms = tokens([claim.entities, claim.dates, claim.locations, claim.numbers, claim.keywords].flat().join(' '));
  let best = 0;
  let bestScore = -1;
  sentences.forEach((sentence, index) => {
    const overlap = [...tokens(sentence)].filter(t => claimTerms.has(t)).length;
    if (overlap > bestScore) { bestScore = overlap; best = index; }
  });
  return sentences.slice(Math.max(0, best - radius), Math.min(sentences.length, best + radius + 1)).join(' ');
}

export function buildEvidenceInput(claim: ExtractedClaim, candidate: RetrievedCandidate, mode: EvidencePresentation = 'raw'): string {
  const raw = candidate.contentType === 'FULL_ARTICLE' && candidate.body ? candidate.body : candidate.snippet;
  if (mode === 'raw') return raw || candidate.title || '';
  const window = relevantSentenceWindow(raw || candidate.title || '', claim);
  // Labels are delimiters, not instructions. Every value is copied from the
  // existing claim/document and remains untrusted evidence.
  return [
    '[CLAIM]', claim.originalText || claim.normalizedText,
    '[SOURCE TITLE]', candidate.title,
    '[PUBLISHER]', candidate.publisher,
    '[EVIDENCE]', window
  ].join('\n');
}

export function describeResolvedContext(claim: ExtractedClaim): string {
  const entities = [...claim.entities, ...claim.locations].filter(Boolean);
  const dates = claim.dates.filter(Boolean);
  return `resolved entities=${entities.length ? entities.join(', ') : 'none'}; dates=${dates.length ? dates.join(', ') : 'none'}`;
}
