import assert from 'node:assert/strict';
import { analyzeScifactReport } from './analyzeScifactEndToEnd.js';

const report = {
  protocol_version: 'fixture-v1',
  dataset: { claims_evaluated: 4 },
  rows: [
    { id: 1, gold: 'SUPPORT', benchmark_prediction: 'CONTRADICT', candidate_pool_recall_hit: true, gold_evidence_ids: ['10'], retrieved_evidence_ids_top5: ['10'] },
    { id: 2, gold: 'SUPPORT', benchmark_prediction: 'SUPPORT', candidate_pool_recall_hit: true, gold_evidence_ids: ['11'], retrieved_evidence_ids_top5: ['12'] },
    { id: 3, gold: 'NOT_ENOUGH_INFO', benchmark_prediction: 'CONTRADICT', candidate_pool_recall_hit: false, gold_evidence_ids: [], retrieved_evidence_ids_top5: ['13'] },
    { id: 4, gold: 'CONTRADICT', benchmark_prediction: 'NOT_ENOUGH_INFO', candidate_pool_recall_hit: true, gold_evidence_ids: ['14'], retrieved_evidence_ids_top5: ['14'] }
  ]
};

const result = analyzeScifactReport(report);
assert.equal(result.claims_analyzed, 4);
assert.equal(result.confusion_matrix.SUPPORT.CONTRADICT, 1);
assert.equal(result.by_gold_label.SUPPORT.candidate_recall, 1);
assert.equal(result.by_gold_label.SUPPORT.gold_evidence_recall_at_5, 0.5);
assert.equal(result.by_gold_label.NOT_ENOUGH_INFO.candidate_recall_denominator, 0);
assert.equal(result.error_rates.support_recall, 0.5);
assert.equal(result.error_rates.not_enough_info_false_contradiction_rate, 1);
assert.deepEqual(result.error_claim_ids.nei_predicted_contradict, [3]);
assert.throws(() => analyzeScifactReport({ rows: [] }), /must not be empty/);
assert.throws(() => analyzeScifactReport({ rows: [{ id: 'bad' }] }), /Invalid SciFact report row/);
console.log('SciFact error-analysis tests passed.');
