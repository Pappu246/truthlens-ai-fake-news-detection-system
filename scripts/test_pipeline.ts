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

  // 2. SHORT TEXT PROTECTION (NEEDS MORE CONTEXT contract)
  console.log('\n--- 2. SHORT TEXT PROTECTION (NEEDS MORE CONTEXT) ---');
  const shortResult = mlEngine.analyzeArticle('Breaking: New policy announced.');
  assert(
    shortResult.status === 'INSUFFICIENT_INFORMATION',
    'Short text (<60 chars) returns INSUFFICIENT_INFORMATION status',
    `got status: ${shortResult.status}`
  );
  assert(
    shortResult.prediction === 'NEEDS MORE CONTEXT',
    'Short text verdict is NEEDS MORE CONTEXT (never REAL/FAKE)',
    `got: ${shortResult.prediction}`
  );
  assert(
    shortResult.confidence_score === null,
    'Short text confidence is N/A (null) — no percentage can be displayed',
    `got: ${shortResult.confidence_score}`
  );
  assert(
    shortResult.fake_probability === null && shortResult.real_probability === null,
    'Short text probabilities are withheld (null)'
  );

  // 3. FAKE NEWS SAMPLE — must never be shown as LIKELY REAL
  console.log('\n--- 3. FAKE NEWS SAMPLE ---');
  const fakeText = 'BREAKING: SHOCKING SECRET EXPOSED! Government whistleblowers reveal deep state mind control and alien conspiracy hidden from the public! 100% undeniable proof!';
  const fakeResult = mlEngine.analyzeArticle(fakeText);
  assert(
    fakeResult.prediction !== 'LIKELY REAL',
    'Fake-style text is NEVER classified as LIKELY REAL',
    `prediction: ${fakeResult.prediction}, prob: ${fakeResult.fake_probability}`
  );
  assert(
    fakeResult.prediction === 'LIKELY FAKE' || fakeResult.prediction === 'NEEDS MORE CONTEXT',
    'Fake-style text verdict is LIKELY FAKE or NEEDS MORE CONTEXT (uncertain demo model)',
    `prediction: ${fakeResult.prediction}, prob: ${fakeResult.fake_probability}`
  );
  if (fakeResult.prediction === 'LIKELY FAKE') {
    assert(
      fakeResult.fake_probability >= 0.65,
      'LIKELY FAKE is backed by P(FAKE) >= 0.65',
      `prob: ${fakeResult.fake_probability}`
    );
    assert(
      fakeResult.feature_attributions.some((f: any) => f.signal_direction === 'fake'),
      'Feature attribution identifies signals toward FAKE'
    );
  }

  // 3b. STRONG fake sample (canonical demo) — must be LIKELY FAKE, not real
  const strongFakeText = 'SHOCKING SECRET EXPOSED BY MILITARY WHISTLEBLOWER! Alien mothership over five miles wide is hovering in lunar orbit completely concealed from civilian telescopes using cloaking technology! The mainstream corrupt media and shadow government are desperately attempting to scrub this unbelievable miracle truth from the internet! Insiders confirm that world leaders signed a secret treaty allowing deep-state extraction operations in exchange for zero-point energy weapons! Share this before the global elites delete it forever! Wake up people!';
  const strongFakeResult = mlEngine.analyzeArticle(strongFakeText);
  assert(
    strongFakeResult.prediction === 'LIKELY FAKE',
    'Strong fake sample classified as LIKELY FAKE',
    `prediction: ${strongFakeResult.prediction}, prob: ${strongFakeResult.fake_probability}`
  );

  // 4. REAL NEWS SAMPLE — must never be shown as LIKELY FAKE
  console.log('\n--- 4. REAL NEWS SAMPLE ---');
  const realText = 'The federal department announced preliminary economic data on Friday morning, according to official reports published in the quarterly bulletin following peer-reviewed analysis.';
  const realResult = mlEngine.analyzeArticle(realText);
  assert(
    realResult.prediction !== 'LIKELY FAKE',
    'Real-style article is NEVER classified as LIKELY FAKE',
    `prediction: ${realResult.prediction}, prob: ${realResult.fake_probability}`
  );
  if (realResult.prediction === 'LIKELY REAL') {
    const tReal = realResult.thresholds?.real_threshold ?? 0.35;
    assert(
      realResult.fake_probability <= tReal,
      `LIKELY REAL is backed by P(FAKE) <= ${tReal}`,
      `prob: ${realResult.fake_probability}`
    );
  }
  if (realResult.prediction === 'LIKELY REAL') {
    assert(
      realResult.feature_attributions.some((f: any) => f.signal_direction === 'real'),
      'Feature attribution identifies signals toward REAL'
    );
  }

  // 4b. THE user's exact normal article — must not be LIKELY FAKE 99%/100%
  const userNormalArticle = 'The Ministry of Education announced a new digital learning initiative to provide online educational resources to students. The programme will include access to government schools and digital classrooms, helping students and teachers use online learning materials more effectively.';
  const userNormalResult = mlEngine.analyzeArticle(userNormalArticle);
  assert(
    userNormalResult.prediction !== 'LIKELY FAKE',
    'User normal article is NEVER displayed as LIKELY FAKE',
    `prediction: ${userNormalResult.prediction}, prob: ${userNormalResult.fake_probability}`
  );
  assert(
    userNormalResult.fake_probability === null || userNormalResult.fake_probability < 0.9,
    'User normal article: no unsupported 99%/100% fake score',
    `prob: ${userNormalResult.fake_probability}`
  );

  // 5. AMBIGUOUS TEXT — verdict must be consistent with the decision zone
  console.log('\n--- 5. UNCERTAINTY ZONE CONSISTENCY ---');
  const ambiguousText = 'Officials stated that unexpected weather patterns caused regional disruptions, but local rumors claim that strange airborne devices were sighted during the storm.';
  const ambResult = mlEngine.analyzeArticle(ambiguousText);
  const tF = ambResult.thresholds?.fake_threshold ?? 0.65;
  const tR = ambResult.thresholds?.real_threshold ?? 0.35;
  const inZone = typeof ambResult.fake_probability === 'number' &&
    ambResult.fake_probability > tR && ambResult.fake_probability < tF;
  assert(
    ambResult.prediction === 'LIKELY REAL' ||
    ambResult.prediction === 'LIKELY FAKE' ||
    ambResult.prediction === 'NEEDS MORE CONTEXT',
    'Ambiguous text verdict is one of the three contract verdicts',
    `prediction: ${ambResult.prediction}`
  );
  assert(
    (ambResult.prediction === 'NEEDS MORE CONTEXT' && inZone) ||
    (ambResult.prediction === 'LIKELY FAKE' && typeof ambResult.fake_probability === 'number' && ambResult.fake_probability >= tF) ||
    (ambResult.prediction === 'LIKELY REAL' && typeof ambResult.fake_probability === 'number' && ambResult.fake_probability <= tR),
    'Ambiguous text verdict is consistent with the active decision zone',
    `prediction: ${ambResult.prediction}, P(FAKE): ${ambResult.fake_probability}, zone: (${tR}, ${tF})`
  );
  if (ambResult.prediction === 'NEEDS MORE CONTEXT') {
    assert(
      ambResult.confidence_score === null,
      'Uncertain verdict confidence is N/A (null)',
      `got: ${ambResult.confidence_score}`
    );
  }

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
    claimRes.has_claim === true &&
    claimRes.detected_claim.toLowerCase().includes('vaccination rates'),
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
