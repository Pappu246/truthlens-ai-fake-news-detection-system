#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { downloadInRanges } from "./v3RangeDownload.mjs";

const bytes = Buffer.from(Array.from({ length: 73 }, (_, index) => (index * 37 + 11) % 256));
let interruptedOnce = false;
const server = createServer((req, res) => {
  if (req.url === "/ignore-range") {
    res.writeHead(200, { "Content-Length": String(bytes.length) });
    res.end(bytes);
    return;
  }
  const rangeHeader = req.headers.range;
  const match = typeof rangeHeader === "string" && rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
  if (!match) {
    res.writeHead(416);
    res.end();
    return;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start === 20 && !interruptedOnce) {
    interruptedOnce = true;
    res.writeHead(503);
    res.end("deliberate single failure to verify retry");
    return;
  }
  res.writeHead(206, {
    "Accept-Ranges": "bytes",
    "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
    "Content-Length": String(end - start + 1)
  });
  res.end(bytes.subarray(start, end + 1));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "truthlens-range-test-"));
try {
  const output = path.join(tempDir, "assembled.bin");
  const parts = await downloadInRanges(
    `http://127.0.0.1:${address.port}/range`,
    output,
    bytes.length,
    { chunkBytes: 20, concurrency: 3, attempts: 3, timeoutSeconds: 5 }
  );
  assert.deepEqual(await fs.readFile(output), bytes, "assembled bytes differ from source");
  assert.equal(interruptedOnce, true, "retry path was not exercised");
  await fs.rm(parts, { recursive: true, force: true });

  await assert.rejects(
    downloadInRanges(
      `http://127.0.0.1:${address.port}/ignore-range`,
      path.join(tempDir, "should-not-exist.bin"),
      bytes.length,
      { chunkBytes: 20, concurrency: 2, attempts: 1, timeoutSeconds: 5 }
    ),
    /Origin does not provide verified byte-range responses/
  );
  console.log("Ranged download regression: PASS (exact bytes, ordered assembly, retry, and range rejection)");
} finally {
  server.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}
