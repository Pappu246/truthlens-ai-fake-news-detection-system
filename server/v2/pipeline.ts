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
 * `server/verification/evidenceEngine.ts`.
 */
import { ExtractedClaim } from '../../src/types';
import { claimModel } from '../claimModel';
import { expandQueries, buildClaim } from './queryExpansion';
import { CorpusSource, LiveEvidenceProviderCorpusSource } from './retrieval/corpusSource';
import { hybridRetrieve, HybridRetrievalOptions } from './retrieval/hybridRetriever';
import { enrichWithFullText } from './retrieval/fullTextEnricher';
import { rerankEvidence } from './rerank/reranker';
import { NliAdapter } from './nli/nliAdapter';
import { defaultNliAdapter } from './nli/heuristicNliAdapter';
import { createConfiguredNliAdapter } from './nli/huggingFaceNliAdapter';
import { decideVerdict, RawPriorInput, DecisionThresholds, DEFAULT_DECISION_THRESHOLDS } from './decision/decisionPolicy';
import { buildProvenance } from './provenance';
import { ClassifiedEvidence, NliClassification, ProvenanceRecord, RetrievedCandidate, V2VerificationResult } from './types';
import { sanitiseUntrustedEvidence } from '../verification/evidenceEngine';

export interface V2PipelineOptions {
  corpus?: CorpusSource;
  nliAdapter?: NliAdapter;
  nliConcurrency?: number;
  retrieval?: HybridRetrievalOptions;
  thresholds?: DecisionThresholds;
  enableFullTextEnrichment?: boolean;
  priorOverride?: RawPriorInput;
  minCandidatesExpectedWarning?: number;
  /** Optional publication-date cutoff for research evidence integrity. */
  claimDate?: string | null;
  /** Exclude evidence published after claimDate when true (default when valid date supplied). */
  enforceTemporalEvidence?: boolean;
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
  } catch {
    return { available: false, probabilityTrue: null, label: null, modelVersion: null };
  }
}

function resolveNliAdapter(explicit?: NliAdapter): NliAdapter {
  if (explicit) return explicit;
  return createConfiguredNliAdapter() ?? defaultNliAdapter;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }

  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function verifyClaimV2(claimText: string, options?: V2PipelineOptions): Promise<V2VerificationResult> {
  const text = (claimText || '').trim();
  const corpus = options?.corpus ?? new LiveEvidenceProviderCorpusSource();
  const nliAdapter = resolveNliAdapter(options?.nliAdapter);
  const thresholds = options?.thresholds ?? DEFAULT_DECISION_THRESHOLDS;

  const usingRemoteNli = nliAdapter.modelName !== defaultNliAdapter.modelName;
  const limitations: string[] = [
    'This is the TruthLens V2 RESEARCH STACK. It is not the production verdict pipeline.',
    usingRemoteNli
      ? `NLI uses configured pretrained/remote model ${nliAdapter.modelName}; verify latency, rate limits and model version before production use.`
      : 'Evidence classification uses the transparent rule-based fallback NLI adapter. Enable the optional Hugging Face adapter for a pretrained model.',
    'Dense retrieval defaults to a deterministic hashing-based embedding. An optional pretrained remote embedding adapter can be enabled separately.',
    'The evaluation fixture set is a small, manually curated development set, not a world-level benchmark.'
  ];

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
      prior: {
        source: 'liar_claim_model' as const,
        available: false,
        probabilityTrue: null,
        label: null,
        modelVersion: null,
        weightApplied: 0,
        note: 'Not evaluated: no checkable claim was supplied.'
      },
      priorAgreesWithEvidence: null,
      rationale: `INSUFFICIENT_EVIDENCE: ${reason}`,
      ruleTrace: [{ rule: 'input_guard', detail: reason }]
    };
    const provenance = buildProvenance(
      text,
      queries,
      [],
      decision,
      { channelsUsed: [], totalRetrievedBeforeDedup: 0, totalAfterDedup: 0, temporalCutoff: null, temporalCandidatesExcluded: 0 },
      limitations
    );
    return { available: false, claim: text, provenance };
  }

  const claim = buildClaim(text);
  const queries = expandQueries(text);

  const retrieval = await hybridRetrieve(claim, queries, corpus, options?.retrieval);

  let candidates = retrieval.candidates;
  if (options?.enableFullTextEnrichment) {
    const enrichment = await enrichWithFullText(candidates);
    candidates = enrichment.candidates;
  }

  const temporalCutoff = options?.claimDate ? new Date(options.claimDate).getTime() : NaN;
  const enforceTemporal = options?.enforceTemporalEvidence !== false && Number.isFinite(temporalCutoff);
  let temporalCandidatesExcluded = 0;
  if (enforceTemporal) {
    const beforeTemporal = candidates.length;
    candidates = candidates.filter(candidate => {
      if (!candidate.publishedAt) return true;
      const published = new Date(candidate.publishedAt).getTime();
      if (!Number.isFinite(published)) return true;
      return published <= temporalCutoff;
    });
    temporalCandidatesExcluded = beforeTemporal - candidates.length;
    if (temporalCandidatesExcluded > 0) {
      limitations.push(`Excluded ${temporalCandidatesExcluded} evidence candidate(s) published after the claim date ${new Date(temporalCutoff).toISOString().slice(0, 10)}.`);
    }
  } else if (options?.claimDate && !Number.isFinite(temporalCutoff)) {
    limitations.push('A claim date was supplied but could not be parsed; temporal evidence filtering was not applied.');
  }

  const reranked = rerankEvidence(candidates);

  const batchCapableNli = nliAdapter as NliAdapter & {
    classifyBatch?: (claim: ExtractedClaim, passages: string[]) => NliClassification[] | Promise<NliClassification[]>;
  };
  let classified: ClassifiedEvidence[];
  if (typeof batchCapableNli.classifyBatch === 'function' && reranked.length > 1) {
    const batchSize = Math.max(1, Math.min(options?.nliConcurrency ?? 8, reranked.length));
    const classifiedChunks: ClassifiedEvidence[][] = [];
    for (let start = 0; start < reranked.length; start += batchSize) {
      const chunk = reranked.slice(start, start + batchSize);
      const passages = chunk.map(passageFor);
      const nliResults = await batchCapableNli.classifyBatch(claim, passages);
      classifiedChunks.push(chunk.map((r, index) => {
        const passage = passages[index];
        const nli = nliResults[index];
        const safeTitle = sanitiseUntrustedEvidence(r.title || '', 240).text;
        const safePublisher = sanitiseUntrustedEvidence(r.publisher || 'Unknown source', 120).text;
        return { ...r, title: safeTitle, publisher: safePublisher, passage, nli };
      }));
    }
    classified = classifiedChunks.flat();
  } else {
    classified = await mapWithConcurrency(
      reranked,
      options?.nliConcurrency ?? (nliAdapter.modelName === defaultNliAdapter.modelName ? reranked.length : 4),
      async r => {
        const passage = passageFor(r);
        const nli = await nliAdapter.classify(claim, passage, r.publishedAt || undefined);
        const safeTitle = sanitiseUntrustedEvidence(r.title || '', 240).text;
        const safePublisher = sanitiseUntrustedEvidence(r.publisher || 'Unknown source', 120).text;
        return { ...r, title: safeTitle, publisher: safePublisher, passage, nli };
      }
    );
  }

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
      totalAfterDedup: candidates.length,
      temporalCutoff: enforceTemporal ? new Date(temporalCutoff).toISOString() : null,
      temporalCandidatesExcluded
    },
    limitations
  );

  return { available: classified.length > 0, claim: text, provenance };
}
