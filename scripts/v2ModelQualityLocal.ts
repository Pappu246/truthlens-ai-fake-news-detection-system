/**
 * TruthLens V2 — token-free LOCAL pretrained model-quality evaluation
 * -------------------------------------------------------------------
 * Runs the already sealed local pretrained models used by the V2.1/V2.5
 * research evaluations:
 *   - Xenova/nli-deberta-v3-xsmall (q8) NLI
 *   - Xenova/all-MiniLM-L6-v2 (q8) embeddings
 *
 * This is a component-level evaluation on frozen SciFact dev data. It does
 * not report final TruthLens verdict accuracy because SciFact's one-gold-paper
 * structure does not match the V2 two-independent-source decision policy.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { buildClaim } from '../server/v2/queryExpansion';
import { defaultNliAdapter } from '../server/v2/nli/heuristicNliAdapter';
import { defaultEmbeddingModel, cosineSimilarity } from '../server/v2/retrieval/embeddings';
import { PretrainedNliAdapter } from '../server/v2/nli/pretrainedNliAdapter';
import { TransformerEmbeddingModel } from '../server/v2/retrieval/transformerEmbeddingModel';
import { disposeMlWorker } from '../server/v2/ml/mlWorkerClient';
import {
  ALL_MODEL_MANIFESTS,
  getV2ModelDir,
  verifyModelHashes
} from '../server/v2/ml/modelManifest';

type NliGold = 'SUPPORTS' | 'REFUTES' | 'NEUTRAL';

interface SciFactRationale {
  label: 'SUPPORT' | 'CONTRADICT';
  sentences: number[];
}
interface SciFactClaim {
  id: number;
  claim: string;
  evidence: Record<string, SciFactRationale[]>;
  cited_doc_ids: number[];
}
interface SciFactDocument {
  doc_id: number;
  title: string;
  abstract: string[];
  structured: boolean;
}

const EXPECTED_CLAIMS_SHA = '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217';
const EXPECTED_CORPUS_SHA = 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function metricReport(predictions: string[], gold: string[], labels: string[]) {
  const perClass = labels.map(label => {
    let tp = 0, fp = 0, fn = 0, support = 0;
    for (let i = 0; i < gold.length; i++) {
      if (gold[i] === label) support++;
      if (predictions[i] === label && gold[i] === label) tp++;
      if (predictions[i] === label && gold[i] !== label) fp++;
      if (predictions[i] !== label && gold[i] === label) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { label, precision, recall, f1, support };
  });
  const accuracy = gold.length
    ? gold.reduce((sum, label, i) => sum + Number(predictions[i] === label), 0) / gold.length
    : 0;
  const macroF1 = perClass.reduce((sum, item) => sum + item.f1, 0) / labels.length;
  return { accuracy, macroF1, perClass };
}

function ece(samples: Array<{ correct: boolean; confidence: number }>): number {
  if (!samples.length) return 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, confidence: 0, accuracy: 0 }));
  for (const sample of samples) {
    const idx = Math.min(9, Math.floor(Math.max(0, Math.min(0.999999, sample.confidence)) * 10));
    const bin = bins[idx];
    bin.n++;
    bin.confidence += sample.confidence;
    bin.accuracy += Number(sample.correct);
  }
  return bins.reduce((sum, bin) => {
    if (!bin.n) return sum;
    const confidence = bin.confidence / bin.n;
    const accuracy = bin.accuracy / bin.n;
    return sum + (bin.n / samples.length) * Math.abs(confidence - accuracy);
  }, 0);
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') || path.join('data', 'external', 'scifact'));
  const claimsPath = path.join(dataDir, 'claims_dev.jsonl');
  const corpusPath = path.join(dataDir, 'corpus.jsonl');
  if (!fs.existsSync(claimsPath) || !fs.existsSync(corpusPath)) {
    throw new Error(`SciFact data missing under ${dataDir}`);
  }

  const claimsSha = sha256File(claimsPath);
  const corpusSha = sha256File(corpusPath);
  if (claimsSha !== EXPECTED_CLAIMS_SHA || corpusSha !== EXPECTED_CORPUS_SHA) {
    throw new Error(`SciFact hash mismatch: claims=${claimsSha}, corpus=${corpusSha}`);
  }

  const modelDir = getV2ModelDir();
  for (const manifest of ALL_MODEL_MANIFESTS) {
    const verified = await verifyModelHashes(modelDir, manifest);
    if (!verified.ok) {
      throw new Error(`Sealed model verification failed for ${manifest.id}: ${verified.mismatches.join('; ')}`);
    }
  }

  const allClaims = readJsonl<SciFactClaim>(claimsPath).sort((a, b) => a.id - b.id);
  const corpus = readJsonl<SciFactDocument>(corpusPath);
  if (allClaims.length !== 300) throw new Error(`Expected 300 claims, got ${allClaims.length}`);
  if (corpus.length !== 5183) throw new Error(`Expected 5183 corpus documents, got ${corpus.length}`);

  const maxClaims = Math.max(1, Math.min(Number(arg('max-claims') || allClaims.length), allClaims.length));
  const claims = allClaims.slice(0, maxClaims);
  const docsById = new Map(corpus.map(doc => [String(doc.doc_id), doc]));

  const localEmbedding = new TransformerEmbeddingModel();
  const localNli = new PretrainedNliAdapter({ embeddingModel: localEmbedding });

  const goldLabels: string[] = [];
  const heuristicPredictions: string[] = [];
  const localPredictions: string[] = [];
  const heuristicCalibration: Array<{ correct: boolean; confidence: number }> = [];
  const localCalibration: Array<{ correct: boolean; confidence: number }> = [];
  const embeddingMargins: Array<{ heuristic: number; local: number }> = [];

  try {
    for (const [claimIndex, claim] of claims.entries()) {
      const builtClaim = buildClaim(claim.claim);
      const passages: Array<{ text: string; gold: NliGold }> = [];

      for (const [docId, rationales] of Object.entries(claim.evidence || {})) {
        const doc = docsById.get(docId);
        if (!doc) throw new Error(`Missing evidence document ${docId} for claim ${claim.id}`);
        for (const rationale of rationales) {
          const passage = rationale.sentences.map(index => doc.abstract[index]).filter(Boolean).join(' ').trim();
          if (!passage) throw new Error(`Empty rationale for claim ${claim.id}/doc ${docId}`);
          passages.push({
            text: passage,
            gold: rationale.label === 'SUPPORT' ? 'SUPPORTS' : 'REFUTES'
          });
        }
      }

      for (const citedId of claim.cited_doc_ids || []) {
        if (Object.prototype.hasOwnProperty.call(claim.evidence || {}, String(citedId))) continue;
        const doc = docsById.get(String(citedId));
        if (!doc) throw new Error(`Missing cited document ${citedId} for claim ${claim.id}`);
        passages.push({
          text: doc.abstract.join(' '),
          gold: 'NEUTRAL'
        });
      }

      for (const item of passages) {
        const heuristic = defaultNliAdapter.classify(builtClaim, item.text);
        const local = localNli.classify(builtClaim, item.text);
        goldLabels.push(item.gold);
        heuristicPredictions.push(heuristic.label);
        localPredictions.push(local.label);
        heuristicCalibration.push({ correct: heuristic.label === item.gold, confidence: heuristic.confidence });
        localCalibration.push({ correct: local.label === item.gold, confidence: local.confidence });
      }

      const goldTexts = passages.filter(item => item.gold !== 'NEUTRAL').map(item => item.text);
      if (goldTexts.length > 0) {
        const negativeDocIndex = (claim.id * 7919) % corpus.length;
        let negativeDoc = corpus[negativeDocIndex];
        const goldDocIds = new Set(Object.keys(claim.evidence || {}));
        let guard = 0;
        while (negativeDoc && goldDocIds.has(String(negativeDoc.doc_id)) && guard++ < corpus.length) {
          negativeDoc = corpus[(negativeDocIndex + guard) % corpus.length];
        }

        if (negativeDoc) {
          const localQuery = localEmbedding.embed(claim.claim);
          const localGoldScores = goldTexts.map(text => {
            const v = localEmbedding.embed(text);
            let dot = 0;
            for (let i = 0; i < Math.min(localQuery.length, v.length); i++) dot += localQuery[i] * v[i];
            return dot;
          });
          const localNegativeVector = localEmbedding.embed(negativeDoc.abstract.join(' '));
          let localNegative = 0;
          for (let i = 0; i < Math.min(localQuery.length, localNegativeVector.length); i++) localNegative += localQuery[i] * localNegativeVector[i];

          const heuristicQuery = defaultNliAdapter.modelName
            ? (await import('../server/v2/retrieval/embeddings')).defaultEmbeddingModel.embed(claim.claim)
            : [];
          const heuristicGoldScores = goldTexts.map(text =>
            (await import('../server/v2/retrieval/embeddings')).cosineSimilarity(
              heuristicQuery,
              (await import('../server/v2/retrieval/embeddings')).defaultEmbeddingModel.embed(text)
            )
          );
          const heuristicNegative = (await import('../server/v2/retrieval/embeddings')).cosineSimilarity(
            heuristicQuery,
            (await import('../server/v2/retrieval/embeddings')).defaultEmbeddingModel.embed(negativeDoc.abstract.join(' '))
          );

          embeddingMargins.push({
            heuristic: Math.max(...heuristicGoldScores) - heuristicNegative,
            local: Math.max(...localGoldScores) - localNegative
          });
        }
      }

      if ((claimIndex + 1) % 10 === 0 || claimIndex + 1 === claims.length) {
        console.log(`processed ${claimIndex + 1}/${claims.length} claims`);
      }
    }

    const heuristicNli = metricReport(heuristicPredictions, goldLabels, ['SUPPORTS', 'REFUTES', 'NEUTRAL']);
    const localNli = metricReport(localPredictions, goldLabels, ['SUPPORTS', 'REFUTES', 'NEUTRAL']);
    const heuristicEce = ece(heuristicCalibration);
    const localEce = ece(localCalibration);

    const meanHeuristicMargin = embeddingMargins.length
      ? embeddingMargins.reduce((sum, item) => sum + item.heuristic, 0) / embeddingMargins.length : 0;
    const meanLocalMargin = embeddingMargins.length
      ? embeddingMargins.reduce((sum, item) => sum + item.local, 0) / embeddingMargins.length : 0;

    const output = {
      protocol_version: 'truthlens-v2-model-quality-local-pretrained-v1',
      generated_at: new Date().toISOString(),
      benchmark: false,
      dataset: {
        name: 'SciFact',
        split: 'dev',
        claims_evaluated: claims.length,
        corpus_documents: corpus.length,
        claims_sha256: claimsSha,
        corpus_sha256: corpusSha
      },
      models: {
        heuristic_nli: defaultNliAdapter.modelName,
        local_pretrained_nli: localNli.modelName,
        local_pretrained_nli_version: localNli.modelVersion,
        heuristic_embedding: defaultEmbeddingModel.name,
        local_pretrained_embedding: localEmbedding.name,
        local_pretrained_embedding_version: localEmbedding.version
      },
      nli: {
        passages: goldLabels.length,
        heuristic: heuristicNli,
        local_pretrained: localNli,
        delta_accuracy: localNli.accuracy - heuristicNli.accuracy,
        delta_macro_f1: localNli.macroF1 - heuristicNli.macroF1,
        heuristic_ece: heuristicEce,
        local_pretrained_ece: localEce,
        delta_ece: localEce - heuristicEce
      },
      embedding_component_diagnostic: {
        comparisons: embeddingMargins.length,
        metric: 'max gold-rationale cosine minus deterministic non-gold negative cosine',
        heuristic_mean_margin: meanHeuristicMargin,
        local_pretrained_mean_margin: meanLocalMargin,
        delta_mean_margin: meanLocalMargin - meanHeuristicMargin,
        heuristic_positive_margin_rate: embeddingMargins.length
          ? embeddingMargins.filter(item => item.heuristic > 0).length / embeddingMargins.length : 0,
        local_pretrained_positive_margin_rate: embeddingMargins.length
          ? embeddingMargins.filter(item => item.local > 0).length / embeddingMargins.length : 0
      },
      interpretation: [
        'This evaluates component-level model quality only; it is not final TruthLens verdict accuracy.',
        'NLI is measured on gold evidence passages plus cited-no-evidence neutral passages.',
        'The embedding result is a controlled semantic-separation diagnostic, not exhaustive retrieval Recall@K.',
        'The pretrained weights are locally sealed and hash-verified before evaluation.',
        'No production threshold, decision policy, source policy, abstention rule, or model was changed by this evaluation.'
      ]
    };

    const outputPath = path.resolve(arg('output') || path.join('artifacts', 'v2-model-quality', 'local-pretrained-model-quality.json'));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await disposeMlWorker();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
