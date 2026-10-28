import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from './v3Jsonl';

async function collect<T>(filePath: string, maxRows?: number): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of readJsonl<T>(filePath, maxRows)) rows.push(row);
  return rows;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'truthlens-jsonl-stream-'));
  try {
    const boundedPath = path.join(root, 'bounded.jsonl');
    await fs.writeFile(boundedPath, '{"id":1}\r\n\r\n{"id":2}\nnot-json-after-limit\n');
    assert.deepEqual(await collect<{id:number}>(boundedPath, 2), [{id:1},{id:2}],
      'bounded reads must stop before parsing records beyond the requested limit');
    assert.deepEqual(await collect<{id:number}>(boundedPath, 0), [],
      'zero-row reads must not parse the input');

    const validPath = path.join(root, 'valid.jsonl');
    await fs.writeFile(validPath, '{"id":1}\n\n{"id":2}\n');
    assert.deepEqual(await collect<{id:number}>(validPath), [{id:1},{id:2}],
      'unbounded reads must stream all non-empty JSONL records');

    const malformedPath = path.join(root, 'malformed.jsonl');
    await fs.writeFile(malformedPath, '{"id":1}\n{broken}\n');
    await assert.rejects(
      () => collect(malformedPath),
      /Invalid JSONL at .*malformed\.jsonl:2:/,
      'malformed rows must report their physical line number'
    );
    await assert.rejects(
      () => collect(validPath, -1),
      /maxRows must be a non-negative safe integer/,
      'negative row limits must fail closed'
    );

    console.log('Streaming JSONL regression tests: PASS (bounded lazy reads, blank lines, malformed-row diagnostics, invalid limits)');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
