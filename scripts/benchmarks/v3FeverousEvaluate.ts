import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonl } from './v3Jsonl';
import { FixtureCorpusSource } from '../../server/v2/retrieval/corpusSource';
import { verifyClaimV2 } from '../../server/v2/pipeline';
import { hasGoldCandidate, hasGoldEvidence } from './v3FeverousEvidenceRecall';
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
  retrievalMethod: string; feverous_page: string; feverous_element_id: string;
  feverous_type: string; feverous_id: string;
};
type Row = { id: string | number; claim: string; label: string; gold_evidence: unknown; candidates: Candidate[]; };

function arg(name: string, fallback?: string) {
  const hit = process.argv.find((v) => v.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const input = path.resolve(arg('input', 'artifacts/v3/feverous/candidates.jsonl')!);
  const output = path.resolve(arg('output', 'artifacts/v3/feverous/truthlens-predictions.jsonl')!);
  const maxClaims = Number(arg('max-claims', '0'));
  if (!Number.isSafeInteger(maxClaims) || maxClaims < 0) throw new Error('Invalid --max-claims value: ' + String(maxClaims));
  const limit = maxClaims > 0 ? maxClaims : undefined;
  const evaluatedCommitSha = arg('commit-sha') || process.env.TRUTHLENS_EVALUATED_COMMIT_SHA || process.env.GITHUB_SHA || '';
  if (!/^[a-f0-9]{40}$/i.test(evaluatedCommitSha)) throw new Error('An exact evaluated commit SHA is required.');
  const protocolManifestPath = path.resolve('research/multibenchmark-manifest.json');
  const protocolManifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(protocolManifestPath)).digest('hex');
  const runtimeConfig = { per_query_top_k: 20, final_pipeline_k: 8, nli_concurrency: Number(process.env.TRUTHLENS_NLI_CONCURRENCY || 8), relatedness_floor: 0.15, max_pair_tokens: 384, full_text_enrichment: false, prior_override: 'disabled' };
  const runtimeConfigSha256 = sha256Json(runtimeConfig);
  const context = await createLocalNliContext();
  const predictions: unknown[] = [];
  let candidateRecall = 0;
  let candidateRecallDenominator = 0;
  let labelCorrect = 0;
  let productionLabelCorrect = 0;

  try {
    for await (const row of readJsonl<Row>(input, limit)) {
      const corpus = new FixtureCorpusSource(row.candidates.map(c => ({
        id: c.id, url: c.url, title: c.title, snippet: c.snippet, body: c.body,
        contentType: c.contentType, publisher: c.publisher, publishedAt: c.publishedAt ?? null,
        retrievedAt: c.retrievedAt, retrievalMethod: c.retrievalMethod
      })));
      const result = await verifyClaimV2(row.claim, {
        corpus,
        nliAdapter: context.nliAdapter,
        nliConcurrency: Number(process.env.TRUTHLENS_NLI_CONCURRENCY || 8),
        retrieval: { embeddingModel: context.embeddingModel, perQueryTopK: 20, finalTopK: 8 },
        enableFullTextEnrichment: false,
        minCandidatesExpectedWarning: 0,
        priorOverride: { available: false, probabilityTrue: null, label: null, modelVersion: null }
      });
      const predictedLabel = benchmarkDirection(result);
      const productionPredictedLabel = productionDirection(result.provenance.final_verdict);
      if (predictedLabel === row.label) labelCorrect++;
      if (productionPredictedLabel === row.label) productionLabelCorrect++;

      const candidateIds = new Set(row.candidates.map(c => c.feverous_id));
      if (hasGoldEvidence(row.gold_evidence)) {
        candidateRecallDenominator++;
        if (hasGoldCandidate(row.gold_evidence, candidateIds)) candidateRecall++;
      }
      const scoredEvidence = result.provenance.evidence
        .slice().sort((a, b) => b.rerank_score - a.rerank_score).slice(0, 5)
        .map(e => row.candidates.find(c => c.url === e.url)?.feverous_id || null)
        .filter((value): value is string => Boolean(value));
      predictions.push({
        id: row.id, claim: row.claim, label: row.label, predicted_label: predictedLabel,
        evidence: row.gold_evidence, predicted_evidence: scoredEvidence,
        truthlens_provenance: {
          production_verdict: result.provenance.final_verdict,
          production_confidence: result.provenance.final_confidence,
          abstained: result.provenance.abstained,
          retrieval_summary: result.provenance.retrieval_summary,
          evidence_urls: result.provenance.evidence.map(e => e.url)
        }
      });
      if (predictions.length % 25 === 0) console.log('Evaluated ' + predictions.length + (limit !== undefined ? '/' + limit : ' claims'));
    }
    if (limit !== undefined && predictions.length !== limit) {
      throw new Error('Expected ' + limit + ' FEVEROUS claims, read ' + predictions.length);
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, predictions.map(value => JSON.stringify(value)).join('\n') + '\n');
    const report = {
      benchmark_id: 'feverous',
      gold_evidence_in_retrieval: false,
      protocol_version: 'truthlens-v3-benchmark-protocol-v1',
      dataset: {
        name: 'FEVEROUS', version_or_split: 'dev', evaluation_count: predictions.length,
        candidate_recall_denominator: candidateRecallDenominator
      },
      model: context.models,
      runtime_config: runtimeConfig,
      metrics: {
        label_accuracy: predictions.length ? labelCorrect / predictions.length : 0,
        production_policy_mapped_accuracy: predictions.length ? productionLabelCorrect / predictions.length : 0,
        open_candidate_recall: candidateRecallDenominator ? candidateRecall / candidateRecallDenominator : null,
        open_candidate_recall_hits: candidateRecall,
        open_candidate_recall_denominator: candidateRecallDenominator
      },
      predictions_output: output,
      scorer_revision: 'Raldir/FEVEROUS@32b68ce4e33c53f34ae2e6d88b51cd073ab85ab6',
      provenance: {
        commit_sha: evaluatedCommitSha,
        configuration_sha256: runtimeConfigSha256,
        protocol_manifest_sha256: protocolManifestSha256,
        model_manifest_sha256: context.models.manifest_sha256
      },
      generated_at: new Date().toISOString(),
      interpretation: [
        'Official FEVEROUS scoring uses the benchmark-specific weighted NLI evidence vote.',
        'Production-policy mapped accuracy is reported separately.',
        'Gold evidence is never supplied as predicted_evidence or passed to retrieval/NLI.',
        'Local sealed DeBERTa NLI and MiniLM embeddings are used; no remote inference or heuristic fallback is allowed.'
      ]
    };
    const reportPath = path.resolve(arg('report', 'artifacts/v3/feverous/truthlens-adapter-report.json')!);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({
      benchmark_id: report.benchmark_id, evaluation_count: predictions.length,
      label_accuracy: report.metrics.label_accuracy,
      production_policy_mapped_accuracy: report.metrics.production_policy_mapped_accuracy,
      open_candidate_recall: report.metrics.open_candidate_recall,
      open_candidate_recall_denominator: candidateRecallDenominator,
      model_manifest_sha256: context.models.manifest_sha256,
      report_output: reportPath, predictions_output: output
    }, null, 2));
  } finally {
    await disposeLocalNliContext();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.stack || error.message : error); process.exit(1); });
