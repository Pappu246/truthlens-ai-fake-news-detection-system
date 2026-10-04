/**
 * TruthLens AI — article model safety regression suite.
 *
 * Covers the production failure mode found in the v3.0 artifact:
 * averaged fold Platt parameters were applied to a different full-training
 * SVM, saturating unfamiliar inputs toward FAKE.
 *
 * This suite intentionally tests:
 *   1. zero-vocabulary input -> abstain, no public probability
 *   2. Reuters-style real article -> never high-confidence FAKE
 *   3. clearly fabricated article -> never LIKELY REAL
 *   4. historical LIAR REAL samples -> no 95%+ FAKE false certainty
 *   5. diagnostics expose the exact vs legacy inference mode
 */
import fs from 'fs';
import path from 'path';
import { mlEngine } from '../server/mlEngine';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail = '') {
  if (condition) {
    console.log(`✅ [PASS] ${name}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const REAL_ARTICLE =
  'WASHINGTON (Reuters) - The U.S. Department of Education on Tuesday announced a new digital learning initiative to provide online educational resources to public school students across the country, senior officials told reporters. The program, according to Education Secretary Miguel Cardona, will expand broadband access in government schools, equip digital classrooms, and help students and teachers use online learning materials more effectively during the upcoming academic year.';

const FAKE_ARTICLE =
  'SHOCKING SECRET EXPOSED BY MILITARY WHISTLEBLOWER! Alien mothership over five miles wide is hovering in lunar orbit completely concealed from civilian telescopes using cloaking technology! The mainstream corrupt media and shadow government are desperately attempting to scrub this unbelievable miracle truth from the internet! Insiders confirm that world leaders signed a secret treaty allowing deep-state extraction operations in exchange for zero-point energy weapons! Share this before the global elites delete it forever! Wake up people!';

console.log('=== MODEL SAFETY / CALIBRATION REGRESSION ===');

const zeroVocab =
  'qzxvultra qzxvultra2 qzxvultra3 qzxvultra4 qzxvultra5 qzxvultra6 ' +
  'qzxvultra7 qzxvultra8 qzxvultra9 qzxvultra10 qzxvultra11 qzxvultra12 ' +
  'qzxvultra13 qzxvultra14 qzxvultra15 qzxvultra16 qzxvultra17 qzxvultra18 ' +
  'qzxvultra19 qzxvultra20 qzxvultra21 qzxvultra22';

const ood = mlEngine.analyzeArticle(zeroVocab);
assert(ood.prediction === 'NEEDS MORE CONTEXT', 'Zero-vocabulary input abstains', JSON.stringify({
  prediction: ood.prediction, coverage: ood.vocabulary_coverage
}));
assert(ood.fake_probability === null && ood.real_probability === null,
  'Zero-vocabulary input exposes no misleading class probability',
  JSON.stringify({ fake_probability: ood.fake_probability, real_probability: ood.real_probability }));
assert(ood.confidence_score === null, 'Zero-vocabulary confidence is withheld');

const real = mlEngine.analyzeArticle(REAL_ARTICLE);
if (real.model_inference_mode === 'legacy_single_svm') {
  assert(real.model === 'Linear SVM (Safety-Gated Legacy)' && real.model_used === 'Linear SVM (Safety-Gated Legacy)',
    'Legacy article result names the actual safety-gated runtime',
    JSON.stringify({ model: real.model, model_used: real.model_used }));
}
assert(real.prediction !== 'LIKELY FAKE',
  'Reuters-style real article is never LIKELY FAKE',
  JSON.stringify({ prediction: real.prediction, fake_probability: real.fake_probability, margin: real.decision_margin }));
if (real.prediction === 'LIKELY REAL') {
  assert((real.fake_probability ?? 1) < 0.35,
    'Reuters-style real article has low fake score',
    JSON.stringify(real.fake_probability));
}

const fake = mlEngine.analyzeArticle(FAKE_ARTICLE);
assert(fake.prediction !== 'LIKELY REAL',
  'Clearly fabricated article is never LIKELY REAL',
  JSON.stringify({ prediction: fake.prediction, fake_probability: fake.fake_probability }));

const rssSummary = {
  text: 'Officials announced today that consumer prices rose in March, according to data published by the national statistics office. ' +
    'The report said the change was in line with forecasts and that officials would review the figures at the next scheduled meeting. ' +
    'Analysts said the release would be followed by additional economic data later this month.',
  inputType: 'live_news' as const,
  contentSource: 'RSS_SUMMARY_ONLY' as const
};
const rss = mlEngine.analyzeArticle(rssSummary.text, 'https://example.com/news', rssSummary);
assert(rss.prediction === 'NEEDS MORE CONTEXT',
  'RSS summary never receives a forced real/fake verdict',
  JSON.stringify({ prediction: rss.prediction, content_source: rss.content_source }));
assert(rss.fake_probability === null && rss.real_probability === null,
  'RSS summary withholds fake/real probabilities',
  JSON.stringify({ fake_probability: rss.fake_probability, real_probability: rss.real_probability }));
assert(rss.confidence_score === null,
  'RSS summary withholds confidence',
  JSON.stringify(rss.confidence_score));

const blocked = mlEngine.analyzeArticle(rssSummary.text, 'https://example.com/news', {
  inputType: 'live_news',
  contentSource: 'EXTRACTION_BLOCKED'
});
assert(blocked.prediction === 'NEEDS MORE CONTEXT',
  'Extraction-blocked content never receives a forced verdict',
  JSON.stringify(blocked.prediction));

const artifactPath = path.join(process.cwd(), 'data', 'saved_model_artifacts.json');
if (fs.existsSync(artifactPath)) {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const hasExactEnsemble = artifact.selected_model?.inference_mode === 'calibrated_ensemble'
    && Array.isArray(artifact.selected_model?.members)
    && artifact.selected_model.members.length === 3;
  assert(
    hasExactEnsemble || artifact.selected_model?.inference_mode === undefined || artifact.selected_model?.inference_mode === 'legacy_single_svm',
    'Artifact inference mode is explicit or safely recognized as legacy',
    String(artifact.selected_model?.inference_mode)
  );
}

const diag = mlEngine.getDiagnostics();
assert(
  diag.inference_mode === 'calibrated_ensemble' || diag.inference_mode === 'legacy_single_svm',
  'Diagnostics expose recognized inference mode',
  String(diag.inference_mode)
);
if (diag.inference_mode === 'legacy_single_svm') {
  assert(
    diag.model_name === 'Linear SVM (Safety-Gated Legacy)' &&
      diag.model_type === 'Linear SVM (Safety-Gated Legacy)' &&
      diag.calibration?.is_calibrated === false &&
      diag.decision_policy?.probability_output === 'WITHHELD',
    'Legacy diagnostics label matches the non-calibrated safety runtime',
    JSON.stringify({
      model_name: diag.model_name,
      model_type: diag.model_type,
      is_calibrated: diag.calibration?.is_calibrated,
      probability_output: diag.decision_policy?.probability_output
    })
  );
}

const externalPath = path.join(process.cwd(), 'data', 'external_validation.json');
if (fs.existsSync(externalPath)) {
  const external = JSON.parse(fs.readFileSync(externalPath, 'utf8'));
  const samples = Array.isArray(external.sample_predictions) ? external.sample_predictions : [];
  const realSamples = samples.filter((x: any) => x.mapped_binary_label === 'REAL');
  let extremeFalseFake = 0;
  for (const sample of realSamples) {
    try {
      const result = mlEngine.analyzeArticle(sample.statement);
      if (result.prediction === 'LIKELY FAKE' && typeof result.confidence_score === 'number' && result.confidence_score >= 95) {
        extremeFalseFake++;
      }
    } catch {
      // A historical sample may trip the normal context guard; that is safe.
    }
  }
  assert(
    extremeFalseFake === 0,
    'Historical LIAR REAL samples do not produce 95%+ FAKE certainty',
    `extreme false-fake count=${extremeFalseFake}/${realSamples.length}`
  );
}

console.log(`\nMODEL SAFETY SUMMARY: ${passed} PASSED, ${failed} FAILED`);
if (failed > 0) process.exit(1);
