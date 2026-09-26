/**
 * V2 FINAL DECISION POLICY — AGGREGATION + ABSTENTION
 * =====================================================
 * Transparent, rule-based aggregation over classified evidence. Every branch
 * is logged into `ruleTrace` so a verdict can be audited after the fact.
 *
 * Hard contract (PHASE 6 of the task spec):
 *   - The LIAR claim-model prior may nudge CONFIDENCE by a small, capped
 *     amount when it agrees with an evidence-driven verdict, and is recorded
 *     (with an explicit disagreement flag) when it does not — but it NEVER
 *     changes the categorical verdict on its own, and it never turns
 *     INSUFFICIENT_EVIDENCE/CONFLICTED into VERIFIED/REFUTED.
 *   - TRUE/FALSE-shaped verdicts are never forced when evidence is weak or
 *     genuinely conflicting; those cases abstain (INSUFFICIENT_EVIDENCE /
 *     CONFLICTED).
 */
import { ClassifiedEvidence, DecisionRuleTrace, PriorSignal, VerdictDecision, VerdictV2 } from '../types';

export interface DecisionThresholds {
  minIndependentSourcesForVerdict: number;
  strongStrengthThreshold: number;
  weakTotalThreshold: number;
  conflictMinEachSide: number;
  conflictRatioBand: number; // min/max ratio at/above which sides are "comparable"
  priorMaxConfidenceNudge: number;
}

export const DEFAULT_DECISION_THRESHOLDS: DecisionThresholds = {
  minIndependentSourcesForVerdict: 2,
  strongStrengthThreshold: 0.5,
  weakTotalThreshold: 0.3,
  conflictMinEachSide: 0.2,
  conflictRatioBand: 0.6,
  priorMaxConfidenceNudge: 0.05
};

export interface RawPriorInput {
  available: boolean;
  probabilityTrue: number | null;
  label: string | null;
  modelVersion: string | null;
}

function voteWeight(e: ClassifiedEvidence): number {
  const duplicatePenalty = e.isDuplicateCluster ? 0.35 : 1.0;
  return e.nli.confidence * e.rerankScore * duplicatePenalty;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function makePriorSignal(prior: RawPriorInput, weightApplied: number, note: string): PriorSignal {
  return {
    source: 'liar_claim_model',
    available: prior.available,
    probabilityTrue: prior.probabilityTrue,
    label: prior.label,
    modelVersion: prior.modelVersion,
    weightApplied,
    note
  };
}

export function decideVerdict(
  evidence: ClassifiedEvidence[],
  prior: RawPriorInput,
  thresholds: DecisionThresholds = DEFAULT_DECISION_THRESHOLDS
): VerdictDecision {
  const ruleTrace: DecisionRuleTrace[] = [];

  const supporting = evidence.filter(e => e.nli.label === 'SUPPORTS');
  const refuting = evidence.filter(e => e.nli.label === 'REFUTES');

  const supportStrength = supporting.reduce((sum, e) => sum + voteWeight(e), 0);
  const refuteStrength = refuting.reduce((sum, e) => sum + voteWeight(e), 0);
  const independentSupportingSources = new Set(supporting.map(e => e.domainClusterId)).size;
  const independentRefutingSources = new Set(refuting.map(e => e.domainClusterId)).size;
  const total = supportStrength + refuteStrength;

  ruleTrace.push({
    rule: 'evidence_tally',
    detail: `supportStrength=${supportStrength.toFixed(3)} (${independentSupportingSources} independent source(s)), ` +
      `refuteStrength=${refuteStrength.toFixed(3)} (${independentRefutingSources} independent source(s)), ` +
      `${evidence.length - supporting.length - refuting.length} NEUTRAL/UNCLEAR item(s) contributed no vote.`
  });

  let verdict: VerdictV2;
  let abstained: boolean;
  let abstentionReason: string | null = null;
  let confidence: number;

  if (total < thresholds.weakTotalThreshold) {
    verdict = 'INSUFFICIENT_EVIDENCE';
    abstained = true;
    abstentionReason = `Total weighted evidence signal (${total.toFixed(3)}) is below the weak-evidence threshold ` +
      `(${thresholds.weakTotalThreshold}). There is not enough reliable evidence to reach a verdict.`;
    confidence = clamp(total * 0.3, 0, 0.35);
    ruleTrace.push({ rule: 'weak_evidence', detail: abstentionReason });
  } else if (
    supportStrength >= thresholds.conflictMinEachSide &&
    refuteStrength >= thresholds.conflictMinEachSide &&
    Math.min(supportStrength, refuteStrength) / Math.max(supportStrength, refuteStrength) >= thresholds.conflictRatioBand
  ) {
    verdict = 'CONFLICTED';
    abstained = true;
    abstentionReason = 'Independent sources present comparable strength support and refutation. ' +
      'The evidence base is genuinely contested, not merely thin.';
    confidence = clamp(Math.min(0.6, total / 2), 0, 0.6);
    ruleTrace.push({
      rule: 'comparable_support_and_refute',
      detail: `support=${supportStrength.toFixed(3)} vs refute=${refuteStrength.toFixed(3)}, ratio=` +
        `${(Math.min(supportStrength, refuteStrength) / Math.max(supportStrength, refuteStrength)).toFixed(2)}`
    });
  } else if (supportStrength > refuteStrength) {
    if (independentSupportingSources >= thresholds.minIndependentSourcesForVerdict && supportStrength >= thresholds.strongStrengthThreshold) {
      verdict = 'VERIFIED';
      abstained = false;
      const margin = total > 0 ? (supportStrength - refuteStrength) / total : 0;
      confidence = clamp(
        supportStrength * 0.55 + margin * 0.25 + Math.min(1, independentSupportingSources / 3) * 0.2,
        0.5,
        0.97
      );
      ruleTrace.push({
        rule: 'support_dominant_and_corroborated',
        detail: `${independentSupportingSources} independent supporting source(s), strength=${supportStrength.toFixed(3)} >= ` +
          `threshold ${thresholds.strongStrengthThreshold}.`
      });
    } else {
      verdict = 'INSUFFICIENT_EVIDENCE';
      abstained = true;
      abstentionReason = independentSupportingSources < thresholds.minIndependentSourcesForVerdict
        ? `Only ${independentSupportingSources} independent supporting source(s) found; at least ` +
          `${thresholds.minIndependentSourcesForVerdict} are required before a VERIFIED verdict is issued.`
        : `Supporting evidence strength (${supportStrength.toFixed(3)}) did not reach the confidence threshold ` +
          `(${thresholds.strongStrengthThreshold}).`;
      confidence = clamp(supportStrength * 0.4, 0, 0.45);
      ruleTrace.push({ rule: 'support_insufficient_corroboration', detail: abstentionReason });
    }
  } else {
    if (independentRefutingSources >= thresholds.minIndependentSourcesForVerdict && refuteStrength >= thresholds.strongStrengthThreshold) {
      verdict = 'REFUTED';
      abstained = false;
      const margin = total > 0 ? (refuteStrength - supportStrength) / total : 0;
      confidence = clamp(
        refuteStrength * 0.55 + margin * 0.25 + Math.min(1, independentRefutingSources / 3) * 0.2,
        0.5,
        0.97
      );
      ruleTrace.push({
        rule: 'refute_dominant_and_corroborated',
        detail: `${independentRefutingSources} independent refuting source(s), strength=${refuteStrength.toFixed(3)} >= ` +
          `threshold ${thresholds.strongStrengthThreshold}.`
      });
    } else {
      verdict = 'INSUFFICIENT_EVIDENCE';
      abstained = true;
      abstentionReason = independentRefutingSources < thresholds.minIndependentSourcesForVerdict
        ? `Only ${independentRefutingSources} independent refuting source(s) found; at least ` +
          `${thresholds.minIndependentSourcesForVerdict} are required before a REFUTED verdict is issued.`
        : `Refuting evidence strength (${refuteStrength.toFixed(3)}) did not reach the confidence threshold ` +
          `(${thresholds.strongStrengthThreshold}).`;
      confidence = clamp(refuteStrength * 0.4, 0, 0.45);
      ruleTrace.push({ rule: 'refute_insufficient_corroboration', detail: abstentionReason });
    }
  }

  // ---- LIAR prior: recorded, capped nudge only, never decisive -----------
  let priorAgreesWithEvidence: boolean | null = null;
  let weightApplied = 0;
  let priorNote = 'No LIAR claim-model prior was supplied for this decision.';

  if (prior.available && prior.probabilityTrue !== null) {
    const priorLeansTrue = prior.probabilityTrue >= 0.5;
    if (!abstained) {
      priorAgreesWithEvidence = (verdict === 'VERIFIED') === priorLeansTrue;
      if (priorAgreesWithEvidence) {
        weightApplied = thresholds.priorMaxConfidenceNudge;
        confidence = clamp(confidence + weightApplied, 0, 0.99);
        priorNote = 'LIAR claim-model prior agreed with the evidence-driven verdict; confidence nudged up by a capped amount.';
      } else {
        weightApplied = -thresholds.priorMaxConfidenceNudge / 2;
        confidence = clamp(confidence + weightApplied, 0, 0.99);
        priorNote = 'LIAR claim-model prior DISAGREED with the evidence-driven verdict. Per policy, the evidence-driven ' +
          'verdict is retained unchanged in category; only a small confidence penalty was applied, and the ' +
          'disagreement is recorded here rather than hidden.';
        ruleTrace.push({
          rule: 'prior_disagreement_recorded_not_applied',
          detail: `LIAR prior probability_true=${prior.probabilityTrue.toFixed(3)} (label=${prior.label}) disagreed ` +
            `with evidence-driven verdict=${verdict}. Verdict was NOT changed by the prior.`
        });
      }
    } else {
      priorAgreesWithEvidence = null;
      priorNote = 'Evidence-driven decision abstained; the LIAR prior is recorded for transparency but was not used ' +
        'to force a verdict, per policy.';
    }
  }

  const prior_signal = makePriorSignal(prior, weightApplied, priorNote);

  const rationale = abstained
    ? `${verdict}: ${abstentionReason}`
    : `${verdict}: evidence from ${verdict === 'VERIFIED' ? independentSupportingSources : independentRefutingSources} ` +
      `independent source(s) ${verdict === 'VERIFIED' ? 'corroborates' : 'contradicts'} the claim. ` +
      'This is an evidence-grounded verdict, not a statistical style/linguistic classification.';

  return {
    verdict,
    confidence: Math.round(confidence * 1000) / 1000,
    abstained,
    abstentionReason,
    supportStrength: Math.round(supportStrength * 1000) / 1000,
    refuteStrength: Math.round(refuteStrength * 1000) / 1000,
    independentSupportingSources,
    independentRefutingSources,
    prior: prior_signal,
    priorAgreesWithEvidence,
    rationale,
    ruleTrace
  };
}
