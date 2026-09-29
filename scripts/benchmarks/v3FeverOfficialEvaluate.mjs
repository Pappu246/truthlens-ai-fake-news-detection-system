#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
function arg(name) { const hit = process.argv.find((v) => v.startsWith("--" + name + "=")); return hit ? hit.slice(name.length + 3) : undefined; }
function runPython(cwd, script) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [script], { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
  const predictions = path.resolve(arg("predictions") || "artifacts/v3/fever/predictions.json");
  const actual = path.resolve(arg("actual") || "data/external/fever/shared_task_dev.jsonl");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "truthlens-fever-"));
  try {
    const scorer = path.join(tmp, "fever_scorer.py");
    const runner = path.join(tmp, "run.py");
    await fs.writeFile(scorer, await fetchText("https://raw.githubusercontent.com/sheffieldnlp/fever-scorer/4801615100fbf6327f8e99b5dbaefe5dd890e869/src/fever/scorer.py"));
    const code = ["import json, sys", "sys.path.insert(0, " + JSON.stringify(tmp) + ")", "from fever_scorer import fever_score", "with open(" + JSON.stringify(predictions) + ", encoding=\"utf-8\") as f: predictions = json.load(f)", "with open(" + JSON.stringify(actual) + ", encoding=\"utf-8\") as f: actual = [json.loads(line) for line in f if line.strip()]", "strict, acc, precision, recall, f1 = fever_score(predictions, actual)", "print(json.dumps({\"strict_score\": strict, \"label_accuracy\": acc, \"evidence_precision\": precision, \"evidence_recall\": recall, \"evidence_f1\": f1}, indent=2))"].join("\n");
    await fs.writeFile(runner, code);
    const scorerRun = await runPython(tmp, "run.py");
    const out = path.resolve(arg("output") || "artifacts/v3/fever/official-scorer-run.json");
    await fs.mkdir(path.dirname(out), { recursive: true });
    const metrics = JSON.parse(scorerRun.stdout.trim());
    await fs.writeFile(out, JSON.stringify({
      benchmark_id: "fever",
      protocol_version: "truthlens-v3-benchmark-protocol-v1",
      scorer_revision: "4801615100fbf6327f8e99b5dbaefe5dd890e869",
      predictions,
      actual,
      metrics,
      scorer_stdout: scorerRun.stdout,
      scorer_stderr: scorerRun.stderr,
      generated_at: new Date().toISOString()
    }, null, 2) + "\n");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error?.stack || error); process.exit(1); });