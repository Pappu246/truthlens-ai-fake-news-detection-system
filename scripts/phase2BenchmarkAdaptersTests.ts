import { normalizeAveritec, normalizeFever, normalizeFeverous } from './phase2BenchmarkAdapters';

function assert(condition: unknown, message: string): void { if (!condition) throw new Error(message); }

const fever = normalizeFever({ id: 1, claim: 'A', label: 'SUPPORTS', evidence: [[[0, 7, 'Ada_Lovelace', 2]]] });
assert(fever.label === 'SUPPORT', 'FEVER SUPPORTS mapping failed');
assert(fever.evidence[0]?.sentence_ids?.[0] === 2, 'FEVER sentence mapping failed');

const feverous = normalizeFeverous({ id: 2, claim: 'B', label: 'REFUTES', challenge: 'Numerical Reasoning', evidence: [{ content: ['page_sentence_4', 'page_cell_9'], context: {} }] });
assert(feverous.label === 'CONTRADICT', 'FEVEROUS REFUTES mapping failed');
assert(feverous.evidence[0]?.content_ids?.length === 2, 'FEVEROUS content mapping failed');

const averitec = normalizeAveritec({ id: 3, claim: 'C', label: 'Not Enough Evidence', claim_date: '2024-01-01', speaker: 'X', reporting_source: 'Y', questions: [{ question: 'Q', answers: [{ answer: 'A', source_url: 'https://example.com/evidence' }] }] });
assert(averitec.label === 'INSUFFICIENT_EVIDENCE', 'AVeriTeC label mapping failed');
assert(averitec.evidence[0]?.source_url === 'https://example.com/evidence', 'AVeriTeC URL mapping failed');

console.log('Phase 2 benchmark adapter tests: 3 benchmark schemas normalized successfully.');
