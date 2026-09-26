/**
 * TRUTHLENS V2 — EVIDENCE-GROUNDED VERIFICATION PIPELINE
 * =========================================================
 *
 *   CLAIM -> QUERY EXPANSION -> HYBRID RETRIEVAL -> RERANKING
 *         -> EVIDENCE (NLI) CLASSIFICATION -> AGGREGATION/ABSTENTION
 *         -> PROVENANCE
 *
 * This orchestrator wires together the modules in `server/v2/**`. It is
 * additive to, and fully isolated from, the production evidence engine in
 * `server/verification/evidenceEngine.ts`, which is unchanged by this file.
 */
import { ExtractedClaim } from '../../src/types';
import { claimModel, ClaimModelUnavailableError } from '../claimModel';
import { expandQueries, buildClaim } from './queryExpansion';
import { CorpusSource, LiveEvidenceProviderCorpusSource } from './retrieval/corpusSource';
import { hybridRetrieve, HybridRetrievalOptions } from './retrieval/hybridRetriever';
import { enrichWithFullText } from './retrieval/fullTextEnricher';
import { rerankEvidence } from './rerank/reranker';
import { NliAdapter } from './nli/nliAdapter';
import { decideVerdict, RawPriorInput, DecisionThresholds, DEFAULT_DECISION_THRESHOLDS } from './decision/decisionPolicy';
import { describeActiveAdapters, resolveDefaultEmbeddingModel, resolveDefaultNliAdapter } from './ml/modelResolution';
import { describeClock, isClockFrozen, resolveNowMs } from './clock';
import { buildProvenance } from './provenance';
import { ClassifiedEvidence, ProvenanceRecord, RetrievedCandidate, V2VerificationResult } from './types';
import { sanitiseUntrustedEvidence } from '../verification/evidenceEngine';
import { buildEvidenceInput, EvidencePresentation } from './evidenceContext';

export interface V2PipelineOptions {
  corpus?: CorpusSource;
  nliAdapter?: NliAdapter;
  retrieval?: HybridRetrievalOptions;
  thresholds?: DecisionThresholds;
  enableFullTextEnrichment?: boolean;
  /** Research-only NLI presentation experiment. Raw is the frozen default. */
  evidencePresentation?: EvidencePresentation;
  /** Overrides the LIAR prior lookup — used by tests to inject a fixed prior. */
  priorOverride?: RawPriorInput;
  /** Minimum evidence pool size below which the pipeline reports a corpus
   * warning (does not block the decision — the decision policy already
   * abstains on weak evidence). */
  minCandidatesExpectedWarning?: number;
  /** Optional honest dataset/context note for an injected evaluation corpus.
   * The default text is retained for the original 56-fixture harness. */
  evaluationDatasetNote?: string;
  /** Freezes the time-dependent freshness signal (and provenance
   * `generated_at`) at this epoch-millisecond instant. Research-integrity
   * fix: offline evaluation must not depend on the day it is executed.
   * When omitted, the shared V2 clock is used (TRUTHLENS_V2_FROZEN_NOW when
   * set, otherwise Date.now()). Thresholds/weights/policy are unchanged. */
  nowMs?: number;
}

function passageFor(candidate: RetrievedCandidate): string {
  const raw = candidate.contentType === 'FULL_ARTICLE' && candidate.body ? candidate.body : candidate.snippet;
  return sanitiseUntrustedEvidence(raw || candidate.title || '', 800).text;
}

function lookupPrior(claimText: string): RawPriorInput {
  try {
    const prediction = claimModel.predict(claimText);
    return {
      available: prediction.probability_true !== null,
      probabilityTrue: prediction.probability_true,
      label: prediction.label,
      modelVersion: prediction.model_version
    };
  } catch (err) {
    return { available: false, probabilityTrue: null, label: null, modelVersion: null };
  }
}

export async function verifyClaimV2(claimText: string, options?: V2PipelineOptions): Promise<V2VerificationResult> {
  const text = (claimText || '').trim();
  const corpus = options?.corpus ?? new LiveEvidenceProviderCorpusSource();
  const thresholds = options?.thresholds ?? DEFAULT_DECISION_THRESHOLDS;
  const nowMs = resolveNowMs(options?.nowMs);
  const clockFrozen = isClockFrozen(options?.nowMs);

  // ---- V2.1 adapter resolution -------------------------------------------
  // Explicitly injected adapters (tests, experiments) win; otherwise the
  // mode resolver selects the REAL pretrained ONNX adapters by default, or
  // the fixture research adapters when TRUTHLENS_V2_MODEL_MODE=fixture was
  // set explicitly, and throws a clear actionable error when pretrained
  // models were requested but their sealed files are unavailable. There is
  // never a silent fallback to heuristic inference.
  const nliAdapter = options?.nliAdapter ?? resolveDefaultNliAdapter();
  const embeddingModel = options?.retrieval?.embeddingModel ?? resolveDefaultEmbeddingModel();
  const retrievalOptions: HybridRetrievalOptions = { ...options?.retrieval, embeddingModel };
  const modelsInfo = {
    embedding: { name: embeddingModel.name, version: embeddingModel.version, dimensions: embeddingModel.dimensions },
    nli: { name: nliAdapter.modelName, version: nliAdapter.modelVersion }
  };
  const hasInjectedModel = Boolean(options?.nliAdapter || options?.retrieval?.embeddingModel);
  const adapterDescription = hasInjectedModel
    ? `Explicitly injected research/evaluation adapters active: embeddings=${modelsInfo.embedding.name} ` +
      `(${modelsInfo.embedding.version}); NLI=${modelsInfo.nli.name} (${modelsInfo.nli.version}). ` +
      'These identities come from the actual injected adapters, not the default model resolver.'
    : describeActiveAdapters().description;

  const limitations: string[] = [
    'This is the TruthLens V2 RESEARCH STACK (V2.1 pretrained-adapter upgrade). It is not the production verdict pipeline.',
    adapterDescription,
    options?.evaluationDatasetNote ??
      'The evaluation fixture set is a small, manually curated development set, not a world-level benchmark.'
  ];
  if (clockFrozen) {
    limitations.push(
      `Time-dependent signals (evidence freshness, provenance timestamp) ran against a ${describeClock(options?.nowMs)}.`
    );
  }

  if (!text || text.split(/\s+/).filter(Boolean).length < 4) {
    const claim: ExtractedClaim = buildClaim(text || ' ');
    const queries = expandQueries(text || claim.normalizedText);
    const reason = !text
      ? 'No claim text was supplied.'
      : 'The supplied text is too short to form a checkable claim (fewer than four words).';
    const decision = {
      verdict: 'INSUFFICIENT_EVIDENCE' as const,
      confidence: 0,
      abstained: true,
      abstentionReason: reason,
      supportStrength: 0,
      refuteStrength: 0,
      independentSupportingSources: 0,
      independentRefutingSources: 0,
      prior: { source: 'liar_claim_model' as const, available: false, probabilityTrue: null, label: null, modelVersion: null, weightApplied: 0, note: 'Not evaluated: no checkable claim was supplied.' },
      priorAgreesWithEvidence: null,
      rationale: `INSUFFICIENT_EVIDENCE: ${reason}`,
      ruleTrace: [{ rule: 'input_guard', detail: reason }]
    };
    limitations.push('The input was rejected by the input guard before any retrieval or model adapter actually ran.');
    const provenance = buildProvenance(text, queries, [], decision,
      { channelsUsed: [], totalRetrievedBeforeDedup: 0, totalAfterDedup: 0 }, limitations, undefined, nowMs);
    return { available: false, claim: text, provenance };
  }

  const claim = buildClaim(text);
  const queries = expandQueries(text);

  const retrieval = await hybridRetrieve(claim, queries, corpus, retrievalOptions);

  let candidates = retrieval.candidates;
  if (options?.enableFullTextEnrichment) {
    const enrichment = await enrichWithFullText(candidates);
    candidates = enrichment.candidates;
  }

  const reranked = rerankEvidence(candidates, { nowMs });

  const presentation = options?.evidencePresentation ?? 'raw';
  const classified: ClassifiedEvidence[] = reranked.map(r => {
    const passage = sanitiseUntrustedEvidence(buildEvidenceInput(claim, r, presentation), 4000).text;
    const nli = nliAdapter.classify(claim, passage, r.publishedAt || undefined);
    // Title/publisher are untrusted, retrieved strings just like the body —
    // sanitise them too so provenance never echoes a raw instruction-shaped
    // span back out through a field other than the passage.
    const safeTitle = sanitiseUntrustedEvidence(r.title || '', 240).text;
    const safePublisher = sanitiseUntrustedEvidence(r.publisher || 'Unknown source', 120).text;
    return { ...r, title: safeTitle, publisher: safePublisher, passage, nli };
  });

  const prior = options?.priorOverride ?? lookupPrior(text);
  const decision = decideVerdict(classified, prior, thresholds);

  if (classified.length === 0) {
    limitations.push('No candidate evidence documents were retrieved for this claim.');
  }
  const minExpected = options?.minCandidatesExpectedWarning ?? 2;
  if (classified.length > 0 && classified.length < minExpected) {
    limitations.push(`Only ${classified.length} evidence candidate(s) were retrieved; coverage is thin.`);
  }

  const provenance: ProvenanceRecord = buildProvenance(
    text,
    queries,
    classified,
    decision,
    {
      channelsUsed: retrieval.channelsUsed,
      totalRetrievedBeforeDedup: retrieval.totalRetrievedBeforeDedup,
      totalAfterDedup: candidates.length
    },
    limitations,
    modelsInfo,
    nowMs
  );

  return { available: classified.length > 0, claim: text, provenance };
}
