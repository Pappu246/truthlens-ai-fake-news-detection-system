#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EXPECTED_CLAIMS_SHA = '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217';
const EXPECTED_CORPUS_SHA = 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62';
const input = path.resolve(process.argv.find(v => v.startsWith('--input='))?.slice(8) || 'artifacts/v2-scifact-e2e/scifact-end-to-end.json');
const output = path.resolve(process.argv.find(v => v.startsWith('--output='))?.slice(9) || 'artifacts/v3/scifact-artifact-gate.json');
const expectedCommit = process.env.TRUTHLENS_EXPECTED_COMMIT_SHA ||
  process.argv.find(v => v.startsWith('--expected-commit-sha='))?.slice(22) || '';

export function validateScifactArtifact(report, expectedCommitSha) {
  const failures = [];
  const add = (ok, message) => { if (!ok) failures.push(message); };
  add(report?.benchmark === true, 'benchmark flag must be true');
  add(report?.protocol_version === 'truthlens-v2-scifact-end-to-end-v2', 'SciFact protocol version mismatch');
  add(report?.dataset?.claims_evaluated === 300, 'expected exactly 300 SciFact dev claims');
  add(report?.dataset?.corpus_documents === 5183, 'expected exactly 5,183 SciFact corpus documents');
  add(report?.dataset?.claims_sha256 === EXPECTED_CLAIMS_SHA, 'SciFact claims hash mismatch');
  add(report?.dataset?.corpus_sha256 === EXPECTED_CORPUS_SHA, 'SciFact corpus hash mismatch');
  add(Array.isArray(report?.rows) && report.rows.length === 300, 'SciFact row count must equal 300');
  const provenance = report?.run_provenance || {};
  add(/^[a-f0-9]{40}$/i.test(provenance.source_commit_sha || ''), 'source commit SHA missing or invalid');
  add(/^[a-f0-9]{40}$/i.test(expectedCommitSha || ''), 'expected commit SHA missing or invalid');
  add(provenance.source_commit_sha === expectedCommitSha, 'artifact commit SHA does not match evaluated head');
  add(/^[a-f0-9]{64}$/i.test(provenance.config_sha256 || ''), 'config SHA-256 missing or invalid');
  add(/^[a-f0-9]{64}$/i.test(provenance.model_manifest_sha256 || ''), 'model manifest SHA-256 missing or invalid');
  add(report?.models?.manifest_sha256 === provenance.model_manifest_sha256, 'model manifest SHA mismatch');
  add(Array.isArray(report?.models?.sealed_manifest) && report.models.sealed_manifest.length >= 2, 'sealed model manifest missing');
  const metrics = report?.end_to_end || {};
  for (const key of ['benchmark_directional_accuracy', 'benchmark_directional_macro_f1']) {
    add(typeof metrics[key] === 'number' && Number.isFinite(metrics[key]) && metrics[key] >= 0 && metrics[key] <= 1, key + ' must be in [0,1]');
  }
  const evidenceDenominator = report?.rows?.filter(row => Array.isArray(row.gold_evidence_ids) && row.gold_evidence_ids.length > 0).length;
  add(evidenceDenominator === 188, 'SciFact evidence-bearing claim denominator must equal 188');
  add(metrics.open_candidate_recall_denominator === evidenceDenominator, 'candidate-recall denominator mismatch');
  add(metrics.gold_evidence_recall_at_5_denominator === evidenceDenominator, 'Recall@5 denominator mismatch');
  add(Number.isInteger(metrics.open_candidate_recall_hits) && metrics.open_candidate_recall_hits >= 0 && metrics.open_candidate_recall_hits <= evidenceDenominator, 'candidate-recall hits outside denominator');
  add(Number.isInteger(metrics.gold_evidence_recall_at_5_hits) && metrics.gold_evidence_recall_at_5_hits >= 0 && metrics.gold_evidence_recall_at_5_hits <= evidenceDenominator, 'Recall@5 hits outside denominator');
  const confusion = metrics.benchmark_directional_confusion_matrix;
  const confusionCount = Array.isArray(confusion) ? confusion.reduce((sum, row) =>
    sum + Object.values(row?.predicted || {}).reduce((n, value) => n + (Number.isInteger(value) && value >= 0 ? value : 0), 0), 0) : -1;
  add(confusionCount === 300, 'directional confusion matrix must account for all 300 claims');
  return { complete: failures.length === 0, failures };
}

async function main() {
  if (!/^[a-f0-9]{40}$/i.test(expectedCommit)) throw new Error('Set TRUTHLENS_EXPECTED_COMMIT_SHA to the exact evaluated PR-head SHA.');
  const bytes = await fs.readFile(input);
  const report = JSON.parse(bytes.toString('utf8'));
  const validation = validateScifactArtifact(report, expectedCommit);
  const outputReport = {
    schema_version: 1,
    benchmark_id: 'scifact',
    generated_at: new Date().toISOString(),
    evaluated_commit_sha: expectedCommit,
    artifact_path: input,
    artifact_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    evaluation_count: report.dataset?.claims_evaluated ?? null,
    metrics: {
      directional_accuracy: report.end_to_end?.benchmark_directional_accuracy ?? null,
      directional_macro_f1: report.end_to_end?.benchmark_directional_macro_f1 ?? null,
      candidate_recall: report.end_to_end?.open_candidate_recall ?? null,
      gold_evidence_recall_at_5: report.end_to_end?.gold_evidence_recall_at_5 ?? null
    },
    status: validation.complete ? 'PASS' : 'BLOCKED',
    failures: validation.failures,
    production_promotion_allowed: false
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(outputReport, null, 2) + '\n');
  console.log(JSON.stringify(outputReport, null, 2));
  if (!validation.complete) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(error?.stack || error); process.exit(1); });
}
