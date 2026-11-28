import assert from 'node:assert/strict';
import {
  buildMatchedLocalContextControl,
  buildRationaleContextWindow,
  calculateMetrics
} from './v2ScifactMatchedContext.js';

const sentences = [
  'The study background discusses the disease population and prior observations.',
  'The randomized trial found a statistically significant reduction in the primary outcome.',
  'Participants were followed for twelve months after enrollment.',
  'The control group received standard treatment and routine monitoring.',
  'The authors discuss limitations and future work in the final section.'
];
const rationale = buildRationaleContextWindow(sentences, [1], 180);
assert.ok(rationale.includes(sentences[1]));
assert.ok(rationale.length >= sentences[1].length);
assert.ok(rationale.length <= 180);
const control = buildMatchedLocalContextControl(sentences, [1], rationale.length);
assert.ok(control);
assert.equal(control.length, rationale.length);
assert.ok(!control.includes(sentences[1]));
assert.throws(() => buildRationaleContextWindow(sentences, [], 180), /at least one/i);
assert.throws(() => buildRationaleContextWindow(sentences, [99], 180), /outside/i);
assert.equal(buildMatchedLocalContextControl([sentences[1]], [0], 20), null);

const gold = ['SUPPORTS', 'REFUTES', 'SUPPORTS'] as const;
const result = calculateMetrics(['SUPPORTS', 'NEUTRAL', 'UNCLEAR'], [...gold]);
assert.equal(result.passages, 3);
assert.equal(result.accuracy, 1 / 3);
assert.equal(result.per_class[0].recall, 1 / 2);
assert.equal(result.per_class[1].recall, 0);
assert.throws(() => calculateMetrics([], []), /equal non-empty/i);
console.log('SciFact matched-context helper tests passed.');
