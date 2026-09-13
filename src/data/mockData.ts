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
    expected_outcome: 'SUSPICIOUS',
    source_url: 'http://unverified-tech-leaks.blog',
    text: 'Insiders claim that a groundbreaking quantum computing processor may launch ahead of schedule next month, according to unconfirmed supply chain rumors circulating in Asian markets. Early reports suggest performance improvements of up to 400 percent over existing silicon architectures, though independent benchmarks have not yet been made public. Company representatives declined to comment on future product roadmaps or verify specifications.'
  }
];

export const INITIAL_METRICS_DATA: ModelComparisonData = {
  dataset_path: "data/True.csv & data/Fake.csv",
  dataset_name: "ISOT Fake News Dataset",
  total_samples: 38656,
  training_samples: 30924,
  test_samples: 7732,
  best_model: "linear_svm",
  selection_metric: "f1_score",
  last_trained: "2026-09-06T10:50:50.640552Z",
  is_demo: false,
  dataset_status: "ISOT BENCHMARK DATASET",
  evaluation_status: "Evaluated on genuine 20% held-out test split (N=7,732)",
  demo_badge_label: "PRODUCTION BENCHMARK (ISOT DATASET)",
  limitation: "The model is trained on the ISOT dataset, which primarily contains English news from an older time period. Performance may not generalize to current news, Hindi/Hinglish content, satire, or domains outside the training distribution.",
  raw_counts_before_cleaning: {
    real_articles: 21417,
    fake_articles: 23481,
    total_articles: 44898
  },
  cleaning_statistics: {
    removed_empty_title_text: 631,
    removed_duplicates: 5611,
    removed_invalid_rows: 0,
    total_removed_rows: 6242
  },
  cross_validation: {
    n_splits: 5,
    method: "Stratified 5-Fold Cross-Validation",
    leakage_guard_note: "TF-IDF vocabulary and IDF weights fitted exclusively inside each training fold without access to validation fold.",
    logistic_regression: {
      accuracy_mean: 0.9904,
      accuracy_std: 0.0013,
      precision_mean: 0.9947,
      precision_std: 0.0005,
      recall_mean: 0.9840,
      recall_std: 0.0032,
      f1_mean: 0.9893,
      f1_std: 0.0015
    },
    linear_svm: {
      accuracy_mean: 0.9959,
      accuracy_std: 0.0007,
      precision_mean: 0.9960,
      precision_std: 0.0008,
      recall_mean: 0.9949,
      recall_std: 0.0013,
      f1_mean: 0.9955,
      f1_std: 0.0008
    }
  },
  logistic_regression: {
    accuracy: 0.9908,
    macro_f1: 0.9898,
    weighted_f1: 0.9898,
    precision_fake: 0.9942,
    recall_fake: 0.9854,
    f1_fake: 0.9898,
    precision_real: 0.9942,
    recall_real: 0.9854,
    f1_real: 0.9898,
    confusion_matrix: {
      true_real: 4219,
      false_fake: 20,
      false_real: 51,
      true_fake: 3442
    }
  },
  linear_svm: {
    accuracy: 0.9957,
    macro_f1: 0.9953,
    weighted_f1: 0.9953,
    precision_fake: 0.9940,
    recall_fake: 0.9966,
    f1_fake: 0.9953,
    precision_real: 0.9940,
    recall_real: 0.9966,
    f1_real: 0.9953,
    confusion_matrix: {
      true_real: 4218,
      false_fake: 21,
      false_real: 12,
      true_fake: 3481
    }
  }
};
