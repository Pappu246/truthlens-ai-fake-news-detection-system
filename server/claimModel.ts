/**
 * TruthLens dedicated CLAIM model (LIAR specialist).
 *
 * This is deliberately a SEPARATE model from the ISOT article model:
 *   - article model : ISOT calibrated Linear SVM, operates on full article bodies
 *   - claim model   : LIAR calibrated Linear SVM, operates on single short claims
 *
 * The two are never merged into one accuracy number.
 *
 * The tokenizer below is a byte-for-byte mirror of scripts/liar_common.py::analyzer.
 * scripts/claimParity.ts asserts that every TEST row scores identically in both
 * runtimes; if this file drifts from the Python tokenizer, that check fails.
 */
import fs from 'fs';
import path from 'path';

export const CLAIM_MODEL_ARTIFACT_FILENAME = 'claim_model_artifacts.json';

export type ClaimVariantName = 'text_only' | 'text_meta';

export interface ClaimSpeakerMetadata {
  speaker?: string;
  party?: string;
  /** LIAR-style speaker credit history. All five counts are required together. */
  credit_history?: {
    barely_true_count: number;
    false_count: number;
    half_true_count: number;
    mostly_true_count: number;
    pants_on_fire_count: number;
  };
}

interface ClaimVariantArtifact {
  variant: string;
  uses_metadata: boolean;
  self_count_removed: boolean | null;
  hyperparameters: Record<string, unknown>;
  hyperparameter_search: unknown[];
  vocabulary: Record<string, number>;
  idf: number[];
  meta_feature_names: string[];
  weights: number[];
  bias: number;
  plattA: number;
  plattB: number;
  metrics: { valid: any; test: any };
}

export interface ClaimModelArtifact {
  model_name: string;
  model_type: string;
  model_version: string;
  model_role: string;
  trained_at: string;
  git_sha?: string;
  dataset: any;
  preprocessing: any;
  decision_threshold: number;
  threshold_policy: string;
  calibration: string;
  variants: Record<string, ClaimVariantArtifact>;
  serving: any;
}

export interface ClaimPrediction {
  claim_text: string;
  model_role: 'claim_model';
  model_name: string;
  model_version: string;
  model_type: string;
  variant_used: ClaimVariantName;
  metadata_available: boolean;
  metadata_fields_used: string[];
  probability_true: number | null;
  probability_false: number | null;
  decision_threshold: number;
  label: 'LIKELY TRUE' | 'LIKELY FALSE' | 'INSUFFICIENT CONTEXT';
  confidence: number | null;
  top_features: Array<{
    term: string;
    tfidf_value: number;
    coefficient: number;
    impact_score: number;
    signal_direction: 'true' | 'false';
  }>;
  limitations: string[];
  benchmark: {
    dataset: string;
    split: string;
    n: number;
    accuracy: number;
    macro_f1: number;
    note: string;
  } | null;
  scored_at: string;
}

const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', "aren't",
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can',
  'cannot', 'could', "couldn't", 'did', "didn't", 'do', 'does', "doesn't", 'doing', "don't", 'down',
  'during', 'each', 'few', 'for', 'from', 'further', 'had', "hadn't", 'has', "hasn't", 'have', "haven't",
  'having', 'he', "he'd", "he'll", "he's", 'her', 'here', "here's", 'hers', 'herself', 'him', 'himself',
  'his', 'how', "how's", 'i', "i'd", "i'll", "i'm", "i've", 'if', 'in', 'into', 'is', "isn't", 'it',
  "it's", 'its', 'itself', "let's", 'me', 'more', 'most', "mustn't", 'my', 'myself', 'no', 'nor', 'not',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'same', "shan't", 'she', "she'd", "she'll", "she's", 'should', "shouldn't", 'so', 'some', 'such',
  'than', 'that', "that's", 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', "there's",
  'these', 'they', "they'd", "they'll", "they're", "they've", 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'very', 'was', "wasn't", 'we', "we'd", "we'll", "we're", "we've", 'were',
  "weren't", 'what', "what's", 'when', "when's", 'where', "where's", 'which', 'while', 'who', "who's",
  'whom', 'why', "why's", 'with', "won't", 'would', "wouldn't", 'you', "you'd", "you'll", "you're",
  "you've", 'your', 'yours', 'yourself', 'yourselves'
]);

const MIN_TOKEN_LEN = 3;

/** Mirror of liar_common.clean_text */
export function cleanClaimText(text: string): string {
  if (!text) return '';
  let cleaned = text.toLowerCase();
  cleaned = cleaned.replace(/https?:\/\/\S+|www\.\S+/g, ' ');
  cleaned = cleaned.replace(/<.*?>/g, ' ');
  cleaned = cleaned.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'\[\]]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(' ').filter(t => !STOPWORDS.has(t) && t.length >= MIN_TOKEN_LEN);
  return tokens.join(' ');
}

/** Mirror of liar_common.analyzer */
export function claimNgrams(text: string): string[] {
  const cleaned = cleanClaimText(text);
  if (!cleaned) return [];
  const words = cleaned.split(' ');
  const grams: string[] = [];
  for (const w of words) if (w.length >= MIN_TOKEN_LEN) grams.push(w);
  for (let j = 0; j < words.length - 1; j++) {
    if (words[j].length >= MIN_TOKEN_LEN && words[j + 1].length >= MIN_TOKEN_LEN) {
      grams.push(`${words[j]} ${words[j + 1]}`);
    }
  }
  return grams;
}

const PARTIES = ['republican', 'democrat', 'none', 'independent', 'organization', 'libertarian'];
const LOW_ACCOUNTABILITY_SPEAKERS = new Set([
  'viral-image', 'facebook-posts', 'bloggers', 'chain-email', 'blog-posting',
  'email-viral', 'social-media-posting', 'tweets'
]);

/** Mirror of liar_common.meta_features (self-count already excluded at inference). */
export function buildMetaFeatures(meta: ClaimSpeakerMetadata): number[] {
  const c = meta.credit_history;
  const barely = Math.max(0, Number(c?.barely_true_count ?? 0));
  const falseC = Math.max(0, Number(c?.false_count ?? 0));
  const half = Math.max(0, Number(c?.half_true_count ?? 0));
  const mostly = Math.max(0, Number(c?.mostly_true_count ?? 0));
  const pants = Math.max(0, Number(c?.pants_on_fire_count ?? 0));
  const total = barely + falseC + half + mostly + pants;
  const denom = total > 0 ? total : 1;
  const party = (meta.party || '').trim().toLowerCase();
  const speaker = (meta.speaker || '').trim().toLowerCase();

  const feats: number[] = [
    total > 0 ? 1 : 0,
    Math.log1p(total),
    barely / denom,
    falseC / denom,
    half / denom,
    mostly / denom,
    pants / denom,
    (barely + falseC + pants) / denom,
    LOW_ACCOUNTABILITY_SPEAKERS.has(speaker) ? 1 : 0
  ];
  for (const p of PARTIES) feats.push(party === p ? 1 : 0);
  feats.push(party && !PARTIES.includes(party) ? 1 : 0);
  return feats;
}

export function hasUsableClaimMetadata(meta?: ClaimSpeakerMetadata | null): boolean {
  const c = meta?.credit_history;
  if (!c) return false;
  const required = ['barely_true_count', 'false_count', 'half_true_count',
    'mostly_true_count', 'pants_on_fire_count'] as const;
  return required.every(k => Number.isFinite(Number((c as any)[k])) && Number((c as any)[k]) >= 0);
}

export class ClaimModelUnavailableError extends Error {
  public readonly code = 'CLAIM_MODEL_UNAVAILABLE';
}

export class ClaimModel {
  private artifact: ClaimModelArtifact | null = null;
  private vocabs = new Map<string, Map<string, number>>();
  private loadError: string | null = null;

  constructor(artifactPath?: string) {
    this.load(artifactPath);
  }

  private candidatePaths(explicit?: string): string[] {
    if (explicit) return [explicit];
    const cwd = process.cwd();
    return [
      path.join(cwd, 'data', CLAIM_MODEL_ARTIFACT_FILENAME),
      path.join(cwd, '..', 'data', CLAIM_MODEL_ARTIFACT_FILENAME),
      path.join(cwd, 'dist', 'data', CLAIM_MODEL_ARTIFACT_FILENAME)
    ];
  }

  private load(explicit?: string): void {
    for (const p of this.candidatePaths(explicit)) {
      try {
        if (!fs.existsSync(p)) continue;
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as ClaimModelArtifact;
        this.validate(parsed);
        this.artifact = parsed;
        this.vocabs.clear();
        for (const [name, v] of Object.entries(parsed.variants)) {
          this.vocabs.set(name, new Map(Object.entries(v.vocabulary)));
        }
        this.loadError = null;
        return;
      } catch (err: any) {
        this.loadError = `${p}: ${err.message}`;
      }
    }
    if (!this.loadError) {
      this.loadError = `Claim model artifact ${CLAIM_MODEL_ARTIFACT_FILENAME} not found.`;
    }
    this.artifact = null;
  }

  /** Fail loudly on a malformed/degraded artifact rather than silently scoring garbage. */
  private validate(a: ClaimModelArtifact): void {
    if (a.model_role !== 'claim_model') throw new Error('artifact model_role is not claim_model');
    if (!a.variants?.text_only) throw new Error('artifact is missing the text_only variant');
    for (const [name, v] of Object.entries(a.variants || {})) {
      const vocabSize = Object.keys(v.vocabulary || {}).length;
      if (vocabSize === 0) throw new Error(`variant ${name} has an empty vocabulary`);
      if ((v.idf || []).length !== vocabSize) {
        throw new Error(`variant ${name}: idf length ${v.idf?.length} != vocabulary size ${vocabSize}`);
      }
      const expected = vocabSize + (v.uses_metadata ? v.meta_feature_names.length : 0);
      if ((v.weights || []).length !== expected) {
        throw new Error(`variant ${name}: weights length ${v.weights?.length} != expected ${expected}`);
      }
      if (!Number.isFinite(v.bias) || !Number.isFinite(v.plattA) || !Number.isFinite(v.plattB)) {
        throw new Error(`variant ${name}: non-finite bias/platt parameters`);
      }
    }
  }

  public isReady(): boolean { return this.artifact !== null; }
  public getLoadError(): string | null { return this.loadError; }
  public getArtifact(): ClaimModelArtifact {
    if (!this.artifact) throw new ClaimModelUnavailableError(this.loadError || 'Claim model unavailable.');
    return this.artifact;
  }

  /** L2-normalised sublinear tf-idf over the variant vocabulary. */
  public vectorize(variant: ClaimVariantName, text: string): Array<[number, number]> {
    const v = this.getArtifact().variants[variant];
    const vocab = this.vocabs.get(variant)!;
    const counts = new Map<string, number>();
    for (const g of claimNgrams(text)) counts.set(g, (counts.get(g) || 0) + 1);

    const vec: Array<[number, number]> = [];
    let normSq = 0;
    for (const [term, count] of counts.entries()) {
      const idx = vocab.get(term);
      if (idx === undefined) continue;
      const value = (1.0 + Math.log(count)) * v.idf[idx];
      vec.push([idx, value]);
      normSq += value * value;
    }
    const norm = Math.sqrt(normSq) || 1.0;
    return vec.map(([i, x]) => [i, x / norm] as [number, number]);
  }

  private decision(variant: ClaimVariantName, text: string, meta?: ClaimSpeakerMetadata): number {
    const v = this.getArtifact().variants[variant];
    const vocabSize = this.vocabs.get(variant)!.size;
    let z = v.bias;
    for (const [idx, val] of this.vectorize(variant, text)) z += v.weights[idx] * val;
    if (v.uses_metadata) {
      const m = buildMetaFeatures(meta || {});
      for (let i = 0; i < m.length; i++) z += v.weights[vocabSize + i] * m[i];
    }
    return z;
  }

  /** Raw calibrated probability that the claim is TRUE. Used by the parity check. */
  public probabilityTrue(variant: ClaimVariantName, text: string, meta?: ClaimSpeakerMetadata): number {
    const v = this.getArtifact().variants[variant];
    const z = this.decision(variant, text, meta);
    const exponent = Math.min(Math.max(v.plattA * z + v.plattB, -50), 50);
    return 1.0 / (1.0 + Math.exp(exponent));
  }

  public predict(rawClaim: string, meta?: ClaimSpeakerMetadata | null): ClaimPrediction {
    const artifact = this.getArtifact();
    const claim = (rawClaim || '').trim();
    if (!claim) throw new Error('Claim text is required.');
    if (claim.length > 5000) throw new Error('Claim text exceeds the 5,000 character limit.');

    const metadataAvailable = hasUsableClaimMetadata(meta);
    const variant: ClaimVariantName = metadataAvailable ? 'text_meta' : 'text_only';
    const v = artifact.variants[variant];
    const limitations: string[] = [];

    // A claim with no in-vocabulary evidence is NOT scored. Returning a
    // calibrated-looking number from an all-zero feature vector would just be
    // the model's prior dressed up as a prediction.
    const vec = this.vectorize(variant, claim);
    const words = claim.split(/\s+/).filter(Boolean);
    if (vec.length === 0 || words.length < 3) {
      return {
        claim_text: claim,
        model_role: 'claim_model',
        model_name: artifact.model_name,
        model_version: artifact.model_version,
        model_type: artifact.model_type,
        variant_used: variant,
        metadata_available: metadataAvailable,
        metadata_fields_used: metadataAvailable ? ['speaker_credit_history', 'party', 'speaker'] : [],
        probability_true: null,
        probability_false: null,
        decision_threshold: artifact.decision_threshold,
        label: 'INSUFFICIENT CONTEXT',
        confidence: null,
        top_features: [],
        limitations: [
          vec.length === 0
            ? 'No term in this claim occurs in the model vocabulary, so the feature vector is empty. Scoring it would return the training prior, not a prediction about this claim.'
            : 'The claim is too short to carry usable lexical signal (fewer than 3 words).',
          'Use the evidence engine for a retrieval-based assessment of this claim.'
        ],
        benchmark: null,
        scored_at: new Date().toISOString()
      };
    }

    const pTrue = this.probabilityTrue(variant, claim, meta || undefined);
    const pFalse = 1 - pTrue;
    const threshold = artifact.decision_threshold;

    if (!metadataAvailable) {
      limitations.push(
        'No speaker metadata was supplied, so the text-only variant was used. The metadata-conditioned ' +
        'variant is NOT evaluated with zero-filled metadata, because a model trained with a feature ' +
        'block and served without it is mis-specified and its reported accuracy would not apply.'
      );
      limitations.push(
        `Text-only LIAR TEST accuracy is ${(v.metrics.test.accuracy * 100).toFixed(2)}% ` +
        `(macro-F1 ${v.metrics.test.macro_f1.toFixed(4)}). This is a weak-signal task: short political ` +
        'claims carry little lexical evidence of veracity. Treat the score as a prior, not a verdict.'
      );
    } else {
      limitations.push(
        'Speaker credit-history metadata was supplied and used. The current claim must NOT be included ' +
        'in those counts; if it is, the score is contaminated by its own label.'
      );
    }
    limitations.push(
      'Trained on LIAR (US political fact-checks, 2007-2016). Claims outside that domain and period are out of distribution.'
    );
    limitations.push(
      'half-true and barely-true claims were excluded from training; genuinely partial claims have no correct output class here.'
    );

    const vocab = this.vocabs.get(variant)!;
    const indexToTerm = new Map<number, string>();
    for (const [t, i] of vocab.entries()) indexToTerm.set(i, t);
    const top = vec
      .map(([idx, val]) => {
        const coef = v.weights[idx] || 0;
        const impact = val * coef;
        return {
          term: indexToTerm.get(idx) || '',
          tfidf_value: Math.round(val * 10000) / 10000,
          coefficient: Math.round(coef * 10000) / 10000,
          impact_score: Math.round(impact * 10000) / 10000,
          signal_direction: (impact > 0 ? 'true' : 'false') as 'true' | 'false',
          intensity: Math.abs(impact)
        };
      })
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, 8)
      .map(({ intensity, ...rest }) => rest);

    return {
      claim_text: claim,
      model_role: 'claim_model',
      model_name: artifact.model_name,
      model_version: artifact.model_version,
      model_type: artifact.model_type,
      variant_used: variant,
      metadata_available: metadataAvailable,
      metadata_fields_used: metadataAvailable ? ['speaker_credit_history', 'party', 'speaker'] : [],
      probability_true: pTrue,
      probability_false: pFalse,
      decision_threshold: threshold,
      label: pTrue >= threshold ? 'LIKELY TRUE' : 'LIKELY FALSE',
      confidence: Math.max(pTrue, pFalse),
      top_features: top,
      limitations,
      benchmark: {
        dataset: 'LIAR (binary: true|mostly-true vs false|pants-fire)',
        split: 'held-out TEST, evaluated once',
        n: v.metrics.test.n,
        accuracy: v.metrics.test.accuracy,
        macro_f1: v.metrics.test.macro_f1,
        note: 'This benchmark describes the claim model only. It is unrelated to the ISOT article model score.'
      },
      scored_at: new Date().toISOString()
    };
  }

  public getMetrics(): any {
    const a = this.getArtifact();
    return {
      status: 'AVAILABLE',
      model_role: 'claim_model',
      model_name: a.model_name,
      model_type: a.model_type,
      model_version: a.model_version,
      trained_at: a.trained_at,
      git_sha: a.git_sha,
      dataset: a.dataset,
      preprocessing: a.preprocessing,
      calibration: a.calibration,
      decision_threshold: a.decision_threshold,
      threshold_policy: a.threshold_policy,
      serving: a.serving,
      variants: Object.fromEntries(Object.entries(a.variants).map(([name, v]) => [name, {
        uses_metadata: v.uses_metadata,
        self_count_removed: v.self_count_removed,
        hyperparameters: v.hyperparameters,
        vocabulary_size: Object.keys(v.vocabulary).length,
        meta_feature_names: v.meta_feature_names,
        valid: v.metrics.valid,
        test: v.metrics.test
      }])),
      honesty_notes: [
        'TEST was read once, after model selection and Platt calibration were frozen on TRAIN/VALID.',
        'The decision threshold is fixed at 0.50 and was never tuned against TEST.',
        'No TEST row was dropped and no label was rewritten.',
        'LIAR credit-history counts include the verdict of the statement they accompany; that ' +
        'self-contribution is subtracted before features are built. Leaving it in inflates accuracy ' +
        'by roughly 14 points and is the source of commonly quoted ~76% LIAR figures.'
      ]
    };
  }
}

export const claimModel = new ClaimModel();
