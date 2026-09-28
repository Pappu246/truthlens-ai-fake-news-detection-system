/**
 * TruthLens V2 — external model-quality evaluation
 * -------------------------------------------------
 * Compares the deterministic fallback adapters with the optional pretrained
 * Hugging Face adapters on the frozen SciFact development split.
 *
 * This intentionally evaluates component-level evidence reasoning rather than
 * the final TruthLens verdict, because the production V2 policy requires two
 * independent directional sources while many SciFact claims have one gold
 * paper. Reporting final-verdict accuracy here would mix model quality with
 * a known dataset/policy mismatch.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { buildClaim } from '../server/v2/queryExpansion';
import { defaultNliAdapter } from '../server/v2/nli/heuristicNliAdapter';
import { HuggingFaceNliAdapter } from '../server/v2/nli/huggingFaceNliAdapter';
import { cosineSimilarity, defaultEmbeddingModel } from '../server/v2/retrieval/embeddings';
import { HuggingFaceEmbeddingModel } from '../server/v2/retrieval/huggingFaceEmbeddingModel';

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
  const accuracy = gold.length === 0
    ? 0
    : gold.reduce((sum, label, i) => sum + Number(predictions[i] === label), 0) / gold.length;
  const macroF1 = perClass.reduce((sum, item) => sum + item.f1, 0) / labels.length;
  return { accuracy, macroF1, perClass };
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (attempt === attempts) break;
      await new Promise(resolve => setTimeout(resolve, 750 * attempt));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
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
  const expectedClaimsSha = '86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217';
  const expectedCorpusSha = 'b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62';
  if (claimsSha !== expectedClaimsSha || corpusSha !== expectedCorpusSha) {
    throw new Error(`SciFact hash mismatch: claims=${claimsSha}, corpus=${corpusSha}`);
  }

  const token = process.env.HF_TOKEN?.trim();
  if (!token) throw new Error('HF_TOKEN is required for external model-quality evaluation.');

  const allClaims = readJsonl<SciFactClaim>(claimsPath).sort((a, b) => a.id - b.id);
  const corpus = readJsonl<SciFactDocument>(corpusPath);
  const docsById = new Map(corpus.map(doc => [String(doc.doc_id), doc]));
  const maxClaims = Number(arg('max-claims') || allClaims.length);
  const claims = allClaims.slice(0, maxClaims);

  const remoteNli = new HuggingFaceNliAdapter({ token });
  const remoteEmbedding = new HuggingFaceEmbeddingModel({ token });

  const passageGold: NliGold[] = [];
  const heuristicPredictions: string[] = [];
  const remotePredictions: string[] = [];
  const heuristicCalibration: Array<{ correct: boolean; confidence: number }> = [];
  const remoteCalibration: Array<{ correct: boolean; confidence: number }> = [];

  const embeddingMargins: Array<{ heuristic: number; remote: number; remoteBetter: boolean }> = [];

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
      const heuristic = await Promise.resolve(defaultNliAdapter.classify(builtClaim, item.text));
      const remote = await withRetry(() => remoteNli.classify(builtClaim, item.text));
      passageGold.push(item.gold);
      heuristicPredictions.push(heuristic.label);
      remotePredictions.push(remote.label);
      heuristicCalibration.push({ correct: heuristic.label === item.gold, confidence: heuristic.confidence });
      remoteCalibration.push({ correct: remote.label === item.gold, confidence: remote.confidence });
    }

    // Embedding diagnostic: compare the claim against all gold rationale
    // passages and one deterministic non-gold negative. This is a component
    // diagnostic, not a claim of Recall@K over the entire 5,183-document corpus.
    if (passages.length > 0) {
      const goldTexts = passages.filter(item => item.gold !== 'NEUTRAL').map(item => item.text);
      const negativeDocIndex = (claim.id * 7919) % corpus.length;
      let negativeDoc = corpus[negativeDocIndex];
      const goldDocIds = new Set(Object.keys(claim.evidence || {}));
      let guard = 0;
      while (negativeDoc && goldDocIds.has(String(negativeDoc.doc_id)) && guard++ < corpus.length) {
        negativeDoc = corpus[(negativeDocIndex + guard) % corpus.length];
      }

      if (goldTexts.length > 0 && negativeDoc) {
        const remoteTexts = [claim.claim, ...goldTexts, negativeDoc.abstract.join(' ')];
        const remoteVectors = await withRetry(() => remoteEmbedding.embedBatch(remoteTexts));
        const remoteQuery = remoteVectors[0];
        const remoteGoldScores = remoteVectors.slice(1, -1).map(v => cosineSimilarity(remoteQuery, v));
        const remoteNegative = cosineSimilarity(remoteQuery, remoteVectors[remoteVectors.length - 1]);
        const remoteMargin = Math.max(...remoteGoldScores) - remoteNegative;

        const heuristicTexts = [claim.claim, ...goldTexts, negativeDoc.abstract.join(' ')]
          .map(text => defaultEmbeddingModel.embed(text));
        const heuristicQuery = heuristicTexts[0];
        const heuristicGoldScores = heuristicTexts.slice(1, -1).map(v => cosineSimilarity(heuristicQuery, v));
        const heuristicNegative = cosineSimilarity(heuristicQuery, heuristicTexts[heuristicTexts.length - 1]);
        const heuristicMargin = Math.max(...heuristicGoldScores) - heuristicNegative;

        embeddingMargins.push({
          heuristic: heuristicMargin,
          remote: remoteMargin,
          remoteBetter: remoteMargin > heuristicMargin
        });
      }
    }

    if ((claimIndex + 1) % 10 === 0 || claimIndex + 1 === claims.length) {
      console.log(`processed ${claimIndex + 1}/${claims.length} claims`);
    }
  }

  const heuristicNli = metricReport(heuristicPredictions, passageGold, ['SUPPORTS', 'REFUTES', 'NEUTRAL']);
  const remoteNli = metricReport(remotePredictions, passageGold, ['SUPPORTS', 'REFUTES', 'NEUTRAL']);

  function ece(samples: Array<{ correct: boolean; confidence: number }>): number {
    const bins = Array.from({ length: 5 }, () => ({ n: 0, confidence: 0, accuracy: 0 }));
    for (const sample of samples) {
      const idx = Math.min(4, Math.floor(Math.max(0, Math.min(0.999999, sample.confidence)) * 5));
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

  const heuristicEce = ece(heuristicCalibration);
  const remoteEce = ece(remoteCalibration);
  const meanHeuristicMargin = embeddingMargins.length
    ? embeddingMargins.reduce((sum, item) => sum + item.heuristic, 0) / embeddingMargins.length
    : 0;
  const meanRemoteMargin = embeddingMargins.length
    ? embeddingMargins.reduce((sum, item) => sum + item.remote, 0) / embeddingMargins.length
    : 0;
  const heuristicWins = embeddingMargins.filter(item => item.heuristic > 0).length;
  const remoteWins = embeddingMargins.filter(item => item.remote > 0).length;
  const remoteBetterCount = embeddingMargins.filter(item => item.remoteBetter).length;

  const output = {
    protocol_version: 'truthlens-v2-model-quality-external-v1',
    generated_at: new Date().toISOString(),
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
      remote_nli: remoteNli.modelName,
      heuristic_embedding: defaultEmbeddingModel.name,
      remote_embedding: remoteEmbedding.name
    },
    nli: {
      passages: passageGold.length,
      heuristic: heuristicNli,
      remote: remoteNli,
      delta_accuracy: remoteNli.accuracy - heuristicNli.accuracy,
      delta_macro_f1: remoteNli.macroF1 - heuristicNli.macroF1,
      heuristic_ece: heuristicEce,
      remote_ece: remoteEce,
      delta_ece: remoteEce - heuristicEce
    },
    embedding_component_diagnostic: {
      comparisons: embeddingMargins.length,
      metric: 'max gold-rationale cosine minus deterministic non-gold negative cosine',
      heuristic_mean_margin: meanHeuristicMargin,
      remote_mean_margin: meanRemoteMargin,
      delta_mean_margin: meanRemoteMargin - meanHeuristicMargin,
      heuristic_positive_margin_rate: embeddingMargins.length ? heuristicWins / embeddingMargins.length : 0,
      remote_positive_margin_rate: embeddingMargins.length ? remoteWins / embeddingMargins.length : 0,
      remote_better_margin_rate: embeddingMargins.length ? remoteBetterCount / embeddingMargins.length : 0
    },
    interpretation: [
      'This is component-level model-quality evidence, not production verdict accuracy.',
      'NLI is measured on gold evidence passages plus cited-no-evidence neutral passages only.',
      'The embedding result is a controlled semantic-separation diagnostic, not exhaustive retrieval Recall@K.',
      'No production threshold, decision policy, source policy, abstention rule, or model was changed by this evaluation.',
      'SciFact is scientific-abstract verification and is not a direct live-news benchmark.'
    ]
  };

  const outputPath = path.resolve(arg('output') || path.join('artifacts', 'v2-model-quality', 'external-model-quality.json'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
