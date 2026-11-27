import assert from 'node:assert/strict';
import { LruEmbeddingModel } from './v3EmbeddingCache';

function mockModel() {
  const calls: string[][] = [];
  let embedCalls = 0;
  const model = {
    name: 'mock-embedding',
    version: 'test-v1',
    dimensions: 3,
    embed(text: string) {
      embedCalls += 1;
      return [text.length, 1, 0];
    },
    embedBatch(texts: string[]) {
      calls.push([...texts]);
      return texts.map(text => [text.length, 1, 0]);
    }
  };
  return { model, calls, getEmbedCalls: () => embedCalls };
}

async function main() {
  const { model, calls, getEmbedCalls } = mockModel();
  const cached = new LruEmbeddingModel(model, 3);
  const firstBatch = cached.embedBatch(['alpha', 'beta', 'alpha']);
  assert.ok(!(firstBatch instanceof Promise), 'sync underlying models must retain the synchronous batch contract');
  const first = await firstBatch;
  assert.deepEqual(first[0], first[2], 'duplicate inputs must share the same deterministic vector');
  assert.deepEqual(calls, [['alpha', 'beta']], 'batch duplicates must be computed only once');
  assert.equal(cached.stats().batch_dedup_hits, 1);

  const second = await cached.embedBatch(['alpha', 'beta']);
  assert.deepEqual(second, [first[0], first[1]]);
  assert.equal(calls.length, 1, 'cached batch must not call the underlying model');
  assert.equal(cached.stats().hits, 2);

  await cached.embed('gamma');
  assert.equal(cached.stats().entries, 3);
  await cached.embed('delta');
  assert.equal(cached.stats().entries, 3, 'cache must remain bounded');
  assert.equal(cached.stats().evictions, 1);

  await cached.embed('beta');
  assert.equal(getEmbedCalls(), 2, 'recently used beta must remain in the LRU cache');
  await cached.embed('alpha');
  assert.equal(getEmbedCalls(), 3, 'least-recently-used alpha must be recomputed after eviction');

  assert.equal(cached.name, model.name);
  assert.equal(cached.version, model.version);
  assert.equal(cached.dimensions, model.dimensions);

  const asyncModel = {
    ...model,
    embed: async (text: string) => [text.length, 1, 0],
    embedBatch: async (texts: string[]) => texts.map(text => [text.length, 1, 0])
  };
  const asyncCached = new LruEmbeddingModel(asyncModel, 2);
  const asyncBatch = asyncCached.embedBatch(['async', 'model']);
  assert.ok(asyncBatch instanceof Promise, 'async underlying models must remain supported');
  assert.deepEqual(await asyncBatch, [[5, 1, 0], [5, 1, 0]]);

  const bad = new LruEmbeddingModel({
    ...model,
    embedBatch: () => [[1, 2]]
  }, 2);
  await assert.rejects(() => bad.embedBatch(['bad']), /invalid vector/);

  assert.throws(() => new LruEmbeddingModel(model, 0), /positive safe integer/);
  console.log('Bounded embedding-cache regression tests: PASS');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
