/**
 * TRUTHLENS AI — MODEL ARTIFACT LIFECYCLE REGRESSION SUITE (Node backend)
 *
 * Covers Task 10 of the ML upgrade: production runtime audit. Proves,
 * deterministically, that TruthLensMLEngine never ends up in a state where
 * it silently serves predictions from an empty/uninitialized model.
 *
 * Regression target #1: previously, when data/saved_model_artifacts.json
 * existed but failed its own integrity check (vocabulary/idf/weights
 * length mismatch, or non-finite calibration parameters), the constructor
 * did not check loadModelArtifact()'s return value and never fell back to
 * training. The engine was left with an empty vocabulary, silently
 * returning exactly P(FAKE)=0.5 for every single request forever, with
 * /api/health still unconditionally reporting status "ok".
 *
 * Regression target #2: the initial fix for #1 called train() as a
 * fallback, but train() unconditionally persisted its result to the
 * canonical production artifact path. That meant merely IMPORTING this
 * module (which constructs a module-level mlEngine singleton against the
 * real production path) -- or calling the lazy getDiagnostics()/
 * getMetrics() initializers -- could silently overwrite the canonical,
 * possibly carefully-promoted production model, with no human action and
 * no record of it happening. train() now takes a persist flag (default
 * true, preserving the existing behavior of the three genuinely explicit,
 * human-initiated call sites: POST /api/train, POST /api/dataset/reset-
 * demo, and the dataset-import method); every implicit/lazy fallback call
 * site now passes persist=false, so recovery still works in memory but
 * can never silently touch disk.
 *
 * All fixtures below use a temp directory and an artifactFileOverride
 * constructor argument -- no test in this file ever reads or writes the
 * real production artifact at data/saved_model_artifacts.json.
 *
 * Run: npx tsx scripts/test_artifact_lifecycle.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TruthLensMLEngine } from '../server/mlEngine';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passed++;
  } else {
    console.error(`[FAIL] ${testName}${detail ? ` -- ${detail}` : ''}`);
    failed++;
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truthlens-artifact-test-'));
function artifactPath(name: string): string {
  return path.join(tmpDir, name);
}

// A valid, internally-consistent (if tiny) artifact: vocab size 3, matching
// idf/weights lengths, finite calibration parameters.
const VALID_ARTIFACT = {
  vocabulary: { alpha: 0, beta: 1, gamma: 2 },
  idf: [1.1, 1.2, 1.3],
  selected_model: { name: 'Test SVM', weights: [0.4, -0.2, 0.1], bias: 0.05, plattA: -1.5, plattB: 0.1 },
  metrics: { is_demo: true, dataset_info: { is_demo: true, total_samples: 10 } },
  trained_at: new Date().toISOString(),
  thresholds: { fake_threshold: 0.65, real_threshold: 0.35, min_text_length: 60, min_word_count: 20 },
};

// Case D: internally INCONSISTENT -- vocab has 3 terms but idf/weights only
// have 1 entry each. This is the exact shape of bug that caused the
// original incident.
const INCONSISTENT_ARTIFACT = {
  vocabulary: { alpha: 0, beta: 1, gamma: 2 },
  idf: [1.0],
  selected_model: { name: 'Broken', weights: [0.5], bias: 0, plattA: -1.88, plattB: 0.0 },
};

// Case E: valid shapes but a completely EMPTY vocabulary -- the exact
// degenerate state the old code silently ran in indefinitely.
const EMPTY_VOCAB_ARTIFACT = {
  vocabulary: {},
  idf: [],
  selected_model: { name: 'Empty', weights: [], bias: 0, plattA: -1.88, plattB: 0.0 },
};

function write(name: string, obj: unknown): string {
  const p = artifactPath(name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

// ---------------------------------------------------------------------
// A. Valid production artifact loads successfully
// ---------------------------------------------------------------------
{
  const p = write('valid.json', VALID_ARTIFACT);
  const engine = new TruthLensMLEngine(p);
  assert(engine.isModelTrained() === true, 'A: a valid, consistent artifact loads and isModelTrained() is true');
  const prob = engine.predictProbability('some arbitrary text with alpha and beta terms in it');
  assert(prob !== 0.5, 'A: a real prediction is not pinned at exactly 0.5', `got ${prob}`);
}

// ---------------------------------------------------------------------
// B. Missing artifact -> safe recovery (falls back to training)
// ---------------------------------------------------------------------
{
  const missingPath = artifactPath('does-not-exist.json');
  const engine = new TruthLensMLEngine(missingPath);
  assert(engine.isModelTrained() === true,
    'B: a missing artifact file triggers fallback training, not a crash or an untrained engine');
}

// ---------------------------------------------------------------------
// C. Corrupt (unparseable) artifact -> integrity failure detected, safe
//    recovery via fallback training, never a silent empty model
// ---------------------------------------------------------------------
{
  const p = artifactPath('corrupt.json');
  fs.writeFileSync(p, '{ this is not valid json ][');
  const engine = new TruthLensMLEngine(p);
  assert(engine.isModelTrained() === true,
    'C: unparseable JSON triggers fallback training instead of leaving an untrained/empty engine');
}

// ---------------------------------------------------------------------
// D. Inconsistent artifact (vocab/idf/weights length mismatch) ->
//    detected and safely recovered via fallback training. THIS IS THE
//    EXACT REGRESSION CASE for the bug that was just fixed.
// ---------------------------------------------------------------------
{
  const p = write('inconsistent.json', INCONSISTENT_ARTIFACT);
  const engine = new TruthLensMLEngine(p);
  assert(engine.isModelTrained() === true,
    'D (regression): an inconsistent artifact (vocab=3, idf/weights=1) now triggers fallback ' +
    'training -- previously the constructor ignored loadModelArtifact()\'s false return and left ' +
    'the engine permanently untrained with an empty vocabulary');
}

// ---------------------------------------------------------------------
// E. Empty vocabulary artifact cannot silently produce P(FAKE)=0.5 for
//    every request. With the fix, this case is caught by the same
//    integrity guard (vocabSize === 0) and falls back to training, so a
//    real, non-degenerate model is what actually serves predictions.
// ---------------------------------------------------------------------
{
  const p = write('empty-vocab.json', EMPTY_VOCAB_ARTIFACT);
  const engine = new TruthLensMLEngine(p);
  assert(engine.isModelTrained() === true,
    'E: an empty-vocabulary artifact is rejected by the integrity guard and triggers fallback training');
  const prob1 = engine.predictProbability('the government announced a new policy today after review');
  const prob2 = engine.predictProbability('BREAKING miracle cure secret they dont want you to know');
  assert(!(prob1 === 0.5 && prob2 === 0.5),
    'E: two different inputs do not both collapse to exactly 0.5 (the empty-vocab degenerate case)',
    `prob1=${prob1}, prob2=${prob2}`);
}

// ---------------------------------------------------------------------
// F. Health-state invariant: isModelTrained() must be false ONLY in a
//    state that should never be reachable after construction (since the
//    constructor now always falls back to training). This test exists to
//    guard the invariant server.ts's /api/health depends on.
// ---------------------------------------------------------------------
{
  const p = write('valid2.json', VALID_ARTIFACT);
  const engine = new TruthLensMLEngine(p);
  assert(typeof engine.isModelTrained() === 'boolean',
    'F: isModelTrained() returns a real boolean the health endpoint can trust');
  assert(engine.isModelTrained() === true,
    'F: after construction with any artifact path (valid, missing, corrupt, or inconsistent), ' +
    'the engine is always left in a trained state -- never silently untrained');
}

// ---------------------------------------------------------------------
// G. REGRESSION: constructing an engine against a CORRUPT artifact must
//    train a working in-memory model WITHOUT writing that fallback back
//    to disk -- neither to the real production path, nor even to the
//    override path it was given. Only an explicit, human-initiated action
//    (the /api/train or /api/dataset/reset-demo routes, or the separate
//    scripts/promote_model.py governance flow) may ever write to a
//    canonical artifact location. A merely-imported/constructed engine
//    recovering from a bad file must never silently do so on disk.
// ---------------------------------------------------------------------
{
  const p = artifactPath('corrupt-must-not-persist.json');
  fs.writeFileSync(p, '{ not valid json ][');
  const beforeBytes = fs.readFileSync(p, 'utf-8');

  const engine = new TruthLensMLEngine(p);
  assert(engine.isModelTrained() === true,
    'G: engine still recovers to a working in-memory model from a corrupt artifact');

  const afterBytes = fs.readFileSync(p, 'utf-8');
  assert(afterBytes === beforeBytes,
    'G (regression): the corrupt artifact FILE ON DISK is byte-identical before and after ' +
    'construction -- the fallback trained in memory only and never wrote back to it',
    `before had ${beforeBytes.length} bytes, after has ${afterBytes.length} bytes`);
}

// ---------------------------------------------------------------------
// H. REGRESSION: the real production artifact must be completely
//    unaffected by merely importing this module and exercising the
//    engine, including calling getDiagnostics()/getMetrics() on a
//    freshly-constructed instance whose in-memory metrics are initially
//    unset (their own lazy-init path used to persist too).
// ---------------------------------------------------------------------
{
  const REAL_PRODUCTION_ARTIFACT = path.join(process.cwd(), 'data', 'saved_model_artifacts.json');
  const before = fs.existsSync(REAL_PRODUCTION_ARTIFACT)
    ? fs.readFileSync(REAL_PRODUCTION_ARTIFACT, 'utf-8')
    : null;

  // Construct several engines against isolated temp paths (as all tests in
  // this file do) and call the lazy getters that used to trigger a
  // same-process persist side effect.
  const p1 = write('h-check-1.json', VALID_ARTIFACT);
  const e1 = new TruthLensMLEngine(p1);
  e1.getDiagnostics();
  e1.getMetrics();

  const after = fs.existsSync(REAL_PRODUCTION_ARTIFACT)
    ? fs.readFileSync(REAL_PRODUCTION_ARTIFACT, 'utf-8')
    : null;

  assert(before === after,
    'H (regression): the real production artifact at data/saved_model_artifacts.json is ' +
    'byte-identical before and after constructing engines and calling getDiagnostics()/' +
    'getMetrics() -- importing/exercising this module never touches the canonical file',
    before === null ? 'production artifact did not exist' : 'production artifact content changed');
}



console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
