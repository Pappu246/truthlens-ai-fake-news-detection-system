/**
 * Claim model contract + artifact-integrity tests.
 *
 * Covers the invariants that keep the LIAR claim model honest:
 *   - the artifact is structurally sound and is rejected loudly when it is not
 *   - the text-only variant is served whenever metadata is missing
 *   - the metadata variant is NEVER served with zero-filled metadata
 *   - benchmark numbers stay attached to the model that produced them
 *   - degenerate input returns INSUFFICIENT CONTEXT, not a fabricated score
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ClaimModel,
  ClaimModelUnavailableError,
  buildMetaFeatures,
  claimNgrams,
  cleanClaimText,
  hasUsableClaimMetadata
} from '../server/claimModel';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n${t}`); console.log('-'.repeat(72)); }

const FULL_META = {
  speaker: 'donald-trump',
  party: 'republican',
  credit_history: {
    barely_true_count: 63, false_count: 114, half_true_count: 51,
    mostly_true_count: 37, pants_on_fire_count: 61
  }
};

function main(): void {
  console.log('='.repeat(72));
  console.log('CLAIM MODEL TESTS');
  console.log('='.repeat(72));

  const model = new ClaimModel();

  section('1. Artifact loads and is structurally valid');
  check('claim model artifact is loadable', model.isReady(), model.getLoadError() || '');
  const a = model.getArtifact();
  check('model_role is claim_model', a.model_role === 'claim_model');
  check('model_version is the LIAR claim version', a.model_version === '1.1.0-liar-claim', a.model_version);
  check('decision threshold is 0.50', a.decision_threshold === 0.5);
  check('threshold policy forbids test tuning', /never tuned on test/i.test(a.threshold_policy));
  check('both serving variants present',
    Boolean(a.variants.text_only && a.variants.text_meta));
  for (const [name, v] of Object.entries(a.variants)) {
    const vocabSize = Object.keys(v.vocabulary).length;
    check(`${name}: idf length matches vocabulary`, v.idf.length === vocabSize);
    const expected = vocabSize + (v.uses_metadata ? v.meta_feature_names.length : 0);
    check(`${name}: weight vector length matches feature space`, v.weights.length === expected);
    check(`${name}: platt parameters finite`,
      Number.isFinite(v.plattA) && Number.isFinite(v.plattB) && Number.isFinite(v.bias));
    check(`${name}: test split is the full held-out set`, v.metrics.test.n === 802, String(v.metrics.test.n));
  }
  check('text_meta has the self-count leak removed', a.variants.text_meta.self_count_removed === true);
  check('leakage diagnostic variant is NOT shipped in the runtime artifact',
    !('text_meta_raw_credit' in a.variants));

  section('2. Split policy is documented and held-out splits are intact');
  check('half-true / barely-true are excluded',
    a.dataset.excluded_labels.includes('half-true') && a.dataset.excluded_labels.includes('barely-true'));
  check('TRAIN count recorded', a.dataset.counts.train > 6000, String(a.dataset.counts.train));
  check('VALID count is 799', a.dataset.counts.valid === 799, String(a.dataset.counts.valid));
  check('TEST count is 802', a.dataset.counts.test === 802, String(a.dataset.counts.test));
  check('split policy states held-out rows are never removed',
    /no row is ever removed from a held-out split/i.test(a.dataset.split_policy));
  check('dataset fingerprint recorded', typeof a.dataset.fingerprint_sha256 === 'string'
    && a.dataset.fingerprint_sha256.length === 64);

  section('3. Tokenizer contract');
  check('cleanClaimText lowercases and strips punctuation',
    cleanClaimText('The BUDGET, rose 5%!') === 'budget rose');
  check('cleanClaimText strips URLs', !cleanClaimText('see https://x.com/abc now').includes('https'));
  check('cleanClaimText strips html', !cleanClaimText('<b>taxes</b> increased').includes('<b>'));
  check('claimNgrams emits unigrams and bigrams',
    JSON.stringify(claimNgrams('federal budget deficit')) ===
    JSON.stringify(['federal', 'budget', 'deficit', 'federal budget', 'budget deficit']));
  check('claimNgrams on empty input returns []', claimNgrams('   ').length === 0);

  section('4. Metadata gating -- the core honesty requirement');
  check('no metadata -> not usable', hasUsableClaimMetadata(undefined) === false);
  check('partial credit history -> not usable',
    hasUsableClaimMetadata({ credit_history: { false_count: 1 } as any }) === false);
  check('party only -> not usable', hasUsableClaimMetadata({ party: 'republican' }) === false);
  check('complete credit history -> usable', hasUsableClaimMetadata(FULL_META) === true);

  const claim = 'Says John McCain has done nothing to help the vets.';
  const noMeta = model.predict(claim);
  check('missing metadata serves the text_only variant', noMeta.variant_used === 'text_only');
  check('missing metadata is reported explicitly', noMeta.metadata_available === false);
  check('missing metadata is documented as a limitation',
    noMeta.limitations.some(l => /no speaker metadata was supplied/i.test(l)));
  check('limitation explains why metadata variant is not used',
    noMeta.limitations.some(l => /mis-specified/i.test(l)));
  check('text-only benchmark is the one reported',
    noMeta.benchmark?.accuracy === a.variants.text_only.metrics.test.accuracy);

  const partial = model.predict(claim, { party: 'republican' });
  check('partial metadata falls back to text_only', partial.variant_used === 'text_only');
  check('partial metadata scores identically to no metadata',
    partial.probability_true === noMeta.probability_true);

  const withMeta = model.predict(claim, FULL_META);
  check('complete metadata serves the text_meta variant', withMeta.variant_used === 'text_meta');
  check('metadata variant reports metadata_available', withMeta.metadata_available === true);
  check('metadata variant lists the fields it used',
    withMeta.metadata_fields_used.includes('speaker_credit_history'));
  check('metadata variant warns about self-inclusion',
    withMeta.limitations.some(l => /must NOT be included/i.test(l)));
  check('metadata changes the score', withMeta.probability_true !== noMeta.probability_true);
  check('metadata variant reports the metadata benchmark',
    withMeta.benchmark?.accuracy === a.variants.text_meta.metrics.test.accuracy);

  const zeroMeta = buildMetaFeatures({});
  check('zero-filled metadata block is all-zero except ratios denominator',
    zeroMeta[0] === 0 && zeroMeta[1] === 0);
  check('zero-filled metadata never reaches the metadata variant',
    model.predict(claim, { credit_history: undefined } as any).variant_used === 'text_only');

  section('5. Degenerate input is withheld, not guessed');
  const gibberish = model.predict('zzzzq qqqzz xxxyy');
  check('out-of-vocabulary claim -> INSUFFICIENT CONTEXT', gibberish.label === 'INSUFFICIENT CONTEXT');
  check('out-of-vocabulary claim withholds probability', gibberish.probability_true === null);
  check('out-of-vocabulary claim explains why',
    gibberish.limitations.some(l => /model vocabulary/i.test(l)));
  const tiny = model.predict('taxes rose');
  check('two-word claim -> INSUFFICIENT CONTEXT', tiny.label === 'INSUFFICIENT CONTEXT');
  let threwEmpty = false;
  try { model.predict(''); } catch { threwEmpty = true; }
  check('empty claim throws a request error', threwEmpty);
  let threwLong = false;
  try { model.predict('a '.repeat(4000)); } catch { threwLong = true; }
  check('over-long claim throws a request error', threwLong);

  section('6. Determinism and probability sanity');
  const scores = new Set<number>();
  for (let i = 0; i < 5; i++) scores.add(model.predict(claim).probability_true!);
  check('repeated scoring is deterministic', scores.size === 1);
  const sample = [
    'The unemployment rate for college graduates is 4.4 percent and over 10 percent for noncollege-educated.',
    'Denali is the Kenyan word for black power.',
    'Wisconsin is on pace to double the number of layoffs this year.',
    'Over the past five years the federal government has paid out $601 million in benefits to deceased federal employees.'
  ];
  for (const s of sample) {
    const r = model.predict(s);
    check(`probabilities sum to 1 for: ${s.slice(0, 38)}...`,
      Math.abs((r.probability_true! + r.probability_false!) - 1) < 1e-12);
    check(`label matches threshold for: ${s.slice(0, 38)}...`,
      (r.probability_true! >= 0.5) === (r.label === 'LIKELY TRUE'));
    check(`feature attributions returned for: ${s.slice(0, 38)}...`, r.top_features.length > 0);
  }

  section('7. Model separation');
  check('claim prediction is tagged with the claim role', noMeta.model_role === 'claim_model');
  check('benchmark names the LIAR dataset', /LIAR/.test(noMeta.benchmark!.dataset));
  check('benchmark disclaims any link to the article model',
    /unrelated to the ISOT article model/i.test(noMeta.benchmark!.note));
  const metrics = model.getMetrics();
  check('metrics endpoint payload is claim-scoped', metrics.model_role === 'claim_model');
  check('metrics document the credit-history leak',
    metrics.honesty_notes.some((n: string) => /self-contribution is subtracted/i.test(n)));
  check('metrics state TEST was read once after freezing',
    metrics.honesty_notes.some((n: string) => /read once/i.test(n)));

  section('8. Corrupt artifacts fail loudly (no silent degradation)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-artifact-'));
  const write = (obj: any) => {
    const p = path.join(tmp, `${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  const base = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'claim_model_artifacts.json'), 'utf-8'));

  const wrongRole = JSON.parse(JSON.stringify(base)); wrongRole.model_role = 'article_model';
  check('artifact with wrong model_role is rejected', !new ClaimModel(write(wrongRole)).isReady());

  const noVariant = JSON.parse(JSON.stringify(base)); delete noVariant.variants.text_only;
  check('artifact without text_only is rejected', !new ClaimModel(write(noVariant)).isReady());

  const badIdf = JSON.parse(JSON.stringify(base)); badIdf.variants.text_only.idf.pop();
  check('artifact with idf/vocabulary mismatch is rejected', !new ClaimModel(write(badIdf)).isReady());

  const badWeights = JSON.parse(JSON.stringify(base)); badWeights.variants.text_only.weights.pop();
  check('artifact with truncated weights is rejected', !new ClaimModel(write(badWeights)).isReady());

  const badPlatt = JSON.parse(JSON.stringify(base)); badPlatt.variants.text_only.plattA = null;
  check('artifact with non-finite platt params is rejected', !new ClaimModel(write(badPlatt)).isReady());

  const emptyVocab = JSON.parse(JSON.stringify(base));
  emptyVocab.variants.text_only.vocabulary = {}; emptyVocab.variants.text_only.idf = [];
  check('artifact with empty vocabulary is rejected', !new ClaimModel(write(emptyVocab)).isReady());

  const missing = new ClaimModel(path.join(tmp, 'does-not-exist.json'));
  check('missing artifact reports unavailable', !missing.isReady());
  let threwUnavailable = false;
  try { missing.predict('the federal budget deficit grew last year'); }
  catch (e) { threwUnavailable = e instanceof ClaimModelUnavailableError; }
  check('unavailable model raises ClaimModelUnavailableError', threwUnavailable);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${'='.repeat(72)}`);
  console.log(`CLAIM MODEL TESTS: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  console.log('='.repeat(72));
}

main();
