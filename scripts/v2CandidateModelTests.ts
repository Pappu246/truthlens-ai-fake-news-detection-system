/**
 * TRUTHLENS V2.2 — EXPERIMENTAL CANDIDATE + RESEARCH-INTEGRITY TESTS
 * ===================================================================
 * `npm run test:v2-candidate`
 *
 * Covers exactly the V2.2 surface area:
 *
 *  A. CANDIDATE REGISTRY — identity/revision/seal fields of every registered
 *     experimental NLI candidate, and the invariant that registering a
 *     candidate can never alter the default model resolution.
 *  B. FAIL-CLOSED PROVISIONING — unsealed candidates, unknown ids, missing
 *     files and size-tampered files all raise `ModelUnavailableError`; a
 *     sealed candidate with complete bytes verifies (skipped, not faked,
 *     when those bytes are not provisioned locally).
 *  C. RESEARCH-INTEGRITY FIXES —
 *     1. NLI basis text never claims "maxP<0.5" when that is false;
 *     2. the 4-way score vector sums to exactly 1.000 after rounding, and
 *        rounding can never move the argmax;
 *     3. the freshness/provenance clock is injectable and frozen runs are
 *        reproducible regardless of the wall-clock date.
 *
 * The suite is model-download-light: A, B and C run without any candidate
 * weights. Tests that genuinely need candidate bytes report SKIP with the
 * reason instead of silently passing.
 */
process.env.TRUTHLENS_V2_MODEL_MODE = 'fixture';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { rerankEvidence } from '../server/v2/rerank/reranker';
import { RawDocument, RetrievedCandidate } from '../server/v2/types';
import {
  DEFAULT_FROZEN_EVALUATION_INSTANT,
  FROZEN_NOW_ENV_VAR,
  FrozenClockError,
  describeClock,
  isClockFrozen,
  parseFrozenNow,
  resolveNowMs
} from '../server/v2/clock';
import {
  PretrainedNliAdapter,
  mapModelProbsToNliScores,
  roundDistributionTo3dp
} from '../server/v2/nli/pretrainedNliAdapter';
import { buildClaim } from '../server/v2/queryExpansion';
import {
  ALL_MODEL_MANIFESTS,
  DEBERTA_V3_BASE_MNLI_FEVER_ANLI_CANDIDATE,
  DISTILBERT_MNLI_CANDIDATE,
  EXPECTED_CANDIDATE_FILES,
  EXPERIMENTAL_NLI_CANDIDATES,
  ModelUnavailableError,
  NLI_MODEL_NAME,
  assertCandidateUsable,
  candidateReadiness,
  findExperimentalCandidate,
  getV2ModelDir,
  isSealedCandidate,
  verifyCandidateHashes
} from '../server/v2/ml/modelManifest';
import { describeCandidate, resolveExperimentalNliAdapter } from '../server/v2/ml/modelResolution';
import { verifyClaimV2 } from '../server/v2/pipeline';
import { FixtureCorpusSource } from '../server/v2/retrieval/corpusSource';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function skip(name: string, reason: string): void {
  skipped++;
  console.log(`  SKIP  ${name} -- ${reason}`);
}

function throwsModelUnavailable(fn: () => unknown): { threw: boolean; message: string } {
  try {
    fn();
    return { threw: false, message: '' };
  } catch (error) {
    return {
      threw: error instanceof ModelUnavailableError,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

// ---------------------------------------------------------------------------
// A. Candidate registry
// ---------------------------------------------------------------------------
function testRegistry(): void {
  console.log('\nA. EXPERIMENTAL CANDIDATE REGISTRY');

  check('registry is non-empty', EXPERIMENTAL_NLI_CANDIDATES.length >= 2,
    `found ${EXPERIMENTAL_NLI_CANDIDATES.length}`);

  const ids = EXPERIMENTAL_NLI_CANDIDATES.map(candidate => candidate.id);
  check('candidate ids are unique', new Set(ids).size === ids.length, ids.join(', '));

  check('candidate registry never shadows the default manifests',
    ALL_MODEL_MANIFESTS.every(manifest => !ids.includes(manifest.id)),
    `default manifests: ${ALL_MODEL_MANIFESTS.map(m => m.id).join(', ')}`);

  check('default NLI model is still the sealed xsmall model',
    NLI_MODEL_NAME === 'Xenova/nli-deberta-v3-xsmall', NLI_MODEL_NAME);

  for (const candidate of EXPERIMENTAL_NLI_CANDIDATES) {
    check(`${candidate.id}: kind is 'nli'`, candidate.kind === 'nli');
    check(`${candidate.id}: base model recorded`, candidate.baseModel.length > 0);
    check(`${candidate.id}: expected label set declared`,
      ['entailment', 'neutral', 'contradiction'].every(label => candidate.expectedLabels.includes(label)),
      candidate.expectedLabels.join(', '));
    check(`${candidate.id}: purpose documented`, candidate.purpose.length > 40);
    check(`${candidate.id}: at least one pinned source`, candidate.sources.length > 0);

    if (candidate.sealState === 'sealed') {
      check(`${candidate.id}: seal covers every required file`,
        EXPECTED_CANDIDATE_FILES.every(required => candidate.files.some(file => file.path === required)),
        candidate.files.map(file => file.path).join(', '));
      check(`${candidate.id}: every sealed file has size + sha256`,
        candidate.files.every(file => file.bytes > 0 && /^[0-9a-f]{64}$/.test(file.sha256)));
      const onnx = candidate.files.find(file => file.path === 'onnx/model_quantized.onnx');
      check(`${candidate.id}: versionSeal is content-derived`,
        Boolean(onnx && candidate.versionSeal === `q8@${onnx.sha256.slice(0, 8)}`),
        `${candidate.versionSeal} vs q8@${onnx?.sha256.slice(0, 8)}`);
      check(`${candidate.id}: github mirrors pin a git blob sha1`,
        candidate.sources.every(source => source.type !== 'github-git-blob' || Boolean(source.commit)) &&
        candidate.files.every(file => !candidate.sources.some(s => s.type === 'github-git-blob') || Boolean(file.gitBlobSha1)));
    } else {
      check(`${candidate.id}: unsealed entry records NO byte seals`, candidate.files.length === 0);
      check(`${candidate.id}: unsealed entry records no version seal`, candidate.versionSeal === null);
      check(`${candidate.id}: unsealed entry explains the blocker`,
        Boolean(candidate.unsealedReason && candidate.unsealedReason.length > 40));
    }
  }

  const candidate = DEBERTA_V3_BASE_MNLI_FEVER_ANLI_CANDIDATE;
  console.log('\nA2. V2.2 CANDIDATE UNDER EVALUATION');
  check('candidate id is Xenova/DeBERTa-v3-base-mnli-fever-anli',
    candidate.id === 'Xenova/DeBERTa-v3-base-mnli-fever-anli', candidate.id);
  check('candidate base model is MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli',
    candidate.baseModel === 'MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli', candidate.baseModel);
  check('candidate is registered by lookup', findExperimentalCandidate(candidate.id) === candidate);
  check('candidate revision is either a real sha or explicitly null (never invented)',
    candidate.revision === null || /^[0-9a-f]{7,40}$/.test(candidate.revision), String(candidate.revision));
  check('candidate is NOT reported as sealed while its bytes are unattested',
    isSealedCandidate(candidate.id) === (candidate.sealState === 'sealed'));
  check('describeCandidate surfaces seal state',
    describeCandidate(candidate.id).includes(candidate.sealState) ||
    describeCandidate(candidate.id).includes(String(candidate.versionSeal)),
    describeCandidate(candidate.id));
}

// ---------------------------------------------------------------------------
// B. Fail-closed provisioning / resolution
// ---------------------------------------------------------------------------
function testFailClosed(): void {
  console.log('\nB. FAIL-CLOSED CANDIDATE RESOLUTION');

  const unknown = throwsModelUnavailable(() => candidateReadiness('Xenova/not-a-real-candidate'));
  check('unknown candidate id raises ModelUnavailableError', unknown.threw, unknown.message.slice(0, 120));

  const unsealedId = DEBERTA_V3_BASE_MNLI_FEVER_ANLI_CANDIDATE.id;
  const unsealedReadiness = candidateReadiness(unsealedId);
  check('unsealed candidate is never "ready"', unsealedReadiness.ok === false);
  check('unsealed candidate readiness explains why',
    unsealedReadiness.problems.some(problem => problem.includes('UNSEALED')),
    unsealedReadiness.problems.join(' | '));

  const unsealedAssert = throwsModelUnavailable(() => assertCandidateUsable(unsealedId));
  check('assertCandidateUsable refuses an unsealed candidate', unsealedAssert.threw);
  check('refusal message is actionable',
    unsealedAssert.message.includes('seal:v2-candidate') || unsealedAssert.message.includes('download:v2-candidate'),
    unsealedAssert.message.slice(0, 160));

  const unsealedResolve = throwsModelUnavailable(() => resolveExperimentalNliAdapter(unsealedId));
  check('resolveExperimentalNliAdapter fails closed for an unsealed candidate', unsealedResolve.threw);
  check('no silent fallback to the default model is mentioned as an option',
    !/falling back/i.test(unsealedResolve.message));

  check('hash verification refuses unsealed candidates',
    verifyCandidateHashes(unsealedId).ok === false);

  // Sealed candidate, empty model dir -> missing files must fail closed.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truthlens-candidate-'));
  const sealedId = DISTILBERT_MNLI_CANDIDATE.id;
  const missingReadiness = candidateReadiness(sealedId, emptyDir);
  check('sealed candidate with no local files is not ready', missingReadiness.ok === false);
  check('missing-file problems name every sealed file',
    missingReadiness.problems.length >= DISTILBERT_MNLI_CANDIDATE.files.length,
    `${missingReadiness.problems.length} problems`);
  const missingAssert = throwsModelUnavailable(() => assertCandidateUsable(sealedId, emptyDir));
  check('assertCandidateUsable fails closed on missing files', missingAssert.threw);

  // Size-tampered file -> rejected before any inference.
  const tamperedRoot = path.join(emptyDir, sealedId);
  for (const file of DISTILBERT_MNLI_CANDIDATE.files) {
    const target = path.join(tamperedRoot, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(file.path === 'config.json' ? file.bytes - 1 : file.bytes));
  }
  const tampered = candidateReadiness(sealedId, emptyDir);
  check('size-tampered sealed file is detected', tampered.ok === false &&
    tampered.problems.some(problem => problem.includes('config.json')), tampered.problems.join(' | '));

  // Same-size but wrong-content file -> caught by SHA-256 verification.
  fs.writeFileSync(path.join(tamperedRoot, 'config.json'),
    Buffer.alloc(DISTILBERT_MNLI_CANDIDATE.files.find(f => f.path === 'config.json')!.bytes, 0x41));
  const sameSize = candidateReadiness(sealedId, emptyDir);
  const hashes = verifyCandidateHashes(sealedId, emptyDir);
  check('same-size tampering passes the size check but FAILS the hash seal',
    sameSize.ok === true && hashes.ok === false,
    `readiness=${sameSize.ok}, hashes=${hashes.ok}`);
  fs.rmSync(emptyDir, { recursive: true, force: true });

  // Real provisioned candidate bytes, when present.
  const realReadiness = candidateReadiness(sealedId, getV2ModelDir());
  if (realReadiness.ok) {
    const realHashes = verifyCandidateHashes(sealedId, getV2ModelDir());
    check(`${sealedId}: locally provisioned bytes match every SHA-256 seal`, realHashes.ok,
      realHashes.mismatches.join(' | '));
  } else {
    skip(`${sealedId}: local seal verification`,
      'comparison model not provisioned (npm run download:v2-candidate -- --model=' + sealedId + ')');
  }

  const candidateRoot = path.join(getV2ModelDir(), DEBERTA_V3_BASE_MNLI_FEVER_ANLI_CANDIDATE.id);
  if (fs.existsSync(candidateRoot)) {
    skip('candidate end-to-end adapter smoke test',
      'candidate directory exists but the registry entry is unsealed; seal it first');
  } else {
    skip('candidate end-to-end adapter smoke test',
      'candidate weights are not obtainable in this environment (see docs/V2_2_MODEL_COMPARISON.md)');
  }
}

// ---------------------------------------------------------------------------
// C1. Score-sum rounding invariant
// ---------------------------------------------------------------------------
function testRoundingInvariant(): void {
  console.log('\nC1. SCORE-SUM ROUNDING INVARIANT (integrity fix)');

  const units = (values: number[]): number => values.reduce((sum, value) => sum + Math.round(value * 1000), 0);

  const knownBad: Array<Record<string, number>> = [
    { entailment: 0.3334, contradiction: 0.3333, neutral: 0.3333 },
    { entailment: 0.5005, contradiction: 0.4, neutral: 0.0995 },
    { entailment: 0.0005, contradiction: 0.0005, neutral: 0.999 },
    { entailment: 0.49, contradiction: 0.49, neutral: 0.02 },
    { entailment: 1, contradiction: 0, neutral: 0 }
  ];
  for (const probs of knownBad) {
    const { scores } = mapModelProbsToNliScores(probs);
    const total = units([scores.supports, scores.refutes, scores.neutral, scores.unclear]);
    check(`scores sum to exactly 1.000 for ${JSON.stringify(probs)}`, total === 1000, `sum=${total / 1000}`);
  }

  // Randomised property test: sum invariant, argmax preservation, bounded drift.
  let sumViolations = 0;
  let argmaxViolations = 0;
  let driftViolations = 0;
  const trials = 20000;
  let seed = 20260926;
  const rng = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < trials; trial++) {
    const raw = [rng(), rng(), rng(), rng()];
    const total = raw.reduce((a, b) => a + b, 0);
    const exact = raw.map(value => value / total);
    const rounded = roundDistributionTo3dp(exact);
    if (units(rounded) !== 1000) sumViolations++;
    let exactArgmax = 0;
    let roundedArgmax = 0;
    for (let i = 1; i < 4; i++) {
      if (exact[i] > exact[exactArgmax]) exactArgmax = i;
      if (rounded[i] > rounded[roundedArgmax]) roundedArgmax = i;
    }
    if (exactArgmax !== roundedArgmax) argmaxViolations++;
    if (rounded.some((value, i) => Math.abs(value - exact[i]) > 0.0015 + 1e-12)) driftViolations++;
  }
  check(`sum invariant holds over ${trials} random distributions`, sumViolations === 0, `${sumViolations} violations`);
  check('rounding never moves the argmax', argmaxViolations === 0, `${argmaxViolations} violations`);
  check('rounding drift stays within 0.0015 per component', driftViolations === 0, `${driftViolations} violations`);

  // The relatedness-gate constant vector must obey the same invariant.
  check('relatedness-gate score vector sums to exactly 1.000',
    units([0.005, 0.005, 0.98, 0.01]) === 1000);

  // Label/confidence coherence is preserved by the mapping: a majority
  // entailment stays SUPPORTS, while a sub-majority max stays UNCLEAR
  // (the unchanged model-uncertainty rule).
  const majority = mapModelProbsToNliScores({ entailment: 0.6, contradiction: 0.39, neutral: 0.01 }).scores;
  const majorityMax = Math.max(majority.supports, majority.refutes, majority.neutral, majority.unclear);
  check('argmax stays SUPPORTS for a majority-entailment input',
    majority.supports === majorityMax, JSON.stringify(majority));
  const undecidedScores = mapModelProbsToNliScores({ entailment: 0.44, contradiction: 0.43, neutral: 0.13 }).scores;
  const undecidedMax = Math.max(undecidedScores.supports, undecidedScores.refutes, undecidedScores.neutral, undecidedScores.unclear);
  check('argmax stays UNCLEAR when no class reaches majority (unchanged rule)',
    undecidedScores.unclear === undecidedMax, JSON.stringify(undecidedScores));
}

// ---------------------------------------------------------------------------
// C2. Provenance wording
// ---------------------------------------------------------------------------
class ScriptedNliClient {
  constructor(private readonly responses: Array<Record<string, number>>) {}
  private index = 0;
  public call<T>(op: string, _payload: Record<string, unknown>): T {
    if (op === 'embed') return { vector: [1, 0, 0] } as unknown as T;
    const probs = this.responses[Math.min(this.index++, this.responses.length - 1)];
    return { probs } as unknown as T;
  }
  public meta(): unknown { return {}; }
  public async dispose(): Promise<void> { /* no-op */ }
}

function testBasisWording(): void {
  console.log('\nC2. NLI BASIS WORDING (integrity fix)');

  const identityEmbedding = {
    name: 'test-embedding',
    version: 'test',
    dimensions: 3,
    embed: () => [1, 0, 0] // cosine 1.0 -> always passes the relatedness gate
  };

  // Pass A returns a CONFIDENT NEUTRAL (maxP = 0.999, no directional majority)
  // on a claim with an attribution clause -> pass B is consulted.
  const confidentNeutral = { entailment: 0.0005, contradiction: 0.0005, neutral: 0.999 };
  const adapter = new PretrainedNliAdapter({
    client: new ScriptedNliClient([confidentNeutral, { entailment: 0.8, contradiction: 0.1, neutral: 0.1 }]) as never,
    embeddingModel: identityEmbedding,
    modelName: 'test/nli',
    modelVersion: 'test'
  });
  const result = adapter.classify(
    buildClaim('Reuters confirmed that the central bank raised interest rates by half a point'),
    'The central bank raised interest rates by half a point, according to the published minutes.'
  );

  check('basis does NOT claim maxP<0.5 when maxP is 0.999',
    !/0\.999<0\.5/.test(result.basis), result.basis.slice(0, 200));
  check('basis states the real control-flow condition (no directional majority)',
    /NO DIRECTIONAL MAJORITY/i.test(result.basis), result.basis.slice(0, 200));
  check('basis reports both directional probabilities that were below 0.5',
    result.basis.includes('entailment=0.001') && result.basis.includes('contradiction=0.001'),
    result.basis.slice(0, 240));
  check('pass B result is used as the winner', result.label === 'SUPPORTS', result.label);
  check('basis records which pass decided', /winner=passB/.test(result.basis), result.basis.slice(0, 240));

  // Genuinely undecided pass A (maxP < 0.5) must still describe itself correctly.
  const undecided = { entailment: 0.4, contradiction: 0.35, neutral: 0.25 };
  const adapter2 = new PretrainedNliAdapter({
    client: new ScriptedNliClient([undecided]) as never,
    embeddingModel: identityEmbedding,
    modelName: 'test/nli',
    modelVersion: 'test'
  });
  const result2 = adapter2.classify(buildClaim('The bridge reopened to traffic last Tuesday morning'),
    'Officials discussed the bridge project at a routine meeting.');
  check('no-attribution claim reports that no second pass applies',
    /no attribution clause/.test(result2.basis), result2.basis.slice(0, 200));
  check('UNCLEAR wording matches the implemented rule',
    /maxP<0\.5/.test(result2.basis) && /winning pass/.test(result2.basis), result2.basis.slice(0, 260));
  check('score vector from a genuinely undecided pass still sums to 1.000',
    Math.round((result2.scores.supports + result2.scores.refutes + result2.scores.neutral + result2.scores.unclear) * 1000) === 1000,
    JSON.stringify(result2.scores));
}

// ---------------------------------------------------------------------------
// C3. Frozen evaluation clock
// ---------------------------------------------------------------------------
function makeCandidate(publishedAt: string | null): RetrievedCandidate {
  return {
    id: `doc-${publishedAt ?? 'none'}`,
    url: `https://example-${Math.random().toString(36).slice(2, 8)}.test/a`,
    canonicalUrl: 'https://example.test/a',
    title: 'Example report',
    snippet: 'An example evidence passage about a measurable event.',
    publisher: 'Example Publisher',
    publishedAt,
    retrievedAt: '2026-09-26T00:00:00.000Z',
    retrievalMethod: 'test',
    contentType: 'SUMMARY',
    lexicalScore: 0.5,
    denseScore: 0.5,
    fusedScore: 0.5,
    foundBy: [{ channel: 'bm25', query: 'example', rank: 1, score: 0.5 }]
  } as unknown as RetrievedCandidate;
}

async function testFrozenClock(): Promise<void> {
  console.log('\nC3. FROZEN EVALUATION CLOCK (integrity fix)');

  const saved = process.env[FROZEN_NOW_ENV_VAR];
  delete process.env[FROZEN_NOW_ENV_VAR];

  check('clock defaults to wall-clock time', isClockFrozen() === false);
  check('explicit nowMs is treated as frozen', isClockFrozen(1_700_000_000_000) === true);
  check('explicit nowMs wins', resolveNowMs(1_700_000_000_000) === 1_700_000_000_000);
  check('ISO frozen instant parses', parseFrozenNow(DEFAULT_FROZEN_EVALUATION_INSTANT) ===
    Date.parse(DEFAULT_FROZEN_EVALUATION_INSTANT));
  check('epoch-millisecond frozen instant parses', parseFrozenNow('1700000000000') === 1_700_000_000_000);

  let frozenClockThrew = false;
  try { parseFrozenNow('not-a-timestamp'); } catch (error) { frozenClockThrew = error instanceof FrozenClockError; }
  check('an unparsable frozen instant fails loudly (no silent wall-clock fallback)', frozenClockThrew);

  process.env[FROZEN_NOW_ENV_VAR] = DEFAULT_FROZEN_EVALUATION_INSTANT;
  check('env var freezes the clock', isClockFrozen() === true &&
    resolveNowMs() === Date.parse(DEFAULT_FROZEN_EVALUATION_INSTANT));
  check('describeClock reports the frozen instant',
    describeClock().includes(DEFAULT_FROZEN_EVALUATION_INSTANT), describeClock());
  delete process.env[FROZEN_NOW_ENV_VAR];

  // Freshness must depend on the injected clock, not on the execution date.
  const dated = [makeCandidate('2026-03-26T00:00:00.000Z')];
  const atFreeze = rerankEvidence(dated, { nowMs: Date.parse('2026-09-26T00:00:00.000Z') })[0];
  const atFreezeAgain = rerankEvidence(dated, { nowMs: Date.parse('2026-09-26T00:00:00.000Z') })[0];
  const muchLater = rerankEvidence(dated, { nowMs: Date.parse('2030-09-26T00:00:00.000Z') })[0];

  check('frozen rerank is reproducible', atFreeze.rerankScore === atFreezeAgain.rerankScore,
    `${atFreeze.rerankScore} vs ${atFreezeAgain.rerankScore}`);
  check('freshness genuinely depends on "now" (so freezing it matters)',
    muchLater.rerankSignals.freshness < atFreeze.rerankSignals.freshness,
    `${muchLater.rerankSignals.freshness} vs ${atFreeze.rerankSignals.freshness}`);
  check('undated evidence keeps the neutral 0.5 freshness under any clock',
    rerankEvidence([makeCandidate(null)], { nowMs: 0 })[0].rerankSignals.freshness === 0.5);

  // Same run, two very different clocks, through the whole pipeline.
  const docs: RawDocument[] = [
    {
      id: 'd1',
      url: 'https://agency-one.test/report',
      title: 'Agency report confirms the reservoir level rose by twelve percent',
      snippet: 'The agency measured a twelve percent rise in the reservoir level during the quarter.',
      contentType: 'SUMMARY',
      publisher: 'Agency One',
      publishedAt: '2026-09-01T00:00:00.000Z',
      retrievedAt: '2026-09-26T00:00:00.000Z',
      retrievalMethod: 'test_fixture'
    } as RawDocument
  ];
  const claim = 'The agency reported that the reservoir level rose by twelve percent during the quarter';
  const runA = await verifyClaimV2(claim, {
    corpus: new FixtureCorpusSource(docs),
    nowMs: Date.parse('2026-09-26T00:00:00.000Z'),
    priorOverride: { available: false, probabilityTrue: null, label: null, modelVersion: null }
  });
  const runB = await verifyClaimV2(claim, {
    corpus: new FixtureCorpusSource(docs),
    nowMs: Date.parse('2026-09-26T00:00:00.000Z'),
    priorOverride: { available: false, probabilityTrue: null, label: null, modelVersion: null }
  });
  const runFuture = await verifyClaimV2(claim, {
    corpus: new FixtureCorpusSource(docs),
    nowMs: Date.parse('2026-12-26T00:00:00.000Z'),
    priorOverride: { available: false, probabilityTrue: null, label: null, modelVersion: null }
  });

  check('two frozen runs produce byte-identical provenance',
    JSON.stringify(runA.provenance) === JSON.stringify(runB.provenance));
  check('frozen provenance timestamp equals the frozen instant',
    runA.provenance.generated_at === '2026-09-26T00:00:00.000Z', runA.provenance.generated_at);
  check('a different clock would have produced different rerank scores (fix is load-bearing)',
    runA.provenance.evidence[0].rerank_score !== runFuture.provenance.evidence[0].rerank_score,
    `${runA.provenance.evidence[0].rerank_score} vs ${runFuture.provenance.evidence[0].rerank_score}`);
  check('frozen runs disclose the frozen clock in limitations',
    runA.provenance.limitations.some(limitation => limitation.includes('frozen evaluation clock')),
    runA.provenance.limitations.join(' | '));

  if (saved !== undefined) process.env[FROZEN_NOW_ENV_VAR] = saved;
}

async function main(): Promise<void> {
  console.log('='.repeat(78));
  console.log('TRUTHLENS V2.2 — CANDIDATE REGISTRY + RESEARCH-INTEGRITY TESTS');
  console.log('='.repeat(78));

  testRegistry();
  testFailClosed();
  testRoundingInvariant();
  testBasisWording();
  await testFrozenClock();

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
