import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from './v3Jsonl';
import { FixtureCorpusSource } from '../../server/v2/retrieval/corpusSource';
import { verifyClaimV2 } from '../../server/v2/pipeline';
import {
  benchmarkDirection,
  createLocalNliContext,
  disposeLocalNliContext,
  productionDirection,
  sha256Json
} from './v3LocalNli';

type Candidate = {
  id: string; url: string; title: string; snippet: string; body?: string;
  contentType: 'FULL_ARTICLE' | 'SUMMARY' | 'HEADLINE_ONLY';
  publisher: string; publishedAt?: string | null; retrievedAt: string;
  retrievalMethod: string; fever_page: string; fever_line: number;
};
type Row = { id: number; claim: string; label: string; gold_evidence: unknown[][]; candidates: Candidate[]; };

function arg(name: string) {
  const hit = process.argv.find((v) => v.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : undefined;
}
function goldIds(groups: unknown[][]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups || []) for (const item of group || []) {
    if (Array.isArray(item) && item.length >= 4 && item[2] && Number.isInteger(item[3])) {
      ids.add(String(item[2]) + '::' + String(item[3]));
    }
  }
  return ids;
}

async function main() {
  const input = path.resolve(arg('input') || 'artifacts/v3/fever/candidates.jsonl');
  const maxClaimsArg = arg('max-claims');
  const maxClaims = maxClaimsArg === undefined ? undefined : Number(maxClaimsArg);
  if (maxClaims !== undefined && (!Number.isSafeInteger(maxClaims) || maxClaims < 0)) {
    throw new Error(`Invalid --max-claims value: ${maxClaimsArg}`);
  }
  const commitSha = arg('commit-sha') || process.env.TRUTHLENS_EVALUATED_COMMIT_SHA || process.env.GITHUB_SHA || '';
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error('An exact evaluated commit SHA is required.');
  const configSha = arg('config-sha256') || 'PIN_REQUIRED';
  const context = await createLocalNliContext();
  const predictions: unknown[] = [];
  let candidateRecall = 0;
  let candidateRecallDenominator = 0;
  let labelCorrect = 0;
  let productionLabelCorrect = 0;

  try {
    for await (const row of readJsonl<Row>(input, maxClaims)) {
      const corpus = new FixtureCorpusSource(row.candidates.map(c => ({
        id: c.id, url: c.url, title: c.title, snippet: c.snippet, body: c.body,
        contentType: c.contentType, publisher: c.publisher, publishedAt: c.publishedAt ?? null,
        retrievedAt: c.retrievedAt, retrievalMethod: c.retrievalMethod
      })));
      const result = await verifyClaimV2(row.claim, {
        corpus,
        nliAdapter: context.nliAdapter,
        nliConcurrency: 8,
        retrieval: { embeddingModel: context.embeddingModel, perQueryTopK: 20, finalTopK: 8 },
        enableFullTextEnrichment: false,
        minCandidatesExpectedWarning: 0,
        priorOverride: { available: false, probabilityTrue: null, label: null, modelVersion: null }
      });

      const predicted = benchmarkDirection(result);
      const productionPredicted = productionDirection(result.provenance.final_verdict);
      if (predicted === row.label) labelCorrect++;
      if (productionPredicted === row.label) productionLabelCorrect++;

      const gold = goldIds(row.gold_evidence);
      const candidateIds = new Set(row.candidates.map(c => c.id));
      if (gold.size > 0) {
        candidateRecallDenominator++;
        if ([...gold].some(id => candidateIds.has(id))) candidateRecall++;
      }

      const evidence = result.provenance.evidence
        .slice().sort((a, b) => b.rerank_score - a.rerank_score).slice(0, 5)
        .map(e => {
          const candidate = row.candidates.find(item => item.url === e.url);
          return candidate ? [candidate.fever_page, candidate.fever_line] : [];
        }).filter(item => item.length === 2);

      predictions.push({
        id: row.id,
        label: row.label,
        predicted_label: predicted,
        evidence: row.gold_evidence,
        predicted_evidence: evidence,
        truthlens_provenance: {
          production_verdict: result.provenance.final_verdict,
          production_confidence: result.provenance.final_confidence,
          abstained: result.provenance.abstained,
          evidence_nli_labels: result.provenance.evidence.map(e => e.nli_label)
        }
      });
    }

    if (maxClaims !== undefined && predictions.length !== maxClaims) {
      throw new Error(`Expected ${maxClaims} FEVER claims, read ${predictions.length}`);
    }
    const report = {
      benchmark_id: 'fever',
      protocol_version: 'truthlens-v3-benchmark-protocol-v1',
      dataset: {
        name: 'FEVER', version_or_split: 'shared_task_dev',
        claims_sha256: arg('claims-sha256') || 'PIN_REQUIRED',
        corpus_sha256: arg('corpus-sha256') || 'PIN_REQUIRED',
        evaluation_count: predictions.length,
        candidate_recall_denominator: candidateRecallDenominator
      },
      model: context.models,
      metrics: {
        label_accuracy: predictions.length ? labelCorrect / predictions.length : 0,
        production_policy_mapped_accuracy: predictions.length ? productionLabelCorrect / predictions.length : 0,
        open_candidate_recall: candidateRecallDenominator ? candidateRecall / candidateRecallDenominator : null,
        open_candidate_recall_hits: candidateRecall,
        open_candidate_recall_denominator: candidateRecallDenominator
      },
      provenance: {
        commit_sha: commitSha,
        generated_at: new Date().toISOString(),
        configuration_sha256: configSha,
        model_manifest_sha256: context.models.manifest_sha256
      },
      scorer_input: predictions,
      interpretation: [
        'Official FEVER scoring uses the evidence/label gold fields and predicted_evidence/predicted_label model outputs.',
        'Benchmark labels use the same weighted NLI evidence vote as SciFact and AVeriTeC; production-policy mapped accuracy is reported separately.',
        'Gold evidence is never supplied as predicted_evidence or passed to retrieval/NLI.',
        'Local sealed DeBERTa NLI and MiniLM embeddings are used; no remote inference or heuristic fallback is allowed.'
      ]
    };
    const out = path.resolve(arg('output') || 'artifacts/v3/fever/truthlens-adapter-report.json');
    const predictionsOut = path.resolve(arg('predictions-output') || 'artifacts/v3/fever/truthlens-predictions.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(predictionsOut, JSON.stringify(predictions, null, 2) + '\n');
    console.log(JSON.stringify({
      benchmark_id: report.benchmark_id, evaluation_count: predictions.length,
      label_accuracy: report.metrics.label_accuracy,
      production_policy_mapped_accuracy: report.metrics.production_policy_mapped_accuracy,
      open_candidate_recall: report.metrics.open_candidate_recall,
      open_candidate_recall_denominator: candidateRecallDenominator,
      model_manifest_sha256: context.models.manifest_sha256,
      report_output: out, predictions_output: predictionsOut
    }, null, 2));
  } finally {
    await disposeLocalNliContext();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
