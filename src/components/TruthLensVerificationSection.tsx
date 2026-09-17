import React, { useState } from 'react';
import {
  ArticleVerificationResponse,
  ClaimVerificationResult,
  EvidenceItem,
  ClaimImportance,
  ClaimAssessment,
  SourceType
} from '../types';
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Search,
  ExternalLink,
  ShieldCheck,
  Scale,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Clock,
  Info,
  Layers,
  FileCheck
} from 'lucide-react';

interface TruthLensVerificationSectionProps {
  initialVerification?: ArticleVerificationResponse;
  articleTitle?: string;
  articleContent: string;
  sourceUrl?: string;
  mlRiskLevel?: 'LOW' | 'MODERATE' | 'HIGH' | 'UNDETERMINED';
  analysisId?: string | number;
}

export const TruthLensVerificationSection: React.FC<TruthLensVerificationSectionProps> = ({
  initialVerification,
  articleTitle,
  articleContent,
  sourceUrl,
  mlRiskLevel = 'UNDETERMINED',
  analysisId
}) => {
  const [verification, setVerification] = useState<ArticleVerificationResponse | undefined>(initialVerification);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedClaimId, setExpandedClaimId] = useState<string | null>(null);

  const handleVerifyArticle = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/verify-article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: articleTitle || '',
          content: articleContent,
          sourceUrl: sourceUrl || '',
          mlRiskLevel,
          analysisId
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to verify article claims.');
      }

      const data: ArticleVerificationResponse = await res.json();
      setVerification(data);
      if (data.claims && data.claims.length > 0) {
        setExpandedClaimId(data.claims[0].claim.claimId);
      }
    } catch (err: any) {
      setError(err.message || 'Error occurred during verification.');
    } finally {
      setIsLoading(false);
    }
  };

  const getAssessmentBadge = (assessment: ClaimAssessment) => {
    switch (assessment) {
      case 'SUPPORTED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
            <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
            SUPPORTED
          </span>
        );
      case 'CONTRADICTED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-800 border border-red-200">
            <XCircle className="w-3.5 h-3.5 text-red-600" />
            CONTRADICTED
          </span>
        );
      case 'MIXED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
            <Scale className="w-3.5 h-3.5 text-amber-600" />
            MIXED / CONFLICTING
          </span>
        );
      case 'INSUFFICIENT':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-300">
            <Info className="w-3.5 h-3.5 text-slate-500" />
            INSUFFICIENT EVIDENCE
          </span>
        );
    }
  };

  const getImportanceBadge = (importance: ClaimImportance) => {
    switch (importance) {
      case 'HIGH':
        return <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">High Priority</span>;
      case 'MEDIUM':
        return <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">Medium</span>;
      case 'LOW':
      default:
        return <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">Supporting</span>;
    }
  };

  const getSourceTypeBadge = (sourceType: SourceType) => {
    switch (sourceType) {
      case 'OFFICIAL_GOVERNMENT':
        return <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">Official Gov</span>;
      case 'OFFICIAL_ORGANIZATION':
        return <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200">Official Org</span>;
      case 'PRIMARY_SCIENTIFIC':
        return <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">Academic / Science</span>;
      case 'MAJOR_NEWS':
        return <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">Major News Outlet</span>;
      case 'REPUTABLE_SOURCE':
        return <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">Reputable Source</span>;
      default:
        return <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Web Source</span>;
    }
  };

  const getFinalVerdictBadge = (finalAssessment: string) => {
    switch (finalAssessment) {
      case 'LIKELY SUPPORTED':
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-500 text-white font-black text-sm uppercase tracking-wide shadow-xs">
            <ShieldCheck className="w-4 h-4" />
            Likely Supported
          </div>
        );
      case 'LIKELY FALSE':
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-rose-600 text-white font-black text-sm uppercase tracking-wide shadow-xs">
            <XCircle className="w-4 h-4" />
            Likely False
          </div>
        );
      case 'MIXED / CONTESTED':
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-500 text-white font-black text-sm uppercase tracking-wide shadow-xs">
            <Scale className="w-4 h-4" />
            Mixed / Contested
          </div>
        );
      case 'INSUFFICIENT EVIDENCE':
      case 'UNVERIFIED':
      default:
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-700 text-white font-black text-sm uppercase tracking-wide shadow-xs">
            <Info className="w-4 h-4" />
            Insufficient Evidence
          </div>
        );
    }
  };

  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-6">
      {/* Header with Title and Trigger Button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-7 h-7 rounded-lg bg-indigo-50 text-indigo-700 flex items-center justify-center">
              <FileCheck className="w-4 h-4" />
            </div>
            <h3 className="text-base font-black uppercase tracking-tight text-slate-900">
              TruthLens Fact-Checking & Evidence Engine
            </h3>
            <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 font-mono">
              Phase 4
            </span>
          </div>
          <p className="text-xs text-slate-500 leading-relaxed max-w-xl">
            Extracts factual claims, queries authentic news and encyclopedic indexes, tests numerical consistency, and evaluates source diversity.
          </p>
        </div>

        <button
          onClick={handleVerifyArticle}
          disabled={isLoading}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm self-start sm:self-auto"
        >
          {isLoading ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Verifying Claims...</span>
            </>
          ) : (
            <>
              <Search className="w-3.5 h-3.5" />
              <span>{verification ? 'Re-verify with Evidence' : 'Verify Article Claims'}</span>
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading state indicator */}
      {isLoading && (
        <div className="p-8 text-center bg-slate-50 rounded-2xl border border-dashed border-slate-300 space-y-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto animate-pulse">
            <RefreshCw className="w-5 h-5 animate-spin" />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-bold text-slate-800">Searching Real-World Sources...</h4>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Extracting factual entities and dates → Querying live news outlets and knowledge indexes → Evaluating numerical consistency.
            </p>
          </div>
        </div>
      )}

      {/* Unverified state initial callout */}
      {!verification && !isLoading && (
        <div className="p-6 bg-slate-50 rounded-2xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center shrink-0 shadow-xs">
              <Scale className="w-5 h-5 text-slate-600" />
            </div>
            <div className="space-y-1">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Independent Factual Verification
              </h4>
              <p className="text-xs text-slate-600 max-w-lg leading-relaxed">
                The machine learning model on the left detects stylistic linguistic patterns. Click <strong>Verify Article Claims</strong> to corroborate core factual assertions against real external reporting.
              </p>
            </div>
          </div>
          <button
            onClick={handleVerifyArticle}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all shadow-xs shrink-0"
          >
            Start Verification
          </button>
        </div>
      )}

      {/* VERIFICATION REPORT */}
      {verification && !isLoading && (
        <div className="space-y-6">
          {/* Dual-Signal Comparison Banner */}
          <div className="p-5 bg-gradient-to-r from-slate-900 to-slate-800 rounded-2xl text-white space-y-4 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-700/60 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-indigo-300">
                  Dual-Signal Evaluation
                </span>
                <span className="text-slate-500">•</span>
                <span className="text-xs text-slate-300">ML Risk vs Factual Evidence</span>
              </div>
              <div>{getFinalVerdictBadge(verification.finalAssessment)}</div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="p-3.5 bg-slate-800/80 rounded-xl border border-slate-700/80 space-y-1">
                <span className="text-[10px] font-bold uppercase text-slate-400 block font-mono">
                  Signal 1: ML Linguistic Risk
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-black text-white">
                    {verification.mlRisk} LINGUISTIC RISK
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-slate-700 text-slate-300 font-mono">
                    Linear SVM
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 pt-1 leading-snug">
                  Evaluates vocabulary distribution, sensational markers, and writing style.
                </p>
              </div>

              <div className="p-3.5 bg-slate-800/80 rounded-xl border border-slate-700/80 space-y-1">
                <span className="text-[10px] font-bold uppercase text-slate-400 block font-mono">
                  Signal 2: External Evidence
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-black text-white">
                    {verification.finalAssessment}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-slate-700 text-slate-300 font-mono">
                    Live Web
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 pt-1 leading-snug">
                  {verification.finalAssessmentReasoning}
                </p>
              </div>
            </div>

            {/* Synthesis explanation */}
            <div className="p-3 bg-indigo-950/60 rounded-xl border border-indigo-900/60 text-xs text-indigo-200 leading-relaxed flex items-start gap-2.5">
              <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
              <div>
                <strong className="text-white block mb-0.5">Synthesis Reasoning:</strong>
                <span>{verification.mlEvidenceSynthesis}</span>
              </div>
            </div>
          </div>

          {/* Evidence Summary Counters */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3.5 bg-emerald-50/70 rounded-xl border border-emerald-200">
              <span className="text-[10px] font-black uppercase text-emerald-800 block tracking-wider mb-1">
                Supported
              </span>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-emerald-900">
                  {verification.summary?.supported ?? 0}
                </span>
                <span className="text-xs text-emerald-700 font-mono">
                  / {verification.summary?.totalClaims ?? 0} claims
                </span>
              </div>
            </div>

            <div className="p-3.5 bg-red-50/70 rounded-xl border border-red-200">
              <span className="text-[10px] font-black uppercase text-red-800 block tracking-wider mb-1">
                Contradicted
              </span>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-red-900">
                  {verification.summary?.contradicted ?? 0}
                </span>
                <span className="text-xs text-red-700 font-mono">
                  / {verification.summary?.totalClaims ?? 0} claims
                </span>
              </div>
            </div>

            <div className="p-3.5 bg-amber-50/70 rounded-xl border border-amber-200">
              <span className="text-[10px] font-black uppercase text-amber-800 block tracking-wider mb-1">
                Mixed / Contested
              </span>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-amber-900">
                  {verification.summary?.mixed ?? 0}
                </span>
                <span className="text-xs text-amber-700 font-mono">
                  / {verification.summary?.totalClaims ?? 0} claims
                </span>
              </div>
            </div>

            <div className="p-3.5 bg-slate-100 rounded-xl border border-slate-200">
              <span className="text-[10px] font-black uppercase text-slate-700 block tracking-wider mb-1">
                Insufficient Info
              </span>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-slate-900">
                  {verification.summary?.insufficient ?? 0}
                </span>
                <span className="text-xs text-slate-600 font-mono">
                  / {verification.summary?.totalClaims ?? 0} claims
                </span>
              </div>
            </div>
          </div>

          {/* Warnings & Advisories */}
          {verification.warnings && verification.warnings.length > 0 && (
            <div className="space-y-2">
              {verification.warnings.map((warn, wIdx) => (
                <div
                  key={wIdx}
                  className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2.5"
                >
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <span className="leading-snug">{warn}</span>
                </div>
              ))}
            </div>
          )}

          {/* Extracted Claims & Evidence Details */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-black uppercase tracking-wider text-slate-500">
                Extracted Claims & Independent Evidence ({verification.claims.length})
              </h4>
              <span className="text-[10px] text-slate-400 font-mono">Click claim to expand sources</span>
            </div>

            <div className="space-y-3">
              {verification.claims.map((claimResult: ClaimVerificationResult) => {
                const isExpanded = expandedClaimId === claimResult.claim.claimId;
                const evidenceList = claimResult.evidence || [];

                return (
                  <div
                    key={claimResult.claim.claimId}
                    className="border border-slate-200 rounded-2xl bg-white overflow-hidden transition-all shadow-xs"
                  >
                    {/* Claim summary header */}
                    <div
                      onClick={() => setExpandedClaimId(isExpanded ? null : claimResult.claim.claimId)}
                      className="p-4 bg-slate-50/70 hover:bg-slate-100/70 cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors"
                    >
                      <div className="space-y-1.5 flex-1 pr-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {getImportanceBadge(claimResult.claim.importance)}
                          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-slate-200/80 text-slate-700">
                            {claimResult.claim.claimType}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono">
                            {evidenceList.length} source{evidenceList.length !== 1 ? 's' : ''} retrieved
                          </span>
                        </div>
                        <p className="text-sm font-semibold text-slate-900 leading-snug">
                          {claimResult.claim.normalizedText}
                        </p>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        {getAssessmentBadge(claimResult.assessment)}
                        <button
                          type="button"
                          className="w-7 h-7 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-900 transition-colors"
                        >
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {/* Expanded details */}
                    {isExpanded && (
                      <div className="p-4 space-y-4 border-t border-slate-200 bg-white">
                        {/* Claim Metadata & Explanation */}
                        <div className="p-3 bg-slate-50 rounded-xl text-xs space-y-2 border border-slate-200 font-mono">
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-slate-500">Assessment Note:</span>
                            <span className="font-sans font-medium text-slate-800 text-right">
                              {claimResult.assessmentExplanation}
                            </span>
                          </div>

                          {claimResult.sourceDiversity?.syndicationNote && (
                            <div className="flex items-center justify-between text-slate-600 text-[11px] pt-1 border-t border-slate-200">
                              <span>Source Diversity:</span>
                              <span className="font-sans">{claimResult.sourceDiversity.syndicationNote}</span>
                            </div>
                          )}

                          {claimResult.claim.entities.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 pt-1">
                              <span className="text-[10px] uppercase text-slate-400 font-sans">Entities:</span>
                              {claimResult.claim.entities.map((ent, eIdx) => (
                                <span key={eIdx} className="px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-700 text-[10px]">
                                  {ent}
                                </span>
                              ))}
                            </div>
                          )}

                          {claimResult.claim.numbers.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                              <span className="text-[10px] uppercase text-slate-400 font-sans">Key Metrics:</span>
                              {claimResult.claim.numbers.map((num, nIdx) => (
                                <span key={nIdx} className="px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-700 text-[10px]">
                                  {num}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Numerical or Temporal Warnings for this claim */}
                        {claimResult.numericalWarning && (
                          <div className="p-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                            <span>{claimResult.numericalWarning}</span>
                          </div>
                        )}

                        {/* Sources list */}
                        <div className="space-y-2.5">
                          <span className="text-[10px] font-black uppercase text-slate-400 block tracking-wider">
                            Retrieved External Sources ({evidenceList.length})
                          </span>

                          {evidenceList.length === 0 ? (
                            <div className="p-4 bg-slate-50 rounded-xl text-center text-xs text-slate-500">
                              No authoritative external evidence was found for this specific claim. (Remember: A lack of evidence does not mean the story is fake).
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 gap-2.5">
                              {evidenceList.map((ev: EvidenceItem) => (
                                <div
                                  key={ev.id}
                                  className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/50 hover:bg-slate-50 transition-colors space-y-2 text-xs"
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex items-center gap-2">
                                      <span className="font-bold text-slate-900">{ev.sourceName}</span>
                                      {getSourceTypeBadge(ev.sourceType)}
                                    </div>

                                    <div className="flex items-center gap-2">
                                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                        ev.relation === 'SUPPORTS'
                                          ? 'bg-emerald-100 text-emerald-800'
                                          : ev.relation === 'CONTRADICTS'
                                          ? 'bg-red-100 text-red-800'
                                          : 'bg-amber-100 text-amber-800'
                                      }`}>
                                        {ev.relation}
                                      </span>
                                      <span className="text-[10px] font-mono font-bold text-slate-600">
                                        {(ev.relevanceScore * 100).toFixed(0)}% match
                                      </span>
                                    </div>
                                  </div>

                                  <p className="text-slate-800 italic font-serif leading-relaxed">
                                    "{ev.snippet}"
                                  </p>

                                  <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1 border-t border-slate-200/80">
                                    <span>
                                      {ev.publishedAt ? `Published: ${new Date(ev.publishedAt).toLocaleDateString()}` : 'Date recorded'}
                                    </span>
                                    <a
                                      href={ev.sourceUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1 font-semibold"
                                    >
                                      <span>Original Article</span>
                                      <ExternalLink className="w-3 h-3" />
                                    </a>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
