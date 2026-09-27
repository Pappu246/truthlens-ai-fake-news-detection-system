/**
 * TruthLens V2.5 research-only contradiction-aware NLI adjudication.
 *
 * This namespace is deliberately not imported by server/v2 or production
 * routes. It runs two passes through the caller-supplied, already-sealed NLI
 * adapter and exposes both raw outputs plus a transparent research decision.
 */
import { ExtractedClaim } from '../../src/types';
import { NliAdapter } from '../v2/nli/nliAdapter';
import { NliClassification, NliLabel } from '../v2/types';
import { buildClaim } from '../v2/queryExpansion';

export interface V25Signals {
  support_signal: number;
  refutation_signal: number;
  neutral_signal: number;
}

export interface V25Adjudication {
  original_nli: NliClassification;
  false_claim_nli: NliClassification;
  signals: V25Signals;
  label: 'SUPPORTS' | 'REFUTES' | 'NEUTRAL';
  confidence: number;
  adjudication_reason: string;
  decision_trace: string[];
}

// Research gate only. These constants do not alter V2 decision thresholds or
// the V2 pipeline; they make the experiment deterministic and inspectable.
const MATERIAL = 0.60;
const MARGIN = 0.10;
const NON_DOMINATION_MARGIN = 0.05;

function falseClaim(claim: ExtractedClaim): ExtractedClaim {
  return buildClaim(`The claim is false: ${claim.originalText || claim.normalizedText}`);
}

function materiallySupports(value: number, other: number, neutral: number): boolean {
  return value >= MATERIAL && value - other >= MARGIN && value - neutral >= NON_DOMINATION_MARGIN;
}

/** Run Pass A, Pass B, then conservatively adjudicate without mutating V2. */
export function adjudicateContradictionAware(
  adapter: NliAdapter,
  claim: ExtractedClaim,
  passage: string,
  publishedAt?: string | null
): V25Adjudication {
  const original = adapter.classify(claim, passage, publishedAt);
  const falsePass = adapter.classify(falseClaim(claim), passage, publishedAt);
  const signals: V25Signals = {
    support_signal: original.scores.supports,
    refutation_signal: Math.max(original.scores.refutes, falsePass.scores.supports),
    neutral_signal: original.scores.neutral
  };
  const trace = [
    'original_nli',
    'false_claim_nli',
    `support_signal=${signals.support_signal}`,
    `refutation_signal=max(original_refutes=${original.scores.refutes}, false_claim_entailment=${falsePass.scores.supports})=${signals.refutation_signal}`,
    `neutral_signal=${signals.neutral_signal}`
  ];

  let label: V25Adjudication['label'];
  let reason: string;
  if (materiallySupports(signals.refutation_signal, signals.support_signal, signals.neutral_signal)) {
    label = 'REFUTES';
    reason = 'refutation signal is material and is not dominated by support or neutral signal';
  } else if (materiallySupports(signals.support_signal, signals.refutation_signal, signals.neutral_signal)) {
    label = 'SUPPORTS';
    reason = 'support signal is material and is not dominated by refutation or neutral signal';
  } else {
    label = 'NEUTRAL';
    reason = 'neither polarity passed the conservative materiality and non-domination gates';
  }
  trace.push(`adjudication_reason=${reason}`);
  return {
    original_nli: original,
    false_claim_nli: falsePass,
    signals,
    label,
    confidence: label === 'REFUTES' ? signals.refutation_signal : label === 'SUPPORTS' ? signals.support_signal : signals.neutral_signal,
    adjudication_reason: reason,
    decision_trace: trace
  };
}

export function v25LabelToNli(label: V25Adjudication['label']): NliLabel {
  return label;
}

/** Explicit opt-in NliAdapter wrapper for research harnesses only. */
export class ContradictionAwareNliAdapter implements NliAdapter {
  public readonly modelName: string;
  public readonly modelVersion: string;
  public lastAdjudication: V25Adjudication | null = null;

  constructor(private readonly base: NliAdapter) {
    this.modelName = base.modelName;
    this.modelVersion = base.modelVersion;
  }

  public classify(claim: ExtractedClaim, passage: string, publishedAt?: string | null): NliClassification {
    const result = adjudicateContradictionAware(this.base, claim, passage, publishedAt);
    this.lastAdjudication = result;
    // Preserve Pass A probabilities exactly. Only the research label/confidence
    // is exposed through the adapter seam; V2 policy and thresholds remain
    // untouched and this wrapper is never selected by the V2 resolver.
    return {
      ...result.original_nli,
      label: result.label,
      confidence: result.confidence,
      basis: `${result.original_nli.basis}; V2.5 ${result.adjudication_reason}`
    };
  }
}
