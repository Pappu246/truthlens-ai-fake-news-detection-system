#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
function arg(name) { const hit = process.argv.find((v) => v.startsWith("--" + name + "=")); return hit ? hit.slice(name.length + 3) : undefined; }
function runPython(cwd, script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [script, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error("python scorer exited " + code + "\n" + stderr));
    });
  });
}
async function fetchText(url) { const res = await fetch(url, { headers: { "user-agent": "TruthLens-V3-Benchmark-Adapter/1.0" } }); if (!res.ok) throw new Error("failed to fetch " + url + ": HTTP " + res.status); return res.text(); }
async function main() {
  const predictions = path.resolve(arg("predictions") || "artifacts/v3/averitec/predictions.json");
  const references = path.resolve(arg("references") || "data/external/averitec/dev.json");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "truthlens-averitec-"));
  try {
    await fs.writeFile(path.join(tmp, "eval.py"), await fetchText("https://raw.githubusercontent.com/MichSchli/AVeriTeC/7c62d1ec8df3fb560d6efe2b85fa191135636f81/eval.py"));
    await fs.writeFile(path.join(tmp, "utils.py"), await fetchText("https://raw.githubusercontent.com/MichSchli/AVeriTeC/7c62d1ec8df3fb560d6efe2b85fa191135636f81/utils.py"));
    const scorerRun = await runPython(tmp, "eval.py", ["--predictions", predictions, "--references", references]);
    const out = path.resolve(arg("output") || "artifacts/v3/averitec/official-scorer-run.json");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify({ benchmark_id: "averitec", protocol_version: "truthlens-v3-benchmark-protocol-v1", scorer_source: "https://github.com/MichSchli/AVeriTeC/blob/7c62d1ec8df3fb560d6efe2b85fa191135636f81/eval.py", predictions, references, scorer_stdout: scorerRun.stdout, scorer_stderr: scorerRun.stderr, generated_at: new Date().toISOString() }, null, 2) + "\n");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error?.stack || error); process.exit(1); });