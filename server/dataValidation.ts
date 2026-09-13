import fs from 'fs';
import path from 'path';

export interface ParsedArticleRecord {
  id: number;
  title: string;
  text: string;
  combined: string;
  label: number; // 0 = REAL, 1 = FAKE
  rawLabel: string;
}

export interface DatasetValidationReport {
  status: 'VALID' | 'WARNING' | 'ERROR';
  is_demo: boolean;
  dataset_status: 'DEMO DATASET' | 'VALIDATED BENCHMARK';
  evaluation_status: string;
  demo_badge_label: string;
  strong_warning?: string;
  filename: string;
  file_path: string;
  total_samples: number;
  available_columns: string[];
  text_columns: string[];
  label_column: string;
  real_samples: number;
  fake_samples: number;
  class_distribution: {
    REAL: { count: number; percentage: number };
    FAKE: { count: number; percentage: number };
  };
  class_balance: string;
  imbalance_ratio: number;
  missing_values: number;
  invalid_labels_count: number;
  duplicate_articles: number;
  short_articles: number;
  issues: string[];
  warnings: string[];
  parsed_records?: ParsedArticleRecord[];
}

/**
 * Robust CSV parser implementing RFC 4180
 * Handles multi-line quoted fields, escaped quotes (""), and varied line breaks.
 */
export function parseCSV(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let insideQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const nextChar = i + 1 < content.length ? content[i + 1] : '';

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        // Escaped quote: "" -> "
        currentCell += '"';
        i += 2;
        continue;
      } else {
        // Toggle quote state
        insideQuotes = !insideQuotes;
        i++;
        continue;
      }
    }

    if (!insideQuotes && char === ',') {
      currentRow.push(currentCell.trim());
      currentCell = '';
      i++;
      continue;
    }

    if (!insideQuotes && (char === '\r' || char === '\n')) {
      if (char === '\r' && nextChar === '\n') {
        i += 2;
      } else {
        i++;
      }
      currentRow.push(currentCell.trim());
      // Only push non-empty rows
      if (currentRow.some(cell => cell.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
      continue;
    }

    currentCell += char;
    i++;
  }

  // Flush remaining cell/row
  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some(cell => cell.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Validate dataset from a file or raw string content
 */
export function validateDatasetContent(
  csvContent: string,
  filename = 'news.csv',
  filePath = ''
): DatasetValidationReport {
  const issues: string[] = [];
  const warnings: string[] = [];

  const rawRows = parseCSV(csvContent);
  if (rawRows.length === 0) {
    return {
      status: 'ERROR',
      is_demo: true,
      dataset_status: 'DEMO DATASET',
      evaluation_status: 'Insufficient for reliable benchmark',
      demo_badge_label: 'DEMO DATASET — NOT SUITABLE FOR FINAL MODEL EVALUATION',
      filename,
      file_path: filePath,
      total_samples: 0,
      available_columns: [],
      text_columns: [],
      label_column: '',
      real_samples: 0,
      fake_samples: 0,
      class_distribution: {
        REAL: { count: 0, percentage: 0 },
        FAKE: { count: 0, percentage: 0 }
      },
      class_balance: 'EMPTY',
      imbalance_ratio: 1,
      missing_values: 0,
      invalid_labels_count: 0,
      duplicate_articles: 0,
      short_articles: 0,
      issues: ['The CSV file is completely empty or contains no valid rows.'],
      warnings: []
    };
  }

  // Header detection
  const headerRow = rawRows[0].map(c => c.trim().toLowerCase());
  let titleIdx = -1;
  let textIdx = -1;
  let labelIdx = -1;

  for (let j = 0; j < headerRow.length; j++) {
    const col = headerRow[j];
    if (col === 'text' || col === 'article' || col === 'content' || col === 'body' || col === 'article_text') {
      textIdx = j;
    } else if (col === 'title' || col === 'headline' || col === 'subject') {
      titleIdx = j;
    } else if (col === 'label' || col === 'target' || col === 'class' || col === 'category' || col === 'fake_or_real') {
      labelIdx = j;
    }
  }

  // Validation: Must have at least a text column and a label column
  if (textIdx === -1) {
    issues.push("Missing required text column. Expected one of: 'text', 'article', 'content', 'body'.");
  }
  if (labelIdx === -1) {
    issues.push("Missing required label column. Expected one of: 'label', 'target', 'class', 'category'.");
  }

  if (issues.length > 0) {
    return {
      status: 'ERROR',
      is_demo: true,
      dataset_status: 'DEMO DATASET',
      evaluation_status: 'Insufficient for reliable benchmark',
      demo_badge_label: 'DEMO DATASET — NOT SUITABLE FOR FINAL MODEL EVALUATION',
      filename,
      file_path: filePath,
      total_samples: 0,
      available_columns: rawRows[0],
      text_columns: textIdx !== -1 ? [rawRows[0][textIdx]] : [],
      label_column: labelIdx !== -1 ? rawRows[0][labelIdx] : '',
      real_samples: 0,
      fake_samples: 0,
      class_distribution: {
        REAL: { count: 0, percentage: 0 },
        FAKE: { count: 0, percentage: 0 }
      },
      class_balance: 'INVALID_COLUMNS',
      imbalance_ratio: 1,
      missing_values: 0,
      invalid_labels_count: 0,
      duplicate_articles: 0,
      short_articles: 0,
      issues,
      warnings
    };
  }

  let realSamples = 0;
  let fakeSamples = 0;
  let missingValues = 0;
  let invalidLabelsCount = 0;
  let duplicateArticles = 0;
  let shortArticles = 0;
  const seenTexts = new Set<string>();
  const parsedRecords: ParsedArticleRecord[] = [];

  for (let r = 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (row.length === 0 || (row.length === 1 && !row[0])) continue;

    const titleVal = titleIdx !== -1 && titleIdx < row.length ? row[titleIdx].trim() : '';
    const textVal = textIdx < row.length ? row[textIdx].trim() : '';
    const labelRaw = labelIdx < row.length ? row[labelIdx].trim() : '';
    const labelNormalized = labelRaw.toUpperCase();

    // Check empty article
    if (!titleVal && !textVal) {
      missingValues++;
      continue;
    }

    // Check label
    let numericLabel = -1;
    if (labelNormalized === 'REAL' || labelNormalized === '0' || labelNormalized === 'TRUE' || labelNormalized === 'LEGIT') {
      numericLabel = 0;
      realSamples++;
    } else if (labelNormalized === 'FAKE' || labelNormalized === '1' || labelNormalized === 'FALSE' || labelNormalized === 'HOAX') {
      numericLabel = 1;
      fakeSamples++;
    } else {
      invalidLabelsCount++;
      issues.push(`Row ${r + 1}: Unrecognized label '${labelRaw}'. Must be 'REAL' or 'FAKE'.`);
      continue;
    }

    const combined = `${titleVal} ${textVal}`.trim();
    if (combined.length < 60) {
      shortArticles++;
    }

    // Deduplication check
    const normalizedKey = combined.toLowerCase().replace(/\s+/g, ' ').substring(0, 300);
    if (seenTexts.has(normalizedKey)) {
      duplicateArticles++;
      warnings.push(`Row ${r + 1}: Duplicate article content detected.`);
    } else {
      seenTexts.add(normalizedKey);
    }

    parsedRecords.push({
      id: r,
      title: titleVal,
      text: textVal,
      combined,
      label: numericLabel,
      rawLabel: labelRaw
    });
  }

  const totalValid = parsedRecords.length;

  // Minimum dataset checks
  if (totalValid < 10) {
    issues.push(`Dataset contains only ${totalValid} valid samples. Minimum required for model training is 10 samples.`);
  }

  // Check class imbalance
  const minClass = Math.min(realSamples, fakeSamples);
  const maxClass = Math.max(realSamples, fakeSamples);
  const imbalanceRatio = minClass > 0 ? Math.round((maxClass / minClass) * 10) / 10 : maxClass;

  if (realSamples === 0 || fakeSamples === 0) {
    issues.push('Dataset lacks one of the required binary classes (either 0 REAL or 0 FAKE articles).');
  } else if (imbalanceRatio > 3.0) {
    warnings.push(`Severe class imbalance detected (${imbalanceRatio}:1). Stratified sampling will balance folds, but model may bias toward majority class.`);
  } else if (imbalanceRatio > 1.5) {
    warnings.push(`Moderate class imbalance detected (${imbalanceRatio}:1).`);
  }

  if (duplicateArticles > 0) {
    warnings.push(`Found ${duplicateArticles} duplicate articles. Duplicate entries can cause test set contamination.`);
  }

  if (shortArticles > 0) {
    warnings.push(`Found ${shortArticles} articles shorter than 60 characters. Brief snippets provide insufficient linguistic signals.`);
  }

  // Determine whether this is demo data or validated data
  const isDemo = totalValid <= 50 || filename === 'news.csv' || filename === 'demo_news.csv';
  const datasetStatus: 'DEMO DATASET' | 'VALIDATED BENCHMARK' = isDemo ? 'DEMO DATASET' : 'VALIDATED BENCHMARK';
  
  let evaluationStatus: string;
  let strongWarning: string | undefined;

  if (totalValid < 10) {
    evaluationStatus = 'Cannot evaluate (sample size < 10)';
    strongWarning = `Only ${totalValid} articles available. Model training cannot proceed.`;
  } else if (isDemo) {
    evaluationStatus = 'Insufficient for reliable benchmark';
    strongWarning = `Only ${totalValid} articles available. Model performance is not statistically reliable.`;
  } else if (totalValid < 150) {
    evaluationStatus = 'Preliminary Benchmark (Sub-optimal statistical power)';
    strongWarning = `Moderate sample size (${totalValid} articles). For production-grade benchmarking, 500+ articles recommended.`;
  } else {
    evaluationStatus = 'Validated Benchmark (Stratified 5-Fold CV + Held-out Test)';
  }

  const realPct = totalValid > 0 ? Math.round((realSamples / totalValid) * 1000) / 10 : 0;
  const fakePct = totalValid > 0 ? Math.round((fakeSamples / totalValid) * 1000) / 10 : 0;

  const status: 'VALID' | 'WARNING' | 'ERROR' = issues.length > 0 ? 'ERROR' : (warnings.length > 0 ? 'WARNING' : 'VALID');

  return {
    status,
    is_demo: isDemo,
    dataset_status: datasetStatus,
    evaluation_status: evaluationStatus,
    demo_badge_label: 'DEMO DATASET — NOT SUITABLE FOR FINAL MODEL EVALUATION',
    strong_warning: strongWarning,
    filename,
    file_path: filePath,
    total_samples: totalValid,
    available_columns: rawRows[0],
    text_columns: titleIdx !== -1 ? [rawRows[0][titleIdx], rawRows[0][textIdx]] : [rawRows[0][textIdx]],
    label_column: rawRows[0][labelIdx],
    real_samples: realSamples,
    fake_samples: fakeSamples,
    class_distribution: {
      REAL: { count: realSamples, percentage: realPct },
      FAKE: { count: fakeSamples, percentage: fakePct }
    },
    class_balance: imbalanceRatio <= 1.5 ? 'BALANCED' : `IMBALANCED (${imbalanceRatio}:1)`,
    imbalance_ratio: imbalanceRatio,
    missing_values: missingValues,
    invalid_labels_count: invalidLabelsCount,
    duplicate_articles: duplicateArticles,
    short_articles: shortArticles,
    issues,
    warnings,
    parsed_records: parsedRecords
  };
}

/**
 * Validate dataset from disk path
 */
export function validateDataset(csvPath?: string): DatasetValidationReport {
  const targetPath = csvPath || path.join(process.cwd(), 'data', 'news.csv');

  if (!fs.existsSync(targetPath)) {
    return {
      status: 'ERROR',
      is_demo: true,
      dataset_status: 'DEMO DATASET',
      evaluation_status: 'Insufficient for reliable benchmark',
      demo_badge_label: 'DEMO DATASET — NOT SUITABLE FOR FINAL MODEL EVALUATION',
      strong_warning: 'Dataset file not found.',
      filename: path.basename(targetPath),
      file_path: targetPath,
      total_samples: 0,
      available_columns: [],
      text_columns: [],
      label_column: '',
      real_samples: 0,
      fake_samples: 0,
      class_distribution: {
        REAL: { count: 0, percentage: 0 },
        FAKE: { count: 0, percentage: 0 }
      },
      class_balance: 'UNKNOWN',
      imbalance_ratio: 1,
      missing_values: 0,
      invalid_labels_count: 0,
      duplicate_articles: 0,
      short_articles: 0,
      issues: ['DATASET NOT FOUND AT: ' + targetPath],
      warnings: []
    };
  }

  const content = fs.readFileSync(targetPath, 'utf-8');
  return validateDatasetContent(content, path.basename(targetPath), targetPath);
}
