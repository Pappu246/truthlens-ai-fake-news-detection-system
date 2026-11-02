/**
 * Research-only error analysis for a saved v2ScifactEndToEnd report.
 * Does not rerun the model, change decisions, or alter production behavior.
 */
import fs from 'node:fs';

type Label = 'SUPPORT' | 'CONTRADICT' | 'NOT_ENOUGH_INFO';
interface ReportRow {
  id: number;
  gold: Label;
  benchmark_prediction: Label;
  candidate_pool_recall_hit: boolean;
  gold_evidence_ids: string[];
  retrieved_evidence_ids_top5: string[];
}
interface ScifactReport {
  protocol_version?: string;
  run_provenance?: Record<string, unknown>;
  dataset?: Record<string, unknown>;
  rows: ReportRow[];
}

const LABELS: Label[] = ['SUPPORT', 'CONTRADICT', 'NOT_ENOUGH_INFO'];

function assertReport(value: unknown): ScifactReport {
  if (!value || typeof value !== 'object' || !Array.isArray((value as ScifactReport).rows)) {
    throw new Error('Invalid SciFact report: expected an object with a rows array.');
  }
  const report = value as ScifactReport;
  for (const [index, row] of report.rows.entries()) {
    if (!row || !Number.isInteger(row.id) || !LABELS.includes(row.gold) ||
        !LABELS.includes(row.benchmark_prediction) || typeof row.candidate_pool_recall_hit !== 'boolean' ||
        !Array.isArray(row.gold_evidence_ids) || !Array.isArray(row.retrieved_evidence_ids_top5)) {
      throw new Error(`Invalid SciFact report row at index ${index}.`);
    }
  }
  if (report.rows.length === 0) throw new Error('Invalid SciFact report: rows must not be empty.');
  return report;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

export function analyzeScifactReport(input: unknown) {
  const report = assertReport(input);
  const confusion = Object.fromEntries(LABELS.map(gold => [
    gold,
    Object.fromEntries(LABELS.map(predicted => [
      predicted,
      report.rows.filter(row => row.gold === gold && row.benchmark_prediction === predicted).length
    ]))
  ])) as Record<Label, Record<Label, number>>;

  const byGold = Object.fromEntries(LABELS.map(label => {
    const rows = report.rows.filter(row => row.gold === label);
    const goldEvidenceRows = rows.filter(row => row.gold_evidence_ids.length > 0);
    const top5Hits = goldEvidenceRows.filter(row =>
      row.gold_evidence_ids.some(id => row.retrieved_evidence_ids_top5.includes(id))
    ).length;
    const candidateHits = goldEvidenceRows.filter(row => row.candidate_pool_recall_hit).length;
    const predicted = Object.fromEntries(LABELS.map(prediction => [
      prediction,
      rows.filter(row => row.benchmark_prediction === prediction).length
    ]));
    return [label, {
      claims: rows.length,
      predictions: predicted,
      candidate_recall_hits: candidateHits,
      candidate_recall_denominator: goldEvidenceRows.length,
      candidate_recall: rate(candidateHits, goldEvidenceRows.length),
      gold_evidence_top5_hits: top5Hits,
      gold_evidence_top5_denominator: goldEvidenceRows.length,
      gold_evidence_recall_at_5: rate(top5Hits, goldEvidenceRows.length)
    }];
  })) as Record<Label, {
    claims: number;
    predictions: Record<Label, number>;
    candidate_recall_hits: number;
    candidate_recall_denominator: number;
    candidate_recall: number | null;
    gold_evidence_top5_hits: number;
    gold_evidence_top5_denominator: number;
    gold_evidence_recall_at_5: number | null;
  }>;

  const nonContradictGold = report.rows.filter(row => row.gold !== 'CONTRADICT');
  const falseContradictions = nonContradictGold.filter(row => row.benchmark_prediction === 'CONTRADICT');
  const supportRows = report.rows.filter(row => row.gold === 'SUPPORT');
  const supportCorrect = supportRows.filter(row => row.benchmark_prediction === 'SUPPORT');
  const neiRows = report.rows.filter(row => row.gold === 'NOT_ENOUGH_INFO');
  const neiFalseContradictions = neiRows.filter(row => row.benchmark_prediction === 'CONTRADICT');

  return {
    protocol_version: 'truthlens-scifact-error-analysis-v1',
    analysis_only: true,
    source_protocol_version: report.protocol_version ?? null,
    source_run_provenance: report.run_provenance ?? null,
    dataset: report.dataset ?? null,
    claims_analyzed: report.rows.length,
    confusion_matrix: confusion,
    by_gold_label: byGold,
    error_rates: {
      support_recall: rate(supportCorrect.length, supportRows.length),
      false_contradiction_rate_on_non_contradiction_claims: rate(falseContradictions.length, nonContradictGold.length),
      not_enough_info_false_contradiction_rate: rate(neiFalseContradictions.length, neiRows.length)
    },
    error_claim_ids: {
      support_predicted_contradict: supportRows.filter(row => row.benchmark_prediction === 'CONTRADICT').map(row => row.id),
      support_predicted_nei: supportRows.filter(row => row.benchmark_prediction === 'NOT_ENOUGH_INFO').map(row => row.id),
      nei_predicted_contradict: neiFalseContradictions.map(row => row.id),
      contradict_predicted_not_contradict: report.rows.filter(row => row.gold === 'CONTRADICT' && row.benchmark_prediction !== 'CONTRADICT').map(row => row.id)
    },
    interpretation_limits: [
      'This report analyzes saved claim-level benchmark outputs only; it does not expose per-passage NLI logits or establish a root cause.',
      'Candidate recall and gold-evidence Recall@5 are computed only for claims with gold evidence; NOT_ENOUGH_INFO claims are excluded from those denominators.',
      'A high retrieval recall does not imply correct NLI classification or correct claim-level aggregation.',
      'No model, threshold, retrieval setting, production policy, or benchmark label is changed by this analysis.'
    ]
  };
}

function main() {
  const inputPath = process.argv.find(value => value.startsWith('--input='))?.slice(8)
    || 'artifacts/v2-scifact-e2e/scifact-end-to-end.json';
  const outputPath = process.argv.find(value => value.startsWith('--output='))?.slice(9);
  const report = analyzeScifactReport(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
  const serialized = JSON.stringify(report, null, 2) + String.fromCharCode(10);
  if (outputPath) fs.writeFileSync(outputPath, serialized);
  console.log(serialized);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
