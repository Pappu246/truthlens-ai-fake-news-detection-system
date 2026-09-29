/**
 * V2 EVALUATION METRICS (PHASE 9)
 * ================================
 * Pure functions, no side effects, so they can be unit-tested and reused by
 * both `scripts/v2Evaluate.ts` and any future CI gate.
 *
 * HARD RULE ENFORCED HERE: `highConfidencePrecisionWithCoverage` always
 * returns coverage bundled with precision — there is no function in this
 * module that can report a "high-confidence precision" number without also
 * reporting what fraction of the set that precision was computed over.
 */

export function recallAtK(goldRelevantUrls: string[], retrievedUrlsRankedByScore: string[], k: number): number {
  if (goldRelevantUrls.length === 0) return 1; // nothing to find => vacuously satisfied
  const topK = new Set(retrievedUrlsRankedByScore.slice(0, k));
  const found = goldRelevantUrls.filter(u => topK.has(u)).length;
  return found / goldRelevantUrls.length;
}

export function precisionAtK(relevantSet: Set<string>, retrievedUrlsRankedByScore: string[], k: number): number {
  const topK = retrievedUrlsRankedByScore.slice(0, k);
  if (topK.length === 0) return 0;
  const relevant = topK.filter(u => relevantSet.has(u)).length;
  return relevant / topK.length;
}

export interface ClassAccuracyF1 {
  label: string;
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface MultiClassReport {
  accuracy: number;
  macroF1: number;
  perClass: ClassAccuracyF1[];
  n: number;
}

export function multiClassAccuracyF1(predictions: string[], gold: string[]): MultiClassReport {
  const n = Math.min(predictions.length, gold.length);
  const labels = Array.from(new Set([...predictions.slice(0, n), ...gold.slice(0, n)]));
  let correct = 0;
  const perClass: ClassAccuracyF1[] = labels.map(label => {
    let tp = 0, fp = 0, fn = 0, support = 0;
    for (let i = 0; i < n; i++) {
      const p = predictions[i];
      const g = gold[i];
      if (g === label) support++;
      if (p === label && g === label) tp++;
      if (p === label && g !== label) fp++;
      if (p !== label && g === label) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { label, precision, recall, f1, support };
  });
  for (let i = 0; i < n; i++) if (predictions[i] === gold[i]) correct++;
  const accuracy = n === 0 ? 0 : correct / n;
  const macroF1 = perClass.length === 0 ? 0 : perClass.reduce((s, c) => s + c.f1, 0) / perClass.length;
  return { accuracy, macroF1, perClass, n };
}

/**
 * High-confidence precision + coverage, ALWAYS returned together. Never
 * report one without the other — a model can look artificially strong by
 * only reporting precision on the confident subset while hiding that it
 * only fired on 5% of cases.
 */
export interface HighConfidenceReport {
  confidenceThreshold: number;
  coverage: number; // fraction of the full eval set that met the confidence threshold
  precisionAtThreshold: number; // accuracy among ONLY the high-confidence subset
  nAboveThreshold: number;
  nTotal: number;
}

export function highConfidencePrecisionWithCoverage(
  predictions: Array<{ label: string; confidence: number }>,
  gold: string[],
  confidenceThreshold: number
): HighConfidenceReport {
  const nTotal = Math.min(predictions.length, gold.length);
  const aboveThreshold: Array<{ label: string; gold: string }> = [];
  for (let i = 0; i < nTotal; i++) {
    if (predictions[i].confidence >= confidenceThreshold) {
      aboveThreshold.push({ label: predictions[i].label, gold: gold[i] });
    }
  }
  const nAboveThreshold = aboveThreshold.length;
  const correct = aboveThreshold.filter(x => x.label === x.gold).length;
  return {
    confidenceThreshold,
    coverage: nTotal === 0 ? 0 : nAboveThreshold / nTotal,
    precisionAtThreshold: nAboveThreshold === 0 ? 0 : correct / nAboveThreshold,
    nAboveThreshold,
    nTotal
  };
}

export function abstentionRate(verdicts: Array<{ abstained: boolean }>): number {
  if (verdicts.length === 0) return 0;
  return verdicts.filter(v => v.abstained).length / verdicts.length;
}

/** Expected Calibration Error over equal-width confidence bins. */
export interface CalibrationReport {
  expectedCalibrationError: number;
  bins: Array<{ rangeLow: number; rangeHigh: number; n: number; avgConfidence: number; accuracy: number }>;
}

export function expectedCalibrationError(
  predictions: Array<{ correct: boolean; confidence: number }>,
  numBins = 10
): CalibrationReport {
  const bins: Array<{ rangeLow: number; rangeHigh: number; items: Array<{ correct: boolean; confidence: number }> }> = [];
  for (let i = 0; i < numBins; i++) {
    bins.push({ rangeLow: i / numBins, rangeHigh: (i + 1) / numBins, items: [] });
  }
  for (const p of predictions) {
    const idx = Math.min(numBins - 1, Math.floor(p.confidence * numBins));
    bins[Math.max(0, idx)].items.push(p);
  }
  const n = predictions.length || 1;
  let ece = 0;
  const binsOut = bins.map(b => {
    const count = b.items.length;
    const avgConfidence = count === 0 ? 0 : b.items.reduce((s, x) => s + x.confidence, 0) / count;
    const accuracy = count === 0 ? 0 : b.items.filter(x => x.correct).length / count;
    ece += (count / n) * Math.abs(avgConfidence - accuracy);
    return { rangeLow: b.rangeLow, rangeHigh: b.rangeHigh, n: count, avgConfidence, accuracy };
  });
  return { expectedCalibrationError: ece, bins: binsOut };
}


export function brierScore(predictions: Array<{ correct: boolean; confidence: number }>): number {
  if (predictions.length === 0) return 0;
  const mean = predictions.reduce((sum, p) => {
    const confidence = Math.max(0, Math.min(1, p.confidence));
    const target = p.correct ? 1 : 0;
    return sum + Math.pow(confidence - target, 2);
  }, 0);
  return mean / predictions.length;
}

function logit(probability: number): number {
  const p = Math.max(1e-6, Math.min(1 - 1e-6, probability));
  return Math.log(p / (1 - p));
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

/**
 * Fits a scalar temperature on a calibration split by minimising binary NLL
 * of "is this final verdict correct?" over the supplied confidence values.
 * This does not change categorical verdicts and is intentionally separate from
 * the runtime policy until a held-out calibration artifact is adopted.
 */
export function fitConfidenceTemperature(
  samples: Array<{ correct: boolean; confidence: number }>,
  minTemperature = 0.25,
  maxTemperature = 4,
  step = 0.05
): number {
  if (samples.length === 0) return 1;

  let bestTemperature = 1;
  let bestLoss = Number.POSITIVE_INFINITY;

  for (let temperature = minTemperature; temperature <= maxTemperature + 1e-9; temperature += step) {
    let loss = 0;
    for (const sample of samples) {
      const calibrated = sigmoid(logit(sample.confidence) / temperature);
      const target = sample.correct ? 1 : 0;
      loss += -(target * Math.log(Math.max(calibrated, 1e-12)) +
        (1 - target) * Math.log(Math.max(1 - calibrated, 1e-12)));
    }
    loss /= samples.length;
    if (loss < bestLoss) {
      bestLoss = loss;
      bestTemperature = Number(temperature.toFixed(4));
    }
  }

  return bestTemperature;
}

export function applyConfidenceTemperature(confidence: number, temperature: number): number {
  if (!Number.isFinite(temperature) || temperature <= 0) return Math.max(0, Math.min(1, confidence));
  return sigmoid(logit(confidence) / temperature);
}
