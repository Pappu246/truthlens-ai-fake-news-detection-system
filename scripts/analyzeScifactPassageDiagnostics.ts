/**
 * Research-only passage-level SciFact error diagnostics.
 * Requires the optional evidence_diagnostics rows emitted by the benchmark.
 */
import fs from 'node:fs';

type Label = 'SUPPORT' | 'CONTRADICT' | 'NOT_ENOUGH_INFO';
type NliLabel = 'SUPPORTS' | 'REFUTES' | 'NEUTRAL' | 'UNCLEAR';
interface EvidenceDiagnostic {
  evidence_id: string;
  url: string;
  title: string;
  publisher: string;
  domain: string;
  content_type: string;
  nli_label: NliLabel;
  nli_confidence: number;
  rerank_score: number;
  is_duplicate_cluster: boolean;
  source_type: string;
  support_vote_weight: number;
  refute_vote_weight: number;
  exact_passage: string;
}
interface Row {
  id: number;
  claim: string;
  gold: Label;
  benchmark_prediction: Label;
  candidate_pool_recall_hit: boolean;
  gold_evidence_ids: string[];
  retrieved_evidence_ids_top5: string[];
  evidence_diagnostics: EvidenceDiagnostic[];
}
interface Report { rows: Row[]; run_provenance?: unknown; dataset?: unknown; protocol_version?: string; }
const LABELS: Label[] = ['SUPPORT', 'CONTRADICT', 'NOT_ENOUGH_INFO'];
const NLI_LABELS: NliLabel[] = ['SUPPORTS', 'REFUTES', 'NEUTRAL', 'UNCLEAR'];

function validate(value: unknown): Report {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Report).rows) || !(value as Report).rows.length) {
    throw new Error('Expected a non-empty SciFact report rows array.');
  }
  const report = value as Report;
  for (const [i, row] of report.rows.entries()) {
    if (!row || !Number.isInteger(row.id) || !LABELS.includes(row.gold) ||
        !LABELS.includes(row.benchmark_prediction) || !Array.isArray(row.evidence_diagnostics)) {
      throw new Error(`Invalid passage-diagnostic row at index ${i}; evidence_diagnostics is required.`);
    }
    for (const [j, evidence] of row.evidence_diagnostics.entries()) {
      if (!evidence || !NLI_LABELS.includes(evidence.nli_label) ||
          !Number.isFinite(evidence.nli_confidence) || !Number.isFinite(evidence.rerank_score) ||
          typeof evidence.exact_passage !== 'string') {
        throw new Error(`Invalid evidence diagnostic at row ${i}, evidence ${j}.`);
      }
    }
  }
  return report;
}

function aggregate(rows: Row[]) {
  const counts = Object.fromEntries(NLI_LABELS.map(label => [label, 0])) as Record<NliLabel, number>;
  let supportWeight = 0, refuteWeight = 0, neutralWeight = 0, confidenceSum = 0, n = 0;
  for (const row of rows) for (const e of row.evidence_diagnostics) {
    counts[e.nli_label]++;
    confidenceSum += e.nli_confidence; n++;
    supportWeight += e.support_vote_weight;
    refuteWeight += e.refute_vote_weight;
    if (e.nli_label === 'NEUTRAL' || e.nli_label === 'UNCLEAR') neutralWeight += e.nli_confidence * e.rerank_score * (e.is_duplicate_cluster ? 0.35 : 1);
  }
  return {
    claims: rows.length,
    retrieved_passages: n,
    nli_label_counts: counts,
    mean_nli_confidence: n ? confidenceSum / n : null,
    support_vote_weight: supportWeight,
    refute_vote_weight: refuteWeight,
    neutral_vote_weight_diagnostic: neutralWeight,
    refute_to_support_weight_ratio: supportWeight > 0 ? refuteWeight / supportWeight : (refuteWeight > 0 ? null : 0)
  };
}

function caseDetails(row: Row) {
  return {
    id: row.id,
    claim: row.claim,
    gold: row.gold,
    predicted: row.benchmark_prediction,
    gold_evidence_ids: row.gold_evidence_ids,
    retrieved_evidence_ids_top5: row.retrieved_evidence_ids_top5,
    evidence: row.evidence_diagnostics
      .slice()
      .sort((a, b) => b.refute_vote_weight - a.refute_vote_weight || b.rerank_score - a.rerank_score)
      .map(e => ({
        evidence_id: e.evidence_id, url: e.url, title: e.title, publisher: e.publisher,
        domain: e.domain, content_type: e.content_type, source_type: e.source_type,
        nli_label: e.nli_label, nli_confidence: e.nli_confidence, rerank_score: e.rerank_score,
        duplicate_cluster: e.is_duplicate_cluster, support_vote_weight: e.support_vote_weight,
        refute_vote_weight: e.refute_vote_weight, exact_passage: e.exact_passage
      }))
  };
}

export function analyzePassageDiagnostics(input: unknown) {
  const report = validate(input);
  const rows = report.rows;
  const byGold = Object.fromEntries(LABELS.map(label => [label, aggregate(rows.filter(row => row.gold === label))]));
  const neiFalseRefutes = rows.filter(row => row.gold === 'NOT_ENOUGH_INFO' && row.benchmark_prediction === 'CONTRADICT');
  const supportFalseRefutes = rows.filter(row => row.gold === 'SUPPORT' && row.benchmark_prediction === 'CONTRADICT');
  const supportMisses = rows.filter(row => row.gold === 'SUPPORT' && row.benchmark_prediction !== 'SUPPORT');
  const refuteMisses = rows.filter(row => row.gold === 'CONTRADICT' && row.benchmark_prediction !== 'CONTRADICT');
  const neiRefuteEvidenceCases = neiFalseRefutes.filter(row => row.evidence_diagnostics.some(e => e.nli_label === 'REFUTES'));
  const neiAllNonRefuteCases = neiFalseRefutes.filter(row => row.evidence_diagnostics.length > 0 && row.evidence_diagnostics.every(e => e.nli_label !== 'REFUTES'));
  const totalByNli = aggregate(rows);
  return {
    protocol_version: 'truthlens-scifact-passage-error-diagnostics-v1',
    analysis_only: true,
    source_protocol_version: report.protocol_version ?? null,
    source_run_provenance: report.run_provenance ?? null,
    dataset: report.dataset ?? null,
    claims_analyzed: rows.length,
    overall_evidence: totalByNli,
    evidence_by_gold_label: byGold,
    error_patterns: {
      support_false_contradiction_claims: supportFalseRefutes.length,
      support_false_contradiction_with_any_refute_passage: supportFalseRefutes.filter(row => row.evidence_diagnostics.some(e => e.nli_label === 'REFUTES')).length,
      support_missed_claims: supportMisses.length,
      contradict_missed_claims: refuteMisses.length,
      nei_false_contradiction_claims: neiFalseRefutes.length,
      nei_false_contradiction_with_any_refute_passage: neiRefuteEvidenceCases.length,
      nei_false_contradiction_with_no_refute_passage: neiAllNonRefuteCases.length,
      nei_false_contradiction_all_neutral_or_unclear: neiFalseRefutes.filter(row => row.evidence_diagnostics.length > 0 && row.evidence_diagnostics.every(e => e.nli_label === 'NEUTRAL' || e.nli_label === 'UNCLEAR')).length
    },
    highest_refute_weight_nei_errors: neiFalseRefutes
      .slice().sort((a, b) =>
        b.evidence_diagnostics.reduce((s, e) => s + e.refute_vote_weight, 0) -
        a.evidence_diagnostics.reduce((s, e) => s + e.refute_vote_weight, 0)
      ).slice(0, 30).map(caseDetails),
    highest_refute_weight_support_errors: supportFalseRefutes
      .slice().sort((a, b) =>
        b.evidence_diagnostics.reduce((s, e) => s + e.refute_vote_weight, 0) -
        a.evidence_diagnostics.reduce((s, e) => s + e.refute_vote_weight, 0)
      ).slice(0, 30).map(caseDetails),
    interpretation_limits: [
      'Evidence passages are the exact sanitized passages passed to the NLI adapter; this report does not contain raw model logits.',
      'The diagnostic exposes correlations between retrieved passage labels and claim-level errors; it does not prove causality.',
      'NEI claims have no gold evidence, so their retrieved passages are not automatically false; human adjudication is required.',
      'No production model, threshold, retrieval setting, verdict policy, or benchmark label is changed.'
    ]
  };
}

function main() {
  const inputPath = process.argv.find(v => v.startsWith('--input='))?.slice(8)
    || 'artifacts/v2-scifact-e2e/scifact-end-to-end.json';
  const outputPath = process.argv.find(v => v.startsWith('--output='))?.slice(9);
  const report = analyzePassageDiagnostics(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
  const serialized = JSON.stringify(report, null, 2) + String.fromCharCode(10);
  if (outputPath) fs.writeFileSync(outputPath, serialized);
  console.log(serialized);
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
