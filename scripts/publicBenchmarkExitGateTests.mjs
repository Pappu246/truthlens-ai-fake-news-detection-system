#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(ROOT, 'publicBenchmarkExitGate.mjs');
const NOW = '2026-10-10T08:51:37.078Z';

function makeManifest() {
  return {
    phase: 2,
    production_accuracy_claim: false,
    rules: {
      metric_separation: true,
      no_benchmark_score_as_universal_accuracy: true,
      production_artifact_must_remain_unchanged: true,
      complete_artifact_required_before_publishing_metrics: true
    },
    benchmarks: [
      { id: 'fever_v1', expected_evaluation_claims: 19998 },
      { id: 'feverous', expected_evaluation_claims: 7890 },
      { id: 'averitec', expected_evaluation_claims: 500 }
    ]
  };
}
async function write(root, relative, data) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
}
async function makeFixtures(root) {
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'protocol.md'), 'Frozen benchmark protocol fixture\n');
  await Promise.all([
    write(root, 'research/manifest.json', makeManifest()),
    write(root, 'artifacts/fever-score.json', {
      benchmark_id: 'fever', protocol_version: 'truthlens-v3-benchmark-protocol-v1', evaluation_count: 19998, generated_at: NOW,
      metrics: { strict_score: 0.3, label_accuracy: 0.4, evidence_precision: 0.5, evidence_recall: 0.6, evidence_f1: 0.55 }
    }),
    write(root, 'artifacts/fever-adapter.json', {
      benchmark_id: 'fever', protocol_version: 'truthlens-v3-benchmark-protocol-v1',
      dataset: { evaluation_count: 19998, claims_sha256: 'a'.repeat(64), corpus_sha256: 'b'.repeat(64) },
      provenance: { commit_sha: 'c'.repeat(40), configuration_sha256: 'd'.repeat(64) }
    }),
    write(root, 'artifacts/feverous-score.json', {
      benchmark_id: 'feverous', protocol_version: 'truthlens-v3-benchmark-protocol-v1', evaluation_count: 7890, generated_at: NOW,
      metrics: { strict_score: 0.2, label_accuracy: 0.3, evidence_precision: 0.4, evidence_recall: 0.5, evidence_f1: 0.44 }
    }),
    write(root, 'artifacts/feverous-adapter.json', {
      benchmark_id: 'feverous', protocol_version: 'truthlens-v3-benchmark-protocol-v1', dataset: { evaluation_count: 7890 }, scorer_revision: 'Raldir/FEVEROUS@32b68ce'
    }),
    write(root, 'artifacts/averitec-score.json', {
      benchmark_id: 'averitec', protocol_version: 'truthlens-v3-benchmark-protocol-v1', evaluation_count: 500, generated_at: NOW,
      evaluator: { repository: 'MichSchli/AVeriTeC', commit: '7c62d1ec8df3fb560d6efe2b85fa191135636f81' },
      metrics: { veracity_f1: { macro: 0.28, acc: 0.52 }, averitec_veracity: { '0.1': 0.38 }, averitec_justification: { '0.1': 0.10 } }
    }),
    write(root, 'artifacts/averitec-manifest.json', {
      benchmark: 'AVeriTeC', split: 'dev', claims: 500, claims_sha256: 'e'.repeat(64), evidence_store_sha256: 'f'.repeat(64),
      gold_evidence_in_retrieval: false, production_boundary: 'research_only_no_production_model_threshold_or_runtime_change'
    })
  ]);
}
async function runGate(root, shouldPass) {
  const out = path.join(root, 'result', 'gate.json');
  const args = [
    GATE,
    '--manifest=' + path.join(root, 'research/manifest.json'),
    '--protocol=' + path.join(root, 'docs/protocol.md'),
    '--output=' + out,
    '--fever=' + path.join(root, 'artifacts/fever-score.json'),
    '--fever-adapter=' + path.join(root, 'artifacts/fever-adapter.json'),
    '--feverous=' + path.join(root, 'artifacts/feverous-score.json'),
    '--feverous-adapter=' + path.join(root, 'artifacts/feverous-adapter.json'),
    '--averitec=' + path.join(root, 'artifacts/averitec-score.json'),
    '--averitec-manifest=' + path.join(root, 'artifacts/averitec-manifest.json')
  ];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 });
  const report = JSON.parse(await fs.readFile(out, 'utf8'));
  if (shouldPass) {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(report.status, 'READY_PUBLIC_BENCHMARKS_ONLY');
    assert.equal(report.public_benchmarks_complete, true);
    assert.equal(report.production_promotion_allowed, false);
    assert.equal(report.human_holdout.status, 'DEFERRED_NO_INDEPENDENT_HUMAN_ANNOTATORS');
  } else {
    assert.notEqual(result.status, 0, 'invalid/missing public score artifacts must fail closed');
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.public_benchmarks_complete, false);
    assert.equal(report.production_promotion_allowed, false);
  }
  return report;
}
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'truthlens-public-gate-test-'));
  try {
    await makeFixtures(root);
    const valid = await runGate(root, true);
    assert.equal(valid.results.length, 3);
    const feverousScore = path.join(root, 'artifacts/feverous-score.json');
    const original = JSON.parse(await fs.readFile(feverousScore, 'utf8'));
    original.evaluation_count = 7889;
    await fs.writeFile(feverousScore, JSON.stringify(original, null, 2) + '\n');
    const wrongCount = await runGate(root, false);
    assert.ok(wrongCount.failures.some((failure) => failure.includes('evaluation_count expected 7890')));
    await fs.rm(feverousScore, { force: true });
    const missing = await runGate(root, false);
    assert.ok(missing.failures.some((failure) => failure.includes('feverous: official score artifact missing')));
    console.log('Public benchmark gate tests: PASS (complete artifacts, pinned counts/provenance, fail-closed missing/wrong-count cases, human/production gates remain separate)');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
