#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function runCurl(args, captureStdout = false) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, {
      stdio: captureStdout ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"]
    });
    let stdout = "";
    if (captureStdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error("curl exited " + code));
      resolve(stdout.trim());
    });
  });
}

async function assertRangeSupport(url, timeoutSeconds) {
  const result = await runCurl([
    "--fail", "--location", "--silent", "--show-error",
    "--connect-timeout", "30", "--max-time", String(Math.min(timeoutSeconds, 60)),
    "--max-filesize", "1024", "--range", "0-0",
    "--output", "/dev/null", "--write-out", "%{http_code} %{size_download}", url
  ], true);
  const match = result.match(/(\d{3})\s+(\d+(?:\.\d+)?)/);
  if (!match || Number(match[1]) !== 206 || Number(match[2]) !== 1) {
    throw new Error("Origin does not provide verified byte-range responses (probe: " + result + ")");
  }
}

async function downloadChunk(url, partPath, start, end, { attempts, timeoutSeconds }) {
  const expectedBytes = end - start + 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await fsp.rm(partPath, { force: true });
    try {
      await runCurl([
        "--fail", "--location", "--silent", "--show-error",
        "--connect-timeout", "30", "--max-time", String(timeoutSeconds),
        "--range", start + "-" + end,
        "--output", partPath, url
      ]);
      const stat = await fsp.stat(partPath);
      if (stat.size !== expectedBytes) {
        throw new Error("range " + start + "-" + end + " produced " + stat.size +
          " bytes; expected " + expectedBytes);
      }
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(partPath, { force: true });
      console.warn("Retrying byte range", start + "-" + end,
        "attempt", attempt + "/" + attempts + ":", String(error));
    }
  }
  throw new Error("Failed byte range " + start + "-" + end + " after " +
    attempts + " attempts: " + String(lastError));
}

/**
 * Download an exact-size object by verified HTTP byte ranges and concatenate
 * chunks in order. An incomplete run retains verified chunks for safe resume.
 * The caller must verify the published source SHA-256 before deleting part files.
 */
export async function downloadInRanges(url, destination, totalBytes, options = {}) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new TypeError("totalBytes must be a positive safe integer");
  }
  const chunkBytes = options.chunkBytes ?? (128 * 1024 * 1024);
  const concurrency = options.concurrency ?? 6;
  const attempts = options.attempts ?? 4;
  const timeoutSeconds = options.timeoutSeconds ?? 900;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new TypeError("chunkBytes must be positive");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be positive");
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new TypeError("attempts must be positive");

  await assertRangeSupport(url, timeoutSeconds);
  const partDir = destination + ".parts";
  await fsp.mkdir(partDir, { recursive: true });
  const ranges = [];
  for (let start = 0, index = 0; start < totalBytes; start += chunkBytes, index += 1) {
    ranges.push({
      index, start, end: Math.min(totalBytes - 1, start + chunkBytes - 1),
      path: path.join(partDir, String(index).padStart(4, "0") + ".part")
    });
  }

  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= ranges.length) return;
      const range = ranges[i];
      try {
        const stat = await fsp.stat(range.path);
        if (stat.size === range.end - range.start + 1) continue;
      } catch {}
      console.log("Downloading byte range", range.start + "-" + range.end,
        "(" + (range.index + 1) + "/" + ranges.length + ")");
      await downloadChunk(url, range.path, range.start, range.end, { attempts, timeoutSeconds });
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, ranges.length) }, () => worker()));
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;

  const output = await fsp.open(destination, "w");
  try {
    for (const range of ranges) {
      const stat = await fsp.stat(range.path);
      if (stat.size !== range.end - range.start + 1) {
        throw new Error("Verified chunk has incorrect length: " + range.path);
      }
      const input = fs.createReadStream(range.path);
      for await (const chunk of input) {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset, null);
          if (bytesWritten <= 0) throw new Error("Unable to write range-assembled archive");
          offset += bytesWritten;
        }
      }
    }
  } finally {
    await output.close();
  }
  const stat = await fsp.stat(destination);
  if (stat.size !== totalBytes) {
    throw new Error("Range-assembled archive has " + stat.size + " bytes; expected " + totalBytes);
  }
  return partDir;
}
