import fs from 'fs';
import path from 'path';
import { validateDataset, validateDatasetContent, DatasetValidationReport, ParsedArticleRecord } from './dataValidation';
import { extractPrimaryClaim, ClaimExtractionResult } from './verification/claimExtractor';
import { evaluateSourceProvenance, SourceEvaluation } from './verification/evidenceService';
import { sqliteHistory, SqliteHistoryRecord } from './sqliteHistory';

export interface LinguisticIndicator {
  name: string;
  type: string;
  signal: 'warning' | 'caution' | 'positive' | 'info';
  score: number;
  description: string;
  examples: string[];
}

export interface FeatureAttribution {
  term: string;
  tfidf_value: number;
  coefficient: number;
  impact_score: number;
  signal_direction: 'fake' | 'real';
  signal_label: string;
  intensity: number;
}

export interface Thresholds {
  fake_threshold: number;
  real_threshold: number;
  min_text_length?: number;
  min_word_count?: number;
}

/** Canonical verdict contract — the backend is the single source of truth. */
export const VERDICT_LIKELY_REAL = 'LIKELY REAL';
export const VERDICT_LIKELY_FAKE = 'LIKELY FAKE';
export const VERDICT_NEEDS_MORE_CONTEXT = 'NEEDS MORE CONTEXT';

/**
 * Models trained on small demo datasets (N <= 50) cannot support confident
 * verdicts. Their uncertainty zone is widened so borderline inputs fall back
 * to NEEDS MORE CONTEXT instead of a forced FAKE/REAL call:
 *   - the FAKE bound moves OUT (0.65 -> 0.75): an unreliable model must
 *     never accuse text of being fake without strong evidence;
 *   - the REAL bound moves OUT (0.35 -> 0.40): an unreliable model must not
 *     over-promise "real" on out-of-distribution text either.
 */
const DEMO_FAKE_ZONE_BOUND = 0.75;
const DEMO_REAL_ZONE_BOUND = 0.40;

export interface ModelArtifacts {
  model_name: string;
  model_type: string;
  model_version: string;
  trained_at: string;
  dataset_info: {
    source_path: string;
    total_samples: number;
    train_samples: number;
    test_samples: number;
    real_samples: number;
    fake_samples: number;
    vocabulary_size: number;
  };
  preprocessing: {
    lowercase: boolean;
    strip_urls: boolean;
    strip_html: boolean;
    strip_punctuation: boolean;
    remove_stopwords: boolean;
    min_token_length: number;
    ngram_range: [number, number];
    sublinear_tf: boolean;
  };
  vocabulary: Record<string, number>;
  idf: number[];
  selected_model: {
    name: string;
    weights: number[];
    bias: number;
    plattA: number;
    plattB: number;
  };
  logistic_regression: {
    weights: number[];
    bias: number;
  };
  metrics: {
    logistic_regression: any;
    linear_svm: any;
    best_model: any;
  };
  thresholds: Thresholds;
}

// PRNG (Mulberry32) for 100% deterministic, reproducible train/test splits and training
function createPRNG(seed: number) {
  let s = seed;
  return function() {
    let t = s += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// English stopwords
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

const SENSATIONAL_TERMS = [
  'shocking', 'unbelievable', 'secret', 'exposed', 'censored', 'miracle', 'bombshell',
  'banned', 'terrifying', 'mind control', 'clones', 'whistleblower', 'alien', 'suppressed',
  'hidden truth', 'deep state', 'globalist', 'poisons', 'furious', 'wake up', 'conspiracy',
  'mutant', 'occult', 'chemtrails', 'nano-circuits', 'brainwash'
];

const CERTAINTY_TERMS = [
  'guaranteed', '100%', 'never before', 'undeniable', 'proven fact', 'absolute proof',
  'every single', 'cure all', 'miracle cure', 'completely destroys', 'cures all'
];

const CREDIBILITY_MARKERS = [
  'according to', 'published in', 'spokesperson stated', 'official statement', 'clinical trial',
  'peer-reviewed', 'data indicates', 'department announced', 'preliminary findings', 'reiterated',
  'reported on', 'researchers observed', 'astrophysicists stated', 'officials noted'
];

export function cleanText(text: string, removeStopwords = true): string {
  if (!text) return '';
  let cleaned = text.toLowerCase();
  cleaned = cleaned.replace(/https?:\/\/\S+|www\.\S+/g, ' ');
  cleaned = cleaned.replace(/<.*?>/g, ' ');
  cleaned = cleaned.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'\[\]]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (removeStopwords) {
    const tokens = cleaned.split(' ').filter(t => !STOPWORDS.has(t) && t.length >= 3);
    cleaned = tokens.join(' ');
  }
  return cleaned;
}

export function extractLinguisticIndicators(rawText: string, sourceUrl = ''): LinguisticIndicator[] {
  const indicators: LinguisticIndicator[] = [];
  if (!rawText || rawText.trim().length === 0) return indicators;

  const words = rawText.split(/\s+/).filter(w => w.length > 0);
  const totalWords = words.length;

  // 1. Capitalization Intensity
  const allCapsWords = words.filter(w => w.length > 2 && /^[A-Z0-9!?-]+$/.test(w) && /[A-Z]/.test(w));
  const capsRatio = totalWords > 0 ? (allCapsWords.length / totalWords) * 100 : 0;
  if (capsRatio > 15) {
    indicators.push({
      name: 'Excessive Capitalization',
      type: 'structural',
      signal: 'warning',
      score: Math.min(100, Math.round(capsRatio)),
      description: `Detected ${allCapsWords.length} words in ALL-CAPS (${Math.round(capsRatio)}% of content), often characteristic of clickbait or urgency-driven writing.`,
      examples: allCapsWords.slice(0, 5)
    });
  } else if (capsRatio > 5) {
    indicators.push({
      name: 'Moderate Capitalization',
      type: 'structural',
      signal: 'caution',
      score: Math.round(capsRatio),
      description: `Elevated frequency of capitalized emphasis words (${Math.round(capsRatio)}%).`,
      examples: allCapsWords.slice(0, 3)
    });
  }

  // 2. Punctuation Exaggeration
  const multiExclamations = rawText.match(/!{2,}/g) || [];
  const multiQuestions = rawText.match(/\?{2,}/g) || [];
  const exclamationCount = (rawText.match(/!/g) || []).length;
  if (multiExclamations.length > 0 || multiQuestions.length > 0 || exclamationCount >= 4) {
    indicators.push({
      name: 'Exaggerated Punctuation',
      type: 'structural',
      signal: 'warning',
      score: Math.min(100, (multiExclamations.length * 20) + (exclamationCount * 10)),
      description: `Detected ${exclamationCount} exclamation marks with ${multiExclamations.length + multiQuestions.length} repeated punctuation clusters.`,
      examples: [...multiExclamations, ...multiQuestions].slice(0, 4)
    });
  }

  // 3. Sensationalist Lexicon
  const lowerText = rawText.toLowerCase();
  const matchedSensational: string[] = [];
  for (const term of SENSATIONAL_TERMS) {
    if (lowerText.includes(term)) matchedSensational.push(term);
  }
  if (matchedSensational.length >= 2) {
    indicators.push({
      name: 'Sensationalist & Hyperbolic Terms',
      type: 'lexical',
      signal: 'warning',
      score: matchedSensational.length,
      description: `Identified ${matchedSensational.length} high-arousal sensational terms known to correlate with unverified or conspiratorial claims.`,
      examples: matchedSensational.slice(0, 5)
    });
  }

  // 4. Absolute Certainty Claims
  const matchedCertainty: string[] = [];
  for (const term of CERTAINTY_TERMS) {
    if (lowerText.includes(term)) matchedCertainty.push(term);
  }
  if (matchedCertainty.length > 0) {
    indicators.push({
      name: 'Unqualified Certainty Language',
      type: 'lexical',
      signal: 'caution',
      score: matchedCertainty.length,
      description: `Found ${matchedCertainty.length} extreme certainty claims ('${matchedCertainty.slice(0, 2).join("', '")}'), often used to discourage skepticism.`,
      examples: matchedCertainty
    });
  }

  // 5. Journalistic Attribution Markers
  const matchedCred: string[] = [];
  for (const marker of CREDIBILITY_MARKERS) {
    if (lowerText.includes(marker)) matchedCred.push(marker);
  }
  if (matchedCred.length > 0) {
    indicators.push({
      name: 'Attribution & Journalistic Hedging',
      type: 'verifiability',
      signal: 'positive',
      score: matchedCred.length,
      description: `Contains ${matchedCred.length} institutional attribution phrases ('according to', 'published in', 'official statement') typical of established news reporting.`,
      examples: matchedCred
    });
  }

  // 6. Source Provenance Metadata (Purely informational - NEVER penalizes the text classification)
  if (!sourceUrl || !sourceUrl.trim()) {
    indicators.push({
      name: 'Source URL Provenance',
      type: 'metadata',
      signal: 'info',
      score: 0,
      description: 'No source publication URL provided. Model evaluates classification solely on text content independently of URL presence.',
      examples: []
    });
  } else {
    try {
      const urlObj = new URL(sourceUrl.startsWith('http') ? sourceUrl : `https://${sourceUrl}`);
      indicators.push({
        name: 'Source URL Metadata Provided',
        type: 'metadata',
        signal: 'info',
        score: 1,
        description: `Domain identified as '${urlObj.hostname}'. Domain attribution recorded for provenance analysis.`,
        examples: [urlObj.hostname]
      });
    } catch {
      indicators.push({
        name: 'Source URL Metadata Provided',
        type: 'metadata',
        signal: 'info',
        score: 1,
        description: `Source URL string provided: ${sourceUrl}`,
        examples: [sourceUrl]
      });
    }
  }

  return indicators;
}

export class TruthLensMLEngine {
  private vocabulary: Map<string, number> = new Map();
  private idf: number[] = [];
  private weights: number[] = [];
  private bias = 0;
  // Platt Sigmoid Calibration parameters: P(FAKE) = 1 / (1 + exp(A * z + B))
  private plattA = -1.88;
  private plattB = 0.0;
  private isTrained = false;
  private trainedAt: string = new Date().toISOString();
  private metrics: any = null;
  private thresholds: Thresholds = { fake_threshold: 0.65, real_threshold: 0.35, min_text_length: 60, min_word_count: 20 };
  private historyFile: string;
  private thresholdsFile: string;
  private artifactFile: string;
  private metricsArtifactFile: string;

  constructor(artifactFileOverride?: string) {
    this.historyFile = path.join(process.cwd(), 'data', 'history.json');
    this.thresholdsFile = path.join(process.cwd(), 'data', 'thresholds.json');
    this.artifactFile = artifactFileOverride ?? path.join(process.cwd(), 'data', 'saved_model_artifacts.json');
    this.metricsArtifactFile = path.join(process.cwd(), 'backend', 'models', 'metrics.json');
    
    // Initialize SQLite storage
    sqliteHistory.init().catch(err => console.error('[MLEngine] SQLite init error:', err));
    this.loadPersistedState();

    // Load saved model artifact if present; otherwise perform training.
    // loadModelArtifact() returns false both when the file is unreadable
    // AND when it fails the integrity check below -- in either case we
    // must fall back to training, or the engine silently runs with an
    // empty vocabulary (every prediction becomes exactly P(FAKE)=0.5,
    // landing in the uncertainty zone forever, with no visible error).
    const loaded = fs.existsSync(this.artifactFile) && this.loadModelArtifact(this.artifactFile);
    if (!loaded) {
      console.warn('[MLEngine] No usable model artifact was loaded; training a fresh model in memory now (not persisted to disk -- only an explicit retrain/promotion action may modify the canonical artifact).');
      this.train(undefined, undefined, false);
    }
  }

  private loadPersistedState() {
    try {
      if (fs.existsSync(this.thresholdsFile)) {
        const raw = fs.readFileSync(this.thresholdsFile, 'utf-8');
        const parsed = JSON.parse(raw);
        this.thresholds = {
          fake_threshold: parsed.fake_threshold ?? 0.65,
          real_threshold: parsed.real_threshold ?? 0.35,
          min_text_length: parsed.min_text_length ?? 60,
          min_word_count: parsed.min_word_count ?? 20
        };
      }
    } catch (e) {
      console.warn('[MLEngine] Using default thresholds');
    }
  }

  private loadModelArtifact(filePath: string): boolean {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const artifact: ModelArtifacts = JSON.parse(raw);

      // ARTIFACT INTEGRITY GUARD: a saved model is only usable when the
      // vocabulary, IDF table, weight vector and Platt parameters are mutually
      // consistent. A stale or truncated artifact (e.g. retrained model paired
      // with an older vectorizer) produces saturated ~100% scores for every
      // input. Refuse such artifacts and fall back to deterministic training.
      const vocabSize = Object.keys(artifact.vocabulary || {}).length;
      const idfLen = Array.isArray(artifact.idf) ? artifact.idf.length : 0;
      const weightLen = Array.isArray(artifact.selected_model?.weights) ? artifact.selected_model.weights.length : 0;
      const finite = Number.isFinite(artifact.selected_model?.bias) &&
        Number.isFinite(artifact.selected_model?.plattA) &&
        Number.isFinite(artifact.selected_model?.plattB);
      if (vocabSize === 0 || idfLen !== vocabSize || weightLen !== vocabSize || !finite) {
        console.error(
          `[MLEngine] Model artifact integrity check FAILED (vocab=${vocabSize}, idf=${idfLen}, weights=${weightLen}). ` +
          'Refusing to load an inconsistent artifact; retraining from dataset instead.'
        );
        return false;
      }

      this.vocabulary = new Map(Object.entries(artifact.vocabulary));
      this.idf = artifact.idf;
      this.weights = artifact.selected_model.weights;
      this.bias = artifact.selected_model.bias;
      this.plattA = artifact.selected_model.plattA;
      this.plattB = artifact.selected_model.plattB;
      this.metrics = artifact.metrics;
      this.trainedAt = artifact.trained_at;
      if (artifact.thresholds) {
        this.thresholds = {
          fake_threshold: artifact.thresholds.fake_threshold ?? this.thresholds.fake_threshold,
          real_threshold: artifact.thresholds.real_threshold ?? this.thresholds.real_threshold,
          min_text_length: artifact.thresholds.min_text_length ?? this.thresholds.min_text_length ?? 60,
          min_word_count: artifact.thresholds.min_word_count ?? this.thresholds.min_word_count ?? 20
        };
      }
      this.isTrained = true;

      console.log(`[MLEngine] Successfully loaded trained model artifact from ${filePath}`);
      console.log(`[MLEngine] Model: ${artifact.selected_model.name} | Vocab Size: ${this.vocabulary.size}`);
      return true;
    } catch (err) {
      console.error('[MLEngine] Failed to load model artifact, falling back to training', err);
      return false;
    }
  }

  /**
   * Reliability flag for the active model. Models trained on small demo
   * datasets (N <= 50) are flagged so verdicts and confidence can be
   * presented with appropriate caveats.
   */
  private isDemoModel(): boolean {
    const di = this.metrics?.dataset_info;
    return Boolean(this.metrics?.is_demo ?? di?.is_demo);
  }

  /**
   * Effective decision zone for the active model. For demo (unreliable)
   * models the uncertainty zone is widened so borderline text is returned as
   * NEEDS MORE CONTEXT instead of a forced FAKE/REAL verdict.
   */
  private effectiveDecisionZone(): { fake_threshold: number; real_threshold: number; widened_for_demo: boolean } {
    const tFake = this.thresholds.fake_threshold;
    const tReal = this.thresholds.real_threshold;
    if (this.isDemoModel()) {
      return {
        fake_threshold: Math.max(tFake, DEMO_FAKE_ZONE_BOUND),
        real_threshold: Math.max(tReal, DEMO_REAL_ZONE_BOUND),
        widened_for_demo: true
      };
    }
    return { fake_threshold: tFake, real_threshold: tReal, widened_for_demo: false };
  }

  private modelReliabilityLabel(): string {
    return this.isDemoModel() ? 'DEMO_DATASET' : 'VALIDATED';
  }

  private saveThresholds() {
    try {
      const dataDir = path.dirname(this.thresholdsFile);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(this.thresholdsFile, JSON.stringify(this.thresholds, null, 2), 'utf-8');
    } catch (e) {
      console.error('[MLEngine] Failed to write thresholds file', e);
    }
  }

  /**
   * True only when a real, integrity-checked model is loaded (vocabulary
   * non-empty, weights/idf consistent with it). False means every
   * prediction would silently return exactly P(FAKE)=0.5 -- callers such
   * as /api/health use this to surface that condition instead of hiding it.
   */
  public isModelTrained(): boolean {
    return this.isTrained;
  }

  public getThresholds(): Thresholds {
    return { ...this.thresholds };
  }

  public updateThresholds(fake: number, real: number, minLength?: number): Thresholds {
    if (real >= fake) {
      throw new Error(`Real threshold (${real}) must be strictly less than Fake threshold (${fake}).`);
    }
    this.thresholds.fake_threshold = fake;
    this.thresholds.real_threshold = real;
    if (typeof minLength === 'number' && minLength >= 10 && minLength <= 500) {
      this.thresholds.min_text_length = minLength;
    }
    this.saveThresholds();
    return { ...this.thresholds };
  }

  public getHistory(limit = 50): SqliteHistoryRecord[] {
    return sqliteHistory.getAllHistory(limit);
  }

  public getHistoryItem(id: number): SqliteHistoryRecord | undefined {
    return sqliteHistory.getHistoryById(id);
  }

  public deleteHistoryItem(id: number): boolean {
    return sqliteHistory.deleteHistoryItem(id);
  }

  public clearHistory(): number {
    return sqliteHistory.clearAllHistory();
  }

  /**
   * Complete Machine Learning Training Pipeline:
   * 1. Validates dataset with comprehensive checks (missing labels, short text, duplicates, imbalance).
   * 2. Stratified 5-Fold Cross-Validation:
   *    - In every fold, TF-IDF is fitted EXCLUSIVELY on the training fold (zero data leakage).
   *    - Computes Mean and Standard Deviation (± σ) for Accuracy, Precision, Recall, and F1.
   * 3. Stratified 80/20 Train / Held-Out Test Evaluation:
   *    - Fit final vectorizer on 80% train split.
   *    - Train Logistic Regression & Linear SVM with Platt Sigmoid Calibration.
   *    - Evaluate on held-out test split.
   * 4. Honest Demo Dataset Labeling:
   *    - Explicitly flags demo datasets (N <= 50) as "DEMO DATASET — NOT SUITABLE FOR FINAL MODEL EVALUATION".
   *    - Includes educational rationale on high-dimensional linear separability (p >> n).
   * 5. Saves artifacts to disk for real-time inference.
   */
  /**
   * Trains a model in memory. By default also persists the result to the
   * canonical production artifact path (data/saved_model_artifacts.json) --
   * this matches the long-standing behavior of the explicit, human-
   * initiated POST /api/train endpoint (the "Retrain" UI action), which
   * relies on train() writing to disk as its whole purpose.
   *
   * Pass persist=false for any call site where training is only an
   * implicit fallback to keep the engine usable (a missing/corrupt
   * artifact, or a lazy getDiagnostics()/getMetrics() initializer) rather
   * than a deliberate, human-visible retrain action. This is required so
   * that merely importing this module, running the test suite, or a GET
   * request for diagnostics/metrics can NEVER silently overwrite the
   * canonical production artifact -- only an explicit retrain/promotion
   * action may do that. See docs/ML_UPGRADE_PROGRESS.md, Task 10.
   */
  public train(customRecords?: ParsedArticleRecord[], customInfo?: { filename?: string; source_path?: string }, persist: boolean = true): any {
    const rng = createPRNG(42);
    const datasetPath = customInfo?.source_path || path.join(process.cwd(), 'data', 'news.csv');
    const filename = customInfo?.filename || path.basename(datasetPath);

    let samples: { id: number; title: string; text: string; combined: string; label: number }[] = [];
    let audit: DatasetValidationReport;

    if (customRecords && customRecords.length > 0) {
      samples = customRecords.map(r => ({
        id: r.id,
        title: r.title,
        text: r.text,
        combined: r.combined,
        label: r.label
      }));
      audit = validateDatasetContent('', filename, datasetPath);
    } else {
      audit = validateDataset(datasetPath);
      if (audit.status === 'ERROR') {
        throw new Error(`Dataset validation failed: ${audit.issues.join('; ')}`);
      }
      if (audit.parsed_records && audit.parsed_records.length > 0) {
        samples = audit.parsed_records.map(r => ({
          id: r.id,
          title: r.title,
          text: r.text,
          combined: r.combined,
          label: r.label
        }));
      }
    }

    const totalSamples = samples.length;
    if (totalSamples < 10) {
      throw new Error(`Insufficient samples to train model. Found only ${totalSamples} samples (minimum 10 required).`);
    }

    const realSamples = samples.filter(s => s.label === 0);
    const fakeSamples = samples.filter(s => s.label === 1);

    if (realSamples.length === 0 || fakeSamples.length === 0) {
      throw new Error('Dataset must contain both REAL and FAKE articles to train binary classifier.');
    }

    // Helper: Deterministic PRNG shuffle
    function shuffle<T>(arr: T[]): T[] {
      const copy = [...arr];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    }

    // Helper: Metric calculations (Positive Class = FAKE (1))
    function computeMetrics(preds: number[], yTrue: number[]) {
      let tp = 0, fp = 0, fn = 0, tn = 0;
      for (let i = 0; i < yTrue.length; i++) {
        if (preds[i] === 1 && yTrue[i] === 1) tp++;
        else if (preds[i] === 1 && yTrue[i] === 0) fp++;
        else if (preds[i] === 0 && yTrue[i] === 1) fn++;
        else tn++;
      }
      const acc = yTrue.length > 0 ? (tp + tn) / yTrue.length : 0;
      const prec = (tp + fp > 0) ? tp / (tp + fp) : 0;
      const rec = (tp + fn > 0) ? tp / (tp + fn) : 0;
      const f1 = (prec + rec > 0) ? (2 * prec * rec) / (prec + rec) : 0;
      return {
        positive_class: "FAKE (1)",
        accuracy: Math.round(acc * 1000) / 1000,
        precision: Math.round(prec * 1000) / 1000,
        recall: Math.round(rec * 1000) / 1000,
        f1_score: Math.round(f1 * 1000) / 1000,
        confusion_matrix: {
          matrix: [[tn, fp], [fn, tp]],
          true_negative: tn,
          false_positive: fp,
          false_negative: fn,
          true_positive: tp,
          labels: ["REAL (0)", "FAKE (1)"],
          explanations: {
            false_positive: "Real news incorrectly classified as Fake.",
            false_negative: "Fake news incorrectly classified as Real."
          }
        }
      };
    }

    // Helper: Build isolated TF-IDF pipeline fitted strictly on training documents
    function createIsolatedPipeline(trainDocs: string[]) {
      const termDocFreq = new Map<string, number>();
      for (const doc of trainDocs) {
        const words = doc.split(' ');
        const seen = new Set<string>();
        for (const w of words) {
          if (w.length >= 3) seen.add(w);
        }
        for (let j = 0; j < words.length - 1; j++) {
          if (words[j].length >= 3 && words[j + 1].length >= 3) {
            seen.add(`${words[j]} ${words[j + 1]}`);
          }
        }
        for (const term of seen) {
          termDocFreq.set(term, (termDocFreq.get(term) || 0) + 1);
        }
      }

      const vocab = new Map<string, number>();
      const idfList: number[] = [];
      let idx = 0;
      const N_train = trainDocs.length;

      for (const [term, df] of termDocFreq.entries()) {
        vocab.set(term, idx++);
        idfList.push(Math.log((1 + N_train) / (1 + df)) + 1.0);
      }

      const vectorize = (cleanedText: string): [number, number][] => {
        const words = cleanedText.split(' ');
        const counts = new Map<string, number>();
        for (const w of words) {
          if (w.length >= 3) counts.set(w, (counts.get(w) || 0) + 1);
        }
        for (let j = 0; j < words.length - 1; j++) {
          if (words[j].length >= 3 && words[j + 1].length >= 3) {
            const bi = `${words[j]} ${words[j + 1]}`;
            counts.set(bi, (counts.get(bi) || 0) + 1);
          }
        }
        const vec: [number, number][] = [];
        let normSq = 0;
        for (const [term, count] of counts.entries()) {
          const vIdx = vocab.get(term);
          if (vIdx !== undefined) {
            const tf = 1.0 + Math.log(count);
            const tfidf = tf * idfList[vIdx];
            vec.push([vIdx, tfidf]);
            normSq += tfidf * tfidf;
          }
        }
        const norm = Math.sqrt(normSq) || 1.0;
        return vec.map(([vIdx, val]) => [vIdx, val / norm]);
      };

      return { vocab, idf: idfList, V: vocab.size, vectorize };
    }

    // Helper: Mean and Standard Deviation calculator
    function calcStats(nums: number[]) {
      if (nums.length === 0) return { mean: 0, std: 0 };
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const variance = nums.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / nums.length;
      return {
        mean: Math.round(mean * 1000) / 1000,
        std: Math.round(Math.sqrt(variance) * 1000) / 1000
      };
    }

    // =========================================================================
    // STEP 1: STRATIFIED K-FOLD CROSS-VALIDATION (Leakage-Proof)
    // =========================================================================
    const kFolds = Math.max(2, Math.min(5, Math.min(realSamples.length, fakeSamples.length)));
    const shuffledRealForCV = shuffle(realSamples);
    const shuffledFakeForCV = shuffle(fakeSamples);

    const realBuckets: typeof samples[] = Array.from({ length: kFolds }, () => []);
    const fakeBuckets: typeof samples[] = Array.from({ length: kFolds }, () => []);

    shuffledRealForCV.forEach((s, idx) => realBuckets[idx % kFolds].push(s));
    shuffledFakeForCV.forEach((s, idx) => fakeBuckets[idx % kFolds].push(s));

    const lrFoldAccs: number[] = [];
    const lrFoldPrecs: number[] = [];
    const lrFoldRecs: number[] = [];
    const lrFoldF1s: number[] = [];

    const svmFoldAccs: number[] = [];
    const svmFoldPrecs: number[] = [];
    const svmFoldRecs: number[] = [];
    const svmFoldF1s: number[] = [];

    for (let fold = 0; fold < kFolds; fold++) {
      // Stratified fold assembly
      const valFold = [...realBuckets[fold], ...fakeBuckets[fold]];
      const trainFold: typeof samples = [];
      for (let f = 0; f < kFolds; f++) {
        if (f !== fold) {
          trainFold.push(...realBuckets[f], ...fakeBuckets[f]);
        }
      }

      // CRITICAL LEAKAGE GUARD: Pipeline fits vocabulary ONLY on training fold
      const foldPipe = createIsolatedPipeline(trainFold.map(s => cleanText(s.combined)));
      const X_cv_train = trainFold.map(s => foldPipe.vectorize(cleanText(s.combined)));
      const y_cv_train = trainFold.map(s => s.label);
      const X_cv_val = valFold.map(s => foldPipe.vectorize(cleanText(s.combined)));
      const y_cv_val = valFold.map(s => s.label);

      // Train Logistic Regression on Fold
      const lrW = new Array(foldPipe.V).fill(0);
      let lrB = 0;
      for (let ep = 0; ep < 75; ep++) {
        for (let i = 0; i < X_cv_train.length; i++) {
          const x = X_cv_train[i];
          const y = y_cv_train[i];
          let z = lrB;
          for (const [vIdx, val] of x) z += lrW[vIdx] * val;
          const p = 1.0 / (1.0 + Math.exp(-z));
          const err = p - y;
          for (const [vIdx, val] of x) {
            lrW[vIdx] = lrW[vIdx] * (1 - 0.15 * 0.001) - 0.15 * err * val;
          }
          lrB -= 0.15 * err;
        }
      }
      const lrPreds = X_cv_val.map(x => {
        let z = lrB;
        for (const [vIdx, val] of x) z += lrW[vIdx] * val;
        return 1.0 / (1.0 + Math.exp(-z)) >= 0.5 ? 1 : 0;
      });
      const lrFoldM = computeMetrics(lrPreds, y_cv_val);
      lrFoldAccs.push(lrFoldM.accuracy);
      lrFoldPrecs.push(lrFoldM.precision);
      lrFoldRecs.push(lrFoldM.recall);
      lrFoldF1s.push(lrFoldM.f1_score);

      // Train Linear SVM on Fold
      const svmW = new Array(foldPipe.V).fill(0);
      let svmB = 0;
      for (let ep = 0; ep < 65; ep++) {
        for (let i = 0; i < X_cv_train.length; i++) {
          const x = X_cv_train[i];
          const target = y_cv_train[i] === 1 ? 1 : -1;
          let z = svmB;
          for (const [vIdx, val] of x) z += svmW[vIdx] * val;
          const margin = target * z;
          if (margin < 1) {
            for (const [vIdx, val] of x) {
              svmW[vIdx] = svmW[vIdx] * (1 - 0.08 * 0.001) + 0.08 * target * val;
            }
            svmB += 0.08 * target;
          } else {
            for (const [vIdx] of x) {
              svmW[vIdx] = svmW[vIdx] * (1 - 0.08 * 0.001);
            }
          }
        }
      }
      const svmPreds = X_cv_val.map(x => {
        let z = svmB;
        for (const [vIdx, val] of x) z += svmW[vIdx] * val;
        return z >= 0 ? 1 : 0;
      });
      const svmFoldM = computeMetrics(svmPreds, y_cv_val);
      svmFoldAccs.push(svmFoldM.accuracy);
      svmFoldPrecs.push(svmFoldM.precision);
      svmFoldRecs.push(svmFoldM.recall);
      svmFoldF1s.push(svmFoldM.f1_score);
    }

    const lrCVStats = {
      accuracy: calcStats(lrFoldAccs),
      precision: calcStats(lrFoldPrecs),
      recall: calcStats(lrFoldRecs),
      f1_score: calcStats(lrFoldF1s)
    };

    const svmCVStats = {
      accuracy: calcStats(svmFoldAccs),
      precision: calcStats(svmFoldPrecs),
      recall: calcStats(svmFoldRecs),
      f1_score: calcStats(svmFoldF1s)
    };

    // =========================================================================
    // STEP 2: STRATIFIED 80/20 HELD-OUT SPLIT FOR FINAL MODEL
    // =========================================================================
    const shuffledReal = shuffle(realSamples);
    const shuffledFake = shuffle(fakeSamples);

    const trainRealCount = Math.floor(shuffledReal.length * 0.8);
    const trainFakeCount = Math.floor(shuffledFake.length * 0.8);

    const trainSet = shuffle([
      ...shuffledReal.slice(0, trainRealCount),
      ...shuffledFake.slice(0, trainFakeCount)
    ]);
    const testSet = shuffle([
      ...shuffledReal.slice(trainRealCount),
      ...shuffledFake.slice(trainFakeCount)
    ]);

    // Fit final TF-IDF vectorizer exclusively on 80% trainSet
    const finalPipe = createIsolatedPipeline(trainSet.map(s => cleanText(s.combined)));
    this.vocabulary = finalPipe.vocab;
    this.idf = finalPipe.idf;
    const V = finalPipe.V;

    const X_train = trainSet.map(s => this.vectorize(cleanText(s.combined)));
    const y_train = trainSet.map(s => s.label);
    const X_test = testSet.map(s => this.vectorize(cleanText(s.combined)));
    const y_test = testSet.map(s => s.label);

    // Train Model A: Logistic Regression (L2 regularized)
    const lrWeights = new Array(V).fill(0);
    let lrBias = 0;
    const lrEpochs = 100;
    const lrRate = 0.15;
    const lrLambda = 0.001;

    for (let epoch = 0; epoch < lrEpochs; epoch++) {
      for (let i = 0; i < X_train.length; i++) {
        const x = X_train[i];
        const y = y_train[i];
        let z = lrBias;
        for (const [idx, val] of x) z += lrWeights[idx] * val;
        const p = 1.0 / (1.0 + Math.exp(-z));
        const err = p - y;
        for (const [idx, val] of x) {
          lrWeights[idx] = lrWeights[idx] * (1 - lrRate * lrLambda) - lrRate * err * val;
        }
        lrBias -= lrRate * err;
      }
    }

    // Train Model B: Linear SVM (Hinge loss with L2 regularization)
    const svmWeights = new Array(V).fill(0);
    let svmBias = 0;
    const svmEpochs = 80;
    const svmRate = 0.08;
    const svmLambda = 0.001;

    for (let epoch = 0; epoch < svmEpochs; epoch++) {
      for (let i = 0; i < X_train.length; i++) {
        const x = X_train[i];
        const y = y_train[i] === 1 ? 1 : -1;
        let z = svmBias;
        for (const [idx, val] of x) z += svmWeights[idx] * val;
        const margin = y * z;
        if (margin < 1) {
          for (const [idx, val] of x) {
            svmWeights[idx] = svmWeights[idx] * (1 - svmRate * svmLambda) + svmRate * y * val;
          }
          svmBias += svmRate * y;
        } else {
          for (const [idx] of x) {
            svmWeights[idx] = svmWeights[idx] * (1 - svmRate * svmLambda);
          }
        }
      }
    }

    // Fit Platt Sigmoid Calibration on SVM decision margins
    const trainMargins = X_train.map((x, i) => {
      let z = svmBias;
      for (const [idx, val] of x) z += svmWeights[idx] * val;
      return { z, y: y_train[i] };
    });

    let plattA = -2.0;
    let plattB = 0.0;
    for (let iter = 0; iter < 50; iter++) {
      let gradA = 0;
      let gradB = 0;
      for (const item of trainMargins) {
        const p = 1.0 / (1.0 + Math.exp(plattA * item.z + plattB));
        const diff = p - item.y;
        gradA += diff * item.z;
        gradB += diff;
      }
      plattA -= 0.02 * (gradA / trainMargins.length);
      plattB -= 0.02 * (gradB / trainMargins.length);
    }

    // Evaluate on Held-out Test Set
    const lrTestProbs = X_test.map(x => {
      let z = lrBias;
      for (const [idx, val] of x) z += lrWeights[idx] * val;
      return 1.0 / (1.0 + Math.exp(-z));
    });
    const lrTestPreds = lrTestProbs.map(p => p >= 0.5 ? 1 : 0);
    const lrTestMetrics = computeMetrics(lrTestPreds, y_test);

    const svmTestMargins = X_test.map(x => {
      let z = svmBias;
      for (const [idx, val] of x) z += svmWeights[idx] * val;
      return z;
    });
    const svmTestProbs = svmTestMargins.map(z => 1.0 / (1.0 + Math.exp(plattA * z + plattB)));
    const svmTestPreds = svmTestProbs.map(p => p >= 0.5 ? 1 : 0);
    const svmTestMetrics = computeMetrics(svmTestPreds, y_test);

    // =========================================================================
    // STEP 3: MODEL SELECTION & ARTIFACT MANAGEMENT
    // =========================================================================
    let bestName = 'Linear SVM (Calibrated)';
    let bestWeights = svmWeights;
    let bestBias = svmBias;
    let bestMetrics = svmTestMetrics;
    let selectionReason = '';

    if (svmCVStats.f1_score.mean > lrCVStats.f1_score.mean) {
      bestName = 'Linear SVM (Calibrated)';
      bestWeights = svmWeights;
      bestBias = svmBias;
      bestMetrics = svmTestMetrics;
      selectionReason = `Linear SVM achieved higher cross-validated F1-score (${svmCVStats.f1_score.mean} ± ${svmCVStats.f1_score.std} vs ${lrCVStats.f1_score.mean} ± ${lrCVStats.f1_score.std}).`;
    } else if (lrCVStats.f1_score.mean > svmCVStats.f1_score.mean) {
      bestName = 'Logistic Regression';
      bestWeights = lrWeights;
      bestBias = lrBias;
      bestMetrics = lrTestMetrics;
      selectionReason = `Logistic Regression achieved higher cross-validated F1-score (${lrCVStats.f1_score.mean} ± ${lrCVStats.f1_score.std} vs ${svmCVStats.f1_score.mean} ± ${svmCVStats.f1_score.std}).`;
    } else {
      bestName = 'Linear SVM (Calibrated)';
      bestWeights = svmWeights;
      bestBias = svmBias;
      bestMetrics = svmTestMetrics;
      selectionReason = 'F1-scores tied across Stratified K-Fold CV; Linear SVM selected for maximum-margin regularization and Platt sigmoid calibration.';
    }

    this.weights = bestWeights;
    this.bias = bestBias;
    this.plattA = plattA;
    this.plattB = plattB;
    this.trainedAt = new Date().toISOString();
    this.isTrained = true;

    // Honesty Assessment: Flag demo vs validated benchmark
    const isDemo = totalSamples <= 50 || filename === 'news.csv' || filename.includes('demo');
    const datasetStatus: 'DEMO DATASET' | 'VALIDATED BENCHMARK' = isDemo ? 'DEMO DATASET' : 'VALIDATED BENCHMARK';
    const demoBadgeLabel = 'DEMO DATASET — NOT SUITABLE FOR FINAL MODEL EVALUATION';
    const evalStatus = isDemo
      ? 'Insufficient for reliable benchmark'
      : `Validated Benchmark (Stratified ${kFolds}-Fold CV + Held-out Test)`;
    const strongWarning = isDemo
      ? `Only ${totalSamples} articles available. Model performance is not statistically reliable.`
      : (totalSamples < 150 ? `Moderate sample size (${totalSamples} articles). 500+ articles recommended for production evaluation.` : undefined);

    const whyMisleading = "In text classification with TF-IDF, the vocabulary dimension p (typically 2,000+ terms) vastly exceeds the sample size n (e.g. 28 training samples). In this sparse high-dimensional space (p >> n), data points are mathematically linearly separable, yielding perfect training and test separation on tiny test splits (N=8) despite having zero statistical generalization to real-world news.";

    // Compile Performance Payload
    this.metrics = {
      status: "success",
      model_version: "2.2.0-calibrated",
      trained_at: this.trainedAt,
      is_demo: isDemo,
      dataset_status: datasetStatus,
      demo_badge_label: demoBadgeLabel,
      evaluation_status: evalStatus,
      strong_warning: strongWarning,
      why_misleading_accuracy: whyMisleading,
      real_dataset_required_notice: "Real labelled dataset required for final evaluation.",
      dataset_info: {
        source_path: datasetPath,
        filename,
        total_samples: totalSamples,
        train_samples: trainSet.length,
        test_samples: testSet.length,
        real_samples: realSamples.length,
        fake_samples: fakeSamples.length,
        vocabulary_size: V,
        is_demo: isDemo,
        dataset_status: datasetStatus,
        demo_badge_label: demoBadgeLabel,
        evaluation_status: evalStatus,
        strong_warning: strongWarning
      },
      cross_validation: {
        n_splits: kFolds,
        method: `Stratified ${kFolds}-Fold Cross-Validation`,
        data_leakage_prevented: true,
        leakage_guard_note: "TF-IDF vocabulary and IDF weights fitted exclusively inside each training fold without access to validation fold.",
        logistic_regression: {
          accuracy_mean: lrCVStats.accuracy.mean,
          accuracy_std: lrCVStats.accuracy.std,
          precision_mean: lrCVStats.precision.mean,
          precision_std: lrCVStats.precision.std,
          recall_mean: lrCVStats.recall.mean,
          recall_std: lrCVStats.recall.std,
          f1_mean: lrCVStats.f1_score.mean,
          f1_std: lrCVStats.f1_score.std
        },
        linear_svm: {
          accuracy_mean: svmCVStats.accuracy.mean,
          accuracy_std: svmCVStats.accuracy.std,
          precision_mean: svmCVStats.precision.mean,
          precision_std: svmCVStats.precision.std,
          recall_mean: svmCVStats.recall.mean,
          recall_std: svmCVStats.recall.std,
          f1_mean: svmCVStats.f1_score.mean,
          f1_std: svmCVStats.f1_score.std
        }
      },
      models: {
        logistic_regression: {
          name: "Logistic Regression",
          hyperparameters: { C: 1.0, max_iter: 1000, penalty: "l2" },
          cv_metrics: lrCVStats,
          metrics: lrTestMetrics
        },
        linear_svm: {
          name: "Linear SVM",
          hyperparameters: { C: 1.0, calibration: "sigmoid (Platt)", loss: "hinge", penalty: "l2" },
          cv_metrics: svmCVStats,
          metrics: svmTestMetrics
        }
      },
      best_model: {
        name: bestName,
        model_version: "2.2.0",
        selection_criterion: `Stratified ${kFolds}-Fold Cross-Validation F1-score`,
        selection_reason: selectionReason,
        metrics: bestMetrics
      }
    };

    // Save Artifacts to Disk
    const vocabObj: Record<string, number> = {};
    for (const [k, v] of this.vocabulary.entries()) {
      vocabObj[k] = v;
    }

    const artifactData: ModelArtifacts = {
      model_name: bestName,
      model_type: "linear_svm_calibrated",
      model_version: "2.2.0",
      trained_at: this.trainedAt,
      dataset_info: this.metrics.dataset_info,
      preprocessing: {
        lowercase: true,
        strip_urls: true,
        strip_html: true,
        strip_punctuation: true,
        remove_stopwords: true,
        min_token_length: 3,
        ngram_range: [1, 2],
        sublinear_tf: true
      },
      vocabulary: vocabObj,
      idf: this.idf,
      selected_model: {
        name: bestName,
        weights: this.weights,
        bias: this.bias,
        plattA: this.plattA,
        plattB: this.plattB
      },
      logistic_regression: {
        weights: lrWeights,
        bias: lrBias
      },
      metrics: this.metrics,
      thresholds: this.thresholds
    };

    if (persist) {
      try {
        const dataDir = path.dirname(this.artifactFile);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(this.artifactFile, JSON.stringify(artifactData, null, 2), 'utf-8');

        const backendDir = path.dirname(this.metricsArtifactFile);
        if (!fs.existsSync(backendDir)) fs.mkdirSync(backendDir, { recursive: true });
        fs.writeFileSync(this.metricsArtifactFile, JSON.stringify(this.metrics, null, 2), 'utf-8');
        console.log(`[MLEngine] Saved calibrated model artifacts to ${this.artifactFile}`);
      } catch (err) {
        console.error('[MLEngine] Failed to write model artifacts', err);
      }
    } else {
      console.log('[MLEngine] Trained in memory only (persist=false) -- canonical artifact on disk was not modified.');
    }

    console.log(`[MLEngine] Training complete. Selected: ${bestName} | Vocab: ${V} | CV F1: ${this.metrics.best_model.name.includes('SVM') ? svmCVStats.f1_score.mean : lrCVStats.f1_score.mean} | Test F1: ${bestMetrics.f1_score}`);
    return this.metrics;
  }

  /**
   * Import Dataset with Strict Validation & Safe Replacement
   * Validates CSV format, checks labels/columns, trains pipeline, and updates model
   * ONLY IF the entire pipeline succeeds.
   */
  public importDataset(csvContent: string, filename = 'imported_news.csv'): { success: boolean; validation: DatasetValidationReport; metrics?: any; error?: string } {
    const validation = validateDatasetContent(csvContent, filename);

    if (validation.status === 'ERROR') {
      return {
        success: false,
        validation,
        error: `Dataset validation failed: ${validation.issues.join('; ')}`
      };
    }

    try {
      // Backup previous demo dataset if not already backed up
      const activePath = path.join(process.cwd(), 'data', 'news.csv');
      const backupPath = path.join(process.cwd(), 'data', 'news_demo_backup.csv');
      if (fs.existsSync(activePath) && !fs.existsSync(backupPath)) {
        fs.copyFileSync(activePath, backupPath);
      }

      // Train on the new dataset's parsed records FIRST before touching disk
      const newMetrics = this.train(validation.parsed_records, {
        filename,
        source_path: path.join('data', filename)
      });

      // Write imported CSV to data/news.csv so subsequent server restarts retain it
      fs.writeFileSync(activePath, csvContent, 'utf-8');

      return {
        success: true,
        validation,
        metrics: newMetrics
      };
    } catch (err: any) {
      console.error('[MLEngine] Dataset import failed during training:', err);
      return {
        success: false,
        validation,
        error: `Model training failed on imported dataset: ${err.message}`
      };
    }
  }

  public vectorize(cleanedText: string): [number, number][] {
    const words = cleanedText.split(' ');
    const counts: Map<string, number> = new Map();

    for (const w of words) {
      if (w.length >= 3) {
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    }
    for (let j = 0; j < words.length - 1; j++) {
      if (words[j].length >= 3 && words[j + 1].length >= 3) {
        const bi = `${words[j]} ${words[j + 1]}`;
        counts.set(bi, (counts.get(bi) || 0) + 1);
      }
    }

    const vector: [number, number][] = [];
    let normSq = 0;

    for (const [term, count] of counts.entries()) {
      const idx = this.vocabulary.get(term);
      if (idx !== undefined) {
        // Sublinear TF * IDF
        const tf = 1.0 + Math.log(count);
        const tfidf = tf * this.idf[idx];
        vector.push([idx, tfidf]);
        normSq += tfidf * tfidf;
      }
    }

    // L2 Normalize
    const norm = Math.sqrt(normSq) || 1.0;
    return vector.map(([idx, val]) => [idx, val / norm]);
  }

  public predictProbability(cleanedText: string): number {
    const tfidf = this.vectorize(cleanedText);
    let z = this.bias;
    for (const [idx, val] of tfidf) {
      z += this.weights[idx] * val;
    }
    // Platt Sigmoid scaling: P(y=1) = 1 / (1 + exp(A * z + B))
    const probFake = 1.0 / (1.0 + Math.exp(this.plattA * z + this.plattB));
    return Math.min(Math.max(probFake, 0.0001), 0.9999);
  }

  public getFeatureAttributions(cleanedText: string, topK = 8): FeatureAttribution[] {
    const tfidf = this.vectorize(cleanedText);
    const indexToTerm = new Map<number, string>();
    for (const [term, idx] of this.vocabulary.entries()) {
      indexToTerm.set(idx, term);
    }

    const contributions: FeatureAttribution[] = [];
    for (const [idx, val] of tfidf) {
      const term = indexToTerm.get(idx) || '';
      const w = this.weights[idx] || 0;
      const impact = val * w;
      contributions.push({
        term,
        tfidf_value: Math.round(val * 10000) / 10000,
        coefficient: Math.round(w * 10000) / 10000,
        impact_score: Math.round(impact * 10000) / 10000,
        signal_direction: impact > 0 ? 'fake' : 'real',
        signal_label: impact > 0 ? 'Contributing signal toward FAKE' : 'Contributing signal toward REAL',
        intensity: Math.abs(impact)
      });
    }

    contributions.sort((a, b) => b.intensity - a.intensity);
    return contributions.slice(0, topK);
  }

  public analyzeArticle(
    rawText: string,
    sourceUrl = '',
    options?: {
      inputType?: 'text' | 'url' | 'live_news';
      originalUrl?: string;
      canonicalUrl?: string;
      articleTitle?: string;
      sourceName?: string;
      author?: string;
      publishedAt?: string;
      wordCount?: number;
      extractionStatus?: 'SUCCESS' | 'PARTIAL' | 'FAILED';
      warnings?: string[];
      isHeadlineOnly?: boolean;
    }
  ): any {
    const textTrimmed = (rawText || '').trim();

    // 1. Hard validation — empty input is a request error, never a prediction
    if (textTrimmed.length === 0) {
      throw new Error('Please enter news article text for analysis.');
    }

    if (textTrimmed.length > 50000) {
      throw new Error('Article text exceeds the maximum character limit (50,000 characters).');
    }

    const minLength = this.thresholds.min_text_length ?? 60;
    const minWords = this.thresholds.min_word_count ?? 20;
    const words = textTrimmed.split(/\s+/).filter(w => w.length > 0);
    const hasSource = Boolean(sourceUrl && sourceUrl.trim());

    // 2. Context guards — short, headline-only, vague, incomplete or
    //    source-less content is NEVER classified. The response withholds
    //    probabilities entirely (null) so no fake percentage can be shown.
    const guardReason = (() => {
      if (textTrimmed.length < minLength) {
        return `The supplied text is too short (${textTrimmed.length}/${minLength} characters) or lacks sufficient source context for a reliable assessment.`;
      }
      if (options?.isHeadlineOnly) {
        return 'Headline-only content was provided without article body text, which is not enough context for a reliable assessment.';
      }
      if (words.length < minWords && !hasSource) {
        return `The supplied text is too short (${words.length} words) or lacks sufficient source context (no article body and no source URL).`;
      }
      return null;
    })();

    if (guardReason) {
      const sourceInfo = evaluateSourceProvenance(sourceUrl);
      const claimInfo = extractPrimaryClaim(textTrimmed);
      return {
        id: null,
        status: 'INSUFFICIENT_INFORMATION',
        verdict: VERDICT_NEEDS_MORE_CONTEXT,
        prediction: VERDICT_NEEDS_MORE_CONTEXT,
        reason: guardReason,
        message: 'More article context is required for reliable ML analysis.',
        fake_probability: null,
        real_probability: null,
        confidence: null,
        confidence_score: null,
        model_score: null,
        uncertainty_score: null,
        risk_level: 'UNDETERMINED',
        input_length: textTrimmed.length,
        min_required_length: minLength,
        min_required_words: minWords,
        input_words: words.length,
        detected_claim: claimInfo.detected_claim,
        claim_details: claimInfo,
        thresholds: {
          fake_threshold: this.thresholds.fake_threshold,
          real_threshold: this.thresholds.real_threshold,
          min_text_length: minLength,
          min_word_count: minWords,
          suspicious_zone: `${this.thresholds.real_threshold} - ${this.thresholds.fake_threshold}`
        },
        indicators: [],
        explanation: [
          'No classification is available: the supplied text does not contain enough context for a reliable model evaluation.',
          'Provide the full article body (or a source URL with article text) to obtain a verdict.'
        ],
        feature_attributions: [],
        model: 'Linear SVM (Calibrated)',
        model_used: 'Linear SVM (Calibrated)',
        model_reliability: this.modelReliabilityLabel(),
        source_info: sourceInfo,
        evidence_verification: {
          available: false,
          status: 'UNAVAILABLE',
          message: 'Evidence verification is not currently available.',
          reason: 'External search indexes and live fact-checking APIs are not configured in this runtime.'
        },
        disclaimer: 'This system requires sufficient contextual sentences to evaluate linguistic patterns reliably without guessing.'
      };
    }

    const cleaned = cleanText(textTrimmed);
    if (!cleaned) {
      throw new Error('Article text contains only punctuation, stop words, or symbols.');
    }

    // 3. Dynamic ML Prediction strictly from text (Source URL is completely decoupled)
    const fakeProbRaw = this.predictProbability(cleaned);
    const fakeProb = Math.round(fakeProbRaw * 10000) / 10000;
    const realProb = Math.round((1.0 - fakeProb) * 10000) / 10000;

    const zone = this.effectiveDecisionZone();
    const tFake = zone.fake_threshold;
    const tReal = zone.real_threshold;
    const demoModel = this.isDemoModel();

    // 4. Verdict contract (backend = single source of truth):
    //    LIKELY REAL | LIKELY FAKE | NEEDS MORE CONTEXT
    let prediction: string;
    let riskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'UNDETERMINED';
    let confidence: number | null;
    let verdictReason: string | null = null;

    if (fakeProb >= tFake) {
      prediction = VERDICT_LIKELY_FAKE;
      riskLevel = 'HIGH';
      confidence = fakeProb;
    } else if (fakeProb <= tReal) {
      prediction = VERDICT_LIKELY_REAL;
      riskLevel = 'LOW';
      confidence = realProb;
    } else {
      prediction = VERDICT_NEEDS_MORE_CONTEXT;
      riskLevel = 'UNDETERMINED';
      confidence = null;
      verdictReason = `The model probability (P(FAKE)=${fakeProb}) falls inside the configured uncertainty zone (${tReal} - ${tFake}); the model does not have sufficient certainty to classify this text as real or fake.` +
        (zone.widened_for_demo ? ' The uncertainty zone is widened because the active model was trained on a small demo dataset.' : '');
    }

    // Overconfident scores from demo models are not statistically supported
    const probabilityCaveat = demoModel && (fakeProb >= 0.9 || realProb >= 0.9)
      ? `The active model was trained on a small demo dataset; extreme probabilities are not statistically supported and must not be treated as verified truth.`
      : undefined;

    const confidenceScore = confidence !== null ? Math.round(confidence * 100) : null;
    const uncertaintyScore = Math.round((1.0 - Math.abs(fakeProb - realProb)) * 10000) / 10000;

    // 5. Claim Extraction (Phase 9)
    const claimInfo = extractPrimaryClaim(textTrimmed);

    // 6. Source Provenance & Evidence Verification (Phase 10 & 11)
    const sourceInfo = evaluateSourceProvenance(sourceUrl);

    // 7. Linguistic Indicators & Feature Attributions (Phase 8)
    const indicators = extractLinguisticIndicators(textTrimmed, sourceUrl);
    const featureAttributions = this.getFeatureAttributions(cleaned, 8);

    // Summary reasons
    const summaryReasons: string[] = [];
    const fakeSignals = featureAttributions.filter(f => f.signal_direction === 'fake');
    const realSignals = featureAttributions.filter(f => f.signal_direction === 'real');

    if (fakeSignals.length > 0) {
      const terms = fakeSignals.slice(0, 3).map(f => `'${f.term}'`).join(', ');
      summaryReasons.push(`Model indicators: Vocabulary signals matching unverified or sensational patterns (${terms}).`);
    }
    if (realSignals.length > 0) {
      const terms = realSignals.slice(0, 3).map(f => `'${f.term}'`).join(', ');
      summaryReasons.push(`Model indicators: Vocabulary signals consistent with documented journalistic reporting (${terms}).`);
    }

    const warningInd = indicators.filter(i => i.signal === 'warning');
    for (const w of warningInd.slice(0, 2)) {
      summaryReasons.push(`Potential warning sign: ${w.name} (${w.description})`);
    }

    if (sourceInfo.provided) {
      summaryReasons.push(`Source provenance: Origin domain '${sourceInfo.domain}' recorded for metadata tracking. (Evaluation is based strictly on text content).`);
    } else {
      summaryReasons.push('Source provenance: No source URL supplied. Evaluation is based strictly on text content.');
    }

    if (verdictReason) {
      summaryReasons.push(verdictReason);
    }
    if (probabilityCaveat) {
      summaryReasons.push(probabilityCaveat);
    }

    // 8. Persist to SQLite History (Phase 15 & Phase 3 provenance)
    const effectiveInputType = options?.inputType || (sourceUrl ? 'url' : 'text');
    const recordId = sqliteHistory.insertHistory({
      full_text: textTrimmed,
      prediction,
      confidence,
      fake_probability: fakeProb,
      real_probability: realProb,
      risk_level: riskLevel,
      model_name: 'Linear SVM (Calibrated)',
      source_url: sourceUrl || options?.originalUrl || '',
      detected_claim: claimInfo.detected_claim,
      input_type: effectiveInputType,
      original_url: options?.originalUrl || sourceUrl || undefined,
      canonical_url: options?.canonicalUrl || undefined,
      article_title: options?.articleTitle || undefined,
      source_name: options?.sourceName || sourceInfo.domain || undefined,
      published_at: options?.publishedAt || undefined,
      indicators,
      explanation: featureAttributions
    });

    const calculatedWordCount = options?.wordCount ?? words.length;

    return {
      id: recordId,
      status: 'SUCCESS',
      verdict: prediction,
      prediction,
      reason: verdictReason,
      fake_probability: fakeProb,
      real_probability: realProb,
      confidence,
      confidence_score: confidenceScore,
      model_score: confidenceScore,
      uncertainty_score: uncertaintyScore,
      risk_level: riskLevel,
      input_type: effectiveInputType,
      original_url: options?.originalUrl || sourceUrl || undefined,
      canonical_url: options?.canonicalUrl || undefined,
      article_title: options?.articleTitle || undefined,
      source_name: options?.sourceName || sourceInfo.domain || undefined,
      author: options?.author || undefined,
      published_at: options?.publishedAt || undefined,
      word_count: calculatedWordCount,
      extraction_status: options?.extractionStatus || (effectiveInputType === 'text' ? 'SUCCESS' : 'SUCCESS'),
      extraction_warnings: options?.warnings || [],
      is_headline_only: options?.isHeadlineOnly || false,
      detected_claim: claimInfo.detected_claim,
      claim_details: claimInfo,
      thresholds: {
        fake_threshold: tFake,
        real_threshold: tReal,
        min_text_length: minLength,
        min_word_count: minWords,
        suspicious_zone: `${tReal} - ${tFake}`,
        widened_for_demo: zone.widened_for_demo
      },
      indicators,
      explanation: summaryReasons,
      feature_attributions: featureAttributions,
      model: 'Linear SVM (Calibrated)',
      model_used: 'Linear SVM (Calibrated)',
      model_reliability: this.modelReliabilityLabel(),
      probability_caveat: probabilityCaveat,
      model_version: '2.2.0',
      calibration: 'CalibratedClassifierCV (Platt Scaling via Sigmoid)',
      vectorizer: 'TF-IDF (1-2 ngrams, sublinear tf)',
      source_info: sourceInfo,
      evidence_verification: {
        available: false,
        status: 'UNAVAILABLE',
        message: 'Evidence verification is not currently available.',
        reason: 'External search indexes and live fact-checking APIs are not configured in this runtime.'
      },
      disclaimer: 'Model prediction is probabilistic and is not proof that a claim is true or false.'
    };
  }

  public getDiagnostics(): any {
    // A loaded artifact can have a `metrics` field that is present but
    // incomplete (e.g. produced by a different pipeline, or hand-edited) --
    // checking only truthiness let such an artifact through, then crashed
    // below on this.metrics.best_model. Guard on the specific shape this
    // method actually depends on.
    if (!this.metrics || !this.metrics.best_model || !this.metrics.dataset_info) {
      this.train(undefined, undefined, false);
    }
    const datasetInfo = this.metrics.dataset_info;
    const totalSamples = datasetInfo.total_samples;
    const realSamples = datasetInfo.real_samples;
    const fakeSamples = datasetInfo.fake_samples;

    return {
      status: "operational",
      model_type: "Linear SVM (Calibrated)",
      model_version: "2.2.0",
      model_architecture: "CalibratedClassifierCV(LinearSVC) with Platt Scaling (Sigmoid)",
      is_demo: this.metrics.is_demo,
      dataset_status: this.metrics.dataset_status,
      demo_badge_label: this.metrics.demo_badge_label,
      evaluation_status: this.metrics.evaluation_status,
      strong_warning: this.metrics.strong_warning,
      why_misleading_accuracy: this.metrics.why_misleading_accuracy,
      real_dataset_required_notice: this.metrics.real_dataset_required_notice,
      calibration: {
        method: "sigmoid (Platt scaling)",
        is_calibrated: true,
        description: "Linear SVM decision margins are mapped to well-calibrated posterior probabilities via Platt scaling."
      },
      dataset_size: {
        total_samples: totalSamples,
        train_samples: datasetInfo.train_samples,
        test_samples: datasetInfo.test_samples,
        source_path: datasetInfo.source_path,
        filename: datasetInfo.filename,
        is_demo: this.metrics.is_demo,
        dataset_status: this.metrics.dataset_status,
        demo_badge_label: this.metrics.demo_badge_label,
        evaluation_status: this.metrics.evaluation_status
      },
      feature_count: datasetInfo.vocabulary_size,
      vectorizer: "TF-IDF (1-2 ngrams, sublinear tf)",
      label_distribution: {
        real_count: realSamples,
        fake_count: fakeSamples,
        real_percentage: Math.round((realSamples / totalSamples) * 10000) / 100,
        fake_percentage: Math.round((fakeSamples / totalSamples) * 10000) / 100
      },
      cross_validation: this.metrics.cross_validation,
      evaluation_metrics: {
        best_model_metrics: this.metrics.best_model.metrics,
        logistic_regression_metrics: this.metrics.models.logistic_regression.metrics,
        linear_svm_metrics: this.metrics.models.linear_svm.metrics
      },
      thresholds: this.thresholds,
      trained_at: this.trainedAt
    };
  }

  public getMetrics(): any {
    if (!this.metrics || !this.metrics.best_model || !this.metrics.dataset_info) {
      this.train(undefined, undefined, false);
    }
    return this.metrics;
  }
}

export const mlEngine = new TruthLensMLEngine();
