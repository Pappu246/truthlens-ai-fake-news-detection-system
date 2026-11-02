import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Stream JSONL records without materializing the whole file as one JavaScript
 * string. maxRows bounds parsed records; blank lines are ignored.
 */
export async function* readJsonl<T>(filePath: string, maxRows?: number): AsyncGenerator<T> {
  if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows < 0)) {
    throw new RangeError('maxRows must be a non-negative safe integer');
  }

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let physicalLine = 0;
  let rowsRead = 0;

  try {
    for await (const line of lines) {
      physicalLine += 1;
      if (!line.trim()) continue;
      if (maxRows !== undefined && rowsRead >= maxRows) break;

      let value: T;
      try {
        value = JSON.parse(line) as T;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSONL at ${filePath}:${physicalLine}: ${reason}`);
      }

      rowsRead += 1;
      yield value;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
