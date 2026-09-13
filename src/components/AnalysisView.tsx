import React from 'react';
import { AnalysisResult, ModelComparisonData } from '../types';
import { CheckCircle, AlertTriangle, XCircle, Info, ExternalLink, ShieldAlert, FileText, Search, HelpCircle, Layers } from 'lucide-react';
import { TruthLensVerificationSection } from './TruthLensVerificationSection';

interface AnalysisViewProps {
  result: AnalysisResult | null;
  metrics: ModelComparisonData;
}

export const AnalysisView: React.FC<AnalysisViewProps> = ({ result, metrics }) => {
  const activeModelMetrics = metrics.best_model === 'linear_svm'
    ? metrics.linear_svm
    : metrics.logistic_regression;

  if (!result) {
    return (
      <section className="flex-1 p-6 lg:p-10 bg-slate-50 overflow-y-auto flex flex-col justify-between">
        <div className="max-w-3xl mx-auto my-auto py-12 text-center">
          <div className="w-16 h-16 bg-slate-900 text-white rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-sm">
            <Info className="w-8 h-8" />
          </div>
          <h2 className="text-4xl font-black uppercase tracking-tight text-slate-900 mb-3">
            Ready for Live ML Inference
          </h2>
          <p className="text-slate-600 text-base max-w-lg mx-auto mb-8 leading-relaxed">
            Select one of the quick test samples or paste any news article into the input panel on the left, then click <strong>Analyze Article</strong> to run inference through the calibrated model.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-xl mx-auto text-left">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block mb-1">Active Model</span>
              <span className="text-sm font-bold text-slate-900">Linear SVM (Calibrated)</span>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block mb-1">Calibration</span>
              <span className="text-sm font-bold text-slate-900">Platt Sigmoid Scaling</span>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block mb-1">Decision Zone</span>
              <span className="text-sm font-bold text-slate-900">≤0.35 Real / ≥0.65 Fake</span>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Short Text Protection view
  if (result.status === 'INSUFFICIENT_INFORMATION' || result.prediction === 'INSUFFICIENT INFORMATION') {
    return (
      <section className="flex-1 p-6 lg:p-10 bg-slate-50 overflow-y-auto flex flex-col justify-between">
        <div className="max-w-2xl mx-auto my-auto py-10">
          <div className="bg-white rounded-2xl p-8 border border-amber-200 shadow-sm text-center">
            <div className="w-14 h-14 bg-amber-100 text-amber-700 rounded-2xl flex items-center justify-center mx-auto mb-5">
              <AlertTriangle className="w-7 h-7" />
            </div>
            <span className="px-3 py-1 bg-amber-100 text-amber-800 text-[11px] font-black uppercase tracking-wider rounded-full inline-block mb-3">
              Insufficient Information
            </span>
            <h2 className="text-3xl font-black text-slate-900 mb-3 tracking-tight">
              More Article Context Required
            </h2>
            <p className="text-slate-600 text-base leading-relaxed mb-6 max-w-lg mx-auto">
              {result.message || 'More article context is required for reliable ML analysis.'}
            </p>

            <div className="bg-slate-50 rounded-xl p-4 text-left border border-slate-200 mb-6 text-xs text-slate-600 space-y-2 font-mono">
              <div className="flex justify-between">
                <span>Input Length:</span>
                <span className="font-bold text-slate-900">{result.input_length || 0} characters</span>
              </div>
              <div className="flex justify-between">
                <span>Minimum Required Length:</span>
                <span className="font-bold text-slate-900">{result.min_required_length || 60} characters</span>
              </div>
              <div className="flex justify-between">
                <span>Model Decision:</span>
                <span className="font-bold text-amber-700">Classification Withheld (Safeguard)</span>
              </div>
            </div>

            <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
              Statistical natural language models require multiple sentences to evaluate vocabulary distributions, syntax markers, and attribution hedges. Single headlines or fragments are not classified to avoid arbitrary predictions.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const isFake = result.prediction.includes('FAKE');
  const isReal = result.prediction.includes('REAL');
  const isSuspicious = result.prediction === 'SUSPICIOUS';

  const verdictBadgeClass = isFake
    ? 'bg-red-100 text-red-700 border border-red-200'
    : isReal
    ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
    : 'bg-amber-100 text-amber-700 border border-amber-200';

  const verdictTextClass = isFake
    ? 'text-red-600'
    : isReal
    ? 'text-emerald-600'
    : 'text-amber-600';

  const fakePercentage = Math.round(result.fake_probability * 100);
  const realPercentage = Math.round(result.real_probability * 100);

  const trainingAccPercent = (activeModelMetrics.accuracy * 100).toFixed(1);
  const f1Value = activeModelMetrics.macro_f1.toFixed(2);

  const tFake = result.thresholds?.fake_threshold ?? 0.65;
  const tReal = result.thresholds?.real_threshold ?? 0.35;

  return (
    <section className="flex-1 p-6 lg:p-10 bg-slate-50 overflow-y-auto space-y-8">
      {/* SECTION 1: OVERALL ASSESSMENT */}
      <div className="bg-white p-6 lg:p-8 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4 pb-4 border-b border-slate-100">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
              1. Overall Assessment
            </span>
            <span className={`px-2.5 py-0.5 rounded text-[11px] font-black uppercase tracking-wider ${verdictBadgeClass}`}>
              Risk: {result.risk_level}
            </span>
            {result.input_type && (
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-700 font-mono">
                Input: {result.input_type === 'url' ? 'URL Extraction' : result.input_type === 'live_news' ? 'Live News' : 'Text'}
              </span>
            )}
            <span className="text-slate-400 text-[10px] font-mono">
              ID: {result.id} • {new Date(result.timestamp).toLocaleTimeString()}
            </span>
          </div>
          <div className="text-left md:text-right">
            <span className="text-[10px] font-mono text-slate-400">
              Model: {result.model_used}
            </span>
          </div>
        </div>

        <div className="flex flex-col md:flex-row justify-between items-start md:items-baseline gap-4">
          <div>
            <h2 className={`text-5xl sm:text-6xl lg:text-7xl font-black tracking-tight ${verdictTextClass} uppercase leading-none mb-3`}>
              {result.prediction}
            </h2>
            <p className="text-slate-600 text-sm sm:text-base max-w-2xl leading-relaxed">
              {result.summary || (isSuspicious
                ? 'The article falls into the suspicious uncertainty zone near the decision boundary. Content exhibits mixed signals.'
                : isFake
                ? 'The article exhibits language patterns statistically aligned with unverified or sensationalized reporting.'
                : 'The article exhibits language patterns consistent with documented journalistic reporting.')}
            </p>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 shrink-0 text-left md:text-right">
            <span className="text-3xl sm:text-4xl font-black text-slate-900 leading-none block">
              {result.confidence_score}%
            </span>
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block mt-1">
              Model Confidence Score
            </span>
          </div>
        </div>
      </div>

      {/* SECTION 2: MODEL SCORE / CALIBRATED PROBABILITY */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center justify-between mb-4">
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
            2. Model Score & Calibrated Probability
          </span>
          <span className="text-[11px] font-mono text-slate-500">
            Platt Sigmoid Mapping
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
          <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
            <span className="text-[10px] font-black uppercase text-slate-400 block mb-1">Fake Probability</span>
            <span className="text-2xl font-black text-red-600 font-mono">{fakePercentage}%</span>
            <span className="text-[10px] text-slate-400 block mt-1 font-mono">P(FAKE) = {result.fake_probability}</span>
          </div>
          <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
            <span className="text-[10px] font-black uppercase text-slate-400 block mb-1">Real Probability</span>
            <span className="text-2xl font-black text-emerald-600 font-mono">{realPercentage}%</span>
            <span className="text-[10px] text-slate-400 block mt-1 font-mono">P(REAL) = {result.real_probability}</span>
          </div>
          <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
            <span className="text-[10px] font-black uppercase text-slate-400 block mb-1">Threshold Zone</span>
            <span className="text-sm font-bold text-slate-800 block mt-1">
              Real ≤ {tReal} | Fake ≥ {tFake}
            </span>
            <span className="text-[10px] text-slate-500 block mt-1">
              Suspicious Zone: {tReal} to {tFake}
            </span>
          </div>
        </div>

        {/* Dual Progress Bar */}
        <div className="h-4 w-full bg-slate-100 rounded-full overflow-hidden flex mb-2">
          <div
            className="h-full bg-red-500 transition-all duration-500"
            style={{ width: `${fakePercentage}%` }}
            title={`Fake: ${fakePercentage}%`}
          />
          <div
            className="h-full bg-emerald-500 transition-all duration-500"
            style={{ width: `${realPercentage}%` }}
            title={`Real: ${realPercentage}%`}
          />
        </div>
        <div className="flex justify-between text-[11px] font-bold font-mono">
          <span className="text-red-600">Likely Fake Threshold (≥ {Math.round(tFake * 100)}%)</span>
          <span className="text-amber-600 font-normal">Uncertainty Zone ({Math.round(tReal * 100)}% - {Math.round(tFake * 100)}%)</span>
          <span className="text-emerald-600">Likely Real Threshold (≤ {Math.round(tReal * 100)}%)</span>
        </div>
      </div>

      {/* SECTION 3: DETECTED CLAIM */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center gap-2 mb-3">
          <FileText className="w-4 h-4 text-slate-500" />
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
            3. Detected Claim
          </span>
        </div>
        <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
          <p className="text-base font-semibold text-slate-900 leading-relaxed">
            "{result.detected_claim || 'Specific factual claim could not be confidently identified.'}"
          </p>
          <span className="text-[10px] text-slate-400 block mt-2 font-mono">
            Note: Extracted assertion represents the primary syntactic subject-predicate statement found in the text; it is not verified fact.
          </span>
        </div>
      </div>

      {/* SECTION 4: CONTRIBUTING SIGNALS */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
            4. Contributing Signals (Model Vocabulary Attribution)
          </span>
          <span className="text-[10px] font-mono text-slate-400">
            Linear SVM Weights × TF-IDF
          </span>
        </div>
        <p className="text-xs text-amber-700 bg-amber-50 p-2.5 rounded-lg border border-amber-200 mb-4 font-medium">
          ⚠️ <strong>Disclaimer:</strong> These are model indicators based on statistical correlations in the training dataset; they are NOT proof that the article is factually false.
        </p>

        {result.feature_attributions && result.feature_attributions.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            {result.feature_attributions.map((attr, idx) => {
              const word = attr.term || attr.word;
              const isFakeSignal = attr.signal_direction === 'fake' || attr.direction === 'indicates_fake';
              return (
                <div
                  key={idx}
                  className={`p-3 rounded-xl border text-xs font-mono flex flex-col justify-between ${
                    isFakeSignal
                      ? 'bg-red-50/60 border-red-200 text-red-800'
                      : 'bg-emerald-50/60 border-emerald-200 text-emerald-800'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <span className="font-bold text-sm">"{word}"</span>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-white shadow-xs">
                      {isFakeSignal ? '+FAKE' : '+REAL'}
                    </span>
                  </div>
                  <span className="text-[10px] opacity-75 mt-2">
                    {attr.signal_label || (isFakeSignal ? 'Signal toward FAKE' : 'Signal toward REAL')}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-slate-500 font-mono mb-4">No dominant single tokens identified above baseline.</p>
        )}

        {/* Structural indicators */}
        <div className="border-t border-slate-100 pt-3">
          <span className="text-[10px] font-bold uppercase text-slate-400 block mb-2 tracking-wider">
            Heuristic & Stylistic Observations
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
              <span className="text-[10px] text-slate-400 font-mono block mb-1">Sensational Terms</span>
              <span className="font-bold text-slate-800">{result.linguistic_signals?.sensational_count ?? 0} detected</span>
            </div>
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
              <span className="text-[10px] text-slate-400 font-mono block mb-1">ALL-CAPS Words</span>
              <span className="font-bold text-slate-800">{result.linguistic_signals?.all_caps_words_count ?? 0} words</span>
            </div>
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
              <span className="text-[10px] text-slate-400 font-mono block mb-1">Punctuation Clustering</span>
              <span className="font-bold text-slate-800">
                {result.linguistic_signals?.excessive_punctuation ? 'Exaggerated (!/?)' : 'Standard'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 5: SOURCE INFORMATION & ACQUISITION PROVENANCE */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ExternalLink className="w-4 h-4 text-slate-500" />
            <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
              5. Source Information & Provenance (Phase 3 Acquisition)
            </span>
          </div>
          {result.extraction_status && (
            <span className={`text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded ${
              result.extraction_status === 'SUCCESS'
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-amber-100 text-amber-800'
            }`}>
              Extraction: {result.extraction_status}
            </span>
          )}
        </div>

        {/* Detailed provenance if from URL or Live News */}
        {(result.article_title || result.canonical_url || result.source_name || result.published_at) && (
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 mb-4 space-y-2 text-xs">
            {result.article_title && (
              <div>
                <span className="text-[10px] font-bold uppercase text-slate-400 block font-mono">Article Title:</span>
                <span className="font-bold text-slate-900 text-sm leading-snug">{result.article_title}</span>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
              {result.source_name && (
                <div>
                  <span className="text-[10px] font-bold uppercase text-slate-400 block font-mono">Publisher / Wire:</span>
                  <span className="font-semibold text-slate-800">{result.source_name}</span>
                </div>
              )}
              {result.published_at && (
                <div>
                  <span className="text-[10px] font-bold uppercase text-slate-400 block font-mono">Published Date:</span>
                  <span className="text-slate-700">{new Date(result.published_at).toLocaleString()}</span>
                </div>
              )}
              {result.word_count && (
                <div>
                  <span className="text-[10px] font-bold uppercase text-slate-400 block font-mono">Article Length:</span>
                  <span className="text-slate-700">{result.word_count} words extracted</span>
                </div>
              )}
            </div>
            {result.canonical_url && (
              <div className="pt-1">
                <span className="text-[10px] font-bold uppercase text-slate-400 block font-mono">Canonical Link:</span>
                <a
                  href={result.canonical_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-600 hover:text-slate-900 underline truncate block font-mono text-[11px]"
                >
                  {result.canonical_url}
                </a>
              </div>
            )}
            {result.extraction_warnings && result.extraction_warnings.length > 0 && (
              <div className="p-2 rounded bg-amber-50 border border-amber-200 text-amber-800 text-[11px]">
                ⚠️ <strong>Extraction Warning:</strong> {result.extraction_warnings.join(' ')}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
          <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] font-bold uppercase text-slate-400 block mb-1 font-sans">
              Source Domain
            </span>
            <span className="text-sm font-bold text-slate-800 block truncate">
              {result.source_info?.domain || result.source_url || 'Not provided'}
            </span>
            <span className="text-[10px] text-slate-500 block mt-1">
              Source status: {result.source_info?.source_status || (result.source_url ? 'Captured' : 'Not provided')}
            </span>
          </div>

          <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] font-bold uppercase text-slate-400 block mb-1 font-sans">
              Verification Decoupling Policy
            </span>
            <span className="text-sm font-bold text-amber-700 block">
              Classification Independent of Domain
            </span>
            <span className="text-[10px] text-slate-500 block mt-1 font-sans">
              Model evaluates classification solely on extracted text content. The system never automatically concludes "Trusted source = Real", nor does it penalize an article solely for an unknown domain.
            </span>
          </div>
        </div>
      </div>

      {/* SECTION 6: TRUTHLENS VERIFICATION & EVIDENCE ENGINE (PHASE 4) */}
      <TruthLensVerificationSection
        initialVerification={result.verification}
        articleTitle={result.article_title}
        articleContent={result.text_preview || result.full_text || ''}
        sourceUrl={result.canonical_url || result.source_url}
        mlRiskLevel={result.risk_level as any}
        analysisId={result.id}
      />

      {/* SECTION 7: LIMITATIONS & NOTE */}
      <div className="bg-slate-900 text-slate-300 p-6 rounded-2xl space-y-3">
        <div className="flex items-center gap-2 text-slate-400">
          <ShieldAlert className="w-4 h-4 text-amber-400" />
          <span className="text-[10px] font-black uppercase tracking-wider text-white">
            7. System Limitations & Scientific Scope (ISOT Benchmark)
          </span>
        </div>
        <p className="text-xs leading-relaxed text-slate-300">
          This prediction is generated by a machine learning model based on statistical patterns learned from training data. It does not independently verify facts, prove truth, or guarantee accuracy. Machine learning classification detects stylistic and vocabulary similarity to known samples, which differs fundamentally from factual verification.
        </p>
        <div className="p-3 bg-slate-800/80 rounded-xl border border-slate-700 text-xs text-amber-200/90 leading-relaxed">
          <strong className="text-amber-300 uppercase tracking-wide block mb-1">Dataset Generalization Boundary:</strong>
          {metrics.limitation || "The model is trained on the ISOT dataset, which primarily contains English news from an older time period. Performance may not generalize to current news, Hindi/Hinglish content, satire, or domains outside the training distribution."}
        </div>
      </div>
    </section>
  );
};
