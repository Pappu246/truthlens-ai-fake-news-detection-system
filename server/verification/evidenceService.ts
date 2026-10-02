import {
  ExtractedClaim,
  ClaimVerificationResult,
  ArticleVerificationResponse,
  EvidenceItem
} from '../../src/types.js';
import { extractClaims, extractPrimaryClaim, ClaimExtractionResult } from './claimExtractor.js';
import { evidenceProvider } from './evidenceProvider.js';
import { buildArticleVerification } from './assessmentEngine.js';

export interface SourceEvaluation {
  provided: boolean;
  url: string | null;
  domain: string | null;
  source_status: string;
  verification_status: string;
  notes: string;
}

export interface EvidenceSearchStatus {
  available: boolean;
  status: 'AVAILABLE' | 'UNAVAILABLE';
  message: string;
  reason: string;
  results: any[];
}

export interface ClaimVerificationResponse {
  claim: ClaimExtractionResult;
  source: SourceEvaluation;
  evidence: EvidenceSearchStatus;
  status: 'COMPLETED';
  verification_verdict: string;
  verification_note: string;
}

export function evaluateSourceProvenance(sourceUrl?: string | null): SourceEvaluation {
  if (!sourceUrl || !sourceUrl.trim()) {
    return {
      provided: false,
      url: null,
      domain: null,
      source_status: 'Not provided',
      verification_status: 'Not independently verified',
      notes: 'No source URL was supplied. The assessment was performed solely on article text.'
    };
  }

  const trimmed = sourceUrl.trim();
  try {
    const urlObj = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const domain = urlObj.hostname.toLowerCase();
    return {
      provided: true,
      url: trimmed,
      domain,
      source_status: domain,
      verification_status: 'Recorded for provenance',
      notes: `Origin domain '${domain}' recorded for provenance tracking. Evaluation is based on text content and external corroboration.`
    };
  } catch {
    return {
      provided: true,
      url: trimmed,
      domain: trimmed,
      source_status: trimmed,
      verification_status: 'Not independently verified',
      notes: 'Source URL string recorded. Evaluation is based on text content and external corroboration.'
    };
  }
}

/**
 * Executes full Phase 4 Article Verification pipeline:
 * Article -> Extract Claims -> Normalize Claims -> Search Evidence -> Assess Claims -> Rule Aggregation -> Final Assessment
 */
export async function verifyArticleContent(options: {
  title?: string;
  content: string;
  sourceUrl?: string;
  mlRiskLevel?: 'LOW' | 'MODERATE' | 'HIGH' | 'UNDETERMINED';
  id?: string | number;
}): Promise<ArticleVerificationResponse> {
  const { title = '', content, sourceUrl = '', mlRiskLevel = 'UNDETERMINED', id = Date.now().toString() } = options;

  // 1. Extract claims
  const claims = await extractClaims(title, content);

  // 2. Search and verify evidence for claims
  const verifiedClaims = await evidenceProvider.verifyClaims(claims);

  // 3. Build article verification with rule-based aggregation
  const wordCount = content.trim().split(/\s+/).filter(w => w.length > 0).length;
  const contentPreview = content.slice(0, 200) + (content.length > 200 ? '...' : '');

  return buildArticleVerification(id, {
    claims: verifiedClaims,
    mlRiskLevel,
    articleTitle: title || undefined,
    articleUrl: sourceUrl || undefined,
    contentPreview,
    wordCount
  });
}

/**
 * Backward-compatible single claim verification helper
 */
export async function verifyClaim(text: string, sourceUrl?: string | null): Promise<ClaimVerificationResponse> {
  const claim = extractPrimaryClaim(text);
  const source = evaluateSourceProvenance(sourceUrl);

  if (!claim.has_claim) {
    return {
      claim,
      source,
      evidence: {
        available: false,
        status: 'UNAVAILABLE',
        message: 'No verifiable factual claim was extracted.',
        reason: 'The supplied text did not contain a sufficiently specific factual assertion.',
        results: []
      },
      status: 'COMPLETED',
      verification_verdict: 'INSUFFICIENT_EVIDENCE',
      verification_note: 'No factual claim was available for live evidence retrieval.'
    };
  }

  const extracted = await extractClaims('', claim.detected_claim);
  const target = extracted[0];
  if (!target) {
    return {
      claim,
      source,
      evidence: {
        available: false,
        status: 'UNAVAILABLE',
        message: 'Claim normalization failed.',
        reason: 'The extracted claim could not be converted into the evidence-search contract.',
        results: []
      },
      status: 'COMPLETED',
      verification_verdict: 'INSUFFICIENT_EVIDENCE',
      verification_note: 'The claim could not be normalized for evidence retrieval.'
    };
  }

  const results = await evidenceProvider.searchEvidenceForClaim(target);
  const assessment = results.length
    ? results.reduce((best, item) => {
        const rank: Record<string, number> = {
          CONTRADICTS: 4, SUPPORTS: 3, MIXED: 2, INSUFFICIENT: 1, IRRELEVANT: 0
        };
        return (rank[item.relation] ?? 0) > (rank[best.relation] ?? 0) ? item : best;
      }, results[0])
    : undefined;

  const verdict =
    results.some(r => r.relation === 'CONTRADICTS') ? 'LIKELY FALSE' :
    results.some(r => r.relation === 'MIXED') ? 'MIXED / CONTESTED' :
    results.some(r => r.relation === 'SUPPORTS') ? 'LIKELY SUPPORTED' :
    'INSUFFICIENT EVIDENCE';

  const unavailable = results.length === 0;
  return {
    claim,
    source,
    evidence: {
      available: !unavailable,
      status: unavailable ? 'UNAVAILABLE' : 'AVAILABLE',
      message: unavailable ? 'No usable fetched evidence was found.' : 'Live evidence retrieval completed.',
      reason: unavailable
        ? 'No retrieved source page passed fetch and provenance checks.'
        : 'Evidence was retrieved from source pages through the SSRF-safe fetch pipeline.',
      results: results.map(item => ({
        ...item,
        assessment: item.relation,
        source_final_url: item.sourceFinalUrl,
        provenance_verified: item.provenanceVerified,
        source_fetch_status: item.sourceFetchStatus
      }))
    },
    status: 'COMPLETED',
    verification_verdict: verdict,
    verification_note: assessment
      ? `Primary evidence signal: ${assessment.relation} from ${assessment.sourceName}.`
      : 'No evidence signal was strong enough to support a verdict.'
  };
}
