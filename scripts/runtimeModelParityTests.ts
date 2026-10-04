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
