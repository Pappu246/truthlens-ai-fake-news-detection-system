import assert from 'node:assert/strict';
import { MlWorkerClient } from '../server/v2/ml/mlWorkerClient.js';

class RecordingWorkerClient extends MlWorkerClient {
  public readonly batches: string[][] = [];

  public override call<T = unknown>(
    op: string,
    payload: Record<string, unknown>,
    _timeoutMs?: number
  ): T {
    assert.equal(op, 'embedBatch');
    const texts = payload.texts as string[];
    this.batches.push([...texts]);
    return {
      vectors: texts.map((_, index) => new Array(384).fill(index / 100))
    } as T;
  }
}

function run(): void {
  const client = new RecordingWorkerClient();
  const inputs = Array.from(
    { length: 300 },
    (_, index) => `document-${index} ${'x'.repeat(26_000)} 🚀`
  );
  const vectors = client.embedBatch(inputs);

  assert.equal(vectors.length, inputs.length, 'one output vector per input');
  assert.deepEqual(client.batches.flat(), inputs, 'chunking preserves input order and duplicates');
  assert.ok(client.batches.length > 1, 'large corpus input is split into multiple worker requests');

  for (const batch of client.batches) {
    assert.ok(batch.length <= 128, 'each chunk respects the response-safe item cap');
    const payloadBytes = Buffer.byteLength(JSON.stringify({ op: 'embedBatch', texts: batch }), 'utf-8');
    assert.ok(payloadBytes <= (1 << 20) - 8, `request payload is within 1 MiB: ${payloadBytes}`);
  }

  const smallClient = new RecordingWorkerClient();
  const small = ['short one', 'short two'];
  assert.equal(smallClient.embedBatch(small).length, 2);
  assert.equal(smallClient.batches.length, 1, 'small batches keep one worker round-trip');

  const oversizedClient = new RecordingWorkerClient();
  assert.throws(
    () => oversizedClient.embedBatch(['x'.repeat(1 << 20)]),
    /item is too large for the request buffer/,
    'a single oversized document fails clearly before attempting a worker call'
  );
  assert.equal(oversizedClient.batches.length, 0, 'oversized single input is rejected before worker invocation');

  console.log(`ML worker embedBatch payload tests passed (${client.batches.length} bounded chunks).`);
}

run();
