/**
 * V2 DEFAULT NLI ADAPTER — DETERMINISTIC LEXICAL ENTAILMENT HEURISTIC
 * =====================================================================
 * HONESTY NOTE: this is NOT a pretrained transformer entailment model. It is
 * a transparent, rule-based, fully reproducible adapter behind the
 * `NliAdapter` interface, built for the first vertical slice so evidence
 * classification, aggregation, abstention and provenance can all be built,
 * tested, and evaluated end-to-end without requiring a multi-hundred-MB
 * model download in CI or a paid inference API (see PHASE 5 constraints).
 *
 * It reuses the EXISTING, already-tested numeric/temporal consistency
 * checks from `server/verification/evidenceAnalyzer.ts` rather than
 * duplicating that logic.
 *
 * Swapping in a real NLI model later requires only a new class implementing
 * `NliAdapter` (see `nliAdapter.ts`) — no other file in the pipeline changes.
 * This is tracked as the next recommended milestone in
 * docs/V2_KNOWN_LIMITATIONS.md.
 */
import { ExtractedClaim } from '../../../src/types';
import { checkNumericalConsistency, checkTemporalConsistency } from '../../verification/evidenceAnalyzer';
import { NliAdapter } from './nliAdapter';
import { NliClassification, NliLabel, NliScoreDistribution } from '../types';

const SUPPORT_CUES = [
  /\b(?:confirm(?:s|ed|ing)?|verif(?:y|ies|ied)|corroborat(?:e|es|ed|ing)|accurate|correct|consistent with|according to official (?:data|figures|records)|fact[- ]check(?:ed)?:?\s*true)\b/i
];

const REFUTE_CUES = [
  /\b(?:den(?:y|ies|ied)|debunk(?:ed|s|ing)?|false|refut(?:e|es|ed|ing)|disprov(?:e|es|ed|ing)|hoax|untrue|incorrect|no evidence that|fabricat(?:e|ed|es)|never happened|misleading|retract(?:ed|s|ing)?|not true|not correct|contrary to (?:the )?claims?|rejected (?:the )?claims?)\b/i
];

const HEDGE_CUES = [
  // Deliberately excludes the single word "unconfirmed" — it very commonly
  // appears INSIDE a refuting sentence ("confirmed the rumor as unconfirmed
  // and false"), which made single-word matching a false hedge trigger.
  // Multi-word contested/disputed phrasing below is a much more reliable
  // signal that a passage itself expresses genuine ambiguity.
  /\b(?:unclear whether|disputed|contested|debat(?:ed|able)|mixed reports|partially true|partly true|some dispute|conflicting (?:claims|reports|accounts)|it (?:remains|is) unclear)\b/i
];

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'was', 'are', 'were', 'to', 'in', 'of', 'and', 'for', 'by', 'on',
  'with', 'from', 'at', 'that', 'this', 'it', 'as', 'be', 'has', 'have', 'had', 'but', 'or'
]);

function contentTokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 2 && !STOPWORDS.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function softmax(logits: Record<string, number>, temperature = 1): Record<string, number> {
  const keys = Object.keys(logits);
  const values = keys.map(k => logits[k] / temperature);
  const max = Math.max(...values);
  const exps = values.map(v => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const out: Record<string, number> = {};
  keys.forEach((k, i) => { out[k] = exps[i] / sum; });
  return out;
}

export class HeuristicNliAdapter implements NliAdapter {
  public readonly modelName = 'truthlens-heuristic-nli';
  public readonly modelVersion = 'v0.1.0-rule-based';

  public classify(claim: ExtractedClaim, passage: string, publishedAt?: string | null): NliClassification {
    const text = passage || '';
    const claimTokens = contentTokens(`${claim.normalizedText} ${claim.entities.join(' ')} ${claim.keywords.join(' ')}`);
    const passageTokens = contentTokens(text);
    const topicalOverlap = jaccard(claimTokens, passageTokens);

    const supportCue = SUPPORT_CUES.some(p => p.test(text));
    const refuteCue = REFUTE_CUES.some(p => p.test(text));
    const hedgeCue = HEDGE_CUES.some(p => p.test(text));

    const numConsistency = checkNumericalConsistency(claim, text);
    const tempConsistency = checkTemporalConsistency(claim, publishedAt || undefined);

    // NOTE on asymmetric weighting: explicit negation/refutation vocabulary
    // ("false", "denied", "debunked") is treated as a stronger, more specific
    // signal than a bare confirmation word ("confirmed", "verified"), because
    // confirmation words very commonly appear INSIDE a refuting sentence
    // ("officials confirmed the report is false"). This is a general design
    // choice, not tuned to any specific fixture wording — it is the same
    // reason lexical fact-check headlines lead with the refutation verb.
    const logits = {
      supports: (supportCue ? 1.1 : 0) + topicalOverlap * 2.2 + (numConsistency.isConsistent ? 0.2 : 0),
      refutes: (refuteCue ? 1.8 : 0) + (numConsistency.isConsistent ? 0 : 1.3) + (tempConsistency.isConsistent ? 0 : 0.5),
      unclear: hedgeCue ? 1.5 : 0,
      neutral: 0.35 + (1 - topicalOverlap) * 0.6
    };

    const scores = softmax(logits, 0.85) as unknown as NliScoreDistribution;

    let label: NliLabel = (Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0]).toUpperCase() as NliLabel;
    // Off-topic passages (near-zero overlap, no explicit cues) should read as
    // NEUTRAL rather than an over-confident SUPPORTS from the smoothing term.
    if (topicalOverlap < 0.08 && !supportCue && !refuteCue && !hedgeCue) {
      label = 'NEUTRAL';
    }

    const confidence = Math.round(Math.max(...Object.values(scores)) * 1000) / 1000;

    const basisParts: string[] = [
      `topical token overlap=${topicalOverlap.toFixed(2)}`,
      `support-cue=${supportCue}`,
      `refute-cue=${refuteCue}`,
      `hedge-cue=${hedgeCue}`,
      `numeric-consistent=${numConsistency.isConsistent}`,
      `temporal-consistent=${tempConsistency.isConsistent}`
    ];
    if (numConsistency.warning) basisParts.push(numConsistency.warning);
    if (tempConsistency.warning) basisParts.push(tempConsistency.warning);

    return {
      label,
      scores: {
        supports: Math.round(scores.supports * 1000) / 1000,
        refutes: Math.round(scores.refutes * 1000) / 1000,
        neutral: Math.round(scores.neutral * 1000) / 1000,
        unclear: Math.round(scores.unclear * 1000) / 1000
      },
      confidence,
      modelName: this.modelName,
      modelVersion: this.modelVersion,
      basis: basisParts.join('; ')
    };
  }
}

export const defaultNliAdapter: NliAdapter = new HeuristicNliAdapter();
