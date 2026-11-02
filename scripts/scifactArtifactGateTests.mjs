import assert from 'node:assert/strict';
import { validateScifactArtifact } from './scifactArtifactGate.mjs';

const report = {
  benchmark: true,
  gold_evidence_in_retrieval: false,
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
    model_manifest_sha256: 'f545488704f895af94b781601c3a746b2e371e30bc8cdec7431f44917d9a1832'
  },
  models: { manifest_sha256: 'f545488704f895af94b781601c3a746b2e371e30bc8cdec7431f44917d9a1832', nli: { name: 'Xenova/nli-deberta-v3-xsmall', artifact_sha256: '3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6' }, embedding: { name: 'Xenova/all-MiniLM-L6-v2', artifact_sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' }, runtime: { node_major: 22, transformers_js: '3.7.6', onnxruntime_node: '1.21.0' }, sealed_manifest: [{ kind: 'nli' }, { kind: 'embedding' }] },
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
assert.deepEqual(validateScifactArtifact(report, 'a'.repeat(40), 'f545488704f895af94b781601c3a746b2e371e30bc8cdec7431f44917d9a1832'), { complete: true, failures: [] });
assert.equal(validateScifactArtifact(report, 'd'.repeat(40), 'f545488704f895af94b781601c3a746b2e371e30bc8cdec7431f44917d9a1832').complete, false);
const goldLeak = structuredClone(report);
goldLeak.gold_evidence_in_retrieval = true;
assert.ok(validateScifactArtifact(goldLeak, 'a'.repeat(40), 'f545488704f895af94b781601c3a746b2e371e30bc8cdec7431f44917d9a1832').failures.includes('SciFact retrieval must not inject gold evidence'));
const bad = structuredClone(report);
bad.rows = bad.rows.slice(1);
assert.ok(validateScifactArtifact(bad, 'a'.repeat(40), 'f545488704f895af94b781601c3a746b2e371e30bc8cdec7431f44917d9a1832').failures.includes('SciFact row count must equal 300'));
const wrongHash = structuredClone(report);
wrongHash.dataset.claims_sha256 = '0'.repeat(64);
assert.ok(validateScifactArtifact(wrongHash, 'a'.repeat(40), 'f545488704f895af94b781601c3a746b2e371e30bc8cdec7431f44917d9a1832').failures.includes('SciFact claims hash mismatch'));
console.log('SciFact artifact gate tests passed.');
