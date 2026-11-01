/**
 * TruthLens V2 — opt-in NLI research trace regression tests.
 * Uses deterministic mocks; no model downloads, network calls, or dataset access.
 */
import { PretrainedNliAdapter } from '../server/v2/nli/pretrainedNliAdapter.js';

let passed = 0;
function check(name: string, ok: boolean): void {
  if (!ok) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`PASS: ${name}`);
}

const claimText = 'The national statistics office confirmed unemployment fell to 4.1 percent in March 2024.';
const passages = ['The statistics office confirmed the unemployment rate was 4.1 percent in March 2024.'];

function makeAdapter(researchTrace: boolean): PretrainedNliAdapter {
  const embeddingModel = {
    name: 'fixture-embedding',
    version: 'fixture-1',
    embed: (_text: string) => [1, 0],
    embedBatch: (texts: string[]) => texts.map(() => [1, 0])
  } as any;
  const makeOutput = (includeDiagnostics = false) => ({
    probs: { entailment: 0.8, contradiction: 0.1, neutral: 0.1 },
    id2label: { 0: 'contradiction', 1: 'neutral', 2: 'entailment' },
    ...(includeDiagnostics ? { diagnostics: { tokenCountAfterTruncation: 42, atMaxLength: false } } : {})
  });
  const client = {
    classifyBatch: (pairs: Array<{ premise: string; hypothesis: string }>, includeDiagnostics = false) => pairs.map(() => makeOutput(includeDiagnostics)),
    call: (_op: string, payload: Record<string, unknown>) => makeOutput(payload.includeDiagnostics === true)
  } as any;
  return new PretrainedNliAdapter({ embeddingModel, client, researchTrace });
}

async function main(): Promise<void> {
  const claim = { normalizedText: claimText } as any;
  const baseline = makeAdapter(false).classifyBatch(claim, passages);
  const traced = makeAdapter(true).classifyBatch(claim, passages);
  const stripTrace = (items: any[]) => items.map(({ research_trace: _trace, ...prediction }) => prediction);

  check('trace disabled by default produces no research_trace field', baseline.every(item => item.research_trace === undefined));
  check('trace enabled does not change label, scores, confidence, model identity, or basis',
    JSON.stringify(stripTrace(baseline)) === JSON.stringify(stripTrace(traced)));
  const trace = traced[0].research_trace;
  check('trace includes relatedness cosine and gate result', trace?.relatedness_cosine === 1 && trace?.relatedness_gate_passed === true);
  check('trace records the selected hypothesis pass', trace?.selected_hypothesis_pass === 'passA:claim-as-stated');
  check('trace records raw NLI class probabilities',
    trace?.raw_probabilities?.entailment === 0.8 && trace?.raw_probabilities?.contradiction === 0.1 && trace?.raw_probabilities?.neutral === 0.1);
  check('trace records text lengths without storing claim or passage text',
    trace?.premise_char_count === passages[0].length && trace?.hypothesis_char_count === claimText.length &&
    !JSON.stringify(trace).includes(claimText) && !JSON.stringify(trace).includes(passages[0]));
  check('trace records token count and truncation boundary diagnostics',
    trace?.tokenization?.token_count_after_truncation === 42 && trace?.tokenization?.at_max_length === false &&
    trace?.tokenization?.truncation_enabled === true);

  const singleBaseline = makeAdapter(false).classify(claim, passages[0]);
  const singleTraced = makeAdapter(true).classify(claim, passages[0]);
  const { research_trace: _singleTrace, ...singlePrediction } = singleTraced;
  check('single-passage trace does not change label, scores, confidence, or basis',
    JSON.stringify(singleBaseline) === JSON.stringify(singlePrediction));
  check('single-passage trace includes raw probabilities and token diagnostics',
    singleTraced.research_trace?.raw_probabilities?.entailment === 0.8 &&
    singleTraced.research_trace?.tokenization?.token_count_after_truncation === 42);
  console.log(`Completed ${passed} research trace checks.`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
