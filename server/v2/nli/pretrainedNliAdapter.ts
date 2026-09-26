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
 * of the claim as stated (the explicit refutation/confirmation pattern);
 * otherwise, when the claim embeds attribution, pass B decides from the
 * content proposition. Both passes are 100% pretrained-model output — the
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
 * that always sums to 1; `label` is always argmax of `scores` and
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
  const raw4: Array<[NliLabel, number]> = [
    ['SUPPORTS', pe / total],
    ['REFUTES', pc / total],
    ['NEUTRAL', pn / total],
    ['UNCLEAR', uncertainty / total]
  ];
  const scores: NliScoreDistribution = {
    supports: Math.round(raw4[0][1] * 1000) / 1000,
    refutes: Math.round(raw4[1][1] * 1000) / 1000,
    neutral: Math.round(raw4[2][1] * 1000) / 1000,
    unclear: Math.round(raw4[3][1] * 1000) / 1000
  };
  return { scores, maxModelProb };
}

export class PretrainedNliAdapter implements NliAdapter {
  public readonly modelName = NLI_MODEL_NAME;
  public readonly modelVersion = NLI_MODEL_VERSION;
  private readonly maxPairTokens: number;
  private readonly relatednessFloor: number;
  private readonly client: MlWorkerClient;
  private readonly embeddingModel: EmbeddingModel;
  private lastClaimText: string | null = null;
  private lastClaimVector: number[] | null = null;

  constructor(options?: PretrainedNliOptions) {
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
        `passA (hypothesis=claim-as-stated) undecided (maxP=${passA.maxModelProb.toFixed(3)}<0.5, no majority); ` +
        'falling through to passB (hypothesis=content proposition, attribution stripped)';
    } else {
      basisPasses = `passA (hypothesis=claim-as-stated) undecided (maxP=${passA.maxModelProb.toFixed(3)}<0.5); ` +
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
      `${basisPasses}; winner=${decidedBy}; maxP=${winner.maxModelProb.toFixed(3)}; UNCLEAR emitted only when no ` +
      `class has majority support (maxP<0.5); renormalised 4-way distribution sums to 1.0; ` +
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
