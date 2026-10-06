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
  await download(file.url, destination);
  const sha256 = await sha256File(destination);
  if (sha256 !== file.expected_sha256) {
    throw new Error(file.name + " SHA-256 mismatch: got " + sha256 + " expected " + file.expected_sha256);
  }
  const stat = await fsp.stat(destination);
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
