/**
 * Safety tests for a newly trained candidate artifact.
 *
 * This test receives an artifact path produced by the candidate workflow and
 * never reads/writes the canonical production artifact. It checks the runtime
 * loader, calibration contract, abstention for out-of-vocabulary content, and
 * two deterministic real/fabricated article guardrails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TruthLensMLEngine } from '../server/mlEngine.js';

const artifactPath = process.argv[2];
if (!artifactPath || !fs.existsSync(artifactPath)) {
  console.error('Usage: npx tsx scripts/runtimeCandidateSafetyTests.ts <candidate-model-artifact.json>');
  process.exit(2);
}

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log('PASS  ' + name);
  } else {
    failed++;
    console.error('FAIL  ' + name + (detail ? ' -- ' + detail : ''));
  }
}

const engine = new TruthLensMLEngine(artifactPath);
const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
  model_version?: string;
  thresholds?: { fake_threshold?: number; real_threshold?: number };
};
const fakeThreshold = Number(artifact.thresholds?.fake_threshold);
const realThreshold = Number(artifact.thresholds?.real_threshold);
const artifactSha256 = createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

const REAL_ARTICLE =
  'WASHINGTON (Reuters) - The U.S. Department of Education on Tuesday announced a new digital learning initiative to provide online educational resources to public school students across the country, senior officials told reporters. The program, according to Education Secretary Miguel Cardona, will expand broadband access in government schools, equip digital classrooms, and help students and teachers use online learning materials more effectively during the upcoming academic year.';

const FAKE_ARTICLE =
  'SHOCKING SECRET EXPOSED BY MILITARY WHISTLEBLOWER! Alien mothership over five miles wide is hovering in lunar orbit completely concealed from civilian telescopes using cloaking technology! The mainstream corrupt media and shadow government are desperately attempting to scrub this unbelievable miracle truth from the internet! Insiders confirm that world leaders signed a secret treaty allowing deep-state extraction operations in exchange for zero-point energy weapons! Share this before the global elites delete it forever! Wake up people!';

// A separate fabricated sample without sensational-lexicon markers exercises
// the calibrated probability path; the clickbait sample above is expected to
// abstain, not expose probabilities, when model/style signals conflict.
const FAKE_REPRESENTATIVE_ARTICLE =
  'A pharmaceutical company confirmed that its new tablet eliminates diabetes in every patient after a single dose. The company claimed the treatment has completed all required clinical trials, but its filing number is absent from the public trial registry and the regulator has not issued an approval notice.';

check('candidate artifact loaded as a trained runtime model', engine.isModelTrained());
check('candidate thresholds match the frozen production policy (fake 0.98 / real 0.35)',
  fakeThreshold === 0.98 && realThreshold === 0.35,
  JSON.stringify({ fake_threshold: fakeThreshold, real_threshold: realThreshold }));
check('candidate uses an exact calibrated inference contract', engine.isCalibrationExact());
check(
  'candidate inference mode is explicitly calibrated',
  ['single_calibrated_svm', 'calibrated_ensemble'].includes(engine.getInferenceMode()),
  engine.getInferenceMode()
);

const real = engine.analyzeArticle(REAL_ARTICLE);
const fake = engine.analyzeArticle(FAKE_ARTICLE);
const representativeFake = engine.analyzeArticle(FAKE_REPRESENTATIVE_ARTICLE);
const zeroVocabulary =
  'qzxvultra qzxvultra2 qzxvultra3 qzxvultra4 qzxvultra5 qzxvultra6 ' +
  'qzxvultra7 qzxvultra8 qzxvultra9 qzxvultra10 qzxvultra11 qzxvultra12 ' +
  'qzxvultra13 qzxvultra14 qzxvultra15 qzxvultra16 qzxvultra17 qzxvultra18 ' +
  'qzxvultra19 qzxvultra20 qzxvultra21 qzxvultra22';
const ood = engine.analyzeArticle(zeroVocabulary);

check(
  'Reuters-style real article is not force-classified as LIKELY FAKE',
  real.prediction !== 'LIKELY FAKE',
  JSON.stringify({ prediction: real.prediction, fake_probability: real.fake_probability })
);
check(
  'clearly fabricated article is not force-classified as LIKELY REAL',
  fake.prediction !== 'LIKELY REAL',
  JSON.stringify({ prediction: fake.prediction, fake_probability: fake.fake_probability })
);
check(
  'real-leaning model output with multiple sensational markers triggers conservative abstention',
  fake.prediction === 'NEEDS MORE CONTEXT',
  JSON.stringify({ prediction: fake.prediction, indicators: fake.indicators?.map((item: any) => item.name) })
);
check(
  'sensational-conflict abstention withholds both class probabilities and confidence',
  fake.fake_probability === null && fake.real_probability === null && fake.confidence === null,
  JSON.stringify({ fake_probability: fake.fake_probability, real_probability: fake.real_probability, confidence: fake.confidence })
);
check(
  'non-sensational fabricated article receives the calibrated LIKELY FAKE verdict',
  representativeFake.prediction === 'LIKELY FAKE' &&
    typeof representativeFake.fake_probability === 'number' &&
    representativeFake.fake_probability >= fakeThreshold,
  JSON.stringify({
    prediction: representativeFake.prediction,
    fake_probability: representativeFake.fake_probability,
    real_probability: representativeFake.real_probability
  })
);
for (const [label, result] of [['real', real], ['fake', representativeFake]] as const) {
  const pFake = result.fake_probability;
  const pReal = result.real_probability;
  check(
    label + ' representative article exposes calibrated, finite class probabilities',
    typeof pFake === 'number' && Number.isFinite(pFake) && pFake >= 0 && pFake <= 1 &&
      typeof pReal === 'number' && Number.isFinite(pReal) && pReal >= 0 && pReal <= 1,
    JSON.stringify({ prediction: result.prediction, fake_probability: pFake, real_probability: pReal })
  );
  if (typeof pFake === 'number' && typeof pReal === 'number') {
    check(
      label + ' real/fake probabilities are complementary within rounding tolerance',
      Math.abs((pFake + pReal) - 1) <= 0.0002,
      JSON.stringify({ fake_probability: pFake, real_probability: pReal })
    );
  }
}

check('zero-vocabulary input abstains instead of forcing a label',
  ood.prediction === 'NEEDS MORE CONTEXT', ood.prediction);
check('zero-vocabulary input withholds class probabilities',
  ood.fake_probability === null && ood.real_probability === null,
  JSON.stringify({ fake_probability: ood.fake_probability, real_probability: ood.real_probability }));

const safetyReport = {
  schema_version: 1,
  status: 'COMPLETED',
  generated_at: new Date().toISOString(),
  candidate_model_version: artifact.model_version ?? null,
  candidate_artifact_sha256: artifactSha256,
  inference_mode: engine.getInferenceMode(),
  calibration_exact: engine.isCalibrationExact(),
  thresholds: { fake_threshold: fakeThreshold, real_threshold: realThreshold },
  runtime_policy_matches_production: fakeThreshold === 0.98 && realThreshold === 0.35,
  assertions_passed: passed,
  assertions_failed: failed,
  passed: failed === 0 && engine.isModelTrained() && engine.isCalibrationExact() &&
    fakeThreshold === 0.98 && realThreshold === 0.35
};
const safetyReportPath = path.join(path.dirname(path.resolve(artifactPath)), 'runtime_safety_validation.json');
fs.writeFileSync(safetyReportPath, JSON.stringify(safetyReport, null, 2) + '\n', 'utf8');
console.log('\nCANDIDATE SAFETY SUMMARY: ' + passed + ' passed, ' + failed + ' failed');
console.log('Artifact-bound safety report: ' + safetyReportPath);
if (failed > 0) process.exit(1);
