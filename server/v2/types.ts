/**
 * TRUTHLENS V2 — RESEARCH STACK TYPES
 * ===================================
 *
 * This module is part of the V2 EVIDENCE-GROUNDED VERIFICATION research
 * stack (`server/v2/**`). It is additive and isolated from the production
 * verification pipeline in `server/verification/**`, which is unchanged.
 *
 * Pipeline implemented here:
 *
 *   CLAIM -> QUERY EXPANSION -> HYBRID RETRIEVAL (lexical + dense)
 *         -> RERANKING -> EVIDENCE (NLI) CLASSIFICATION
 *         -> AGGREGATION / ABSTENTION -> PROVENANCE
 *
 * The existing LIAR claim model (`server/claimModel.ts`) may contribute a
 * weak prior signal, but per the V2 design contract it can never
 * independently determine the final verdict when evidence exists.
 */
import { ExtractedClaim } from '../../src/types';

export type { ExtractedClaim };

/** The three query variants generated for every claim. */
export interface ExpandedQuerySet {
  claim: string;
  original: string;
  support: string;
  contradiction: string;
  /** All queries, deduplicated, in the order they should be issued. */
  all: string[];
}

/**
 * A raw document as returned by a corpus source, BEFORE ranking/reranking.
 * This is the only place new evidence enters the system — nothing downstream
 * is allowed to invent a document, a URL, or a passage.
 */
export interface RawDocument {
  /** Stable id from the corpus source (not necessarily globally unique). */
  id: string;
  url: string;
  title: string;
  /** Short excerpt actually returned by the source (headline/snippet/summary). */
  snippet: string;
  /** Longer body text, ONLY if the source actually retrieved full text. */
  body?: string;
  /** Marks whether `snippet`/`body` is a full article or a summary/headline. */
  contentType: 'FULL_ARTICLE' | 'SUMMARY' | 'HEADLINE_ONLY';
  publisher: string;
  publishedAt?: string | null;
  retrievedAt: string;
  /** Name of the corpus source that produced this document (for provenance). */
  retrievalMethod: string;
}

export type RetrievalChannel = 'LEXICAL_BM25' | 'DENSE_EMBEDDING';

/** A document after hybrid retrieval + fusion + dedup, before reranking. */
export interface RetrievedCandidate extends RawDocument {
  /** Canonical URL used for de-duplication across queries/channels. */
  canonicalUrl: string;
  /** Which channel(s) surfaced this candidate, and the query that found it. */
  foundBy: Array<{ channel: RetrievalChannel; query: string; rank: number; score: number }>;
  lexicalScore: number;
  denseScore: number;
  /** Reciprocal-rank-fusion score combining lexical + dense signal. */
  fusionScore: number;
}

export interface RerankSignals {
  lexical: number;
  semantic: number;
  sourceQuality: number;
  freshness: number;
  independence: number;
}

/** A candidate after reranking, carrying a transparent signal breakdown. */
export interface RerankedEvidence extends RetrievedCandidate {
  rerankScore: number;
  rerankSignals: RerankSignals;
  rerankExplanation: string;
  sourceType: string;
  domainClusterId: string;
  isDuplicateCluster: boolean;
}

export type NliLabel = 'SUPPORTS' | 'REFUTES' | 'NEUTRAL' | 'UNCLEAR';

export interface NliScoreDistribution {
  supports: number;
  refutes: number;
  neutral: number;
  unclear: number;
}

export interface NliClassification {
  label: NliLabel;
  scores: NliScoreDistribution;
  confidence: number;
  modelName: string;
  modelVersion: string;
  basis: string;
}

/** A fully classified, reranked piece of evidence — the unit the decision
 * policy and provenance layer both consume. */
export interface ClassifiedEvidence extends RerankedEvidence {
  passage: string;
  nli: NliClassification;
}

export type VerdictV2 = 'VERIFIED' | 'REFUTED' | 'INSUFFICIENT_EVIDENCE' | 'CONFLICTED';

export interface DecisionRuleTrace {
  rule: string;
  detail: string;
}

export interface PriorSignal {
  source: 'liar_claim_model';
  available: boolean;
  probabilityTrue: number | null;
  label: string | null;
  modelVersion: string | null;
  weightApplied: number;
  note: string;
}

export interface VerdictDecision {
  verdict: VerdictV2;
  confidence: number;
  abstained: boolean;
  abstentionReason: string | null;
  supportStrength: number;
  refuteStrength: number;
  independentSupportingSources: number;
  independentRefutingSources: number;
  prior: PriorSignal;
  priorAgreesWithEvidence: boolean | null;
  rationale: string;
  ruleTrace: DecisionRuleTrace[];
}

export interface ProvenanceEvidenceRecord {
  evidence_id: string;
  url: string;
  canonical_url: string;
  title: string;
  publisher: string;
  domain: string;
  published_at: string | null;
  retrieval_timestamp: string;
  retrieval_method: string;
  retrieval_channels: RetrievalChannel[];
  content_type: RawDocument['contentType'];
  exact_passage: string;
  nli_label: NliLabel;
  nli_confidence: number;
  nli_model: { name: string; version: string };
  rerank_score: number;
  rerank_signals: RerankSignals;
  is_duplicate_cluster: boolean;
  source_type: string;
}

export interface ProvenanceRecord {
  pipeline: 'truthlens_v2_evidence_grounded';
  pipeline_version: string;
  claim: string;
  queries: ExpandedQuerySet;
  final_verdict: VerdictV2;
  final_confidence: number;
  abstained: boolean;
  abstention_reason: string | null;
  evidence: ProvenanceEvidenceRecord[];
  evidence_counts: { supports: number; refutes: number; neutral: number; unclear: number };
  source_diversity: { independent_domains: number; duplicate_clusters: number };
  prior_signal: PriorSignal;
  decision_rationale: string;
  decision_rule_trace: DecisionRuleTrace[];
  retrieval_summary: {
    channels_used: RetrievalChannel[];
    total_candidates_retrieved: number;
    total_candidates_after_dedup: number;
    total_evidence_used_in_decision: number;
  };
  generated_at: string;
  limitations: string[];
}

export interface V2VerificationResult {
  available: boolean;
  claim: string;
  provenance: ProvenanceRecord;
}
