import assert from 'node:assert/strict';
import { rankRationaleSentences } from './scifactRationaleSelector.js';

assert.deepEqual(
  rankRationaleSentences([1, 0], [[0, 1], [0.8, 0.6], [1, 0], [0.8, 0.6]], 3).map(x => x.index),
  [2, 1, 3]
);
assert.deepEqual(rankRationaleSentences([1, 0], [], 3), []);
assert.deepEqual(rankRationaleSentences([1, 0], [[0, 1], [1, 0]], 1), [{ index: 1, score: 1 }]);
assert.throws(() => rankRationaleSentences([0, 0], [[1, 0]]), /non-zero norm/);
assert.throws(() => rankRationaleSentences([1, 0], [[1, 0, 0]]), /dimension mismatch/);
assert.throws(() => rankRationaleSentences([1, 0], [[1, 0]], -1), /non-negative integer/);
console.log('SciFact rationale selector tests passed.');
