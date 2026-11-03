import { analyzeSciFactRationaleVisibility } from './scifactRationaleVisibility';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const result = analyzeSciFactRationaleVisibility({
  '1': [{ label: 'SUPPORT', sentences: [0, 1, 1] }],
  '2': [{ label: 'CONTRADICT', sentences: [0] }]
}, [
  { doc_id: 1, abstract: ['a'.repeat(800), 'b'] },
  { doc_id: 2, abstract: ['c'.repeat(799), 'd'] }
], 800);
assert(result.gold_evidence_documents === 2, 'gold evidence document count mismatch');
assert(result.gold_rationale_sentences === 3, 'duplicate rationale indices should be counted once per document');
assert(result.visible_rationale_sentences_within_limit === 2, 'sentence ending at char 800 should be visible; later sentence should not');
assert(result.hidden_rationale_sentences_after_limit === 1, 'sentence starting after char 800 should be hidden');
assert(result.per_document[0].hidden_sentence_indices[0] === 1, 'hidden rationale index mismatch');

const missing = analyzeSciFactRationaleVisibility({
  '999': [{ label: 'SUPPORT', sentences: [0] }]
}, [{ doc_id: 1, abstract: ['x'] }]);
assert(missing.missing_gold_document_ids[0] === '999', 'missing gold document must be reported');
assert(missing.gold_rationale_sentences === 0, 'missing document rationale must not be counted as visible');

let invalidLimitRejected = false;
try { analyzeSciFactRationaleVisibility({}, [], 0); } catch { invalidLimitRejected = true; }
assert(invalidLimitRejected, 'non-positive character limit must be rejected');
console.log('SciFact rationale visibility diagnostic tests: PASS');
