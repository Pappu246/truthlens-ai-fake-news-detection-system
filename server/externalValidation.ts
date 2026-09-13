import fs from 'fs';
import path from 'path';

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
    isot_characteristics: string[];
    liar_characteristics: string[];
    conclusion: string;
  };
  sample_predictions: SamplePredictionRecord[];
}

const EXTERNAL_EVAL_FILE = path.join(process.cwd(), 'data', 'external_validation.json');

export function getExternalValidationReport(): ExternalValidationReport | null {
  try {
    if (fs.existsSync(EXTERNAL_EVAL_FILE)) {
      const raw = fs.readFileSync(EXTERNAL_EVAL_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('[ExternalValidation] Failed to read cached report:', err);
  }
  return null;
}

export function saveExternalValidationReport(report: ExternalValidationReport) {
  try {
    const dir = path.dirname(EXTERNAL_EVAL_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(EXTERNAL_EVAL_FILE, JSON.stringify(report, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ExternalValidation] Failed to write report:', err);
  }
}
