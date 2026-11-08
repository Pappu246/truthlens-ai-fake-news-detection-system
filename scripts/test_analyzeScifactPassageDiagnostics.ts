import assert from 'node:assert/strict';
import { analyzePassageDiagnostics } from './analyzeScifactPassageDiagnostics.js';

const evidence = (label: 'SUPPORTS' | 'REFUTES' | 'NEUTRAL' | 'UNCLEAR', refute: number, support = 0) => ({
  evidence_id: 'e1', url: 'https://example.org/a', title: 'Example', publisher: 'Example',
  domain: 'example.org', content_type: 'SUMMARY', nli_label: label, nli_confidence: 0.8,
  rerank_score: 0.5, is_duplicate_cluster: false, source_type: 'UNKNOWN',
  support_vote_weight: support, refute_vote_weight: refute, exact_passage: 'A bounded passage.'
});
const report = {
  protocol_version: 'fixture',
  rows: [
    { id: 1, claim: 'NEI claim text', gold: 'NOT_ENOUGH_INFO', benchmark_prediction: 'CONTRADICT',
      candidate_pool_recall_hit: false, gold_evidence_ids: [], retrieved_evidence_ids_top5: [],
      evidence_diagnostics: [evidence('REFUTES', 0.4)] },
    { id: 2, claim: 'NEI neutral case', gold: 'NOT_ENOUGH_INFO', benchmark_prediction: 'CONTRADICT',
      candidate_pool_recall_hit: false, gold_evidence_ids: [], retrieved_evidence_ids_top5: [],
      evidence_diagnostics: [evidence('NEUTRAL', 0)] },
    { id: 3, claim: 'Supported claim', gold: 'SUPPORT', benchmark_prediction: 'SUPPORT',
      candidate_pool_recall_hit: true, gold_evidence_ids: ['10'], retrieved_evidence_ids_top5: ['10'],
      evidence_diagnostics: [evidence('SUPPORTS', 0, 0.4)] }
  ]
};
const result = analyzePassageDiagnostics(report);
assert.equal(result.claims_analyzed, 3);
assert.equal(result.error_patterns.nei_false_contradiction_claims, 2);
assert.equal(result.error_patterns.nei_false_contradiction_with_any_refute_passage, 1);
assert.equal(result.error_patterns.nei_false_contradiction_with_no_refute_passage, 1);
assert.equal(result.error_patterns.nei_false_contradiction_all_neutral_or_unclear, 1);
assert.equal(result.evidence_by_gold_label.NOT_ENOUGH_INFO.nli_label_counts.REFUTES, 1);
assert.equal(result.evidence_by_gold_label.SUPPORT.nli_label_counts.SUPPORTS, 1);
assert.equal(result.highest_refute_weight_nei_errors[0].id, 1);
assert.throws(() => analyzePassageDiagnostics({ rows: [] }), /non-empty/);
assert.throws(() => analyzePassageDiagnostics({ rows: [{ id: 1 }] }), /evidence_diagnostics is required/);
console.log('SciFact passage-diagnostic tests passed.');
