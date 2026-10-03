import fs from 'node:fs';
import path from 'node:path';
import { FixtureCorpusSource } from '../../server/v2/retrieval/corpusSource';
import { verifyClaimV2 } from '../../server/v2/pipeline';

type Candidate = {
  id: string;
  url: string;
  title: string;
  snippet: string;
  body?: string;
  contentType: 'FULL_ARTICLE' | 'SUMMARY' | 'HEADLINE_ONLY';
  publisher: string;
  publishedAt?: string | null;
  retrievedAt: string;
  retrievalMethod: string;
  fever_page: string;
  fever_line: number;
};

type Row = {
  id: number;
  claim: string;
  label: string;
  gold_evidence: unknown[][];
  candidates: Candidate[];
};

function arg(name: string) {
  const hit = process.argv.find((v) => v.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function mapLabel(verdict: string): string {
  if (verdict === 'VERIFIED') return 'SUPPORTS';
  if (verdict === 'REFUTED') return 'REFUTES';
  return 'NOT ENOUGH INFO';
}

function goldIds(groups: unknown[][]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups || []) {
    for (const item of group || []) {
      if (Array.isArray(item) && item.length >= 4 && item[2] && Number.isInteger(item[3])) {
        ids.add(String(item[2]) + '::' + String(item[3]));
      }
    }
  }
  return ids;
}

async function main() {
  const input = path.resolve(arg('input') || 'artifacts/v3/fever/candidates.jsonl');
  const rows: Row[] = fs.readFileSync(input, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);

  const maxClaims = Number(arg('max-claims') || rows.length);
  const selected = rows.slice(0, Math.min(rows.length, maxClaims));

  const predictions: unknown[] = [];
  let candidateRecall = 0;
  let labelCorrect = 0;

  for (const row of selected) {
    const raw = row.candidates.map((c) => ({
      id: c.id,
      url: c.url,
      title: c.title,
      snippet: c.snippet,
      body: c.body,
      contentType: c.contentType,
      publisher: c.publisher,
      publishedAt: c.publishedAt ?? null,
      retrievedAt: c.retrievedAt,
      retrievalMethod: c.retrievalMethod
    }));

    const corpus = new FixtureCorpusSource(raw);
    const result = await verifyClaimV2(row.claim, {
      corpus,
      nliConcurrency: 8,
      retrieval: { perQueryTopK: 20, finalTopK: 8 },
      enableFullTextEnrichment: false,
      minCandidatesExpectedWarning: 0
    });

    const predicted = mapLabel(result.provenance.final_verdict);
    if (predicted === row.label) labelCorrect += 1;

    const gold = goldIds(row.gold_evidence);
    const candidateIds = new Set(row.candidates.map((c) => c.id));
    if ([...gold].some((id) => candidateIds.has(id))) candidateRecall += 1;

    const evidence = result.provenance.evidence
      .slice()
      .sort((a, b) => b.rerank_score - a.rerank_score)
      .slice(0, 5)
      .map((e) => {
        const c = row.candidates.find((x) => x.url === e.url);
        return c ? [c.fever_page, c.fever_line] : [];
      })
      .filter((x) => x.length === 2);

    predictions.push({
      id: row.id,
      label: row.label,
      predicted_label: predicted,
      evidence: row.gold_evidence,
      predicted_evidence: evidence
    });
  }

  const report = {
    benchmark_id: 'fever',
    protocol_version: 'truthlens-v3-benchmark-protocol-v1',
    dataset: {
      name: 'FEVER',
      version_or_split: 'shared_task_dev',
      claims_sha256: arg('claims-sha256') || 'PIN_REQUIRED',
      corpus_sha256: arg('corpus-sha256') || 'PIN_REQUIRED',
      evaluation_count: selected.length
    },
    model: {
      pipeline: 'TruthLens V2 evidence-grounded runtime',
      nli: process.env.TRUTHLENS_NLI_MODEL || 'configured-runtime',
      embedding: process.env.TRUTHLENS_EMBEDDING_MODEL || 'configured-runtime'
    },
    metrics: {
      label_accuracy: selected.length ? labelCorrect / selected.length : 0,
      open_candidate_recall: selected.length ? candidateRecall / selected.length : 0
    },
    provenance: {
      commit_sha: arg('commit-sha') || process.env.GITHUB_SHA || '0000000000000000000000000000000000000000',
      generated_at: new Date().toISOString(),
      configuration_sha256: arg('config-sha256') || 'PIN_REQUIRED'
    },
    scorer_input: predictions,
    interpretation: 'The official FEVER scorer uses evidence/label as gold fields and predicted_evidence/predicted_label as TruthLens predictions. Gold evidence is never supplied as predicted_evidence.'
  };

  const out = path.resolve(arg('output') || 'artifacts/v3/fever/truthlens-adapter-report.json');
  const predictionsOut = path.resolve(arg('predictions-output') || 'artifacts/v3/fever/truthlens-predictions.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(predictionsOut, JSON.stringify(predictions, null, 2) + '\n');
  console.log(JSON.stringify({
    benchmark_id: report.benchmark_id,
    evaluation_count: selected.length,
    label_accuracy: report.metrics.label_accuracy,
    open_candidate_recall: report.metrics.open_candidate_recall,
    report_output: out,
    predictions_output: predictionsOut
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
