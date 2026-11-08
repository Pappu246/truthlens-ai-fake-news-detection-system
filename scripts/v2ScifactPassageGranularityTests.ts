import assert from 'node:assert/strict';
import { calculateMetrics } from './v2ScifactPassageGranularity.js';

const gold = ['SUPPORTS', 'SUPPORTS', 'REFUTES', 'NEUTRAL'] as const;
const predictions = ['SUPPORTS', 'REFUTES', 'UNCLEAR', 'NEUTRAL'] as const;
const result = calculateMetrics([...predictions], [...gold]);
assert.equal(result.passages, 4);
assert.equal(result.accuracy, 0.5);
assert.equal(result.per_class[0].recall, 0.5);
assert.equal(result.per_class[1].recall, 0);
assert.equal(result.per_class[2].recall, 1);
assert.equal(result.confusion_matrix[0].predicted.REFUTES, 1);
assert.equal(result.confusion_matrix[1].predicted.UNCLEAR, 1);
assert.throws(() => calculateMetrics([], []), /equal non-empty/);
assert.throws(() => calculateMetrics(['SUPPORTS'], []), /equal non-empty/);
console.log('SciFact passage-granularity metric tests passed.');
