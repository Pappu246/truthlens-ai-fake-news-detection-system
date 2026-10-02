import {
  ExtractedClaim,
  ClaimVerificationResult,
  ArticleVerificationResponse,
  FinalAssessment
} from '../../src/types.js';

export interface FinalAssessmentInput {
  claims: ClaimVerificationResult[];
  mlRiskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'UNDETERMINED';
  articleTitle?: string;
  articleUrl?: string;
  contentPreview: string;
  wordCount: number;
}

/**
 * Transparent rule-based synthesis between ML linguistic risk and factual evidence.
 */
export function synthesizeMlAndEvidence(
  finalAssessment: FinalAssessment,
  mlRiskLevel: string,
  summary: { supported: number; contradicted: number; mixed: number; insufficient: number }
): string {
  const isMlHigh = mlRiskLevel === 'HIGH';
  const isMlLow = mlRiskLevel === 'LOW';

  if (finalAssessment === 'LIKELY SUPPORTED') {
    if (isMlHigh) {
      return 'Divergent signals: The ML classifier flagged high linguistic/sensational risk, but retrieved external evidence independently corroborates the factual claims. Factual verification supersedes stylistic language indicators.';
    }
    return 'Corroborated: Retrieved external reporting supports key claims, and the ML classifier confirms low linguistic risk patterns.';
  }

  if (finalAssessment === 'LIKELY FALSE') {
    if (isMlLow) {
      return 'Deceptive credibility: The article employs formal, low-risk linguistic phrasing, yet factual evidence directly refutes or contradicts the core assertions.';
    }
    return 'Compounded risk: Retrieved evidence directly contradicts key assertions, coinciding with elevated ML linguistic risk flags.';
  }

  if (finalAssessment === 'MIXED / CONTESTED') {
    return 'Contested reporting: External sources present contradictory findings or partial truths across key claims. Cross-referencing multiple primary sources is strongly advised.';
  }

  if (finalAssessment === 'UNVERIFIED' || finalAssessment === 'INSUFFICIENT EVIDENCE') {
    if (isMlHigh) {
      return 'Unverified with elevated stylistic risk: External factual sources are currently insufficient to confirm the assertions, while the ML model detects high sensationalist or unverified language patterns.';
    }
    return 'Unverified developing story: External factual evidence is currently insufficient to independently substantiate or refute the claims. Note: A lack of immediate external evidence does not imply the report is fake.';
  }

  return 'Independent multi-signal assessment completed.';
}

/**
 * Evaluates the claims and creates an article-level verification response.
 */
export function buildArticleVerification(
  id: string | number,
  input: FinalAssessmentInput
): ArticleVerificationResponse {
  const { claims, mlRiskLevel, articleTitle, articleUrl, contentPreview, wordCount } = input;

  const totalClaims = claims.length;
  const verifiedClaims = claims.filter(c => c.assessment !== 'INSUFFICIENT').length;

  const supported = claims.filter(c => c.assessment === 'SUPPORTED').length;
  const contradicted = claims.filter(c => c.assessment === 'CONTRADICTED').length;
  const mixed = claims.filter(c => c.assessment === 'MIXED').length;
  const insufficient = claims.filter(c => c.assessment === 'INSUFFICIENT').length;

  const summary = {
    totalClaims,
    verifiedClaims,
    supported,
    contradicted,
    mixed,
    insufficient
  };

  const highImportanceClaims = claims.filter(c => c.claim.importance === 'HIGH');
  const importantClaims = claims.filter(c => c.claim.importance === 'HIGH' || c.claim.importance === 'MEDIUM');
  const calibratedImportantClaims = importantClaims.filter(c => c.confidence.score >= 60);
  const lowConfidenceImportantClaims = importantClaims.filter(c => c.confidence.score < 60);
  const calibrationFloor = 60;

  let finalAssessment: FinalAssessment = 'INSUFFICIENT EVIDENCE';
  let reasoning = '';
  const warnings: string[] = [];

  // Rule 1: Key claims contradicted
  if (contradicted > 0) {
    const highContradicted = highImportanceClaims.some(c => c.assessment === 'CONTRADICTED' && c.confidence.score >= calibrationFloor);
    const calibratedContradictions = claims.filter(c => c.assessment === 'CONTRADICTED' && c.confidence.score >= calibrationFloor).length;
    if (highContradicted || calibratedContradictions >= 2) {
      finalAssessment = 'LIKELY FALSE';
      reasoning = `Core factual assertions were directly contradicted by calibrated external evidence (${contradicted} contradicted claim${contradicted > 1 ? 's' : ''}; confidence floor ${calibrationFloor}).`;
    } else {
      finalAssessment = 'INSUFFICIENT EVIDENCE';
      reasoning = 'Contradictory evidence was found, but its confidence did not meet the article-level calibration floor; the article verdict is withheld.';
      warnings.push(`Article-level contradiction requires evidence confidence >= ${calibrationFloor}.`);
    }
  }
  // Rule 2: Mixed or conflicting sources
  else if (mixed > 0 && supported === 0) {
    finalAssessment = 'MIXED / CONTESTED';
    reasoning = `Retrieved evidence presents conflicting accounts or partial verification across key assertions.`;
  }
  else if (mixed > 0 && supported > 0) {
    finalAssessment = 'MIXED / CONTESTED';
    reasoning = `Some claims are supported by external evidence, while other assertions remain contested or inconclusive.`;
  }
  // Rule 3: Supported claims. A peripheral supported claim must never
  // upgrade an article when a high-importance claim remains unverified.
  else if (supported > 0) {
    const unsupportedImportant = importantClaims.filter(c => c.assessment !== 'SUPPORTED');
    const allHighSupported = highImportanceClaims.length === 0 ||
      highImportanceClaims.every(c => c.assessment === 'SUPPORTED');

    const allImportantCalibrated = importantClaims.length === calibratedImportantClaims.length;
    if (allHighSupported && unsupportedImportant.length === 0 && allImportantCalibrated) {
      finalAssessment = 'LIKELY SUPPORTED';
      reasoning = `Key factual assertions are substantiated by calibrated external reporting (${supported} verified claim${supported > 1 ? 's' : ''}; confidence floor ${calibrationFloor}).`;
    } else {
      finalAssessment = 'INSUFFICIENT EVIDENCE';
      reasoning = `Some assertions are supported, but one or more important claims remain unverified; the article-level result is therefore withheld rather than upgraded from peripheral evidence.`;
      warnings.push('Supported peripheral claims do not establish the truth of an article when important claims remain unverified.');
      if (lowConfidenceImportantClaims.length > 0) {
        warnings.push(`${lowConfidenceImportantClaims.length} important claim(s) fell below the article-level evidence confidence calibration floor of ${calibrationFloor}; the article verdict was withheld.`);
      }
    }
  }
  // Rule 4: Insufficient evidence / Unverified
  else {
    finalAssessment = 'INSUFFICIENT EVIDENCE';
    reasoning = `No authoritative independent evidence was found to confirm or dispute the extracted assertions.`;
    warnings.push('This claim may require additional verification as reporting develops. A lack of evidence does not mean the story is fake.');
  }

  // Collect specific numerical and temporal warnings
  for (const c of claims) {
    if (c.numericalWarning) {
      warnings.push(`Claim "${c.claim.normalizedText.slice(0, 60)}...": ${c.numericalWarning}`);
    }
    if (c.temporalConflict) {
      warnings.push(`Claim "${c.claim.normalizedText.slice(0, 60)}...": ${c.temporalConflict}`);
    }
  }

  // Source-page/provenance warnings are surfaced explicitly. URL safety is
  // necessary but is not the same thing as publisher identity verification.
  const provenanceFailures = claims.filter(c =>
    c.evidence.some(e => e.sourceFetchStatus === 'FAILED' || e.provenanceVerified === false)
  ).length;
  if (provenanceFailures > 0) {
    warnings.push(`${provenanceFailures} claim(s) include evidence whose publisher page or provenance could not be independently confirmed; those records were not allowed to establish a positive verification signal.`);
  }

  // Mandatory journalistic disclaimer
  warnings.push('Important: Evidence availability reflects current external web reporting and does not guarantee absolute factual truth.');

  const mlEvidenceSynthesis = synthesizeMlAndEvidence(finalAssessment, mlRiskLevel, summary);

  return {
    id,
    article: {
      title: articleTitle,
      url: articleUrl,
      contentPreview,
      wordCount
    },
    claims,
    summary,
    finalAssessment,
    finalAssessmentReasoning: reasoning,
    mlRisk: mlRiskLevel,
    mlEvidenceSynthesis,
    warnings,
    createdAt: new Date().toISOString()
  };
}
