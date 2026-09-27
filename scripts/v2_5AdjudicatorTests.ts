/** V2.5 adjudicator tests: deterministic and isolated from the V2 pipeline. */
import { adjudicateContradictionAware, ContradictionAwareNliAdapter } from '../server/v2_5/contradictionAwareAdjudicator';
import { NliAdapter } from '../server/v2/nli/nliAdapter';
import { NliClassification } from '../server/v2/types';
import { buildClaim } from '../server/v2/queryExpansion';
import fs from 'fs';

let passed = 0;
function check(name: string, value: boolean): void {
  if (!value) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`PASS: ${name}`);
}
function nli(supports: number, refutes: number, neutral: number, label: NliClassification['label'] = 'NEUTRAL'): NliClassification {
  return { label, scores: { supports, refutes, neutral, unclear: 0 }, confidence: Math.max(supports, refutes, neutral), modelName: 'test-sealed-xsmall', modelVersion: 'q8@test', basis: 'test' };
}
class MockAdapter implements NliAdapter {
  modelName = 'test-sealed-xsmall'; modelVersion = 'q8@test'; calls: string[] = [];
  constructor(private readonly responses: NliClassification[]) {}
  classify(claim: any, _passage: string): NliClassification {
    this.calls.push(claim.originalText);
    const response = this.responses[this.calls.length - 1];
    if (!response) throw new Error('unexpected third NLI pass');
    return response;
  }
}
const claim = buildClaim('The agency approved the measure in March 2024.');
function run(name: string, a: NliClassification, b: NliClassification, expected: 'SUPPORTS' | 'REFUTES' | 'NEUTRAL'): void {
  const adapter = new MockAdapter([a, b]);
  const result = adjudicateContradictionAware(adapter, claim, 'The agency reported its findings.');
  check(`${name}: exactly two passes`, adapter.calls.length === 2);
  check(`${name}: label=${expected}`, result.label === expected);
  check(`${name}: trace is explicit`, result.decision_trace.includes('original_nli') && result.decision_trace.includes('false_claim_nli') && result.adjudication_reason.length > 0);
  check(`${name}: raw original result is preserved`, result.original_nli === a && result.false_claim_nli === b);
}
run('clear support', nli(.9, .03, .07, 'SUPPORTS'), nli(.05, .1, .85), 'SUPPORTS');
run('clear contradiction from Pass A', nli(.03, .9, .07, 'REFUTES'), nli(.1, .1, .8), 'REFUTES');
run('explicit denial via false-claim entailment', nli(.05, .1, .15), nli(.82, .08, .1, 'SUPPORTS'), 'REFUTES');
run('neutral off-topic', nli(.2, .2, .6), nli(.2, .2, .6), 'NEUTRAL');
run('paraphrased support', nli(.72, .12, .16, 'SUPPORTS'), nli(.1, .2, .7), 'SUPPORTS');
run('non-false contradiction wording', nli(.08, .66, .26, 'REFUTES'), nli(.3, .2, .5), 'REFUTES');
run('already-negative claim remains conservative', nli(.2, .5, .3, 'REFUTES'), nli(.3, .4, .3), 'NEUTRAL');
run('double negation remains ambiguous', nli(.35, .35, .3), nli(.35, .35, .3), 'NEUTRAL');
run('ambiguous evidence', nli(.42, .4, .18), nli(.4, .4, .2), 'NEUTRAL');
const wrapperBase = new MockAdapter([nli(.1, .75, .15, 'REFUTES'), nli(.8, .1, .1, 'SUPPORTS')]);
const wrapper = new ContradictionAwareNliAdapter(wrapperBase);
const wrapped = wrapper.classify(claim, 'The agency denied the measure.');
check('adapter wrapper runs behind the existing interface', wrapped.label === 'REFUTES' && wrapper.lastAdjudication !== null);
check('wrapper preserves Pass A score distribution', wrapped.scores === wrapper.lastAdjudication?.original_nli.scores);
check('module is opt-in and isolated', !fs.readFileSync('server/v2/pipeline.ts', 'utf8').includes('v2_5/contradictionAwareAdjudicator'));
console.log(`V2.5 adjudicator tests: ${passed} passed`);
