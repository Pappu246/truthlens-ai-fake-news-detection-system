import React from 'react';
import { AlertTriangle, CheckCircle, ExternalLink, FileSearch, Info, ShieldCheck, XCircle } from 'lucide-react';
import type { ClaimModelInfo, EvidenceVerificationInfo } from '../types';

interface IndependentSignalsPanelProps {
  claimModel?: ClaimModelInfo;
  evidence?: EvidenceVerificationInfo;
}

function safeHttpUrl(value?: string | null): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function statusPresentation(status?: string) {
  switch (status) {
    case 'SUPPORTED':
      return { label: 'SUPPORTED BY RETRIEVED EVIDENCE', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200', icon: CheckCircle };
    case 'CONTRADICTED':
      return { label: 'CONTRADICTED BY RETRIEVED EVIDENCE', cls: 'bg-rose-50 text-rose-800 border-rose-200', icon: XCircle };
    case 'MIXED':
      return { label: 'MIXED / CONFLICTING EVIDENCE', cls: 'bg-amber-50 text-amber-900 border-amber-200', icon: AlertTriangle };
    case 'SEARCH_UNAVAILABLE':
      return { label: 'SEARCH UNAVAILABLE', cls: 'bg-amber-50 text-amber-900 border-amber-200', icon: AlertTriangle };
    case 'NEEDS_MORE_CONTEXT':
      return { label: 'NEEDS MORE CONTEXT', cls: 'bg-amber-50 text-amber-900 border-amber-200', icon: Info };
    case 'INSUFFICIENT_EVIDENCE':
      return { label: 'INSUFFICIENT EVIDENCE', cls: 'bg-slate-50 text-slate-700 border-slate-200', icon: Info };
    default:
      return { label: 'EVIDENCE STATUS UNAVAILABLE', cls: 'bg-slate-50 text-slate-700 border-slate-200', icon: Info };
  }
}

function claimLabelPresentation(label?: string) {
  if (label === 'LIKELY TRUE') return 'bg-emerald-50 text-emerald-800 border-emerald-200';
  if (label === 'LIKELY FALSE') return 'bg-rose-50 text-rose-800 border-rose-200';
  return 'bg-amber-50 text-amber-900 border-amber-200';
}

/**
 * Shows the backend's specialist claim-model signal and evidence-engine response
 * without merging either into the article classifier's probability or verdict.
 * All retrieved source text is rendered as inert text (never as HTML).
 */
export const IndependentSignalsPanel: React.FC<IndependentSignalsPanelProps> = ({ claimModel, evidence }) => {
  if (!claimModel && !evidence) return null;

  const evidenceStatus = statusPresentation(evidence?.status);
  const EvidenceIcon = evidenceStatus.icon;
  const claimModelAvailable = claimModel?.status === 'AVAILABLE';
  const pTrue = typeof claimModel?.probability_true === 'number' ? claimModel.probability_true : null;
  const pFalse = typeof claimModel?.probability_false === 'number' ? claimModel.probability_false : null;
  const sources = (evidence?.evidence || []).slice(0, 4);

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
          <ShieldCheck className="w-5 h-5" />
        </div>
        <div>
          <h3 className="text-sm font-black uppercase tracking-wide text-slate-900">Separate Claim & Evidence Signals</h3>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
            These are separate outputs. They are not averaged into the article model's fake/real percentage and are not proof by themselves.
          </p>
        </div>
      </div>

      {claimModel && (
        <div className="p-5 border-b border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <FileSearch className="w-4 h-4 text-indigo-700" />
              <h4 className="text-xs font-black uppercase tracking-wide text-slate-800">LIAR Specialist Claim Model</h4>
            </div>
            <span className={`px-2.5 py-1 rounded-full border text-[10px] font-black uppercase tracking-wide ${claimModelAvailable ? claimLabelPresentation(claimModel.label) : 'bg-slate-50 text-slate-700 border-slate-200'}`}>
              {claimModelAvailable ? (claimModel.label || 'CLAIM SIGNAL AVAILABLE') : claimModel.status.replace(/_/g, ' ')}
            </span>
          </div>

          {claimModel.claim_text && (
            <p className="text-sm text-slate-800 leading-relaxed mb-3">“{claimModel.claim_text}”</p>
          )}

          {claimModelAvailable && pTrue !== null && pFalse !== null ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-3">
                <span className="text-[10px] uppercase tracking-wider text-emerald-800 font-bold">Claim-model P(TRUE)</span>
                <strong className="block text-2xl font-black text-emerald-700 font-mono mt-1">{(pTrue * 100).toFixed(1)}%</strong>
                <div className="h-1.5 bg-emerald-100 rounded-full mt-2 overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.max(0, Math.min(100, pTrue * 100))}%` }} />
                </div>
              </div>
              <div className="rounded-xl border border-rose-100 bg-rose-50/50 p-3">
                <span className="text-[10px] uppercase tracking-wider text-rose-800 font-bold">Claim-model P(FALSE)</span>
                <strong className="block text-2xl font-black text-rose-700 font-mono mt-1">{(pFalse * 100).toFixed(1)}%</strong>
                <div className="h-1.5 bg-rose-100 rounded-full mt-2 overflow-hidden">
                  <div className="h-full bg-rose-500 rounded-full" style={{ width: `${Math.max(0, Math.min(100, pFalse * 100))}%` }} />
                </div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-600">{claimModel.reason || 'A separate claim-model score was not available for this input.'}</p>
          )}

          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950 leading-relaxed">
            <strong>Scope limitation:</strong> this model was trained on short political claims from the LIAR benchmark. It can generalize poorly to science, space, health, or other domains. Treat its score as a weak statistical signal, not as an article truth probability or independent fact-check.
            {claimModel.benchmark && (
              <span> Its held-out LIAR benchmark accuracy is {(claimModel.benchmark.accuracy * 100).toFixed(2)}% (n={claimModel.benchmark.n}); this is not a guarantee for the current claim.</span>
            )}
          </div>
          {(claimModel.limitations || []).slice(0, 2).map((limitation, i) => (
            <p key={i} className="text-[11px] text-slate-500 mt-2 leading-relaxed">{limitation}</p>
          ))}
        </div>
      )}

      {evidence && (
        <div className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-slate-700" />
              <h4 className="text-xs font-black uppercase tracking-wide text-slate-800">Evidence Retrieval Result</h4>
            </div>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-black uppercase tracking-wide ${evidenceStatus.cls}`}>
              <EvidenceIcon className="w-3 h-3" />
              {evidenceStatus.label}
            </span>
          </div>
          {evidence.claim_text && <p className="text-sm font-semibold text-slate-800 mb-2">Claim checked: {evidence.claim_text}</p>}
          <p className="text-sm text-slate-700 leading-relaxed">{evidence.final_interpretation || evidence.message || evidence.reason || evidence.evidence_outcome?.detail || 'No independent evidence interpretation was returned.'}</p>

          {evidence.counts && (
            <div className="grid grid-cols-3 gap-2 mt-4">
              <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3">
                <span className="block text-[10px] uppercase font-bold text-emerald-800">Support</span>
                <strong className="block text-xl font-black text-emerald-700">{evidence.counts.support}</strong>
              </div>
              <div className="rounded-lg border border-rose-100 bg-rose-50 p-3">
                <span className="block text-[10px] uppercase font-bold text-rose-800">Contradict</span>
                <strong className="block text-xl font-black text-rose-700">{evidence.counts.contradict}</strong>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <span className="block text-[10px] uppercase font-bold text-slate-600">Unclear</span>
                <strong className="block text-xl font-black text-slate-700">{evidence.counts.unclear}</strong>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[11px] text-slate-500">
            {typeof evidence.source_diversity?.independentSourcesCount === 'number' && (
              <span>Independent sources: <strong>{evidence.source_diversity.independentSourcesCount}</strong></span>
            )}
            {typeof evidence.retrieval?.duration_ms === 'number' && (
              <span>Search time: <strong>{(evidence.retrieval.duration_ms / 1000).toFixed(1)}s</strong></span>
            )}
            {evidence.evidence_outcome?.status && (
              <span>Retrieval: <strong>{evidence.evidence_outcome.status.replace(/_/g, ' ')}</strong></span>
            )}
          </div>

          {sources.length > 0 && (
            <div className="mt-4 space-y-3">
              <h5 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Retrieved sources (up to 4)</h5>
              {sources.map((source, i) => {
                const url = safeHttpUrl(source.source_final_url || source.source_url);
                return (
                  <article key={source.evidence_id || `${source.source_url || source.source_title || 'evidence'}-${i}`} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-bold text-slate-800">{source.source_title || source.retrieved_source || source.source_domain || 'Retrieved source'}</p>
                        <p className="text-[11px] text-slate-500 mt-1">{source.source_domain || source.retrieved_source || 'Unknown domain'}</p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {source.stance && <span className="px-2 py-0.5 rounded border border-slate-200 bg-slate-50 text-[10px] font-bold">{source.stance}</span>}
                        {source.provenance_verified === true
                          ? <span className="px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 text-[10px] font-bold">PROVENANCE VERIFIED</span>
                          : <span className="px-2 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-800 text-[10px] font-bold">PROVENANCE UNVERIFIED</span>}
                        {source.source_fetch_status && <span className="px-2 py-0.5 rounded border border-slate-200 text-[10px]">PAGE {source.source_fetch_status.replace(/_/g, ' ')}</span>}
                      </div>
                    </div>
                    {source.evidence_excerpt && <p className="text-xs text-slate-600 mt-2 leading-relaxed">{source.evidence_excerpt}</p>}
                    {url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-2 text-xs font-bold text-blue-700 hover:underline">Open source <ExternalLink className="w-3 h-3" /></a>}
                  </article>
                );
              })}
            </div>
          )}

          {(!sources.length || evidence.status === 'SEARCH_UNAVAILABLE' || evidence.status === 'INSUFFICIENT_EVIDENCE') && (
            <p className="text-[11px] text-slate-500 mt-3 leading-relaxed">
              Not enough independently usable evidence was retrieved. This is an unverified result, not proof that the claim is false or true.
            </p>
          )}

          {(evidence.limitations || []).slice(0, 3).map((limitation, i) => (
            <p key={i} className="text-[11px] text-slate-500 mt-2 leading-relaxed">{limitation}</p>
          ))}
        </div>
      )}
    </section>
  );
};

