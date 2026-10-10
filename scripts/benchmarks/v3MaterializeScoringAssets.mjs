#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function arg(name, fallback) {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", [
      "--fail", "--location", "--retry", "8", "--retry-all-errors",
      "--retry-delay", "5", "--connect-timeout", "30",
      "--continue-at", "-", "--max-time", "7200",
      "--output", destination, url
    ], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("curl exited " + code)));
  });
}

async function probeRangeSupport(url) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn("curl", [
      "--fail", "--location", "--silent", "--show-error",
      "--connect-timeout", "30", "--max-time", "60",
      "--max-filesize", "1024", "--range", "0-0",
      "--output", "/dev/null", "--write-out", "%{http_code} %{size_download}", url
    ], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error("Range probe failed (curl exit " + code + ")"));
      resolve(stdout.trim());
    });
  });
  const match = output.match(/(\d{3})\s+(\d+(?:\.\d+)?)/);
  if (!match || Number(match[1]) !== 206 || Number(match[2]) !== 1) {
    throw new Error("Origin does not provide verified byte-range responses (probe: " + output + ")");
  }
}

async function downloadRangeChunk(url, partPath, start, end) {
  const expectedBytes = end - start + 1;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await fsp.rm(partPath, { force: true });
    try {
      await new Promise((resolve, reject) => {
        const child = spawn("curl", [
          "--fail", "--location", "--silent", "--show-error",
          "--connect-timeout", "30", "--max-time", "900",
          "--range", start + "-" + end,
          "--output", partPath, url
        ], { stdio: ["ignore", "inherit", "inherit"] });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error("curl exited " + code));
        });
      });
      const stat = await fsp.stat(partPath);
      if (stat.size !== expectedBytes) {
        throw new Error("range " + start + "-" + end + " produced " + stat.size + " bytes; expected " + expectedBytes);
      }
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(partPath, { force: true });
      console.warn("Retrying byte range", start + "-" + end, "attempt", attempt + "/4:", String(error));
    }
  }
  throw new Error("Failed byte range " + start + "-" + end + " after 4 attempts: " + String(lastError));
}

async function downloadInRanges(url, destination, totalBytes) {
  await probeRangeSupport(url);
  const partDir = destination + ".parts";
  await fsp.mkdir(partDir, { recursive: true });
  const chunkBytes = 128 * 1024 * 1024;
  const ranges = [];
  for (let start = 0, index = 0; start < totalBytes; start += chunkBytes, index += 1) {
    const end = Math.min(totalBytes - 1, start + chunkBytes - 1);
    ranges.push({ index, start, end, path: path.join(partDir, String(index).padStart(4, "0") + ".part") });
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
      console.log("Downloading byte range", range.start + "-" + range.end, "(" + (range.index + 1) + "/" + ranges.length + ")");
      await downloadRangeChunk(url, range.path, range.start, range.end);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: 6 }, () => worker()));
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
  const result = await fsp.stat(destination);
  if (result.size !== totalBytes) {
    throw new Error("Range-assembled archive has " + result.size + " bytes; expected " + totalBytes);
  }
  return partDir;
}

const benchmark = arg("benchmark");
const outputRoot = path.resolve(arg("output", "artifacts/v3/benchmark-assets"));

const specs = {
  fever: {
    dataset_version: "FEVER v1.0",
    files: [
      {
        name: "shared_task_dev.jsonl",
        url: "https://zenodo.org/records/4925954/files/shared_task_dev.jsonl?download=1",
        expected_sha256: "e89865bfe1b4dd054e03dd57d7241a6fde24862905f31117cf0cd719f7c78df7"
      },
      {
        name: "wiki-pages.zip",
        url: "https://zenodo.org/records/4925954/files/wiki-pages.zip?download=1",
        expected_sha256: "4b06d95da6adf7fe02d2796176c670dacccb21348da89cba4c50676ab99665f2"
      }
    ]
  },
  feverous: {
    dataset_version: "FEVEROUS v1.0",
    files: [
      {
        name: "dev.jsonl",
        url: "https://zenodo.org/records/4911508/files/dev.jsonl?download=1",
        expected_sha256: "97dc8e2be8982774b0cbb1dc04c0fd5b0966e711e93c8ea01b234ab64356f234"
      },
      {
        name: "feverous-wiki-pages-db.zip",
        url: "https://zenodo.org/records/4911508/files/feverous-wiki-pages-db.zip?download=1",
        expected_bytes: 10353775701,
        expected_sha256: "e25e034d9848c75ab3311a7a7ad8e80e769240b5a36b055da475f20071314881"
      }
    ]
  }
};

if (!specs[benchmark]) {
  console.error("Usage: node scripts/benchmarks/v3MaterializeScoringAssets.mjs --benchmark=fever|feverous");
  process.exit(2);
}

const spec = specs[benchmark];
const outDir = path.join(outputRoot, benchmark);
await fsp.mkdir(outDir, { recursive: true });

const manifest = {
  schema_version: 1,
  benchmark_id: benchmark === "fever" ? "fever_v1" : "feverous",
  dataset_version: spec.dataset_version,
  generated_at: new Date().toISOString(),
  files: []
};

for (const file of spec.files) {
  const destination = path.join(outDir, file.name);
  console.log("Downloading", file.name);
  let partDir = null;
  if (file.expected_bytes !== undefined) {
    partDir = await downloadInRanges(file.url, destination, file.expected_bytes);
  } else {
    await download(file.url, destination);
  }
  const stat = await fsp.stat(destination);
  if (file.expected_bytes !== undefined && stat.size !== file.expected_bytes) {
    throw new Error(file.name + " size mismatch: got " + stat.size + " expected " + file.expected_bytes);
  }
  const sha256 = await sha256File(destination);
  if (sha256 !== file.expected_sha256) {
    throw new Error(file.name + " SHA-256 mismatch: got " + sha256 + " expected " + file.expected_sha256);
  }
  if (partDir) await fsp.rm(partDir, { recursive: true, force: true });
  manifest.files.push({
    name: file.name,
    url: file.url,
    bytes: stat.size,
    sha256,
    expected_sha256: file.expected_sha256
  });
  console.log(JSON.stringify({ benchmark, name: file.name, bytes: stat.size, sha256 }));
}

await fsp.writeFile(
  path.join(outDir, "asset-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8"
);

console.log("SHA-256 locked materialization PASS:", path.join(outDir, "asset-manifest.json"));
