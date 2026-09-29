#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ROOT = process.cwd();

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

function md5File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function curlDownload(url, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", [
      "--fail", "--location", "--retry", "4", "--retry-all-errors",
      "--output", destination, url
    ], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("curl exited " + code)));
  });
}

const benchmark = arg("benchmark");
const outputDir = path.resolve(arg("output", "artifacts/v3/benchmark-assets"));
const withCorpus = process.argv.includes("--with-corpus");

const specs = {
  fever: {
    version: "Zenodo 10.5281/zenodo.4925954 v1",
    files: [
      {
        name: "shared_task_dev.jsonl",
        url: "https://zenodo.org/records/4925954/files/shared_task_dev.jsonl?download=1",
        md5: "4eecc1018b3d2bd46089ca36d886f439",
        required: true
      },
      {
        name: "wiki-pages.zip",
        url: "https://zenodo.org/records/4925954/files/wiki-pages.zip?download=1",
        md5: "ed8bfd894a2c47045dca61f0c8dc4c07",
        required: withCorpus
      }
    ]
  },
  feverous: {
    version: "Zenodo 10.5281/zenodo.4911508 v1",
    files: [
      {
        name: "dev.jsonl",
        url: "https://zenodo.org/records/4911508/files/dev.jsonl?download=1",
        md5: "56150713a60ecf3ea0f32f42561e1082",
        required: true
      },
      {
        name: "feverous-wiki-pages-db.zip",
        url: "https://zenodo.org/records/4911508/files/feverous-wiki-pages-db.zip?download=1",
        md5: "b01271df477efdfca99441c7dc6fe859",
        required: withCorpus
      }
    ]
  },
  averitec: {
    version: "MichSchli/AVeriTeC @ 7c62d1ec8df3fb560d6efe2b85fa191135636f81",
    files: [
      {
        name: "dev.json",
        url: "https://raw.githubusercontent.com/MichSchli/AVeriTeC/7c62d1ec8df3fb560d6efe2b85fa191135636f81/data/dev.json",
        gitBlobSha1: "40974243267f395dc583d805d10f043812419249",
        required: true
      }
    ]
  }
};

if (!specs[benchmark]) {
  console.error("usage: node scripts/benchmarks/v3MaterializeAssets.mjs --benchmark=fever|averitec|feverous [--with-corpus]");
  process.exit(2);
}

const spec = specs[benchmark];
await fsp.mkdir(outputDir, { recursive: true });

const manifest = {
  schema_version: 1,
  benchmark_id: benchmark,
  dataset_version: spec.version,
  generated_at: new Date().toISOString(),
  files: []
};

for (const file of spec.files) {
  if (!file.required) continue;
  const destination = path.join(outputDir, benchmark, file.name);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  console.log("Downloading", file.name);
  await curlDownload(file.url, destination);

  const stats = await fsp.stat(destination);
  const sha256 = await sha256File(destination);
  const record = {
    name: file.name,
    url: file.url,
    bytes: stats.size,
    sha256
  };

  if (file.md5) {
    const md5 = await md5File(destination);
    if (md5 !== file.md5) {
      throw new Error(file.name + " published MD5 mismatch: got " + md5 + " expected " + file.md5);
    }
    record.published_md5 = file.md5;
  }

  if (file.gitBlobSha1) {
    record.pinned_git_blob_sha1 = file.gitBlobSha1;
  }

  manifest.files.push(record);
  console.log(JSON.stringify(record));
}

const manifestPath = path.join(outputDir, benchmark, "asset-manifest.json");
await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("Asset materialization PASS:", manifestPath);
