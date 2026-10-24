#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const manifestPath = path.resolve("research/multibenchmark-manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const expectedCommitSha = process.env.TRUTHLENS_EXPECTED_COMMIT_SHA || "";

const failures = [];
const checks = [];
if (!/^[a-f0-9]{40}$/i.test(expectedCommitSha)) failures.push("expected evaluated commit SHA missing or invalid");

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function sha256(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function checkCommitProvenance(label, file, selectCommitSha) {
  const fileExists = await exists(file);
  if (!fileExists) {
    checks.push({ label, file, pass: false, reason: "provenance artifact missing" });
    failures.push(label + ": provenance artifact missing");
    return;
  }
  try {
    const artifact = await readJson(file);
    const actualCommitSha = selectCommitSha(artifact);
    const expectedValid = /^[a-f0-9]{40}$/i.test(expectedCommitSha);
    const actualValid = /^[a-f0-9]{40}$/i.test(actualCommitSha || "");
    const pass = expectedValid && actualValid && actualCommitSha.toLowerCase() === expectedCommitSha.toLowerCase();
    checks.push({
      label,
      file,
      pass,
      expected_commit_sha: expectedValid ? expectedCommitSha : null,
      actual_commit_sha: actualValid ? actualCommitSha : null
    });
    if (!expectedValid) failures.push(label + ": expected evaluated commit SHA missing or invalid");
    if (!actualValid) failures.push(label + ": artifact commit SHA missing or invalid");
    else if (expectedValid && actualCommitSha.toLowerCase() !== expectedCommitSha.toLowerCase()) {
      failures.push(label + ": commit SHA mismatch (expected " + expectedCommitSha + ", got " + actualCommitSha + ")");
    }
  } catch (error) {
    checks.push({ label, file, pass: false, reason: "invalid provenance JSON" });
    failures.push(label + ": invalid provenance JSON (" + String(error) + ")");
  }
}

async function checkSciFactArtifact() {
  const label = "SciFact full-split benchmark";
  const file = "artifacts/v2-scifact-e2e/scifact-end-to-end.json";
  const expected = manifest.benchmarks?.find((item) => item.id === "scifact");
  const expectedClaims = expected?.expected_evaluation_claims ?? 300;
  const expectedCorpusDocuments = expected?.corpus_documents ?? 5183;
  const startFailureCount = failures.length;
  if (!expected) failures.push("SciFact manifest entry missing");
  if (expectedClaims !== 300) failures.push("SciFact manifest expected_evaluation_claims must be 300");
  if (expectedCorpusDocuments !== 5183) failures.push("SciFact manifest corpus_documents must be 5183");

  if (!(await exists(file))) {
    failures.push(label + ": benchmark artifact missing");
    checks.push({ label, file, pass: false, reason: "benchmark artifact missing" });
    return;
  }

  try {
    const report = await readJson(file);
    if (report.benchmark !== true) failures.push(label + ": benchmark flag is not true");
    if (report.dataset?.claims_evaluated !== expectedClaims) {
      failures.push(label + ": claims_evaluated expected " + expectedClaims + ", got " + report.dataset?.claims_evaluated);
    }
    if (report.dataset?.corpus_documents !== expectedCorpusDocuments) {
      failures.push(label + ": corpus_documents expected " + expectedCorpusDocuments + ", got " + report.dataset?.corpus_documents);
    }
    const rows = Array.isArray(report.rows) ? report.rows : [];
    if (rows.length !== expectedClaims) failures.push(label + ": rows expected " + expectedClaims + ", got " + rows.length);

    const provenance = report.run_provenance || {};
    if (!/^[a-f0-9]{40}$/i.test(provenance.source_commit_sha || "")) {
      failures.push(label + ": source commit SHA missing or invalid");
    }
    if (!/^[a-f0-9]{64}$/i.test(provenance.config_sha256 || "")) {
      failures.push(label + ": configuration SHA-256 missing or invalid");
    }
    if (!/^[a-f0-9]{64}$/i.test(provenance.model_manifest_sha256 || "")) {
      failures.push(label + ": model manifest SHA-256 missing or invalid");
    }
    if (report.models?.manifest_sha256 !== provenance.model_manifest_sha256) {
      failures.push(label + ": model manifest SHA-256 does not match run provenance");
    }

    const endToEnd = report.end_to_end || {};
    const evidenceRows = rows.filter((row) => Array.isArray(row.gold_evidence_ids) && row.gold_evidence_ids.length > 0);
    const evidenceDenominator = evidenceRows.length;
    if (endToEnd.open_candidate_recall_denominator !== evidenceDenominator) {
      failures.push(label + ": open_candidate_recall denominator mismatch");
    }
    if (endToEnd.gold_evidence_recall_at_5_denominator !== evidenceDenominator) {
      failures.push(label + ": gold_evidence_recall_at_5 denominator mismatch");
    }
    const expectedCandidateHits = evidenceRows.filter((row) => row.candidate_pool_recall_hit).length;
    if (endToEnd.open_candidate_recall_hits !== expectedCandidateHits) {
      failures.push(label + ": open_candidate_recall hits mismatch");
    }
    if (!Number.isInteger(endToEnd.gold_evidence_recall_at_5_hits) ||
        endToEnd.gold_evidence_recall_at_5_hits < 0 ||
        endToEnd.gold_evidence_recall_at_5_hits > evidenceDenominator) {
      failures.push(label + ": gold_evidence_recall_at_5 hits outside denominator");
    }
    for (const key of ["benchmark_directional_accuracy", "benchmark_directional_macro_f1"]) {
      const value = endToEnd[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        failures.push(label + ": " + key + " missing or outside [0,1]");
      }
    }
    const confusion = endToEnd.benchmark_directional_confusion_matrix;
    if (!Array.isArray(confusion)) {
      failures.push(label + ": directional confusion matrix missing");
    } else {
      const classified = confusion.reduce((total, item) => total +
        Object.values(item?.predicted || {}).reduce((subtotal, count) =>
          subtotal + (typeof count === "number" && Number.isFinite(count) ? count : 0), 0), 0);
      if (classified !== rows.length) failures.push(label + ": confusion matrix denominator mismatch");
    }

    checks.push({
      label,
      file,
      pass: failures.length === startFailureCount,
      evaluation_count: report.dataset?.claims_evaluated ?? null,
      corpus_documents: report.dataset?.corpus_documents ?? null,
      source_commit_sha: provenance.source_commit_sha ?? null,
      sha256: await sha256(file)
    });
  } catch (error) {
    failures.push(label + ": invalid benchmark artifact (" + String(error) + ")");
    checks.push({ label, file, pass: false, reason: "invalid benchmark artifact" });
  }
}

async function checkArtifact(label, file, expectedBenchmarkId, expectedEvaluationCount = null) {
  const ok = await exists(file);
  checks.push({ label, file, exists: ok });
  if (!ok) {
    failures.push(label + ": missing artifact");
    return;
  }
  try {
    const artifact = await readJson(file);
    if (artifact.benchmark_id !== expectedBenchmarkId) {
      failures.push(label + ": benchmark_id mismatch (" + artifact.benchmark_id + ")");
    }
    if (expectedEvaluationCount !== null && artifact.evaluation_count !== expectedEvaluationCount) {
      failures.push(label + ": evaluation_count mismatch (" + artifact.evaluation_count + ", expected " + expectedEvaluationCount + ")");
    }
    if (!artifact.metrics || typeof artifact.metrics !== "object") {
      failures.push(label + ": metrics payload missing");
    } else if (expectedBenchmarkId === "fever" || expectedBenchmarkId === "feverous") {
      for (const key of ["strict_score", "label_accuracy", "evidence_precision", "evidence_recall", "evidence_f1"]) {
        if (typeof artifact.metrics[key] !== "number" || !Number.isFinite(artifact.metrics[key])) {
          failures.push(label + ": metric " + key + " missing or non-numeric");
        }
      }
    } else if (expectedBenchmarkId === "averitec") {
      const groups = ["veracity_f1", "averitec_veracity", "averitec_justification"];
      for (const group of groups) {
        if (!artifact.metrics[group] || typeof artifact.metrics[group] !== "object" || Object.keys(artifact.metrics[group]).length === 0) {
          failures.push(label + ": metric group " + group + " missing or empty");
        }
      }
    }
    checks[checks.length - 1].sha256 = await sha256(file);
  } catch (error) {
    failures.push(label + ": invalid JSON (" + String(error) + ")");
  }
}

if (manifest.phase !== 2) failures.push("manifest phase is not 2");
if (manifest.production_accuracy_claim !== false) failures.push("production accuracy claim flag must remain false");
if (manifest.rules?.complete_artifact_required_before_publishing_metrics !== true) {
  failures.push("complete artifact rule missing");
}
if (manifest.rules?.production_artifact_must_remain_unchanged !== true) {
  failures.push("production immutability rule missing");
}

const scifactBaseline = "docs/V3_PHASE2_BENCHMARK_PROTOCOL.md";
checks.push({ label: "SciFact baseline protocol record", file: scifactBaseline, exists: await exists(scifactBaseline) });
if (!(await exists(scifactBaseline))) failures.push("SciFact protocol record missing");

await checkSciFactArtifact();

await checkArtifact(
  "FEVER official score",
  "artifacts/v3/fever/official-scorer-run.json",
  "fever",
  manifest.benchmarks.find((item) => item.id === "fever_v1")?.expected_evaluation_claims ?? null
);

await checkArtifact(
  "FEVEROUS official score",
  "artifacts/v3/feverous/official-scorer-run.json",
  "feverous",
  manifest.benchmarks.find((item) => item.id === "feverous")?.expected_evaluation_claims ?? null
);

await checkArtifact(
  "AVeriTeC official score",
  "artifacts/v2-averitec-e2e/official-evaluation.json",
  "averitec",
  manifest.benchmarks.find((item) => item.id === "averitec")?.expected_evaluation_claims ?? null
);

await checkCommitProvenance("SciFact evaluated commit", "artifacts/v2-scifact-e2e/scifact-end-to-end.json", (artifact) => artifact.run_provenance?.source_commit_sha);
await checkCommitProvenance("FEVER score evaluated commit", "artifacts/v3/fever/official-scorer-run.json", (artifact) => artifact.truthlens_git_sha);
await checkCommitProvenance("FEVER adapter evaluated commit", "artifacts/v3/fever/truthlens-adapter-report.json", (artifact) => artifact.provenance?.commit_sha);
await checkCommitProvenance("FEVEROUS score evaluated commit", "artifacts/v3/feverous/official-scorer-run.json", (artifact) => artifact.truthlens_git_sha);
await checkCommitProvenance("FEVEROUS adapter evaluated commit", "artifacts/v3/feverous/truthlens-adapter-report.json", (artifact) => artifact.provenance?.commit_sha);
await checkCommitProvenance("AVeriTeC score evaluated commit", "artifacts/v2-averitec-e2e/official-evaluation.json", (artifact) => artifact.truthlens_git_sha);
await checkCommitProvenance("AVeriTeC reproducibility manifest evaluated commit", "artifacts/v2-averitec-e2e/reproducibility-manifest.json", (artifact) => artifact.truthlens_git_sha);

const openWebHoldout = "research/open-web-v1-holdout.jsonl";
const openWebManifest = "artifacts/v3/open-web-v1/holdout-release-manifest.json";
const openWebGate = "artifacts/v3/open-web-v1/holdout-gate.json";
const holdoutExists = await exists(openWebHoldout);
const openManifestExists = await exists(openWebManifest);
const openGateExists = await exists(openWebGate);
checks.push({
  label: "Open-Web sealed human-labelled holdout",
  holdoutExists,
  manifestExists: openManifestExists,
  validatorGateExists: openGateExists
});
if (!holdoutExists || !openManifestExists || !openGateExists) {
  failures.push("Open-Web human-labelled blind holdout and successful validator evidence are not sealed");
} else {
  try {
    const release = await readJson(openWebManifest);
    const validation = await readJson(openWebGate);
    const holdoutBytes = await fs.readFile(openWebHoldout);
    const actual = crypto.createHash("sha256").update(holdoutBytes).digest("hex");
    const physicalLines = holdoutBytes.toString("utf8").split(/\r?\n/);
    const holdoutRows = physicalLines.filter((line) => line.trim().length > 0).length;

    if (release.benchmark_id !== "truthlens_open_web_v1" || release.release_state !== "SEALED") {
      failures.push("Open-Web release manifest is not SEALED");
    }
    if (release.target_claims !== 100 || release.evaluation_count !== 100 || holdoutRows !== 100) {
      failures.push("Open-Web holdout must contain exactly 100 claims in both file and release manifest");
    }
    if (!/^[a-f0-9]{64}$/i.test(release.sha256 || "") || actual !== release.sha256) {
      failures.push("Open-Web holdout hash does not match release manifest");
    }
    if (validation.benchmark_id !== "truthlens_open_web_v1" ||
        validation.status !== "SEALED" ||
        validation.release_state !== "SEALED" ||
        validation.record_count !== 100) {
      failures.push("Open-Web validator gate artifact does not prove a sealed 100-claim holdout");
    }
    if (!Number.isInteger(release.independent_annotator_count) || release.independent_annotator_count < 2 ||
        !Number.isInteger(validation.independent_annotator_count) || validation.independent_annotator_count < 2) {
      failures.push("Open-Web holdout must attest at least two independent human annotators");
    }
    if (!/^[a-f0-9]{64}$/i.test(release.attestation_sha256 || "") ||
        release.attestation_sha256 !== validation.attestation_sha256) {
      failures.push("Open-Web human annotation attestation provenance is missing or inconsistent");
    }
    if (validation.sha256 !== release.sha256) {
      failures.push("Open-Web validator evidence and release manifest holdout hashes differ");
    }

    checks.push({
      label: "Open-Web holdout count, sealed validator, and human attestation",
      pass: !failures.some((failure) => failure.includes("Open-Web"))
    });
  } catch (error) {
    failures.push("Open-Web holdout gate artifacts are invalid JSON or unreadable (" + String(error) + ")");
  }
}

const gate = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  evaluated_commit_sha: /^[a-f0-9]{40}$/i.test(expectedCommitSha) ? expectedCommitSha : null,
  phase: 2,
  status: failures.length ? "BLOCKED" : "READY_FOR_HUMAN_REVIEW",
  complete: failures.length === 0,
  checks,
  failures,
  production_promotion_allowed: false,
  notes: [
    "Benchmark scores remain benchmark-specific.",
    "A complete artifact and provenance are required before publishing metrics.",
    "Production promotion remains separately gated."
  ]
};

const out = path.resolve("artifacts/v3/phase2-exit-gate.json");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify(gate, null, 2) + "\n");
console.log(JSON.stringify(gate, null, 2));

if (failures.length) process.exit(1);
