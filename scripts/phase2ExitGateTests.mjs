#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(ROOT, 'phase2ExitGate.mjs');
const COMMIT = 'c'.repeat(40);
const STALE_COMMIT = 'd'.repeat(40);
const COUNT = 2;

async function write(root, relative, data) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
}

async function makeFixtures(root) {
  const holdoutPath = 'research/open-web-v1-holdout.jsonl';
  const holdout = '{"claim_id":"blind-001","label":"SUPPORTED","annotator_count":2}\n';
  const holdoutSha = crypto.createHash('sha256').update(holdout).digest('hex');
  await Promise.all([
    write(root, 'research/multibenchmark-manifest.json', {
      phase: 2,
      production_accuracy_claim: false,
      rules: {
        complete_artifact_required_before_publishing_metrics: true,
        production_artifact_must_remain_unchanged: true
      },
      benchmarks: [
        { id: 'fever_v1', expected_evaluation_claims: COUNT },
        { id: 'feverous', expected_evaluation_claims: COUNT },
        { id: 'averitec', expected_evaluation_claims: COUNT }
      ]
    }),
    write(root, 'docs/V3_PHASE2_BENCHMARK_PROTOCOL.md', 'Frozen protocol fixture\n'),
    write(root, 'artifacts/v3/fever/official-scorer-run.json', {
      benchmark_id: 'fever', evaluation_count: COUNT, truthlens_git_sha: COMMIT,
      metrics: { strict_score: 0.3, label_accuracy: 0.4, evidence_precision: 0.5, evidence_recall: 0.6, evidence_f1: 0.55 }
    }),
    write(root, 'artifacts/v3/fever/truthlens-adapter-report.json', { provenance: { commit_sha: COMMIT } }),
    write(root, 'artifacts/v3/feverous/official-scorer-run.json', {
      benchmark_id: 'feverous', evaluation_count: COUNT, truthlens_git_sha: COMMIT,
      metrics: { strict_score: 0.2, label_accuracy: 0.3, evidence_precision: 0.4, evidence_recall: 0.5, evidence_f1: 0.44 }
    }),
    write(root, 'artifacts/v3/feverous/truthlens-adapter-report.json', { provenance: { commit_sha: COMMIT } }),
    write(root, 'artifacts/v2-averitec-e2e/official-evaluation.json', {
      benchmark_id: 'averitec', evaluation_count: COUNT, truthlens_git_sha: COMMIT,
      metrics: { veracity_f1: { macro: 0.2 }, averitec_veracity: { a: 0.1 }, averitec_justification: { a: 0.1 } }
    }),
    write(root, 'artifacts/v2-averitec-e2e/reproducibility-manifest.json', { truthlens_git_sha: COMMIT }),
    write(root, holdoutPath, holdout),
    write(root, 'artifacts/v3/open-web-v1/holdout-release-manifest.json', {
      benchmark_id: 'truthlens_open_web_v1', release_state: 'SEALED', sha256: holdoutSha
    })
  ]);
}

async function runGate(root, expectedSha = COMMIT) {
  const env = { ...process.env };
  if (expectedSha === null) delete env.TRUTHLENS_EXPECTED_COMMIT_SHA;
  else env.TRUTHLENS_EXPECTED_COMMIT_SHA = expectedSha;
  const result = spawnSync(process.execPath, [GATE], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  const report = JSON.parse(await fs.readFile(path.join(root, 'artifacts/v3/phase2-exit-gate.json'), 'utf8'));
  return { result, report };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'truthlens-phase2-gate-test-'));
  try {
    await makeFixtures(root);
    const valid = await runGate(root);
    assert.equal(valid.result.status, 0, valid.result.stderr || valid.result.stdout);
    assert.equal(valid.report.status, 'READY_FOR_HUMAN_REVIEW');
    assert.equal(valid.report.evaluated_commit_sha, COMMIT);
    assert.equal(valid.report.production_promotion_allowed, false);

    await write(root, 'artifacts/v3/feverous/truthlens-adapter-report.json', { provenance: { commit_sha: STALE_COMMIT } });
    const stale = await runGate(root);
    assert.notEqual(stale.result.status, 0);
    assert.ok(stale.report.failures.some((item) => item.includes('FEVEROUS adapter evaluated commit') && item.includes('commit SHA mismatch')));

    const missingExpectedSha = await runGate(root, null);
    assert.notEqual(missingExpectedSha.result.status, 0);
    assert.ok(missingExpectedSha.report.failures.some((item) => item.includes('expected evaluated commit SHA missing or invalid')));

    await fs.rm(path.join(root, 'research/open-web-v1-holdout.jsonl'), { force: true });
    const noHumanHoldout = await runGate(root);
    assert.notEqual(noHumanHoldout.result.status, 0);
    assert.ok(noHumanHoldout.report.failures.some((item) => item.includes('Open-Web human-labelled blind holdout is not sealed')));

    console.log('Phase 2 exit gate tests: PASS (exact-head provenance, stale/missing SHA blocked, absent human holdout remains blocked)');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
