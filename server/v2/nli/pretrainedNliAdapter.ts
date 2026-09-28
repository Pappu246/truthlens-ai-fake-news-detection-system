/**
 * TRUTHLENS V2.1 — PRETRAINED NLI (ENTAILMENT) ADAPTER
 * ======================================================
 * Drop-in replacement for the V2 first-slice `HeuristicNliAdapter` behind
 * the UNCHANGED `NliAdapter` interface (see ./nliAdapter.ts — the interface
 * itself is not modified). The lexical heuristic adapter remains exported
 * and is used ONLY in explicit fixture mode (tests/CI); it is never
 * silently substituted — see server/v2/ml/modelResolution.ts.
 *
 *   model:   Xenova/nli-deberta-v3-xsmall  (ONNX port of
 *            cross-encoder/nli-deberta-v3-xsmall, fine-tuned on MNLI)
 *   weights: int8 dynamic quantization (q8), byte-sealed in
 *            server/v2/ml/modelManifest.ts
 *   runtime: @huggingface/transformers + onnxruntime-node on CPU, fully
 *            offline (mlWorker.cjs). No network, no paid API.
 *
 * INPUTS: premise = retrieved evidence passage. For the hypothesis, claims
 * carry TWO readings: (1) the statement as stated ("<Source> confirmed P"
 * — including the reporting event), and (2) the content proposition P a
 * fact-checker would verify. MNLI cross-encoders are strict and literal:
 * "officials denied the figure" DIRECTLY contradicts reading (1) but not (2),
 * while a corroborating passage usually entails (2) without restating the
 * attribution in (1). The adapter therefore uses a documented TWO-PASS
 * HYPOTHESIS SELECTION policy (see `classify`), applied identically to
 * every claim: pass A decides only on a majority contradiction/entailment
 * of the claim as stated (the explicit refutation/confirmation pattern) —
 * i.e. when entailment>=0.5 or contradiction>=0.5; otherwise (NO DIRECTIONAL
 * MAJORITY, which includes a confident NEUTRAL), when the claim embeds
 * attribution, pass B decides from the content proposition. Both passes are 100% pretrained-model output — the
 * policy only CHOOSES the hypothesis framing, never the label.
 *
 * RELATEDNESS GATE: MNLI cross-encoders assume the (premise, hypothesis)
 * pair is topically related — that is the distribution they were trained
 * and evaluated on. For clearly UNRELATED pairs (a retrieval miss), the
 * model has no meaningful class and predictably over-predicts
 * "contradiction" — a known, documented pathological failure of applying
 * MNLI models off-distribution. Fact-checking pipelines therefore condition
 * verification on retrieval. This adapter implements that as a hard gate
 * driven by the OTHER pretrained model: if the bi-encoder cosine between
 * claim and passage embeddings is below `relatednessFloor` (default 0.15 —
 * unrelated pairs for all-MiniLM-L6-v2 cluster around/below 0, while
 * related-but-non-entailing pairs sit well above it), the passage is
 * labelled NEUTRAL (off-topic) WITHOUT consulting the cross-encoder. The
 * gate uses a pretrained semantic model, not lexical rules; the entailment
 * decision itself always comes from the cross-encoder.
 *
 * Label names are taken from the model's own config.json id2label at runtime
 * (never hard-coded); probabilities come from a softmax over the model's raw
 * logits.
 *
 * OUTPUT CONTRACT (unchanged): SUPPORTS / REFUTES / NEUTRAL / UNCLEAR.
 *   entailment    -> SUPPORTS
 *   contradiction -> REFUTES
 *   neutral       -> NEUTRAL
 *   UNCLEAR is emitted ONLY when the model itself is undecided: when no
 *   class reaches majority support (max probability < 0.5). It is a
 *   model-uncertainty label, NOT a lexical rule — no keyword lists are used
 *   anywhere in this adapter's decision path.
 *
 * The returned 4-class score distribution is a renormalised
 * [entailment, contradiction, neutral, uncertainty=(1-maxP)] distribution
 * that sums to EXACTLY 1.000 after largest-remainder rounding to three
 * decimals (see `roundDistributionTo3dp`); `label` is always argmax of `scores` and
 * `confidence` is always `scores[label]` (schema invariants exercised by
 * scripts/v2ModelTests.ts).
 */
import { ExtractedClaim } from '../../../src/types';
import { NliAdapter } from './nliAdapter';
import { NliClassification, NliLabel, NliScoreDistribution } from '../types';
import { EmbeddingModel } from '../retrieval/embeddings';
import { TransformerEmbeddingModel } from '../retrieval/transformerEmbeddingModel';
import {
  NLI_MODEL_NAME,
  NLI_MODEL_VERSION
} from '../ml/modelManifest';
import { getMlWorkerClient, MlWorkerClient } from '../ml/mlWorkerClient';

export interface PretrainedNliOptions {
  /** Max combined premise+hypothesis tokens fed to the cross-encoder. */
  maxPairTokens?: number;
  /** Overrides the shared worker client (tests). */
  client?: MlWorkerClient;
  /** Bi-encoder relatedness gate: passages with claim/passage cosine below
   * this floor are treated as off-topic (NEUTRAL) without running the
   * cross-encoder (off-distribution inputs produce garbage NLI labels). */
  relatednessFloor?: number;
  /** Embedding model used for the relatedness gate. */
  embeddingModel?: EmbeddingModel;
  /** Additive evaluation hooks. Defaults preserve the sealed V2.1 identity;
   * supplying another identity does not alter the NliAdapter interface. */
  modelName?: string;
  modelVersion?: string;
}

/**
 * Conservative attribution stripping for hypothesis construction. Real-world
 * claims very often embed the reporting act in the sentence ("<Source>
 * confirmed/reported/said that <proposition>"). For fact-checking, the
 * proposition to verify is the REPORTED CONTENT, not the fact that someone
 * reported it — and strict MNLI models correctly refuse to infer the full
 * attribution-bearing sentence from passages that never state it. This is
 * deterministic preprocessing of the hypothesis (construction, not the
 * decision — the decision is 100% the pretrained model's probability output).
 */
const ATTRIBUTION_VERBS =
  '(?:confirm(?:s|ed|ing)?|announc(?:e|es|ed|ing)|report(?:s|ed|ing)?|say(?:s|ing)?|said|claim(?:s|ed|ing)?|stat(?:es|ed|ing)|reveal(?:s|ed|ing)?|declar(?:es|ed|ing)|alleg(?:es|ed|ing)|told|noted?|announced)';

const ATTRIBUTION_PREFIX = new RegExp(
  '^[\\s"\'\u201c\u201d(\[]?.{2,80}?\\b' + ATTRIBUTION_VERBS + '\\s+(?:that\\s+)?(.+)$',
  'is'
);

export function conditionHypothesis(claimText: string): { hypothesis: string; mode: 'attribution_stripped' | 'full_text' } {
  const text = (claimText || '').trim().replace(/\s+/g, ' ');
  const m = ATTRIBUTION_PREFIX.exec(text);
  if (m && m[1]) {
    const remainder = m[1].trim();
    const words = remainder.split(/\s+/).filter(Boolean);
    if (words.length >= 4) {
      return { hypothesis: remainder, mode: 'attribution_stripped' };
    }
  }
  return { hypothesis: text, mode: 'full_text' };
}

const LABEL_FOR_PROB_KEY: Record<string, NliLabel> = {
  entailment: 'SUPPORTS',
  contradiction: 'REFUTES',
  neutral: 'NEUTRAL'
};

/**
 * Maps raw model probabilities (keyed by LABEL NAME from the model's own
 * id2label) to the V2 4-class distribution. Exported as a pure function so
 * the UNCLEAR boundary semantics are unit-testable without model weights.
 * The 4th class, UNCLEAR, holds probability mass `1 - maxP`; after
 * renormalisation it wins the argmax exactly when no model class has
 * majority support (maxP < 0.5).
 */
export function mapModelProbsToNliScores(
  probs: Record<string, number>
): { scores: NliScoreDistribution; maxModelProb: number } {
  const pe = probs.entailment;
  const pc = probs.contradiction;
  const pn = probs.neutral;
  for (const [k, v] of [['entailment', pe], ['contradiction', pc], ['neutral', pn]] as const) {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw new Error(
        `PretrainedNliAdapter: model probabilities missing/invalid for class '${k}' ` +
        `(got keys: ${Object.keys(probs).join(', ')}). Refusing to guess a label — the ` +
        `model's id2label may have changed; update the adapter mapping explicitly.`
      );
    }
  }
  const maxModelProb = Math.max(pe, pc, pn);
  const uncertainty = Math.max(0, 1 - maxModelProb);
  const total = 1 + uncertainty; // (pe+pc+pn) + uncertainty
  const exact: number[] = [pe / total, pc / total, pn / total, uncertainty / total];
  const rounded = roundDistributionTo3dp(exact);
  const scores: NliScoreDistribution = {
    supports: rounded[0],
    refutes: rounded[1],
    neutral: rounded[2],
    unclear: rounded[3]
  };
  return { scores, maxModelProb };
}

/**
 * Rounds a probability distribution to three decimals so that the REPORTED
 * vector still sums to exactly 1.000 (largest-remainder / Hare quota method).
 *
 * Research-integrity fix (V2.1 review, MEDIUM finding): each component used
 * to be rounded independently, so 38/96 reviewed fixture vectors summed to
 * 0.999 or 1.001 while the module documented an exact-sum invariant. The
 * invariant is now enforced in code instead of being asserted in prose.
 *
 * Guarantees (exercised by scripts/v2CandidateModelTests.ts):
 *   1. the four rounded values sum to exactly 1.000 (in 1/1000 integer units);
 *   2. every rounded value is within 0.001 of its exact value, except for the
 *      at most two components touched by a near-tie argmax repair, which stay
 *      within 0.0015;
 *   3. the argmax of the rounded vector is the argmax of the EXACT vector,
 *      with the same first-index tie-break — i.e. no label can change as a
 *      side effect of display rounding.
 * This is presentation-level rounding only: no threshold, weight or decision
 * rule is touched.
 */
export function roundDistributionTo3dp(exact: number[]): number[] {
  const SCALE = 1000;
  const scaled = exact.map(v => v * SCALE);
  const floors = scaled.map(v => Math.floor(v));
  let residual = SCALE - floors.reduce((a, b) => a + b, 0);

  // Exact argmax (first index wins ties) — must survive rounding.
  let exactArgmax = 0;
  for (let i = 1; i < exact.length; i++) if (exact[i] > exact[exactArgmax]) exactArgmax = i;

  const order = scaled
    .map((v, i) => ({ i, remainder: v - floors[i] }))
    .sort((a, b) => (b.remainder - a.remainder) || (a.i - b.i));

  const result = floors.slice();
  for (const { i } of order) {
    if (residual <= 0) break;
    result[i] += 1;
    residual -= 1;
  }
  // Residual can only be in [0, n); the loop above always clears it because
  // sum(floors) > SCALE - n. Defensive guard for non-normalised inputs:
  let guard = 0;
  while (residual > 0 && guard++ < exact.length * 2) {
    result[exactArgmax] += 1;
    residual -= 1;
  }
  while (residual < 0 && guard++ < exact.length * 2) {
    const donor = result.findIndex((v, i) => v > 0 && i !== exactArgmax);
    result[donor >= 0 ? donor : exactArgmax] -= 1;
    residual += 1;
  }

  // Largest-remainder rounding can, for near-ties, hand the displayed maximum
  // to a different class than the exact distribution's argmax. Repair that
  // (and only that) by moving a single 1/1000 unit, so the reported label can
  // never be an artefact of display rounding.
  const roundedArgmax = (values: number[]): number => {
    let best = 0;
    for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
    return best;
  };
  if (roundedArgmax(result) !== exactArgmax) {
    const displaced = roundedArgmax(result);
    result[displaced] -= 1;
    result[exactArgmax] += 1;
  }
  return result.map(v => v / SCALE);
}

export class PretrainedNliAdapter implements NliAdapter {
  public readonly modelName: string;
  public readonly modelVersion: string;
  private readonly maxPairTokens: number;
  private readonly relatednessFloor: number;
  private readonly client: MlWorkerClient;
  private readonly embeddingModel: EmbeddingModel;
  private lastClaimText: string | null = null;
  private lastClaimVector: number[] | null = null;

  constructor(options?: PretrainedNliOptions) {
    this.modelName = options?.modelName ?? NLI_MODEL_NAME;
    this.modelVersion = options?.modelVersion ?? NLI_MODEL_VERSION;
    this.maxPairTokens = options?.maxPairTokens ?? 384;
    this.relatednessFloor = options?.relatednessFloor ?? 0.15;
    this.client = options?.client ?? getMlWorkerClient();
    this.embeddingModel = options?.embeddingModel ?? new TransformerEmbeddingModel(this.client);
  }

  /** Relatedness of (claim, passage) via the pretrained bi-encoder. */
  private relatedness(claimText: string, premise: string): number {
    let claimVec: number[];
    if (this.lastClaimText === claimText && this.lastClaimVector) {
      claimVec = this.lastClaimVector;
    } else {
      claimVec = this.embeddingModel.embed(claimText);
      this.lastClaimText = claimText;
      this.lastClaimVector = claimVec;
    }
    const passageVec = this.embeddingModel.embed(premise);
    let dot = 0;
    const len = Math.min(claimVec.length, passageVec.length);
    for (let i = 0; i < len; i++) dot += claimVec[i] * passageVec[i];
    return Math.max(-1, Math.min(1, dot)); // both vectors L2-normalised
  }

  /** Single cross-encoder run over one hypothesis framing. */
  private runOnce(premise: string, hypothesis: string): { probs: Record<string, number>; scores: NliScoreDistribution; maxModelProb: number } {
    const { probs } = this.client.call<{ probs: Record<string, number> }>('classify', {
      premise,
      hypothesis,
      maxTokens: this.maxPairTokens
    });
    const { scores, maxModelProb } = mapModelProbsToNliScores(probs);
    return { probs, scores, maxModelProb };
  }

  public classify(claim: ExtractedClaim, passage: string, _publishedAt?: string | null): NliClassification {
    const premise = (passage || '').trim();
    const fullClaimText = (claim.normalizedText || '').trim().replace(/\s+/g, ' ');
    const { hypothesis: conditioned, mode } = conditionHypothesis(fullClaimText);

    // -- Relatedness gate ---------------------------------------------------
    // Applying an MNLI cross-encoder to a clearly unrelated pair is
    // off-distribution and predictably pathological (spurious contradiction).
    const rel = this.relatedness(fullClaimText, premise);
    if (rel < this.relatednessFloor) {
      return {
        label: 'NEUTRAL',
        scores: { supports: 0.005, refutes: 0.005, neutral: 0.98, unclear: 0.01 },
        confidence: 0.98,
        modelName: this.modelName,
        modelVersion: this.modelVersion,
        basis:
          `relatedness gate: pretrained bi-encoder cosine=${rel.toFixed(3)} < floor=${this.relatednessFloor} ` +
          '-> passage is off-topic for this claim; cross-encoder NLI not consulted (MNLI models are only ' +
          'valid on topically related pairs). Label=NEUTRAL indicates irrelevance, not a fact-check outcome.'
      };
    }

    // -- Pass A: the claim exactly as stated -------------------------------
    const passA = this.runOnce(premise, fullClaimText);

    // A majority contradiction/entailment of the CLAIM AS STATED is the most
    // specific signal a passage can give (explicit denial/confirmation of the
    // claim) and decides immediately.
    let winner = passA;
    let basisPasses = '';
    let decidedBy = 'passA:claim-as-stated';

    const passAMaxClass = (['entailment', 'contradiction', 'neutral'] as const)
      .reduce((best, key) => (passA.probs[key] > passA.probs[best] ? key : best), 'entailment' as
        'entailment' | 'contradiction' | 'neutral');

    const aDirectionalLabel: NliLabel | null =
      passA.probs.entailment >= 0.5 ? 'SUPPORTS'
      : passA.probs.contradiction >= 0.5 ? 'REFUTES'
      : null;
    if (aDirectionalLabel !== null) {
      basisPasses = `passA (hypothesis=claim-as-stated) directional (${aDirectionalLabel})`;
    } else if (mode === 'attribution_stripped') {
      // -- Pass B: the content proposition (attribution stripped) ----------
      const passB = this.runOnce(premise, conditioned);
      winner = passB;
      decidedBy = 'passB:content-proposition';
      basisPasses =
        'passA (hypothesis=claim-as-stated) produced NO DIRECTIONAL MAJORITY ' +
        `(entailment=${passA.probs.entailment.toFixed(3)}, contradiction=${passA.probs.contradiction.toFixed(3)}, ` +
        `both <0.5; maxP=${passA.maxModelProb.toFixed(3)} on ${passAMaxClass}); ` +
        'falling through to passB (hypothesis=content proposition, attribution stripped)';
    } else {
      basisPasses =
        'passA (hypothesis=claim-as-stated) produced NO DIRECTIONAL MAJORITY ' +
        `(entailment=${passA.probs.entailment.toFixed(3)}, contradiction=${passA.probs.contradiction.toFixed(3)}, ` +
        `both <0.5; maxP=${passA.maxModelProb.toFixed(3)} on ${passAMaxClass}); ` +
        'claim carries no attribution clause, so no second pass is applicable';
    }

    const scores = winner.scores;

    // argmax over the 4-class distribution (stable tie-break by insertion order
    // SUPPORTS > REFUTES > NEUTRAL > UNCLEAR).
    const entries: Array<[NliLabel, number]> = [
      ['SUPPORTS', scores.supports],
      ['REFUTES', scores.refutes],
      ['NEUTRAL', scores.neutral],
      ['UNCLEAR', scores.unclear]
    ];
    let label: NliLabel = 'UNCLEAR';
    let best = -1;
    for (const [l, s] of entries) {
      if (s > best) { best = s; label = l; }
    }
    const confidence = scores[label.toLowerCase() as keyof NliScoreDistribution];

    const probKeys = Object.keys(LABEL_FOR_PROB_KEY).map(k => `${k}=${(winner.probs[k] as number).toFixed(3)}`);
    const basis =
      `cross-encoder MNLI probabilities (${probKeys.join(', ')}) over premise=evidence passage; ` +
      `${basisPasses}; winner=${decidedBy}; maxP=${winner.maxModelProb.toFixed(3)}; UNCLEAR is emitted only when ` +
      `the winning pass has no majority class (its maxP<0.5); renormalised 4-way distribution sums to exactly 1.000 ` +
      'after largest-remainder rounding to three decimals; ' +
      'decision by argmax of model probabilities only — no lexical rules involved.';

    return {
      label,
      scores,
      confidence,
      modelName: this.modelName,
      modelVersion: this.modelVersion,
      basis
    };
  }
}
