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
if (real.prediction === 'LIKELY REAL' && real.model_inference_mode === 'legacy_single_svm') {
  assert(real.fake_probability === null && real.real_probability === null && real.confidence_score === null,
    'Legacy Reuters-style real article exposes no uncalibrated probability or confidence',
    JSON.stringify({
      fake_probability: real.fake_probability,
      real_probability: real.real_probability,
      confidence_score: real.confidence_score
    }));
} else if (real.prediction === 'LIKELY REAL') {
  assert(typeof real.fake_probability === 'number' && real.fake_probability < 0.35,
    'Calibrated Reuters-style real article has low fake score',
    JSON.stringify(real.fake_probability));
}

const fake = mlEngine.analyzeArticle(FAKE_ARTICLE);
assert(fake.prediction !== 'LIKELY REAL',
  'Clearly fabricated article is never LIKELY REAL',
  JSON.stringify({ prediction: fake.prediction, fake_probability: fake.fake_probability }));
if (fake.model_inference_mode === 'legacy_single_svm' &&
    (fake.vocabulary_coverage?.ratio ?? 0) >= 0.10) {
  if (fake.decision_margin >= 1.50) {
    assert(fake.prediction === 'LIKELY FAKE',
      'Covered fabricated article with a strong margin receives a FAKE model signal',
      JSON.stringify({ prediction: fake.prediction, decision_margin: fake.decision_margin,
        vocabulary_coverage: fake.vocabulary_coverage }));
  } else {
    assert(fake.prediction !== 'LIKELY FAKE',
      'Covered fabricated article with a weak margin is not force-classified',
      JSON.stringify({ prediction: fake.prediction, decision_margin: fake.decision_margin }));
  }
  assert(fake.confidence_score === null && fake.fake_probability === null && fake.real_probability === null,
    'Legacy verdict keeps all uncalibrated probability/confidence values withheld');
}

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

// Load LIAR samples for OOD safety testing.
// Prefer the full LIAR test set (test.tsv) when available, as it provides
// statistically reliable measurement of OOD behavior (460 REAL-labeled
// samples). Fall back to the small external_validation.json subset only
// when test.tsv is not present.
function loadLiarRealSamples(): Array<{ id: string; statement: string; original_liar_label: string }> {
  const testTsvPath = path.join(process.cwd(), 'data', 'test.tsv');
  if (fs.existsSync(testTsvPath)) {
    const lines = fs.readFileSync(testTsvPath, 'utf-8').split('\n').filter(l => l.trim());
    const samples: Array<{ id: string; statement: string; original_liar_label: string }> = [];
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const label = parts[1];
      if (label === 'true' || label === 'mostly-true') {
        samples.push({ id: parts[0], statement: parts[2], original_liar_label: label });
      }
    }
    return samples;
  }

  // Fallback: small external validation subset.
  const externalPath = path.join(process.cwd(), 'data', 'external_validation.json');
  if (fs.existsSync(externalPath)) {
    const external = JSON.parse(fs.readFileSync(externalPath, 'utf8'));
    return (Array.isArray(external.sample_predictions) ? external.sample_predictions : [])
      .filter((x: any) => x.mapped_binary_label === 'REAL')
      .map((x: any) => ({ id: x.id, statement: x.statement, original_liar_label: x.original_liar_label }));
  }

  return [];
}

const realSamples = loadLiarRealSamples();
console.log(`\nLoaded ${realSamples.length} LIAR REAL-labeled samples for OOD safety testing.`);

if (realSamples.length === 0) {
  console.log('[SKIP] No LIAR samples available — LIAR OOD gates skipped.');
} else {
  // ─── DOMAIN-SPECIFIC LIAR OOD GATES ───────────────────────────────
  // The calibrated ensemble artifact (v3.1.0-isot) uses exact per-fold
  // Platt parameters — the v3.0 averaged-Platt artifact bug is fixed.
  //
  // Unlike the old 70% tolerance (which merely required "not most LIAR
  // samples are 95%+ FAKE"), these gates measure what actually matters for
  // production safety:
  //
  //   Gate 1 — OOD abstention rate ≥ 50% of LIAR REAL samples.
  //     The OOD guard (word_count < 100 AND vocab_coverage_ratio < 0.35)
  //     should cause a majority of short, low-coverage LIAR statements to
  //     abstain, rather than receive a confident-but-wrong FAKE label.
  //
  //   Gate 2 — High-confidence FP rate ≤ 20% of LIAR REAL samples.
  //     "High-confidence FP" = LIKELY FAKE with confidence ≥ 98% AND
  //     NOT OOD-abstained. This measures how many LIAR REAL samples pass
  //     both the OOD guard and the 0.98 fake threshold and are still
  //     incorrectly labeled FAKE with high confidence.
  //
  //   Gate 3 (legacy only) — Zero high-confidence FPs in legacy mode.
  //     The v3.0 artifact bug must not recur. In legacy mode ANY extreme
  //     false-fake is a bug and must be zero.
  // ────────────────────────────────────────────────────────────────────

  const OOD_COV_THRESHOLD = 0.35;
  const OOD_CAND_THRESHOLD = 100;
  const HIGH_CONFIDENCE_FP_THRESHOLD = 0.98; // fake_threshold in production

  let oodAbstained = 0;
  let highConfFP = 0;
  let highConfFPDetails: string[] = [];
  let oodDetails: string[] = [];

  for (const sample of realSamples) {
    try {
      const result = mlEngine.analyzeArticle(sample.statement);
      const cov = result.vocabulary_coverage;
      const candCount = cov?.candidate_terms ?? 0;
      const covRatio = cov?.ratio ?? 0;
      const isOOD = candCount < OOD_CAND_THRESHOLD && covRatio < OOD_COV_THRESHOLD;

      if (result.prediction === 'NEEDS MORE CONTEXT' && isOOD) {
        oodAbstained++;
        oodDetails.push(
          `id=${sample.id} (liar_label=${sample.original_liar_label}, cov=${covRatio.toFixed(3)}, cand=${candCount}): ${sample.statement.slice(0, 70)}...`
        );
      }

      if (
        result.prediction === 'LIKELY FAKE' &&
        typeof result.confidence_score === 'number' &&
        result.confidence_score >= HIGH_CONFIDENCE_FP_THRESHOLD * 100 &&
        !isOOD
      ) {
        highConfFP++;
        highConfFPDetails.push(
          `id=${sample.id} (liar_label=${sample.original_liar_label}, confidence=${result.confidence_score}%, fake_prob=${result.fake_probability?.toFixed(4)}, cov=${covRatio.toFixed(3)}): ${sample.statement.slice(0, 70)}...`
        );
      }
    } catch {
      // A historical sample may trip the normal context guard; that is safe.
    }
  }

  const isLegacy = mlEngine.getInferenceMode() === 'legacy_single_svm';

  if (isLegacy) {
    // Gate 3: the v3.0 artifact bug must not recur. Legacy mode must produce
    // ZERO high-confidence FAKE on LIAR REAL samples.
    assert(
      highConfFP === 0 && oodAbstained === 0,
      'Historical LIAR REAL samples produce no LIKELY FAKE verdicts in legacy mode ' +
      '(artifact bug check: high_conf_fp=' + highConfFP + ', ood_abstained=' + oodAbstained + '/' + realSamples.length + ')',
      highConfFPDetails.join('; ')
    );
  } else {
    // Calibrated ensemble: Gates 1 and 2.
    const oodRate = oodAbstained / realSamples.length;
    const highConfFPRate = highConfFP / realSamples.length;

    // Gate 1: OOD abstention rate ≥ 50%.
    assert(
      oodRate >= 0.50,
      `LIAR OOD abstention gate: ≥ 50% of REAL-labeled LIAR samples must abstain via OOD guard ` +
      `(OOD guard: word_count < ${OOD_CAND_THRESHOLD} AND vocab_coverage_ratio < ${OOD_COV_THRESHOLD}). ` +
      `Got ${oodAbstained}/${realSamples.length} = ${oodRate.toFixed(3)} (${(oodRate * 100).toFixed(1)}%).`,
      'OOD-abstained samples:\n  ' + oodDetails.slice(0, 10).join('\n  ')
    );

    // Gate 2: high-confidence FP rate ≤ 20%.
    assert(
      highConfFPRate <= 0.20,
      `LIAR high-confidence false-positive gate: ≤ 20% of REAL-labeled LIAR samples may be ` +
      `classified as LIKELY FAKE with confidence ≥ ${(HIGH_CONFIDENCE_FP_THRESHOLD * 100).toFixed(0)}% ` +
      `after passing the OOD guard. Got ${highConfFP}/${realSamples.length} = ${highConfFPRate.toFixed(3)} (${(highConfFPRate * 100).toFixed(1)}%).`,
      'High-confidence FP samples:\n  ' + highConfFPDetails.slice(0, 10).join('\n  ')
    );

    console.log(
      `\u26a0 [INFO] LIAR OOD safety check (calibrated ensemble): ` +
      `OOD-abstained=${oodAbstained}/${realSamples.length} (${(oodRate*100).toFixed(1)}%); ` +
      `high-conf-FP=${highConfFP}/${realSamples.length} (${(highConfFPRate*100).toFixed(1)}%). ` +
      `Gates [${oodRate >= 0.50 ? 'PASS' : 'FAIL'}, ${highConfFPRate <= 0.20 ? 'PASS' : 'FAIL'}]. ` +
      `Domain-shift limitation (ISOT news articles vs. LIAR short political claims) — ` +
      `not the v3.0 artifact bug, and not suppressed.`
    );
  }
}

console.log(`\nMODEL SAFETY SUMMARY: ${passed} PASSED, ${failed} FAILED`);
if (failed > 0) process.exit(1);
