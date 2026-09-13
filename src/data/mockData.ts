import { DemoExample, ModelComparisonData } from '../types';

export const DEFAULT_DEMO_EXAMPLES: DemoExample[] = [
  {
    id: 'real-1',
    title: 'Likely Real (Peer-Reviewed Science)',
    category: 'Science / Peer Review',
    expected_outcome: 'LIKELY REAL',
    source_url: 'https://www.nasa.gov/press-release/james-webb-star-formation',
    text: 'Astronomers utilizing the James Webb Space Telescope have captured unprecedented infrared observations of star-forming regions in the nearby NGC 346 cluster. According to peer-reviewed findings published this week in the Astrophysical Journal, spectroscopic data confirms molecular hydrogen density variations consistent with theoretical models of stellar nurseries. Lead astrophysicists stated that the observations provide critical calibration measurements for understanding galactic evolution during the cosmic noon epoch. Further telemetry data have been archived at the Space Telescope Science Institute for open academic inquiry.'
  },
  {
    id: 'fake-1',
    title: 'Likely Fake (Sensational Conspiracy)',
    category: 'Clickbait / Misinformation',
    expected_outcome: 'LIKELY FAKE',
    source_url: '',
    text: 'SHOCKING SECRET EXPOSED BY MILITARY WHISTLEBLOWER! Alien mothership cloaked behind the moon has been detected! The mainstream corrupt media and globalist elites are frantically censoring this unbelievable miracle video! Top insiders confirm that world leaders signed a secret treaty allowing deep-state extraction operations in exchange for zero-point energy weapons! Share this emergency alert immediately before they delete the internet! Wake up people!'
  },
  {
    id: 'ambiguous-1',
    title: 'Suspicious / Ambiguous (Unverified Rumor)',
    category: 'Tech Rumor / PR',
    expected_outcome: 'NEEDS MORE CONTEXT',
    source_url: 'http://unverified-tech-leaks.blog',
    text: 'Insiders claim that a groundbreaking quantum computing processor may launch ahead of schedule next month, according to unconfirmed supply chain rumors circulating in Asian markets. Early reports suggest performance improvements of up to 400 percent over existing silicon architectures, though independent benchmarks have not yet been made public. Company representatives declined to comment on future product roadmaps or verify specifications.'
  }
];

/**
 * Honest placeholder shown ONLY until /api/models/metrics responds. It must
 * never masquerade as a real benchmark: all numbers are zero and the status
 * makes it clear that real metrics are being fetched from the backend.
 */
export const INITIAL_METRICS_DATA: ModelComparisonData = {
  dataset_path: "data/news.csv",
  dataset_name: "Loading from backend…",
  total_samples: 0,
  training_samples: 0,
  test_samples: 0,
  best_model: "linear_svm",
  selection_metric: "f1_score",
  last_trained: new Date(0).toISOString(),
  is_demo: true,
  dataset_status: "AWAITING BACKEND",
  evaluation_status: "Fetching real evaluation metrics from the backend…",
  demo_badge_label: "LOADING FROM BACKEND…",
  limitation: "Metrics are being fetched from the backend. Values shown until then are placeholders, not real benchmark results.",
  raw_counts_before_cleaning: {
    real_articles: 0,
    fake_articles: 0,
    total_articles: 0
  },
  cleaning_statistics: {
    removed_empty_title_text: 0,
    removed_duplicates: 0,
    removed_invalid_rows: 0,
    total_removed_rows: 0
  },
  cross_validation: {
    n_splits: 0,
    method: "Not loaded yet",
    leakage_guard_note: "TF-IDF vocabulary and IDF weights are fitted exclusively inside each training fold without access to validation fold.",
    logistic_regression: {
      accuracy_mean: 0,
      accuracy_std: 0,
      precision_mean: 0,
      precision_std: 0,
      recall_mean: 0,
      recall_std: 0,
      f1_mean: 0,
      f1_std: 0
    },
    linear_svm: {
      accuracy_mean: 0,
      accuracy_std: 0,
      precision_mean: 0,
      precision_std: 0,
      recall_mean: 0,
      recall_std: 0,
      f1_mean: 0,
      f1_std: 0
    }
  },
  logistic_regression: {
    accuracy: 0,
    macro_f1: 0,
    weighted_f1: 0,
    precision_fake: 0,
    recall_fake: 0,
    f1_fake: 0,
    precision_real: 0,
    recall_real: 0,
    f1_real: 0,
    confusion_matrix: {
      true_real: 0,
      false_fake: 0,
      false_real: 0,
      true_fake: 0
    }
  },
  linear_svm: {
    accuracy: 0,
    macro_f1: 0,
    weighted_f1: 0,
    precision_fake: 0,
    recall_fake: 0,
    f1_fake: 0,
    precision_real: 0,
    recall_real: 0,
    f1_real: 0,
    confusion_matrix: {
      true_real: 0,
      false_fake: 0,
      false_real: 0,
      true_fake: 0
    }
  }
};
