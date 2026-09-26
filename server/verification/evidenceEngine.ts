/**
 * TruthLens Evidence Engine
 * =========================
 *
 * Orchestrates the existing verification modules into the documented pipeline:
 *
 *   CLAIM -> EVIDENCE SEARCH -> SOURCE RELEVANCE -> SUPPORT / CONTRADICTION
 *         -> VERIFICATION SIGNAL -> FINAL INTERPRETATION
 *
 * It does NOT implement a second search system. Retrieval is delegated to
 * EvidenceProvider (Google News RSS + Wikipedia), relevance and relation
 * classification to evidenceAnalyzer, claim parsing to claimExtractor.
 *
 * Two hard rules:
 *
 *   1. NEVER fabricate evidence or citations. Every record carries the URL it
 *      was actually retrieved from and the timestamp of retrieval.
 *   2. If retrieval did not happen or every provider failed, the engine
 *      returns SEARCH_UNAVAILABLE / INSUFFICIENT_EVIDENCE. It never converts
 *      an absence of evidence into a verification verdict.
 *
 * Retrieved evidence is UNTRUSTED DATA. It is sanitised before it enters any
 * record and it can never alter the model contract, call tools, request
 * secrets, or change a verdict by instruction.
 */
import { ExtractedClaim, EvidenceItem } from '../../src/types';
import { extractClaimsHeuristic, generateSearchQueries, classifyClaimType, normalizeClaimText } from './claimExtractor';
import { evidenceProvider, RetrievalDiagnostic } from './evidenceProvider';
import { aggregateClaimAssessment, evaluateSourceDiversity } from './evidenceAnalyzer';

export type VerificationStatus =
  | 'SUPPORTED'
  | 'CONTRADICTED'
  | 'MIXED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'NEEDS_MORE_CONTEXT'
  | 'SEARCH_UNAVAILABLE';

export type EvidenceStance = 'SUPPORT' | 'CONTRADICT' | 'UNCLEAR';

/** One retrieved, sanitised piece of evidence. Every field is auditable. */
export interface EvidenceRecord {
  evidence_id: string;
  claim_text: string;
  evidence_query: string;
  retrieved_source: string;
  source_title: string;
  source_url: string;
  source_domain: string;
  source_type: string;
  evidence_excerpt: string;
  relevance_signal: {
    score: number;
    band: 'HIGH' | 'MEDIUM' | 'LOW';
    explanation: string;
  };
  stance: EvidenceStance;
  stance_basis: string;
  numerical_consistency?: { isConsistent: boolean; warning?: string } | null;
  temporal_consistency?: { isConsistent: boolean; warning?: string } | null;
  published_at?: string | null;
  retrieval_timestamp: string;
  untrusted_content: true;
  sanitisation: { injection_markers_neutralised: number; truncated: boolean };
}

export interface EvidenceVerificationReport {
  available: boolean;
  status: VerificationStatus;
  claim_text: string;
  claim_type: string;
  evidence_queries: string[];
  evidence: EvidenceRecord[];
  counts: { total: number; support: number; contradict: number; unclear: number };
  source_diversity: { independentSourcesCount: number; domains: string[] } | null;
  verification_signal: {
    direction: 'TOWARD_TRUE' | 'TOWARD_FALSE' | 'CONFLICTING' | 'NONE';
    strength: number;
    basis: string;
  };
  final_interpretation: string;
  retrieval: {
    attempted: boolean;
    providers: RetrievalDiagnostic[];
    all_providers_failed: boolean;
    duration_ms: number;
  };
  security: {
    evidence_treated_as: 'UNTRUSTED_DATA';
    injection_markers_neutralised: number;
    guarantees: string[];
  };
  generated_at: string;
  limitations: string[];
}

const MAX_EXCERPT = 600;

/**
 * Patterns that a hostile page might embed to try to steer a downstream model.
 * Evidence text is data, so these are neutralised in-place (kept visible, made
 * inert) rather than silently dropped - silently dropping them would hide an
 * attack from the audit trail.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions?/gi,
  /disregard\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?)/gi,
  /you\s+are\s+now\s+(?:a|an|the)\b/gi,
  /system\s*(?:prompt|message|instruction)/gi,
  /reveal\s+(?:your\s+)?(?:system\s+prompt|instructions?|secrets?)/gi,
  /(?:print|output|return|show)\s+(?:your\s+)?(?:api[_\s-]?key|token|secret|credential|env)/gi,
  /(?:call|execute|run|invoke)\s+(?:the\s+)?(?:tool|function|command|shell)/gi,
  /mark\s+this\s+(?:claim|article)\s+as\s+(?:true|false|verified|real|fake)/gi,
  /(?:classify|rate|score)\s+this\s+as\s+(?:true|false|real|fake)/gi,
  /override\s+(?:the\s+)?(?:verdict|assessment|classification)/gi,
  /<\|[^>]*\|>/g,
  /\[\[?\s*(?:INST|\/INST|SYSTEM|ASSISTANT)\s*\]?\]/gi,
  /<<<\s*END_[A-Z_]+\s*>>>/g
];

export interface SanitisedText {
  text: string;
  neutralised: number;
  truncated: boolean;
}

/**
 * Renders untrusted retrieved text inert for any downstream consumer.
 * Control characters are stripped, instruction-shaped spans are bracketed as
 * neutralised, and the excerpt is length-capped.
 */
export function sanitiseUntrustedEvidence(raw: string, maxLen = MAX_EXCERPT): SanitisedText {
  if (!raw) return { text: '', neutralised: 0, truncated: false };
  let text = raw
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let neutralised = 0;
  for (const pattern of INJECTION_PATTERNS) {
    text = text.replace(pattern, () => {
      neutralised++;
      // The offending span is replaced outright rather than echoed back in a
      // wrapper. Echoing it would leave the instruction text intact in the
      // payload, which is exactly what the defence is supposed to remove.
      // The marker keeps the redaction visible in the audit trail.
      return '[neutralised-instruction]';
    });
  }

  const truncated = text.length > maxLen;
  if (truncated) text = `${text.slice(0, maxLen)}...`;
  return { text, neutralised, truncated };
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'unknown';
  }
}

function relevanceBand(score: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (score >= 0.6) return 'HIGH';
  if (score >= 0.3) return 'MEDIUM';
  return 'LOW';
}

function stanceOf(relation: string): EvidenceStance {
  if (relation === 'SUPPORTS') return 'SUPPORT';
  if (relation === 'CONTRADICTS') return 'CONTRADICT';
  return 'UNCLEAR';
}

function buildClaim(text: string): ExtractedClaim {
  // Reuse the existing heuristic extractor so entity/date/number signals match
  // the rest of the verification stack. No second parser is introduced.
  const parsed = extractClaimsHeuristic('', text);
  if (parsed.length > 0) {
    const c = parsed[0];
    return {
      ...c,
      claimId: 'claim-1',
      importance: 'HIGH',
      searchQueries: c.searchQueries?.length ? c.searchQueries : generateSearchQueries(c)
    } as ExtractedClaim;
  }
  const base = {
    claimId: 'claim-1',
    originalText: text.trim(),
    normalizedText: normalizeClaimText(text) || text.trim(),
    claimType: classifyClaimType(text),
    importance: 'HIGH' as const,
    entities: [], dates: [], locations: [], numbers: [], keywords: []
  };
  return { ...base, searchQueries: generateSearchQueries(base) } as ExtractedClaim;
}

export interface EvidenceEngineOptions {
  /** Hard wall-clock budget. On expiry the engine degrades to what it has. */
  timeBudgetMs?: number;
  /** Explicitly disable retrieval (used by offline tests and by /api/analyze opt-out). */
  enabled?: boolean;
}

/**
 * Retrieval seam. Production always binds this to the existing EvidenceProvider;
 * the test suite binds a deterministic stub so the SUPPORTED / CONTRADICTED /
 * injection paths are exercised without network access. The stub never ships
 * to a runtime path and cannot be selected over HTTP.
 */
export type EvidenceRetriever = (
  claim: ExtractedClaim,
  diagnostics: RetrievalDiagnostic[]
) => Promise<EvidenceItem[]>;

const defaultRetriever: EvidenceRetriever = (claim, diagnostics) =>
  evidenceProvider.searchEvidenceForClaim(claim, diagnostics);

export class EvidenceEngine {
  private retriever: EvidenceRetriever;

  constructor(retriever: EvidenceRetriever = defaultRetriever) {
    this.retriever = retriever;
  }

  public async verifyClaim(claimText: string, options?: EvidenceEngineOptions): Promise<EvidenceVerificationReport> {
    const started = Date.now();
    const text = (claimText || '').trim();
    const generatedAt = new Date().toISOString();

    const securityGuarantees = [
      'Retrieved evidence is treated strictly as untrusted data and never as instructions.',
      'Instruction-shaped spans inside evidence are neutralised before the text is stored or returned.',
      'Evidence cannot alter the model contract, thresholds, or the final verdict by instruction.',
      'The evidence path invokes no tools and exposes no secrets or environment values.',
      'Every citation carries the URL it was actually retrieved from plus a retrieval timestamp; nothing is synthesised.'
    ];

    const emptyReport = (status: VerificationStatus, interpretation: string, limitations: string[],
                         claim?: ExtractedClaim, queries: string[] = [],
                         diagnostics: RetrievalDiagnostic[] = [], attempted = false): EvidenceVerificationReport => ({
      available: false,
      status,
      claim_text: text,
      claim_type: claim?.claimType || 'Other',
      evidence_queries: queries,
      evidence: [],
      counts: { total: 0, support: 0, contradict: 0, unclear: 0 },
      source_diversity: null,
      verification_signal: { direction: 'NONE', strength: 0, basis: 'No usable evidence was retrieved.' },
      final_interpretation: interpretation,
      retrieval: {
        attempted,
        providers: diagnostics,
        all_providers_failed: attempted && diagnostics.length > 0 && diagnostics.every(d => !d.ok),
        duration_ms: Date.now() - started
      },
      security: { evidence_treated_as: 'UNTRUSTED_DATA', injection_markers_neutralised: 0, guarantees: securityGuarantees },
      generated_at: generatedAt,
      limitations
    });

    if (!text) {
      return emptyReport('NEEDS_MORE_CONTEXT', 'No claim text was supplied, so no verification was attempted.',
        ['A claim is required before evidence can be retrieved.']);
    }
    if (text.split(/\s+/).filter(Boolean).length < 4) {
      return emptyReport('NEEDS_MORE_CONTEXT',
        'The supplied text is too short to form a checkable claim. Provide a full assertion.',
        ['Claims shorter than four words cannot produce a meaningful evidence query.']);
    }

    const claim = buildClaim(text);
    const queries = claim.searchQueries.length ? claim.searchQueries : [claim.normalizedText];

    if (options?.enabled === false) {
      return emptyReport('SEARCH_UNAVAILABLE',
        'Evidence retrieval was disabled for this request, so no verification signal is available.',
        ['Evidence retrieval disabled by request.'], claim, queries, [], false);
    }

    const diagnostics: RetrievalDiagnostic[] = [];
    let items: EvidenceItem[] = [];
    const budget = options?.timeBudgetMs ?? 12000;
    try {
      items = await Promise.race([
        this.retriever(claim, diagnostics),
        new Promise<EvidenceItem[]>((_, reject) =>
          setTimeout(() => reject(new Error(`evidence retrieval exceeded ${budget}ms budget`)), budget))
      ]);
    } catch (err: any) {
      diagnostics.push({
        provider: 'evidence_engine', query: queries[0], attemptedAt: new Date().toISOString(),
        ok: false, resultCount: 0, error: err?.message || 'retrieval failed'
      });
    }

    const allFailed = diagnostics.length > 0 && diagnostics.every(d => !d.ok);
    if (allFailed || (items.length === 0 && diagnostics.length === 0)) {
      const report = emptyReport('SEARCH_UNAVAILABLE',
        'Evidence retrieval could not be completed, so this claim is UNVERIFIED. No verdict is implied by this ' +
        'outcome: absence of retrievable evidence is not evidence of falsity.',
        ['Every configured retrieval provider failed or was unreachable from this runtime.',
         'Retry when outbound network access to the news and knowledge indexes is available.'],
        claim, queries, diagnostics, true);
      return report;
    }

    if (items.length === 0) {
      return emptyReport('INSUFFICIENT_EVIDENCE',
        'Retrieval succeeded but returned no source discussing this claim. The claim is UNVERIFIED.',
        ['No independent source addressing this specific assertion was found.',
         'Absence of coverage is not evidence that the claim is false.'],
        claim, queries, diagnostics, true);
    }

    // ---- sanitise + structure -------------------------------------------
    let neutralisedTotal = 0;
    const records: EvidenceRecord[] = items.map((item, i) => {
      const excerpt = sanitiseUntrustedEvidence(item.snippet || item.title || '');
      const title = sanitiseUntrustedEvidence(item.title || '', 240);
      const sourceName = sanitiseUntrustedEvidence(item.sourceName || 'Unknown source', 120);
      neutralisedTotal += excerpt.neutralised + title.neutralised + sourceName.neutralised;
      return {
        evidence_id: `ev-${i + 1}`,
        claim_text: text,
        evidence_query: queries[0],
        retrieved_source: sourceName.text,
        source_title: title.text,
        source_url: item.sourceUrl,
        source_domain: domainOf(item.sourceUrl),
        source_type: item.sourceType,
        evidence_excerpt: excerpt.text,
        relevance_signal: {
          score: Math.round(item.relevanceScore * 1000) / 1000,
          band: relevanceBand(item.relevanceScore),
          explanation: item.relevanceExplanation || 'Lexical and entity overlap with the claim.'
        },
        stance: stanceOf(item.relation),
        stance_basis: item.relation === 'IRRELEVANT'
          ? 'Source does not address the specific assertion.'
          : `Classified ${item.relation} from lexical, numerical and temporal comparison against the claim.`,
        numerical_consistency: item.numericalConsistency ?? null,
        temporal_consistency: item.temporalConsistency ?? null,
        published_at: item.publishedAt ?? null,
        retrieval_timestamp: item.retrievedAt,
        untrusted_content: true as const,
        sanitisation: {
          injection_markers_neutralised: excerpt.neutralised + title.neutralised + sourceName.neutralised,
          truncated: excerpt.truncated
        }
      };
    });

    const relevant = records.filter(r => r.relevance_signal.band !== 'LOW' || r.stance !== 'UNCLEAR');
    const counts = {
      total: records.length,
      support: records.filter(r => r.stance === 'SUPPORT').length,
      contradict: records.filter(r => r.stance === 'CONTRADICT').length,
      unclear: records.filter(r => r.stance === 'UNCLEAR').length
    };

    const aggregated = aggregateClaimAssessment(claim, items);
    const diversity = evaluateSourceDiversity(items.filter(e => e.relation !== 'IRRELEVANT'));

    let status: VerificationStatus;
    let direction: EvidenceVerificationReport['verification_signal']['direction'];
    switch (aggregated.assessment) {
      case 'SUPPORTED': status = 'SUPPORTED'; direction = 'TOWARD_TRUE'; break;
      case 'CONTRADICTED': status = 'CONTRADICTED'; direction = 'TOWARD_FALSE'; break;
      case 'MIXED': status = 'MIXED'; direction = 'CONFLICTING'; break;
      default: status = 'INSUFFICIENT_EVIDENCE'; direction = 'NONE'; break;
    }

    const strength = counts.support + counts.contradict === 0
      ? 0
      : Math.min(1, (Math.abs(counts.support - counts.contradict) / (counts.support + counts.contradict))
        * Math.min(1, (diversity?.independentSourcesCount || 0) / 3));

    const limitations = [
      'Evidence relation is inferred from headlines and short snippets, not from full-article entailment.',
      'Retrieval covers a news index and Wikipedia; it is not an exhaustive survey of the record.',
      'SUPPORTED means independent reporting corroborates the assertion; it is not proof of truth.'
    ];
    if (relevant.length < records.length) {
      limitations.push(`${records.length - relevant.length} retrieved source(s) were low-relevance and carry little weight.`);
    }

    return {
      available: true,
      status,
      claim_text: text,
      claim_type: claim.claimType,
      evidence_queries: queries,
      evidence: records,
      counts,
      source_diversity: diversity
        ? {
            independentSourcesCount: diversity.independentSourcesCount,
            domains: Array.from(new Set(records.map(r => r.source_domain)))
          }
        : null,
      verification_signal: {
        direction,
        strength: Math.round(strength * 1000) / 1000,
        basis: aggregated.assessmentExplanation
      },
      final_interpretation: `${status}: ${aggregated.assessmentExplanation} ` +
        'This is an evidence-retrieval signal, independent of the statistical claim model; the two are reported separately.',
      retrieval: {
        attempted: true,
        providers: diagnostics,
        all_providers_failed: false,
        duration_ms: Date.now() - started
      },
      security: {
        evidence_treated_as: 'UNTRUSTED_DATA',
        injection_markers_neutralised: neutralisedTotal,
        guarantees: securityGuarantees
      },
      generated_at: generatedAt,
      limitations
    };
  }
}

export const evidenceEngine = new EvidenceEngine();
