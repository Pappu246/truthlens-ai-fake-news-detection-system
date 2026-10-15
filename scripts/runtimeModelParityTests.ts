import fs from "fs";
import path from "path";
import { TruthLensMLEngine, cleanText } from "../server/mlEngine";

const ROOT = process.cwd();
const modelsDir = path.join(ROOT, "artifacts", "models");
const requested = process.env.RUNTIME_MODEL_VERSION;

function fail(message: string): never {
  console.error("FAIL: " + message);
  process.exit(1);
}

if (!fs.existsSync(modelsDir)) fail("Candidate models directory missing: " + modelsDir);

const versions = fs.readdirSync(modelsDir)
  .filter(name => fs.statSync(path.join(modelsDir, name)).isDirectory())
  .sort();

const version = requested || versions[versions.length - 1];
if (!version) fail("No runtime model candidate was produced.");

const dir = path.join(modelsDir, version);
const artifactPath = path.join(dir, "model_artifact.json");
const fixturesPath = path.join(dir, "runtime_parity_fixtures.json");
if (!fs.existsSync(artifactPath)) fail("Candidate artifact missing: " + artifactPath);
if (!fs.existsSync(fixturesPath)) fail("Parity fixtures missing: " + fixturesPath);

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
if (artifact.selected_model?.inference_mode !== "single_calibrated_svm") {
  fail("Unexpected inference mode: " + String(artifact.selected_model?.inference_mode));
}

const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8")) as Array<{
  id: string;
  text: string;
  expected_fake_probability: number;
  candidate_terms: number;
  matched_terms: number;
}>;

if (!fixtures.length) fail("Parity fixture set is empty.");

const engine = new TruthLensMLEngine(artifactPath);
let passed = 0;
for (const fixture of fixtures) {
  const actual = engine.predictProbabilityDetailed(cleanText(fixture.text));
  const probabilityDrift = Math.abs(actual.probability - fixture.expected_fake_probability);
  const candidateDelta = actual.candidate_term_count - fixture.candidate_terms;
  const matchedDelta = actual.matched_term_count - fixture.matched_terms;

  if (probabilityDrift > 1e-12 || candidateDelta !== 0 || matchedDelta !== 0) {
    fail(
      "Parity mismatch for " + fixture.id +
      ": probability drift=" + probabilityDrift +
      ", candidate_delta=" + candidateDelta +
      ", matched_delta=" + matchedDelta
    );
  }
  passed++;
}

console.log("PASS: Runtime parity " + passed + "/" + fixtures.length + " fixtures matched within 1e-12.");
console.log("PASS: Candidate " + version);

// Diagnostic-only probes for out-of-domain article styles. These examples are
// NOT labeled as truth/falsehood and do not gate promotion by expected class.
// They record how the calibrated candidate behaves on science, health, and a
// sensational-rumour style so reviewers can see whether it simply abstains on
// every modern-news input. Actual fact-check labels must come from evidence.
const probes = [
  {
    id: "science_nasa_style",
    kind: "official_science_reporting_style",
    text: "NASA's James Webb Space Telescope captured infrared observations of star-forming regions in the NGC 346 cluster. Researchers analyzed spectral measurements and published their findings in a peer-reviewed astronomy journal. The observations help scientists study how stars form in nearby galaxies."
  },
  {
    id: "health_nih_style",
    kind: "medical_research_reporting_style",
    text: "Researchers at the National Institutes of Health described results from a clinical study in a peer-reviewed medical journal. The report outlines the study design, participant outcomes, limitations, and the need for additional research before conclusions can be applied broadly."
  },
  {
    id: "sensational_rumour_style",
    kind: "sensational_unverified_rumour_style",
    text: "SHOCKING SECRET EXPOSED BY MILITARY WHISTLEBLOWER! An alien mothership cloaked behind the moon has been detected by independent observers. Officials are supposedly hiding proof, but no named observer, instrument, report, or verifiable source is provided."
  }
];

const realThreshold = Number(artifact.thresholds?.real_threshold ?? 0.35);
const fakeThreshold = Number(artifact.thresholds?.fake_threshold ?? 0.65);
const probeResults = probes.map(probe => {
  const scored = engine.predictProbabilityDetailed(cleanText(probe.text));
  const label = scored.probability >= fakeThreshold
    ? "LIKELY_FAKE"
    : scored.probability <= realThreshold
      ? "LIKELY_REAL"
      : "NEEDS_MORE_CONTEXT";
  if (!scored.calibrated || !Number.isFinite(scored.probability) ||
      scored.probability < 0 || scored.probability > 1) {
    fail("Invalid calibrated probe result for " + probe.id);
  }
  return {
    id: probe.id,
    kind: probe.kind,
    input_characters: probe.text.length,
    fake_probability: scored.probability,
    decision_margin: scored.decision_margin,
    candidate_terms: scored.candidate_term_count,
    matched_terms: scored.matched_term_count,
    vocabulary_coverage: scored.coverage_ratio,
    diagnostic_label: label,
    ground_truth_label: null,
    note: "Style-distribution diagnostic only; not a factual verdict or ground-truth evaluation."
  };
});

const probeReport = {
  model_version: version,
  model_family: artifact.selected_model?.inference_mode,
  thresholds: { real_threshold: realThreshold, fake_threshold: fakeThreshold },
  generated_at: new Date().toISOString(),
  promotion_status: "CANDIDATE_ONLY",
  note: "No probe label is treated as human ground truth. Use this report to inspect calibration and abstention behaviour only.",
  probes: probeResults
};
fs.writeFileSync(path.join(dir, "runtime_probe_diagnostics.json"), JSON.stringify(probeReport, null, 2) + "\\n");
console.log("PASS: Calibrated runtime diagnostic probes " + probeResults.length + "/"+ probes.length + " recorded.");
