import assert from 'node:assert/strict';
import { validateScifactArtifact } from './scifactArtifactGate.mjs';

const report = {
  benchmark: true,
  protocol_version: 'truthlens-v2-scifact-end-to-end-v2',
  dataset: {
    claims_evaluated: 300,
    corpus_documents: 5183,
    claims_sha256: '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217',
    corpus_sha256: 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62'
  },
  rows: Array.from({ length: 300 }, (_, id) => ({
    id,
    gold_evidence_ids: id < 188 ? ['doc-' + id] : [],
    candidate_pool_recall_hit: id < 187,
    retrieved_evidence_ids_top5: []
  })),
  run_provenance: {
    source_commit_sha: 'a'.repeat(40),
    config_sha256: 'b'.repeat(64),
    model_manifest_sha256: 'c'.repeat(64)
  },
  models: { manifest_sha256: 'c'.repeat(64), sealed_manifest: [{ kind: 'nli' }, { kind: 'embedding' }] },
  end_to_end: {
    benchmark_directional_accuracy: 0.37,
    benchmark_directional_macro_f1: 0.35,
    open_candidate_recall: 187 / 188,
    open_candidate_recall_hits: 187,
    open_candidate_recall_denominator: 188,
    gold_evidence_recall_at_5: 162 / 188,
    gold_evidence_recall_at_5_hits: 162,
    gold_evidence_recall_at_5_denominator: 188,
    benchmark_directional_confusion_matrix: [
      { gold: 'SUPPORT', predicted: { SUPPORT: 17, CONTRADICT: 59, NOT_ENOUGH_INFO: 48 } },
      { gold: 'CONTRADICT', predicted: { SUPPORT: 0, CONTRADICT: 48, NOT_ENOUGH_INFO: 16 } },
      { gold: 'NOT_ENOUGH_INFO', predicted: { SUPPORT: 0, CONTRADICT: 65, NOT_ENOUGH_INFO: 47 } }
    ]
  }
};
assert.deepEqual(validateScifactArtifact(report, 'a'.repeat(40)), { complete: true, failures: [] });
assert.equal(validateScifactArtifact(report, 'd'.repeat(40)).complete, false);
const bad = structuredClone(report);
bad.rows = bad.rows.slice(1);
assert.ok(validateScifactArtifact(bad, 'a'.repeat(40)).failures.includes('SciFact row count must equal 300'));
const wrongHash = structuredClone(report);
wrongHash.dataset.claims_sha256 = '0'.repeat(64);
assert.ok(validateScifactArtifact(wrongHash, 'a'.repeat(40)).failures.includes('SciFact claims hash mismatch'));
console.log('SciFact artifact gate tests passed.');
