import assert from 'node:assert/strict';
import { hasGoldCandidate } from './v3FeverousEvidenceRecall';

const candidates = new Set(['Wiki_12_sentence_0', 'Wiki_9_table_2_cell_3']);

assert.equal(
  hasGoldCandidate([{ content: ['Wiki_12_sentence_0'] }], candidates),
  true,
  'a matching ID inside one evidence group must count as candidate recall',
);
assert.equal(
  hasGoldCandidate([
    { content: ['not-present'] },
    { content: ['Wiki_9_table_2_cell_3'] },
  ], candidates),
  true,
  'matching IDs in later alternative evidence groups must count',
);
assert.equal(
  hasGoldCandidate([{ content: ['not-present'] }], candidates),
  false,
  'non-matching evidence IDs must not count',
);
assert.equal(hasGoldCandidate([], candidates), false, 'empty evidence must not count');
assert.equal(hasGoldCandidate(null, candidates), false, 'missing evidence must not count');
assert.equal(hasGoldCandidate('not-an-array', candidates), false, 'malformed evidence root must fail closed');
assert.equal(
  hasGoldCandidate([null, {}, { content: 'not-an-array' }, { content: [null, 42, {}] }], candidates),
  false,
  'malformed groups and non-string IDs must not count',
);
assert.equal(hasGoldCandidate([{ content: ['Wiki_12_sentence_0'] }], new Set()), false);

console.log('FEVEROUS evidence recall regression: PASS (group content IDs, alternative groups, malformed/empty evidence)');
