/**
 * TruthLens V2 — PHASE 9/12 EVALUATION HARNESS
 * ===============================================
 * Runs the full V2 vertical-slice pipeline over the small development/
 * evaluation fixture set (`data/v2/eval_fixtures.json`) and reports the
 * PHASE 9 metrics. Fully offline and deterministic — corpus sources are
 * built from each fixture's own small synthetic document set, so this never
 * makes a network call.
 *
 * IMPORTANT: this is a development/evaluation harness for the FIRST
 * VERTICAL SLICE, not a claim of world-level accuracy. See
 * docs/V2_BENCHMARK_PROTOCOL.md and docs/V2_KNOWN_LIMITATIONS.md.
 *
 * Run with: npx tsx scripts/v2Evaluate.ts
 */
import fs from 'fs';
import path from 'path';
import { verifyClaimV2 } from '../server/v2/pipeline';
import { DEFAULT_FROZEN_EVALUATION_INSTANT } from '../server/v2/clock';
import { FixtureCorpusSource } from '../server/v2/retrieval/corpusSource';
import { RawDocument } from '../server/v2/types';
import {
  recallAtK,
  multiClassAccuracyF1,
  highConfidencePrecisionWithCoverage,
  abstentionRate,
  expectedCalibrationError
} from '../server/v2/metrics/metrics';
import {
  EMBEDDING_MODEL_DIMENSIONS,
  EMBEDDING_MODEL_NAME,
  EMBEDDING_MODEL_VERSION,
  NLI_MODEL_NAME,
  NLI_MODEL_VERSION,
  V2_1_RUNTIME
} from '../server/v2/ml/modelManifest';
import { resolveModelMode } from '../server/v2/ml/modelResolution';

interface FixtureCorpusDoc {
  id: string; url: string; title: string; snippet: string; publisher: string;
  publishedAt: string; contentType: 'SUMMARY' | 'HEADLINE_ONLY';
}

interface Fixture {
  id: string;
  domain: string;
  claim: string;
  gold_verdict: string;
  gold_evidence_reference: { url: string; title: string; publisher: string } | null;
  evidence_explanation: string;
  corpus: FixtureCorpusDoc[];
}

interface FixtureFile {
  dataset_name: string;
  dataset_type: string;
  total_fixtures: number;
  fixtures: Fixture[];
}

/**
 * RESEARCH-INTEGRITY FIX (V2.1 review): the rerank freshness signal and the
 * fixture `retrievedAt` stamp used wall-clock time, so this harness was only
 * bit-reproducible on the day it was run. Both are now pinned to one frozen
 * instant. Thresholds, weights, the freshness formula, the fixtures and the
 * gold labels are UNCHANGED.
 */
const FROZEN_EVALUATION_NOW = DEFAULT_FROZEN_EVALUATION_INSTANT;
const FROZEN_EVALUATION_NOW_MS = Date.parse(FROZEN_EVALUATION_NOW);

function isRelevantDoc(doc: FixtureCorpusDoc): boolean {
  return !/^unrelated/i.test(doc.title);
}

function toRawDocuments(fixture: Fixture): RawDocument[] {
  return fixture.corpus.map(d => ({
    id: d.id,
    url: d.url,
    title: d.title,
    snippet: d.snippet,
    contentType: d.contentType,
    publisher: d.publisher,
    publishedAt: d.publishedAt,
    retrievedAt: FROZEN_EVALUATION_NOW,
    retrievalMethod: 'fixture_corpus(offline_deterministic)'
  }));
}

async function main() {
  // V2.1: select the adapter mode explicitly. `--mode=pretrained|fixture` or
  // TRUTHLENS_V2_MODEL_MODE; defaults to pretrained (the V2.1 stack). The
  // mode is pinned BEFORE any pipeline call resolves adapters.
  const modeArg = (process.argv.find(a => a.startsWith('--mode=')) || '').split('=')[1] || process.env.TRUTHLENS_V2_MODEL_MODE || 'pretrained';
  process.env.TRUTHLENS_V2_MODEL_MODE = modeArg;
  const resolvedMode = resolveModelMode();

  const fixturePath = path.join(process.cwd(), 'data', 'v2', 'eval_fixtures.json');
  const file: FixtureFile = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

  console.log('='.repeat(78));
  console.log(`TRUTHLENS V2 EVALUATION — ${file.dataset_name} (${file.total_fixtures} fixtures)`);
  console.log(`Dataset type: ${file.dataset_type}`);
  console.log(`Adapter mode: ${resolvedMode}` + (resolvedMode === 'pretrained'
    ? ` (embeddings=${EMBEDDING_MODEL_NAME} ${EMBEDDING_MODEL_VERSION}, nli=${NLI_MODEL_NAME} ${NLI_MODEL_VERSION})`
    : ' (V2 first-slice research placeholders: hashing n-gram embeddings + heuristic NLI; NOT equivalent to real models)'));
  console.log('This is a development/evaluation harness for the first vertical slice.');
  console.log('It is NOT a world-level benchmark and is NOT used to claim any global accuracy figure.');
  console.log('='.repeat(78));

  const predictions: string[] = [];
  const gold: string[] = [];
  const confidencePredictions: Array<{ label: string; confidence: number }> = [];
  const calibrationInputs: Array<{ correct: boolean; confidence: number }> = [];
  const abstentions: Array<{ abstained: boolean }> = [];

  let recallSum = 0;
  let recallCount = 0;
  let evidenceTP = 0;
  let evidenceFP = 0;

  const perFixtureRows: string[] = [];

  for (const fixture of file.fixtures) {
    const corpus = new FixtureCorpusSource(toRawDocuments(fixture));
    const result = await verifyClaimV2(fixture.claim, {
      corpus,
      minCandidatesExpectedWarning: 0,
      nowMs: FROZEN_EVALUATION_NOW_MS
    });

    const predictedVerdict = result.provenance.final_verdict;
    predictions.push(predictedVerdict);
    gold.push(fixture.gold_verdict);
    confidencePredictions.push({ label: predictedVerdict, confidence: result.provenance.final_confidence });
    calibrationInputs.push({ correct: predictedVerdict === fixture.gold_verdict, confidence: result.provenance.final_confidence });
    abstentions.push({ abstained: result.provenance.abstained });

    if (fixture.gold_evidence_reference) {
      const retrievedUrls = result.provenance.evidence
        .slice()
        .sort((a, b) => b.rerank_score - a.rerank_score)
        .map(e => e.url);
      recallSum += recallAtK([fixture.gold_evidence_reference.url], retrievedUrls, 5);
      recallCount += 1;
    }

    for (const e of result.provenance.evidence) {
      const sourceDoc = fixture.corpus.find(d => d.url === e.url);
      const relevant = sourceDoc ? isRelevantDoc(sourceDoc) : true;
      const voted = e.nli_label === 'SUPPORTS' || e.nli_label === 'REFUTES';
      if (voted && relevant) evidenceTP++;
      if (voted && !relevant) evidenceFP++;
    }

    const match = predictedVerdict === fixture.gold_verdict ? 'MATCH' : 'MISMATCH';
    perFixtureRows.push(
      `  [${match.padEnd(8)}] ${fixture.id.padEnd(22)} gold=${fixture.gold_verdict.padEnd(22)} pred=${predictedVerdict.padEnd(22)} conf=${result.provenance.final_confidence.toFixed(2)}`
    );
  }

  const verdictReport = multiClassAccuracyF1(predictions, gold);
  const evidenceRecallAt5 = recallCount === 0 ? null : recallSum / recallCount;
  const evidencePrecision = evidenceTP + evidenceFP === 0 ? null : evidenceTP / (evidenceTP + evidenceFP);
  const hc = highConfidencePrecisionWithCoverage(confidencePredictions, gold, 0.75);
  const abstRate = abstentionRate(abstentions);
  const calibration = expectedCalibrationError(calibrationInputs, 5);

  console.log('\nPer-fixture results:');
  console.log(perFixtureRows.join('\n'));

  console.log('\n' + '-'.repeat(78));
  console.log('FINAL VERDICT METRICS (multi-class over VERIFIED/REFUTED/INSUFFICIENT_EVIDENCE/CONFLICTED)');
  console.log('-'.repeat(78));
  console.log(`Accuracy:  ${(verdictReport.accuracy * 100).toFixed(1)}%  (n=${verdictReport.n})`);
  console.log(`Macro F1:  ${verdictReport.macroF1.toFixed(3)}`);
  for (const c of verdictReport.perClass) {
    console.log(`  ${c.label.padEnd(22)} precision=${c.precision.toFixed(2)} recall=${c.recall.toFixed(2)} f1=${c.f1.toFixed(2)} support=${c.support}`);
  }

  console.log('\n' + '-'.repeat(78));
  console.log('EVIDENCE RETRIEVAL METRICS');
  console.log('-'.repeat(78));
  console.log(`Evidence Recall@5 (gold-referenced fixtures only): ${evidenceRecallAt5 === null ? 'N/A' : (evidenceRecallAt5 * 100).toFixed(1) + '%'} ` +
    `(computed over ${recallCount}/${file.fixtures.length} fixtures that carry a gold_evidence_reference; ` +
    `the remaining ${file.fixtures.length - recallCount} are INSUFFICIENT_EVIDENCE/CONFLICTED fixtures with no single ` +
    'gold URL, so recall is not defined for them and they are excluded rather than silently scored as pass or fail.)');
  console.log(`Evidence precision (fraction of voting SUPPORTS/REFUTES evidence drawn from on-topic docs): ` +
    `${evidencePrecision === null ? 'N/A' : (evidencePrecision * 100).toFixed(1) + '%'} (TP=${evidenceTP}, FP=${evidenceFP})`);

  console.log('\n' + '-'.repeat(78));
  console.log('HIGH-CONFIDENCE PRECISION — ALWAYS REPORTED WITH COVERAGE');
  console.log('-'.repeat(78));
  console.log(`Confidence threshold: ${hc.confidenceThreshold}`);
  console.log(`Coverage (fraction of ALL fixtures at/above threshold): ${(hc.coverage * 100).toFixed(1)}% (${hc.nAboveThreshold}/${hc.nTotal})`);
  console.log(`Precision within that high-confidence subset: ${(hc.precisionAtThreshold * 100).toFixed(1)}%`);

  console.log('\n' + '-'.repeat(78));
  console.log('ABSTENTION');
  console.log('-'.repeat(78));
  console.log(`Abstention rate (INSUFFICIENT_EVIDENCE + CONFLICTED / total): ${(abstRate * 100).toFixed(1)}%`);

  console.log('\n' + '-'.repeat(78));
  console.log('CALIBRATION (Expected Calibration Error, 5 bins)');
  console.log('-'.repeat(78));
  console.log(`ECE: ${calibration.expectedCalibrationError.toFixed(3)}`);
  for (const b of calibration.bins) {
    if (b.n === 0) continue;
    console.log(`  [${b.rangeLow.toFixed(1)}-${b.rangeHigh.toFixed(1)}) n=${b.n} avgConfidence=${b.avgConfidence.toFixed(2)} accuracy=${b.accuracy.toFixed(2)}`);
  }

  const summary = {
    dataset: file.dataset_name,
    dataset_type: file.dataset_type,
    n_fixtures: file.fixtures.length,
    adapter_mode: resolvedMode,
    adapters: resolvedMode === 'pretrained'
      ? {
          embedding: { name: EMBEDDING_MODEL_NAME, version: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_MODEL_DIMENSIONS, normalization: 'mean-pooling + L2', runtime: V2_1_RUNTIME },
          nli: { name: NLI_MODEL_NAME, version: NLI_MODEL_VERSION, runtime: V2_1_RUNTIME }
        }
      : {
          embedding: { name: 'truthlens-hashing-ngram-embedding', version: 'v0.1.0-deterministic', dimensions: 256 },
          nli: { name: 'truthlens-heuristic-nli', version: 'v0.1.0-rule-based' }
        },
    verdict_accuracy: verdictReport.accuracy,
    verdict_macro_f1: verdictReport.macroF1,
    per_class: verdictReport.perClass,
    evidence_recall_at_5: evidenceRecallAt5,
    evidence_recall_at_5_coverage_n: recallCount,
    evidence_precision: evidencePrecision,
    high_confidence_precision: hc,
    abstention_rate: abstRate,
    calibration_ece: calibration.expectedCalibrationError,
    generated_at: new Date().toISOString(),
    frozen_evaluation_clock: FROZEN_EVALUATION_NOW,
    note: resolvedMode === 'pretrained'
      ? 'V2.1 pretrained-adapter run (real ONNX models, offline). Development/evaluation harness, not a world-level benchmark.'
      : 'V2 baseline run (fixture research adapters). Development/evaluation harness, not a world-level benchmark.'
  };
  const outPath = path.join(process.cwd(), 'data', 'v2', 'eval_results.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\nWrote machine-readable summary to ${outPath}`);
  console.log('='.repeat(78));
}

main().catch(err => { console.error(err); process.exit(1); });
