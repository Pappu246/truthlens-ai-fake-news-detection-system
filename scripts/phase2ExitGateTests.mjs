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
  const holdout = Array.from({ length: 100 }, (_, index) => JSON.stringify({
    claim_id: 'blind-' + String(index + 1).padStart(3, '0'),
    human_label: ['SUPPORTED', 'REFUTED', 'INSUFFICIENT_EVIDENCE', 'CONFLICTED'][index % 4]
  })).join('\n') + '\n';
  const holdoutSha = crypto.createHash('sha256').update(holdout).digest('hex');
  const attestationSha = 'a'.repeat(64);
  const scifactRows = Array.from({ length: 300 }, (_, index) => ({
    gold_evidence_ids: index % 2 === 0 ? ["doc-" + index] : [],
    candidate_pool_recall_hit: index % 2 === 0 && index < 200
  }));
  const scifactEvidenceDenominator = scifactRows.filter((row) => row.gold_evidence_ids.length > 0).length;
  const scifactCandidateHits = scifactRows.filter((row) => row.gold_evidence_ids.length > 0 && row.candidate_pool_recall_hit).length;
  await Promise.all([
    write(root, 'research/multibenchmark-manifest.json', {
      phase: 2,
      production_accuracy_claim: false,
      rules: {
        complete_artifact_required_before_publishing_metrics: true,
        production_artifact_must_remain_unchanged: true
      },
      benchmarks: [
        { id: 'scifact', expected_evaluation_claims: 300, corpus_documents: 5183 },
        { id: 'fever_v1', expected_evaluation_claims: COUNT },
        { id: 'feverous', expected_evaluation_claims: COUNT },
        { id: 'averitec', expected_evaluation_claims: COUNT }
      ]
    }),
    write(root, 'docs/V3_PHASE2_BENCHMARK_PROTOCOL.md', 'Frozen protocol fixture\n'),
    write(root, 'artifacts/v2-scifact-e2e/scifact-end-to-end.json', {
      benchmark: true,
      dataset: { claims_evaluated: 300, corpus_documents: 5183 },
      run_provenance: { source_commit_sha: COMMIT, config_sha256: 'd'.repeat(64), model_manifest_sha256: 'b'.repeat(64) },
      models: { manifest_sha256: 'b'.repeat(64) },
      rows: scifactRows,
      end_to_end: {
        open_candidate_recall_denominator: scifactEvidenceDenominator,
        open_candidate_recall_hits: scifactCandidateHits,
        gold_evidence_recall_at_5_denominator: scifactEvidenceDenominator,
        gold_evidence_recall_at_5_hits: 75,
        benchmark_directional_accuracy: 0.7,
        benchmark_directional_macro_f1: 0.68,
        benchmark_directional_confusion_matrix: [{ predicted: { SUPPORT: 100, CONTRADICT: 100, NOT_ENOUGH_INFO: 100 } }]
      }
    }),
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
      benchmark_id: 'truthlens_open_web_v1',
      release_state: 'SEALED',
      target_claims: 100,
      evaluation_count: 100,
      sha256: holdoutSha,
      attestation_sha256: attestationSha,
      independent_annotator_count: 2
    }),
    write(root, 'artifacts/v3/open-web-v1/holdout-gate.json', {
      benchmark_id: 'truthlens_open_web_v1',
      status: 'SEALED',
      release_state: 'SEALED',
      record_count: 100,
      sha256: holdoutSha,
      attestation_sha256: attestationSha,
      independent_annotator_count: 2
    })
  ]);
  return { holdoutSha, scifactRows, scifactEvidenceDenominator, scifactCandidateHits };
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
    const { holdoutSha, scifactRows, scifactEvidenceDenominator, scifactCandidateHits } = await makeFixtures(root);
    const valid = await runGate(root);
    assert.equal(valid.result.status, 0, valid.result.stderr || valid.result.stdout);
    assert.equal(valid.report.status, 'READY_FOR_HUMAN_REVIEW');
    assert.equal(valid.report.evaluated_commit_sha, COMMIT);
    assert.equal(valid.report.production_promotion_allowed, false);

    await write(root, 'artifacts/v3/feverous/truthlens-adapter-report.json', { provenance: { commit_sha: STALE_COMMIT } });
    await write(root, 'artifacts/v2-scifact-e2e/scifact-end-to-end.json', {
      benchmark: true,
      dataset: { claims_evaluated: 300, corpus_documents: 5183 },
      run_provenance: { source_commit_sha: STALE_COMMIT, config_sha256: 'd'.repeat(64), model_manifest_sha256: 'b'.repeat(64) },
      models: { manifest_sha256: 'b'.repeat(64) },
      rows: scifactRows,
      end_to_end: {
        open_candidate_recall_denominator: scifactEvidenceDenominator,
        open_candidate_recall_hits: scifactCandidateHits,
        gold_evidence_recall_at_5_denominator: scifactEvidenceDenominator,
        gold_evidence_recall_at_5_hits: 75,
        benchmark_directional_accuracy: 0.7,
        benchmark_directional_macro_f1: 0.68,
        benchmark_directional_confusion_matrix: [{ predicted: { SUPPORT: 100, CONTRADICT: 100, NOT_ENOUGH_INFO: 100 } }]
      }
    });
    const staleSciFact = await runGate(root);
    assert.notEqual(staleSciFact.result.status, 0);
    assert.ok(staleSciFact.report.failures.some((item) => item.includes('SciFact evaluated commit') && item.includes('commit SHA mismatch')));
    await write(root, 'artifacts/v2-scifact-e2e/scifact-end-to-end.json', {
      benchmark: true,
      dataset: { claims_evaluated: 300, corpus_documents: 5183 },
      run_provenance: { source_commit_sha: COMMIT, config_sha256: 'd'.repeat(64), model_manifest_sha256: 'b'.repeat(64) },
      models: { manifest_sha256: 'b'.repeat(64) },
      rows: scifactRows,
      end_to_end: {
        open_candidate_recall_denominator: scifactEvidenceDenominator,
        open_candidate_recall_hits: scifactCandidateHits,
        gold_evidence_recall_at_5_denominator: scifactEvidenceDenominator,
        gold_evidence_recall_at_5_hits: 75,
        benchmark_directional_accuracy: 0.7,
        benchmark_directional_macro_f1: 0.68,
        benchmark_directional_confusion_matrix: [{ predicted: { SUPPORT: 100, CONTRADICT: 100, NOT_ENOUGH_INFO: 100 } }]
      }
    });

    const stale = await runGate(root);
    assert.notEqual(stale.result.status, 0);
    assert.ok(stale.report.failures.some((item) => item.includes('FEVEROUS adapter evaluated commit') && item.includes('commit SHA mismatch')));

    const missingExpectedSha = await runGate(root, null);
    assert.notEqual(missingExpectedSha.result.status, 0);
    assert.ok(missingExpectedSha.report.failures.some((item) => item.includes('expected evaluated commit SHA missing or invalid')));

    await write(root, 'artifacts/v3/open-web-v1/holdout-release-manifest.json', {
      benchmark_id: 'truthlens_open_web_v1', release_state: 'SEALED', target_claims: 100,
      evaluation_count: 100, sha256: holdoutSha, attestation_sha256: 'b'.repeat(64), independent_annotator_count: 1
    });
    const invalidAttestation = await runGate(root);
    assert.notEqual(invalidAttestation.result.status, 0);
    assert.ok(invalidAttestation.report.failures.some((item) => item.includes('annotation attestation provenance')));
    await fs.rm(path.join(root, 'research/open-web-v1-holdout.jsonl'), { force: true });
    const noHumanHoldout = await runGate(root);
    assert.notEqual(noHumanHoldout.result.status, 0);
    assert.ok(noHumanHoldout.report.failures.some((item) => item.includes('Open-Web human-labelled blind holdout and successful validator evidence are not sealed')));

    console.log('Phase 2 exit gate tests: PASS (SciFact full-split exact-SHA provenance, stale/missing SHA blocked, 100-claim holdout + annotation attestation required)');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
