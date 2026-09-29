import fs from 'node:fs';
import path from 'node:path';
import { FixtureCorpusSource } from '../../server/v2/retrieval/corpusSource';
import { verifyClaimV2 } from '../../server/v2/pipeline';

type Candidate = { id: string; url: string; title: string; snippet: string; body?: string; contentType: 'FULL_ARTICLE' | 'SUMMARY' | 'HEADLINE_ONLY'; publisher: string; publishedAt?: string | null; retrievedAt: string; retrievalMethod: string; feverous_page: string; feverous_element_id: string; feverous_type: string; };
type Row = { id: string | number; claim: string; label: string; gold_evidence: string[][]; candidates: Candidate[]; };

function arg(name: string, fallback?: string) { const hit = process.argv.find((v) => v.startsWith('--' + name + '=')); return hit ? hit.slice(name.length + 3) : fallback; }

function mapVerdict(verdict: string): string {
  if (verdict === 'VERIFIED') return 'SUPPORTS';
  if (verdict === 'REFUTED') return 'REFUTES';
  return 'NOT ENOUGH INFO';
}

async function main() {
  const input = path.resolve(arg('input', 'artifacts/v3/feverous/candidates.jsonl')!);
  const output = path.resolve(arg('output', 'artifacts/v3/feverous/truthlens-predictions.jsonl')!);
  const rows: Row[] = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Row);
  const maxClaims = Number(arg('max-claims', '0'));
  const selected = maxClaims > 0 ? rows.slice(0, maxClaims) : rows;
  const predictions: any[] = [];
  let candidateRecall = 0;
  let labelCorrect = 0;

  for (let i = 0; i < selected.length; i += 1) {
    const row = selected[i];
    const corpus = new FixtureCorpusSource(row.candidates.map((c) => ({
      id: c.id, url: c.url, title: c.title, snippet: c.snippet, body: c.body,
      contentType: c.contentType, publisher: c.publisher, publishedAt: c.publishedAt ?? null,
      retrievedAt: c.retrievedAt, retrievalMethod: c.retrievalMethod
    })));
    const result = await verifyClaimV2(row.claim, {
      corpus,
      nliConcurrency: Number(process.env.TRUTHLENS_NLI_CONCURRENCY || 8),
      retrieval: { perQueryTopK: 20, finalTopK: 8 },
      enableFullTextEnrichment: false,
      minCandidatesExpectedWarning: 0,
      priorOverride: { available: false, probabilityTrue: null, label: null, modelVersion: null }
    });
    const predictedLabel = mapVerdict(result.provenance.final_verdict);
    if (predictedLabel === row.label) labelCorrect += 1;
    const candidateIds = new Set(row.candidates.map((c) => c.feverous_id));
    const goldFlat = (row.gold_evidence || []).flat();
    if (goldFlat.some((id) => candidateIds.has(id))) candidateRecall += 1;
    const scoredEvidence = result.provenance.evidence.slice().sort((a, b) => b.rerank_score - a.rerank_score).slice(0, 5)
      .map((e) => { const c = row.candidates.find((x) => x.url === e.url); return c?.feverous_id || null; })
      .filter((x): x is string => Boolean(x));
    predictions.push({
      id: row.id, claim: row.claim, label: row.label, predicted_label: predictedLabel,
      evidence: row.gold_evidence, predicted_evidence: scoredEvidence,
      truthlens_provenance: {
        final_verdict: result.provenance.final_verdict,
        final_confidence: result.provenance.final_confidence,
        abstained: result.provenance.abstained,
        retrieval_summary: result.provenance.retrieval_summary,
        evidence_urls: result.provenance.evidence.map((e) => e.url)
      }
    });
    if ((i + 1) % 25 === 0 || i + 1 === selected.length) console.log('Evaluated ' + (i + 1) + '/' + selected.length);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, predictions.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const report = {
    benchmark_id: 'feverous', protocol_version: 'truthlens-v3-benchmark-protocol-v1',
    dataset: { name: 'FEVEROUS', version_or_split: 'dev', evaluation_count: predictions.length },
    metrics: { label_accuracy: predictions.length ? labelCorrect / predictions.length : 0, open_candidate_recall: predictions.length ? candidateRecall / predictions.length : 0 },
    predictions_output: output, scorer_revision: 'Raldir/FEVEROUS@32b68ce4e33c53f34ae2e6d88b51cd073ab85ab6', generated_at: new Date().toISOString()
  };
  const reportPath = path.resolve(arg('report', 'artifacts/v3/feverous/truthlens-adapter-report.json')!);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : error); process.exit(1); });