import assert from 'node:assert/strict';
import type { RawDocument } from '../server/v2/types.js';
import { buildReplicaDocuments, selectStratifiedClaims } from './v2ScifactAdversarialContamination.js';

const base: RawDocument = {
  id: '123', url: 'https://scifact.local/document/123', title: 'Example paper',
  snippet: 'The exact abstract text used in the original corpus.',
  contentType: 'SUMMARY', publisher: 'SciFact corpus', publishedAt: null,
  retrievedAt: '2026-11-02T00:00:00.000Z', retrievalMethod: 'scifact_frozen_full_corpus'
};
const same = buildReplicaDocuments([base], 42, 'same_domain', 3);
const cross = buildReplicaDocuments([base], 42, 'cross_domain', 3);
assert.equal(same.length, 3);
assert.equal(cross.length, 3);
assert.equal(new Set(same.map(item => new URL(item.url).hostname)).size, 1);
assert.equal(new Set(cross.map(item => new URL(item.url).hostname)).size, 3);
assert.ok([...same, ...cross].every(item => item.snippet === base.snippet && item.title === base.title));
assert.equal(new Set([...same, ...cross].map(item => item.id)).size, 6);

const claims = [
  { id: 1, claim: 'supports claim', evidence: { '10': [{ label: 'SUPPORT', sentences: [0] }] } },
  { id: 2, claim: 'refutes claim', evidence: { '11': [{ label: 'CONTRADICT', sentences: [0] }] } },
  { id: 3, claim: 'unknown claim', evidence: {} },
  { id: 4, claim: 'supports claim two', evidence: { '12': [{ label: 'SUPPORT', sentences: [0] }] } },
  { id: 5, claim: 'refutes claim two', evidence: { '13': [{ label: 'CONTRADICT', sentences: [0] }] } },
  { id: 6, claim: 'unknown claim two', evidence: {} }
] as Parameters<typeof selectStratifiedClaims>[0];
const selected = selectStratifiedClaims(claims, 6);
assert.deepEqual(selected.map(item => item.id), [1, 4, 2, 5, 3, 6]);
console.log('SciFact real-text contamination harness tests passed.');
