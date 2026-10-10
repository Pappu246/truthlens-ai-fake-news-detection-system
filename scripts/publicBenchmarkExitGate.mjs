#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function arg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}
async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function sha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}
function finiteUnitMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

const manifestPath = path.resolve(arg('manifest', 'research/multibenchmark-manifest.json'));
const protocolPath = path.resolve(arg('protocol', 'docs/V3_PHASE2_BENCHMARK_PROTOCOL.md'));
const outputPath = path.resolve(arg('output', 'artifacts/v3/public-benchmark-gate.json'));
const specs = [
  {
    id: 'fever_v1', benchmarkId: 'fever', expectedCount: 37566,
    scorePath: path.resolve(arg('fever', 'artifacts/v3/fever/official-scorer-run.json')),
    adapterPath: path.resolve(arg('fever-adapter', 'artifacts/v3/fever/truthlens-adapter-report.json')),
    scoreMetrics: ['strict_score', 'label_accuracy', 'evidence_precision', 'evidence_recall', 'evidence_f1']
  },
  {
    id: 'feverous', benchmarkId: 'feverous', expectedCount: 7890,
    scorePath: path.resolve(arg('feverous', 'artifacts/v3/feverous/official-scorer-run.json')),
    adapterPath: path.resolve(arg('feverous-adapter', 'artifacts/v3/feverous/truthlens-adapter-report.json')),
    scoreMetrics: ['strict_score', 'label_accuracy', 'evidence_precision', 'evidence_recall', 'evidence_f1']
  },
  {
    id: 'averitec', benchmarkId: 'averitec', expectedCount: 500,
    scorePath: path.resolve(arg('averitec', 'artifacts/v2-averitec-e2e/official-evaluation.json')),
    adapterPath: path.resolve(arg('averitec-manifest', 'artifacts/v2-averitec-e2e/reproducibility-manifest.json')),
    scoreMetrics: []
  }
];

const failures = [];
const checks = [];
const results = [];
let manifest = null;
try {
  manifest = await readJson(manifestPath);
  checks.push({ label: 'multi-benchmark manifest readable', pass: true, file: manifestPath });
} catch (error) {
  failures.push('multi-benchmark manifest missing/invalid: ' + String(error));
  checks.push({ label: 'multi-benchmark manifest readable', pass: false, file: manifestPath });
}
if (manifest) {
  if (manifest.phase !== 2) failures.push('manifest phase must be 2');
  if (manifest.production_accuracy_claim !== false) failures.push('manifest must keep production_accuracy_claim=false');
  for (const key of ['metric_separation', 'no_benchmark_score_as_universal_accuracy', 'production_artifact_must_remain_unchanged', 'complete_artifact_required_before_publishing_metrics']) {
    if (manifest.rules?.[key] !== true) failures.push('manifest rule must remain true: ' + key);
  }
  for (const spec of specs) {
    const entry = manifest.benchmarks?.find((item) => item.id === spec.id);
    if (!entry) failures.push('manifest benchmark missing: ' + spec.id);
    else if (entry.expected_evaluation_claims !== spec.expectedCount) {
      failures.push(spec.id + ' manifest expected_evaluation_claims must be ' + spec.expectedCount);
    }
  }
}
const protocolExists = await exists(protocolPath);
checks.push({ label: 'benchmark protocol document present', pass: protocolExists, file: protocolPath });
if (!protocolExists) failures.push('benchmark protocol document missing');

for (const spec of specs) {
  const item = {
    benchmark_id: spec.benchmarkId,
    manifest_id: spec.id,
    expected_evaluation_count: spec.expectedCount,
    score_artifact: spec.scorePath,
    adapter_or_reproducibility_artifact: spec.adapterPath
  };
  const scoreExists = await exists(spec.scorePath);
  const adapterExists = await exists(spec.adapterPath);
  const check = {
    label: spec.benchmarkId + ' official score and provenance',
    pass: false,
    score_exists: scoreExists,
    adapter_or_provenance_exists: adapterExists
  };
  if (!scoreExists) failures.push(spec.benchmarkId + ': official score artifact missing');
  if (!adapterExists) failures.push(spec.benchmarkId + ': adapter/provenance artifact missing');
  if (scoreExists && adapterExists) {
    try {
      const score = await readJson(spec.scorePath);
      const adapter = await readJson(spec.adapterPath);
      if (score.benchmark_id !== spec.benchmarkId) failures.push(spec.benchmarkId + ': official score benchmark_id mismatch');
      if (score.protocol_version !== 'truthlens-v3-benchmark-protocol-v1') failures.push(spec.benchmarkId + ': scoring protocol version mismatch');
      if (score.evaluation_count !== spec.expectedCount) failures.push(spec.benchmarkId + ': official score evaluation_count expected ' + spec.expectedCount + ', got ' + score.evaluation_count);
      if (typeof score.generated_at !== 'string' || !Number.isFinite(Date.parse(score.generated_at))) failures.push(spec.benchmarkId + ': official score generated_at missing or invalid');

      if (spec.benchmarkId === 'fever' || spec.benchmarkId === 'feverous') {
        if (adapter.benchmark_id !== spec.benchmarkId) failures.push(spec.benchmarkId + ': adapter report benchmark_id mismatch');
        if (adapter.protocol_version !== 'truthlens-v3-benchmark-protocol-v1') failures.push(spec.benchmarkId + ': adapter protocol version mismatch');
        const adapterCount = adapter.dataset?.evaluation_count;
        if (adapterCount !== spec.expectedCount) failures.push(spec.benchmarkId + ': adapter evaluation_count expected ' + spec.expectedCount + ', got ' + adapterCount);
        if (spec.benchmarkId === 'fever') {
          const provenance = adapter.provenance || {};
          if (!/^[a-f0-9]{40}$/i.test(provenance.commit_sha || '')) failures.push('FEVER: evaluation commit SHA missing');
          if (!/^[a-f0-9]{64}$/i.test(adapter.dataset?.claims_sha256 || '')) failures.push('FEVER: claims SHA-256 provenance missing');
          if (!/^[a-f0-9]{64}$/i.test(adapter.dataset?.corpus_sha256 || '')) failures.push('FEVER: corpus SHA-256 provenance missing');
          if (!/^[a-f0-9]{64}$/i.test(provenance.configuration_sha256 || '')) failures.push('FEVER: configuration SHA-256 provenance missing');
        } else if (typeof adapter.scorer_revision !== 'string' || !adapter.scorer_revision) {
          failures.push('FEVEROUS: scorer revision provenance missing');
        }
      } else {
        if (adapter.benchmark !== 'AVeriTeC') failures.push('AVeriTeC: reproducibility manifest benchmark mismatch');
        if (adapter.split !== 'dev' || adapter.claims !== 500) failures.push('AVeriTeC: reproducibility manifest must pin dev split with 500 claims');
        if (!/^[a-f0-9]{64}$/i.test(adapter.claims_sha256 || '')) failures.push('AVeriTeC: claims SHA-256 provenance missing');
        if (!/^[a-f0-9]{64}$/i.test(adapter.evidence_store_sha256 || '')) failures.push('AVeriTeC: evidence-store SHA-256 provenance missing');
        if (adapter.gold_evidence_in_retrieval !== false) failures.push('AVeriTeC: retrieval must not inject gold evidence');
        if (!String(adapter.production_boundary || '').includes('no_production_model_threshold_or_runtime_change')) failures.push('AVeriTeC: production isolation provenance missing');
        const metrics = score.metrics || {};
        for (const key of ['veracity_f1', 'averitec_veracity', 'averitec_justification']) {
          if (!metrics[key] || typeof metrics[key] !== 'object' || Object.keys(metrics[key]).length === 0) failures.push('AVeriTeC: metric group ' + key + ' missing');
        }
        if (!finiteUnitMetric(metrics.veracity_f1?.acc)) failures.push('AVeriTeC: verdict accuracy must be between 0 and 1');
        if (!finiteUnitMetric(metrics.veracity_f1?.macro)) failures.push('AVeriTeC: macro F1 must be between 0 and 1');
      }
      for (const key of spec.scoreMetrics) {
        if (!finiteUnitMetric(score.metrics?.[key])) failures.push(spec.benchmarkId + ': official metric ' + key + ' missing or outside [0,1]');
      }
      item.score_sha256 = await sha256(spec.scorePath);
      item.provenance_sha256 = await sha256(spec.adapterPath);
      item.generated_at = score.generated_at;
      item.metrics = score.metrics;
      check.pass = true;
    } catch (error) {
      failures.push(spec.benchmarkId + ': invalid score/provenance JSON: ' + String(error));
    }
  }
  checks.push(check);
  results.push(item);
}
const complete = failures.length === 0;
const report = {
  schema_version: 1,
  suite_id: 'truthlens_public_benchmark_suite_v1',
  generated_at: new Date().toISOString(),
  status: complete ? 'READY_PUBLIC_BENCHMARKS_ONLY' : 'BLOCKED',
  public_benchmarks_complete: complete,
  required_benchmarks: specs.map(({ benchmarkId, expectedCount }) => ({ benchmark_id: benchmarkId, expected_evaluation_count: expectedCount })),
  results,
  checks,
  failures,
  human_holdout: {
    status: 'DEFERRED_NO_INDEPENDENT_HUMAN_ANNOTATORS',
    note: 'This report does not replace the separately required blind human-labelled Open-Web holdout or the full Phase 2 exit gate.'
  },
  full_phase2_exit_gate: 'SEPARATE_GATE_REMAINS_AUTHORITATIVE',
  production_accuracy_claim: false,
  production_promotion_allowed: false,
  notes: [
    'Public benchmark metrics apply only to their named datasets and splits.',
    'AI-generated labels are not represented as independent human ground truth.',
    'This public-only report does not declare the entire Phase 2 research gate complete.'
  ]
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
if (!complete) process.exitCode = 1;
