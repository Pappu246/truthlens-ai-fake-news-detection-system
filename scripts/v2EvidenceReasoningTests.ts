/** Deterministic V2.3 research tests. No network, no production imports. */
process.env.TRUTHLENS_V2_MODEL_MODE = 'fixture';
import { buildClaim } from '../server/v2/queryExpansion';
import { buildEvidenceInput, relevantSentenceWindow } from '../server/v2/evidenceContext';
import { FixtureCorpusSource } from '../server/v2/retrieval/corpusSource';
import { verifyClaimV2 } from '../server/v2/pipeline';
import { NliAdapter } from '../server/v2/nli/nliAdapter';
import { NliClassification } from '../server/v2/types';

let passed = 0;
function check(name: string, ok: boolean): void {
  if (!ok) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`PASS: ${name}`);
}

const claim = buildClaim('The Mars Science Laboratory confirmed water ice in Gale Crater in March 2024.');
const doc = {
  id: '1', url: 'https://example.test/1', title: 'Mars Science Laboratory report',
  snippet: 'Scientists discussed unrelated telescope maintenance. The Mars Science Laboratory confirmed water ice in Gale Crater in March 2024. The meeting ended after lunch.',
  contentType: 'SUMMARY' as const, publisher: 'Example Publisher', publishedAt: '2024-03-20T00:00:00Z',
  retrievedAt: '2026-09-26T00:00:00Z', retrievalMethod: 'fixture'
};

class CaptureNli implements NliAdapter {
  modelName = 'test-capture'; modelVersion = '1'; passages: string[] = [];
  classify(_claim: any, passage: string): NliClassification {
    this.passages.push(passage);
    return { label: 'SUPPORTS', scores: { supports: 1, refutes: 0, neutral: 0, unclear: 0 }, confidence: 1, modelName: this.modelName, modelVersion: this.modelVersion, basis: 'test' };
  }
}

async function main(): Promise<void> {
  const window = relevantSentenceWindow(doc.snippet, claim);
  check('sentence window is deterministic and selects the related sentence', window === 'Scientists discussed unrelated telescope maintenance. The Mars Science Laboratory confirmed water ice in Gale Crater in March 2024. The meeting ended after lunch.');
  const candidate = { ...doc, canonicalUrl: doc.url, foundBy: [], lexicalScore: 1, denseScore: 1, fusionScore: 1 } as any;
  const structured = buildEvidenceInput(claim, candidate, 'enriched');
  check('enriched input preserves claim', structured.includes('[CLAIM]\nThe Mars Science Laboratory confirmed water ice in Gale Crater in March 2024.'));
  check('enriched input preserves title and publisher', structured.includes('[SOURCE TITLE]\nMars Science Laboratory report') && structured.includes('[PUBLISHER]\nExample Publisher'));
  check('enriched input contains no invented fact', !structured.includes('discovered') && !structured.includes('NASA'));
  const corpus = new FixtureCorpusSource([doc]);
  const rawNli = new CaptureNli();
  const enrichedNli = new CaptureNli();
  await verifyClaimV2(claim.originalText, { corpus, nliAdapter: rawNli, evidencePresentation: 'raw', minCandidatesExpectedWarning: 0, nowMs: Date.parse('2026-09-26T00:00:00Z') });
  await verifyClaimV2(claim.originalText, { corpus, nliAdapter: enrichedNli, evidencePresentation: 'enriched', minCandidatesExpectedWarning: 0, nowMs: Date.parse('2026-09-26T00:00:00Z') });
  check('raw and enriched use the same retrieved candidate count', rawNli.passages.length === enrichedNli.passages.length && rawNli.passages.length > 0);
  check('raw mode remains passage-only', !rawNli.passages[0].includes('[CLAIM]'));
  check('enriched mode uses labelled structured input', enrichedNli.passages[0].includes('[CLAIM]') && enrichedNli.passages[0].includes('[EVIDENCE]'));
  console.log(`V2.3 evidence reasoning tests: ${passed} passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
