/**
 * V2 PROVENANCE
 * =============
 * Builds the single serializable provenance object required by PHASE 8:
 * claim, verdict, confidence, full evidence list (exact passage, URL, title,
 * publisher/domain, publication date, retrieval timestamp, retrieval
 * method), NLI model/version metadata, and the full decision rule trace.
 */
import { ExpandedQuerySet, ClassifiedEvidence, VerdictDecision, ProvenanceRecord, ProvenanceEvidenceRecord } from './types';

export const PIPELINE_VERSION = 'truthlens-v2-vertical-slice-0.1.0';

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'unknown';
  }
}

function toEvidenceRecord(e: ClassifiedEvidence): ProvenanceEvidenceRecord {
  return {
    evidence_id: e.id,
    url: e.url,
    canonical_url: e.canonicalUrl,
    title: e.title,
    publisher: e.publisher,
    domain: domainOf(e.url),
    published_at: e.publishedAt ?? null,
    retrieval_timestamp: e.retrievedAt,
    retrieval_method: e.retrievalMethod,
    retrieval_channels: Array.from(new Set(e.foundBy.map(f => f.channel))),
    content_type: e.contentType,
    exact_passage: e.passage,
    nli_label: e.nli.label,
    nli_confidence: e.nli.confidence,
    nli_model: { name: e.nli.modelName, version: e.nli.modelVersion },
    rerank_score: e.rerankScore,
    rerank_signals: e.rerankSignals,
    is_duplicate_cluster: e.isDuplicateCluster,
    source_type: e.sourceType
  };
}

export function buildProvenance(
  claimText: string,
  queries: ExpandedQuerySet,
  evidence: ClassifiedEvidence[],
  decision: VerdictDecision,
  retrievalSummary: { channelsUsed: string[]; totalRetrievedBeforeDedup: number; totalAfterDedup: number },
  limitations: string[]
): ProvenanceRecord {
  const counts = {
    supports: evidence.filter(e => e.nli.label === 'SUPPORTS').length,
    refutes: evidence.filter(e => e.nli.label === 'REFUTES').length,
    neutral: evidence.filter(e => e.nli.label === 'NEUTRAL').length,
    unclear: evidence.filter(e => e.nli.label === 'UNCLEAR').length
  };
  const independentDomains = new Set(evidence.map(e => e.domainClusterId)).size;
  const duplicateClusters = evidence.filter(e => e.isDuplicateCluster).length;

  return {
    pipeline: 'truthlens_v2_evidence_grounded',
    pipeline_version: PIPELINE_VERSION,
    claim: claimText,
    queries,
    final_verdict: decision.verdict,
    final_confidence: decision.confidence,
    abstained: decision.abstained,
    abstention_reason: decision.abstentionReason,
    evidence: evidence.map(toEvidenceRecord),
    evidence_counts: counts,
    source_diversity: { independent_domains: independentDomains, duplicate_clusters: duplicateClusters },
    prior_signal: decision.prior,
    decision_rationale: decision.rationale,
    decision_rule_trace: decision.ruleTrace,
    retrieval_summary: {
      channels_used: retrievalSummary.channelsUsed as any,
      total_candidates_retrieved: retrievalSummary.totalRetrievedBeforeDedup,
      total_candidates_after_dedup: retrievalSummary.totalAfterDedup,
      total_evidence_used_in_decision: evidence.length
    },
    generated_at: new Date().toISOString(),
    limitations
  };
}
