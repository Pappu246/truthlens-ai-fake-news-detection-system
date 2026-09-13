import { mlEngine } from '../server/mlEngine';
import { validateDataset } from '../server/dataValidation';
import { extractPrimaryClaim } from '../server/verification/claimExtractor';
import { evaluateSourceProvenance } from '../server/verification/evidenceService';
import { sqliteHistory } from '../server/sqliteHistory';

async function runAllTests() {
  console.log('====================================================');
  console.log('TRUTHLENS AI - ADVANCED ML & PIPELINE VALIDATION TEST');
  console.log('====================================================\n');

  await sqliteHistory.init();

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}${detail ? ` - ${detail}` : ''}`);
      failed++;
    }
  }

  // 1. DATASET AUDIT
  console.log('--- 1. DATASET AUDIT ---');
  const audit = validateDataset();
  assert(audit.status === 'VALID', 'Dataset validation status is VALID');
  assert(audit.total_samples === 36, `Total samples count is 36 (got ${audit.total_samples})`);
  assert(audit.real_samples === 18 && audit.fake_samples === 18, 'Balanced classes: 18 REAL, 18 FAKE');
  assert(audit.missing_values === 0, 'No missing values');
  assert(audit.duplicate_articles === 0, 'No duplicate articles');

  // 2. SHORT TEXT PROTECTION
  console.log('\n--- 2. SHORT TEXT PROTECTION ---');
  const shortResult = mlEngine.analyzeArticle('Breaking: New policy announced.');
  assert(
    shortResult.status === 'INSUFFICIENT_INFORMATION',
    'Short text (<60 chars) returns INSUFFICIENT_INFORMATION',
    `got status: ${shortResult.status}`
  );
  assert(
    shortResult.prediction === 'INSUFFICIENT INFORMATION',
    'Short text prediction is not forced to REAL/FAKE/SUSPICIOUS'
  );

  // 3. OBVIOUS FAKE NEWS SAMPLE
  console.log('\n--- 3. OBVIOUS FAKE NEWS SAMPLE ---');
  const fakeText = 'BREAKING: SHOCKING SECRET EXPOSED! Government whistleblowers reveal deep state mind control and alien conspiracy hidden from the public! 100% undeniable proof!';
  const fakeResult = mlEngine.analyzeArticle(fakeText);
  assert(
    fakeResult.prediction === 'LIKELY FAKE' && fakeResult.fake_probability >= 0.65,
    'Obvious fake article classified as LIKELY FAKE with P(FAKE) >= 0.65',
    `prediction: ${fakeResult.prediction}, prob: ${fakeResult.fake_probability}`
  );
  assert(
    fakeResult.feature_attributions.some((f: any) => f.signal_direction === 'fake'),
    'Feature attribution identifies signals toward FAKE'
  );

  // 4. OBVIOUS REAL NEWS SAMPLE
  console.log('\n--- 4. OBVIOUS REAL NEWS SAMPLE ---');
  const realText = 'The federal department announced preliminary economic data on Friday morning, according to official reports published in the quarterly bulletin following peer-reviewed analysis.';
  const realResult = mlEngine.analyzeArticle(realText);
  assert(
    realResult.prediction === 'LIKELY REAL' && realResult.fake_probability <= 0.35,
    'Obvious real article classified as LIKELY REAL with P(FAKE) <= 0.35',
    `prediction: ${realResult.prediction}, prob: ${realResult.fake_probability}`
  );
  assert(
    realResult.feature_attributions.some((f: any) => f.signal_direction === 'real'),
    'Feature attribution identifies signals toward REAL'
  );

  // 5. AMBIGUOUS / SUSPICIOUS TEXT
  console.log('\n--- 5. BORDERLINE UNCERTAINTY ZONE (SUSPICIOUS) ---');
  const ambiguousText = 'Officials stated that unexpected weather patterns caused regional disruptions, but local rumors claim that strange airborne devices were sighted during the storm.';
  const ambResult = mlEngine.analyzeArticle(ambiguousText);
  assert(
    ambResult.prediction === 'SUSPICIOUS' || (ambResult.fake_probability > 0.35 && ambResult.fake_probability < 0.65),
    'Ambiguous text correctly falls into the uncertainty / suspicious boundary',
    `prediction: ${ambResult.prediction}, P(FAKE): ${ambResult.fake_probability}`
  );

  // 6. SOURCE URL DECOUPLING
  console.log('\n--- 6. SOURCE URL DECOUPLING ---');
  const articleNoUrl = 'The Department of Energy published its final solar energy assessment on Tuesday, confirming that utility installations increased by twelve percent according to federal statisticians.';
  const resNoUrl = mlEngine.analyzeArticle(articleNoUrl, '');
  const resWithUnknownUrl = mlEngine.analyzeArticle(articleNoUrl, 'https://unknown-random-blog-123.xyz/post');

  assert(
    resNoUrl.prediction === resWithUnknownUrl.prediction,
    'Classification is strictly text-based and identical regardless of whether source URL is missing or unfamiliar',
    `No URL: ${resNoUrl.prediction} vs Unfamiliar: ${resWithUnknownUrl.prediction}`
  );
  assert(
    resWithUnknownUrl.source_info.domain === 'unknown-random-blog-123.xyz',
    'Domain is parsed for metadata without altering prediction'
  );

  // 7. CLAIM EXTRACTION
  console.log('\n--- 7. CLAIM EXTRACTION ---');
  const claimText = 'Health officials confirmed that vaccination rates have stabilized across suburban counties over the past six months.';
  const claimRes = extractPrimaryClaim(claimText);
  assert(
    claimRes.has_claim === true && claimRes.detected_claim.includes('Vaccination rates'),
    'Syntactic claim correctly identified from text',
    `detected: "${claimRes.detected_claim}"`
  );

  // 8. EVIDENCE VERIFICATION HONESTY (NO FABRICATION)
  console.log('\n--- 8. EVIDENCE VERIFICATION HONESTY ---');
  assert(
    fakeResult.evidence_verification.available === false,
    'Evidence verification honestly reports unavailable when external search is not connected'
  );
  assert(
    !fakeResult.evidence_verification.results || fakeResult.evidence_verification.results.length === 0,
    'Zero fake or fabricated URLs are generated'
  );

  // 9. SQLITE PERSISTENCE
  console.log('\n--- 9. SQLITE PERSISTENCE ---');
  const historyList = mlEngine.getHistory(5);
  assert(
    Array.isArray(historyList) && historyList.length > 0,
    'Analysis records are persisted in SQLite history',
    `records count: ${historyList.length}`
  );

  console.log('\n====================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) process.exit(1);
}

runAllTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
