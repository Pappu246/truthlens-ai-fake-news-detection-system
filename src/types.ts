/**
 * Canonical verdict contract (backend is the single source of truth):
 *   LIKELY REAL | LIKELY FAKE | NEEDS MORE CONTEXT
 * The legacy labels below are kept for backward compatibility with history
 * records written before the contract change.
 */
export type PredictionLabel =
  | 'LIKELY REAL'
  | 'LIKELY FAKE'
  | 'NEEDS MORE CONTEXT'
  | 'SUSPICIOUS'
  | 'INSUFFICIENT INFORMATION'
  | 'REAL'
  | 'FAKE';

export function isNeedsMoreContextLabel(label: string | undefined | null): boolean {
  return (
    label === 'NEEDS MORE CONTEXT' ||
    label === 'INSUFFICIENT INFORMATION' ||
    label === 'SUSPICIOUS'
  );
}

export interface LinguisticSignals {
  sensational_count: number;
  sensational_words: string[];
  polarizing_count: number;
  polarizing_words: string[];
  all_caps_words_count: number;
  excessive_punctuation: boolean;
  exclamation_count: number;
  question_count: number;
  has_source: boolean;
  source_trust: 'TRUSTED' | 'UNVERIFIED' | 'SUSPICIOUS_TLD' | 'NONE';
  source_notes: string;
}

export interface FeatureAttribution {
  word: string;
  weight: number;
  direction: 'indicates_fake' | 'indicates_real';
  term?: string;
  signal_direction?: 'fake' | 'real';
  signal_label?: string;
  intensity?: number;
  impact_score?: number;
}

export interface SourceProvenanceInfo {
  provided: boolean;
  url: string | null;
  domain: string | null;
  source_status: string;
  verification_status: string;
  notes: string;
}

export interface EvidenceVerificationInfo {
  available: boolean;
  status: string;
  message: string;
  reason?: string;
  results?: any[];
}

/**
 * Content source labeling — explicitly distinguishes what the analysis is
 * based on so the UI never implies "full article" when only RSS summary or
 * a headline was available.
 */
export type ContentSource =
  | 'FULL_ARTICLE_EXTRACTED'
  | 'RSS_SUMMARY_ONLY'
  | 'HEADLINE_ONLY'
  | 'EXTRACTION_BLOCKED'
  | 'TEXT_DIRECT';

export interface AnalysisResult {
  id: string;
  status?: 'SUCCESS' | 'INSUFFICIENT_INFORMATION';
  message?: string;
  /** Canonical verdict from the backend (alias of `prediction`). */
  verdict?: PredictionLabel;
  prediction: PredictionLabel;
  /** Why the backend withheld or softened the verdict, when applicable. */
  reason?: string;
  risk_level: 'LOW' | 'MODERATE' | 'HIGH' | 'UNDETERMINED';
  /**
   * NULL means the backend withheld the probability (e.g. NEEDS MORE CONTEXT
   * for short/vague input). The UI must render N/A — never a fabricated %.
   */
  fake_probability: number | null;
  real_probability: number | null;
  /** NULL means the confidence is not meaningful for this verdict (render N/A). */
  confidence_score: number | null;
  model_score?: number | null;
  uncertainty_score?: number | null;
  model_used: string;
  model_reliability?: string;
  probability_caveat?: string;
  summary: string;
  text_snippet: string;
  source_url?: string;
  detected_claim?: string;
  input_length?: number;
  min_required_length?: number;
  min_required_words?: number;
  input_type?: 'text' | 'url' | 'live_news';
  original_url?: string;
  canonical_url?: string;
  article_title?: string;
  source_name?: string;
  author?: string;
  published_at?: string;
  word_count?: number;
  extraction_status?: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  extraction_warnings?: string[];
  is_headline_only?: boolean;
  /** Content-source label describing exactly what was analyzed. */
  content_source?: ContentSource;
  thresholds?: {
    fake_threshold: number;
    real_threshold: number;
    min_text_length?: number;
    min_word_count?: number;
    suspicious_zone?: string;
    widened_for_demo?: boolean;
  };
  source_info?: SourceProvenanceInfo;
  evidence_verification?: EvidenceVerificationInfo;
  verification?: ArticleVerificationResponse;
  linguistic_signals: LinguisticSignals;
  feature_attributions: FeatureAttribution[];
  explanation?: string[];
  timestamp: string;
}

export interface ModelMetrics {
  accuracy: number;
  macro_f1: number;
  weighted_f1: number;
  precision_fake: number;
  recall_fake: number;
  f1_fake: number;
  precision_real: number;
  recall_real: number;
  f1_real: number;
  confusion_matrix: {
    true_real: number;
    false_fake: number;
    false_real: number;
    true_fake: number;
  };
}

export interface CrossValidationScores {
  accuracy_mean: number;
  accuracy_std: number;
  precision_mean: number;
  precision_std: number;
  recall_mean: number;
  recall_std: number;
  f1_mean: number;
  f1_std: number;
}

export interface ModelComparisonData {
  dataset_path: string;
  dataset_name?: string;
  total_samples: number;
  training_samples: number;
  test_samples: number;
  best_model: string;
  selection_metric: string;
  last_trained: string;
  is_demo: boolean;
  dataset_status: string;
  evaluation_status: string;
  demo_badge_label: string;
  limitation?: string;
  raw_counts_before_cleaning?: {
    real_articles: number;
    fake_articles: number;
    total_articles: number;
  };
  cleaning_statistics?: {
    removed_empty_title_text: number;
    removed_duplicates: number;
    removed_invalid_rows: number;
    total_removed_rows: number;
  };
  strong_warning?: string;
  why_misleading_accuracy?: string;
  real_dataset_required_notice?: string;
  cross_validation?: {
    n_splits: number;
    method: string;
    leakage_guard_note: string;
    logistic_regression: CrossValidationScores;
    linear_svm: CrossValidationScores;
  };
  logistic_regression: ModelMetrics;
  linear_svm: ModelMetrics;
}

export type AnalysisInputMode = 'text' | 'url' | 'live_news';

export interface HistoryItem {
  id: number;
  text_snippet: string;
  full_text?: string;
  source_url: string;
  prediction: PredictionLabel;
  /** NULL = probability was withheld by the backend (render N/A). */
  fake_probability: number | null;
  real_probability?: number | null;
  /** NULL = confidence not meaningful (render N/A). */
  confidence_score: number | null;
  risk_level?: string;
  model_used: string;
  detected_claim?: string;
  input_type?: 'text' | 'url' | 'live_news';
  original_url?: string;
  canonical_url?: string;
  article_title?: string;
  source_name?: string;
  published_at?: string;
  created_at: string;
}

export interface ExtractedArticle {
  success: boolean;
  url: string;
  canonicalUrl?: string;
  normalizedUrl?: string;
  title: string;
  author?: string;
  publishedAt?: string;
  sourceName?: string;
  description?: string;
  content: string;
  wordCount: number;
  characterCount: number;
  paragraphCount: number;
  extractionMethod: string;
  extractionStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  warnings: string[];
  isHeadlineOnly?: boolean;
}

export interface NewsArticle {
  id: string;
  title: string;
  description?: string;
  summary?: string;
  content?: string;
  author?: string;
  url: string;
  sourceName: string;
  publishedAt?: string;
  imageUrl?: string;
  category?: string;
}

export interface NewsFeedResponse {
  articles: NewsArticle[];
  fetchedAt: string;
  provider: string;
  categories?: string[];
  warnings: string[];
  error?: string;
}

export interface DatasetInfo {
  found: boolean;
  path?: string;
  total_records?: number;
  columns?: string[];
  sample_preview?: Array<Record<string, any>>;
  message?: string;
  error?: string;
}

export interface DemoExample {
  id: string;
  title: string;
  category: string;
  expected_outcome: string;
  source_url: string;
  text: string;
}

export interface ExternalValidationMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1_score: number;
  macro_f1: number;
  balanced_accuracy: number;
  fake_class: {
    label: string;
    precision: number;
    recall: number;
    f1_score: number;
  };
  real_class: {
    label: string;
    precision: number;
    recall: number;
    f1_score: number;
  };
}

export interface ExternalValidationConfusionMatrix {
  true_positive: number;
  true_negative: number;
  false_positive: number;
  false_negative: number;
  matrix: number[][];
  labels: string[];
  explanations: {
    true_positive: string;
    true_negative: string;
    false_positive: string;
    false_negative: string;
  };
}

export interface LabelAuditItem {
  original_label: string;
  binary_mapping: 'FAKE' | 'REAL' | 'EXCLUDED';
  count: number;
  status: 'INCLUDED' | 'EXCLUDED';
}

export interface SamplePredictionRecord {
  id: string;
  statement: string;
  original_liar_label: string;
  mapped_binary_label: string;
  predicted_label: string;
  fake_probability: number;
  real_probability: number;
  confidence: number;
  is_correct: boolean;
}

export interface DatasetTextLengthStats {
  mean_words: number;
  median_words: number;
  min_words: number;
  max_words: number;
  total_samples: number;
}

export interface ReutersCitationStats {
  true_csv_total: number;
  true_csv_reuters_count: number;
  true_csv_reuters_percentage: number;
  fake_csv_total: number;
  fake_csv_reuters_count: number;
  fake_csv_reuters_percentage: number;
}

export interface ExternalValidationReport {
  status: 'COMPLETED' | 'RUNNING' | 'NOT AVAILABLE';
  evaluated_at: string;
  dataset_name: string;
  file_used: string;
  production_model: string;
  source_training_dataset: string;
  training_sample_count?: number;
  runtime_feature_space?: string;
  offline_artifact_note?: string;
  model_weights_modified: boolean;
  tf_idf_source: string;
  evaluation_type: string;
  total_test_samples: number;
  valid_text_samples: number;
  excluded_ambiguous_samples: number;
  eligible_binary_samples: number;
  binary_label_distribution: {
    fake: number;
    real: number;
  };
  label_audit: LabelAuditItem[];
  metrics: ExternalValidationMetrics;
  confusion_matrix: ExternalValidationConfusionMatrix;
  text_length_stats?: {
    isot_overall: DatasetTextLengthStats;
    isot_true: DatasetTextLengthStats;
    isot_fake: DatasetTextLengthStats;
    liar_all: DatasetTextLengthStats;
    liar_eligible: DatasetTextLengthStats;
  };
  reuters_citation_stats?: ReutersCitationStats;
  domain_shift_explanation: {
    summary: string;
    production_model_characteristics?: string[];
    isot_characteristics?: string[];
    liar_characteristics: string[];
    conclusion: string;
  };
  sample_predictions: SamplePredictionRecord[];
}

// ==========================================
// PHASE 4: CLAIM EXTRACTION & EVIDENCE TYPES
// ==========================================

export type ClaimType =
  | 'Government / Policy'
  | 'Politics'
  | 'Science'
  | 'Health'
  | 'Economics'
  | 'Finance'
  | 'Technology'
  | 'Crime'
  | 'International'
  | 'Environment'
  | 'Statistics'
  | 'Historical'
  | 'Other';

export type ClaimImportance = 'HIGH' | 'MEDIUM' | 'LOW';

export type ClaimEvidenceRelation = 'SUPPORTS' | 'CONTRADICTS' | 'MIXED' | 'IRRELEVANT' | 'INSUFFICIENT';

export type ClaimAssessment = 'SUPPORTED' | 'CONTRADICTED' | 'MIXED' | 'INSUFFICIENT';

export type FinalAssessment =
  | 'LIKELY SUPPORTED'
  | 'LIKELY FALSE'
  | 'MIXED / CONTESTED'
  | 'UNVERIFIED'
  | 'INSUFFICIENT EVIDENCE';

export type SourceType =
  | 'OFFICIAL_GOVERNMENT'
  | 'OFFICIAL_ORGANIZATION'
  | 'PRIMARY_SCIENTIFIC'
  | 'MAJOR_NEWS'
  | 'REPUTABLE_SOURCE'
  | 'UNKNOWN';

export interface ExtractedClaim {
  claimId: string;
  originalText: string;
  normalizedText: string;
  claimType: ClaimType;
  importance: ClaimImportance;
  entities: string[];
  dates: string[];
  locations: string[];
  numbers: string[];
  keywords: string[];
  searchQueries: string[];
}

export interface NumericalConsistency {
  claimNumbers: string[];
  evidenceNumbers: string[];
  isConsistent: boolean;
  warning?: string;
}

export interface TemporalConsistency {
  claimDate?: string;
  evidenceDate?: string;
  isConsistent: boolean;
  warning?: string;
}

export interface EvidenceItem {
  id: string;
  sourceName: string;
  sourceUrl: string;
  title: string;
  publishedAt?: string;
  retrievedAt: string;
  sourceType: SourceType;
  snippet: string;
  relation: ClaimEvidenceRelation;
  relevanceScore: number;
  relevanceExplanation?: string;
  numericalConsistency?: NumericalConsistency;
  temporalConsistency?: TemporalConsistency;
  isSyndicated?: boolean;
}

export interface ClaimVerificationResult {
  claim: ExtractedClaim;
  assessment: ClaimAssessment;
  assessmentExplanation: string;
  evidence: EvidenceItem[];
  evidenceCounts: {
    supports: number;
    contradicts: number;
    mixed: number;
    insufficient: number;
  };
  numericalWarning?: string;
  temporalConflict?: string;
  sourceDiversity: {
    independentSourcesCount: number;
    totalSourcesCount: number;
    syndicationNote?: string;
  };
  confidence: {
    score: number;
    explanation: string;
  };
}

export interface ArticleVerificationResponse {
  id: string | number;
  article: {
    title?: string;
    url?: string;
    contentPreview: string;
    wordCount: number;
  };
  claims: ClaimVerificationResult[];
  summary: {
    totalClaims: number;
    verifiedClaims: number;
    supported: number;
    contradicted: number;
    mixed: number;
    insufficient: number;
  };
  finalAssessment: FinalAssessment;
  finalAssessmentReasoning: string;
  mlRisk: string;
  mlEvidenceSynthesis: string;
  warnings: string[];
  createdAt: string;
}


