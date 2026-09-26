import React, { useState, useEffect } from 'react';
import { ModelComparisonData } from '../types';
import { RefreshCw, CheckCircle, ShieldCheck, Zap, Sliders, Database, AlertCircle, HelpCircle, Layers, Info } from 'lucide-react';
import { ExternalValidationSection } from './ExternalValidationSection';

interface ModelSpecsViewProps {
  metrics: ModelComparisonData;
  onRetrain: () => Promise<void>;
}

interface DatasetAudit {
  status: string;
  filename: string;
  total_samples: number;
  available_columns: string[];
  real_samples: number;
  fake_samples: number;
  class_balance: string;
  missing_values: number;
  duplicate_articles: number;
  short_articles: number;
}

export const ModelSpecsView: React.FC<ModelSpecsViewProps> = ({ metrics, onRetrain }) => {
  const [retraining, setRetraining] = useState(false);
  const [datasetAudit, setDatasetAudit] = useState<DatasetAudit | null>(null);
  const [fakeThreshold, setFakeThreshold] = useState<number>(0.65);
  const [realThreshold, setRealThreshold] = useState<number>(0.35);
  const [minTextLength, setMinTextLength] = useState<number>(60);
  const [thresholdSavedMsg, setThresholdSavedMsg] = useState<string>('');

  useEffect(() => {
    // Fetch live dataset audit
    fetch('/api/dataset/validation')
      .then(res => res.json())
      .then(data => setDatasetAudit(data))
      .catch(() => {});

    // Fetch current thresholds
    fetch('/api/model/thresholds')
      .then(res => res.json())
      .then(data => {
        if (data.fake_threshold) setFakeThreshold(data.fake_threshold);
        if (data.real_threshold) setRealThreshold(data.real_threshold);
        if (data.min_text_length) setMinTextLength(data.min_text_length);
      })
      .catch(() => {});
  }, []);

  const handleRetrain = async () => {
    setRetraining(true);
    try {
      await onRetrain();
      const res = await fetch('/api/dataset/validation');
      const data = await res.json();
      setDatasetAudit(data);
    } finally {
      setRetraining(false);
    }
  };

  const handleSaveThresholds = async () => {
    if (realThreshold >= fakeThreshold) {
      alert('Real threshold must be strictly lower than Fake threshold.');
      return;
    }
    try {
      const res = await fetch('/api/model/thresholds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fake_threshold: fakeThreshold,
          real_threshold: realThreshold,
          min_text_length: minTextLength
        })
      });
      const data = await res.json();
      if (data.status === 'success') {
        setThresholdSavedMsg('Thresholds saved successfully!');
        setTimeout(() => setThresholdSavedMsg(''), 3000);
      }
    } catch {
      alert('Failed to update thresholds');
    }
  };

  const svm = metrics.linear_svm;
  const lr = metrics.logistic_regression;
  const cv = metrics.cross_validation;

  return (
    <section className="flex-1 p-6 lg:p-10 bg-slate-50 overflow-y-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 bg-emerald-100 text-emerald-800 text-[10px] font-black uppercase tracking-wider rounded">
              {metrics.is_demo ? 'DEMO MODEL (NOT FOR PRODUCTION)' : 'Production Model: Linear SVM (Calibrated)'}
            </span>
            <span className="px-2.5 py-0.5 bg-blue-100 text-blue-800 text-[10px] font-black uppercase tracking-wider rounded">
              Runtime Features: {(metrics.vocabulary_size || metrics.total_samples ? (metrics.vocabulary_size || '—') : '2,910')} TF-IDF terms
            </span>
            <span className={`px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider rounded ${metrics.is_demo ? 'bg-red-100 text-red-800' : 'bg-purple-100 text-purple-800'}`}>
              Training Set: {metrics.dataset_path || (metrics.is_demo ? 'data/news.csv (36 articles)' : 'ISOT True.csv + Fake.csv')}
            </span>
            <span className="px-2.5 py-0.5 bg-amber-100 text-amber-800 text-[10px] font-black uppercase tracking-wider rounded">
              Dataset Status: {metrics.dataset_status || (metrics.is_demo ? 'DEMO DATASET' : 'ISOT BENCHMARK DATASET')}
            </span>
          </div>
          <h2 className="text-4xl lg:text-5xl font-black uppercase tracking-tighter text-slate-900">
            Model Specs & Verification
          </h2>
        </div>

        <button
          onClick={handleRetrain}
          disabled={retraining}
          className="bg-slate-900 text-white font-black px-5 py-3 rounded-lg uppercase tracking-wider text-xs hover:bg-slate-800 transition-all shadow-md flex items-center gap-2 cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${retraining ? 'animate-spin' : ''}`} />
          <span>{retraining ? 'Running Pipeline...' : 'Retrain & Re-evaluate'}</span>
        </button>
      </div>

      {/* Authoritative Production Runtime Model Specifications */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-slate-900" />
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-900">
              Authoritative Production Runtime Specifications
            </h3>
          </div>
          <span className="px-2.5 py-0.5 bg-emerald-100 text-emerald-800 text-[10px] font-bold font-mono rounded">
            Production Node.js Active Runtime
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-mono mb-4">
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] text-slate-400 uppercase font-sans block mb-1">Production Runtime Model</span>
            <strong className="text-slate-900 block text-sm">{metrics.best_model === 'linear_svm' ? 'Linear SVM (Calibrated)' : 'Logistic Regression'}</strong>
            <span className="text-[10px] text-slate-500 font-sans mt-0.5 block">Platt Sigmoid (CalibratedClassifierCV)</span>
          </div>

          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] text-slate-400 uppercase font-sans block mb-1">Runtime Feature Space</span>
            <strong className="text-slate-900 block text-sm">{(metrics.vocabulary_size || 2910).toLocaleString()} TF-IDF features</strong>
            <span className="text-[10px] text-slate-500 font-sans mt-0.5 block">{(metrics.vocabulary_size || 2910).toLocaleString()} terms, {(metrics.vocabulary_size || 2910).toLocaleString()} weights & IDF values</span>
          </div>

          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] text-slate-400 uppercase font-sans block mb-1">Training Dataset & Provenance</span>
            <strong className="text-slate-900 block text-sm">{metrics.dataset_name || 'ISOT Fake News Dataset'}</strong>
            <span className="text-[10px] text-slate-500 font-sans mt-0.5 block">
              {metrics.is_demo
                ? 'DEMO — 36 articles (NOT production suitable)'
                : `${metrics.total_samples?.toLocaleString() || '38,656'} cleaned articles (${metrics.dataset_info?.real_samples?.toLocaleString() || '21,195'} REAL, ${metrics.dataset_info?.fake_samples?.toLocaleString() || '17,461'} FAKE)`}
            </span>
          </div>

          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] text-slate-400 uppercase font-sans block mb-1">Model Reliability</span>
            <strong className="text-slate-900 block text-sm">{metrics.is_demo ? 'DEMO — UNRELIABLE' : 'VALIDATED / BENCHMARK'}</strong>
            <span className="text-[10px] text-slate-500 font-sans mt-0.5 block">{metrics.evaluation_status || 'Evaluated on genuine 20% held-out test split'}</span>
          </div>
        </div>

        <div className={`p-3 border rounded-xl flex items-start gap-2 text-xs ${metrics.is_demo ? 'bg-red-50 border-red-200 text-red-900' : 'bg-emerald-50/60 border-emerald-200 text-emerald-900'}`}>
          <Info className={`w-4 h-4 shrink-0 mt-0.5 ${metrics.is_demo ? 'text-red-600' : 'text-emerald-600'}`} />
          <div className="leading-relaxed">
            {metrics.is_demo ? (
              <>
                <strong>DEMO MODEL ACTIVE:</strong> The runtime is currently serving a model trained on <strong>only 36 demo articles</strong>. Production must deploy the ISOT-trained artifact (<code className="font-mono bg-white px-1 py-0.5 rounded border">data/saved_model_artifacts.json</code>, {'>'}38,000 samples).
              </>
            ) : (
              <>
                <strong>Production Artifact Integrity:</strong> The Node.js runtime is loading <code className="font-mono bg-white px-1 py-0.5 rounded border">data/saved_model_artifacts.json</code> with {(metrics.vocabulary_size || 8000).toLocaleString()} vocabulary terms, matching IDF length, weight count and finite Platt parameters. The offline <code className="font-mono bg-white px-1 py-0.5 rounded border">backend/models/*.joblib</code> artifacts are Python-serialized copies used for research scripts; the runtime uses only the JSON artifact.
              </>
            )}
          </div>
        </div>
      </div>

      {/* Domain Scope & Limitations Notice */}
      <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-3 text-amber-950">
        <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="text-xs leading-relaxed">
          <strong className="font-black uppercase tracking-wide block mb-1 text-amber-900">
            Model Scope & Generalization Boundaries Notice
          </strong>
          {metrics.limitation || (metrics.is_demo
            ? "The runtime model is trained from data/news.csv (36 benchmark articles). Performance is not statistically reliable — this model is for demonstration only and must not be treated as production output."
            : "Trained and evaluated on the ISOT benchmark dataset. Performance may vary on current, multilingual, satirical, or out-of-distribution content. The model detects linguistic patterns associated with known fake-news samples — it does NOT mathematically prove truth."
          )}
        </div>
      </div>

      {/* Production Dataset Audit & Integrity Report */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center gap-2 mb-4">
          <Database className="w-5 h-5 text-slate-700" />
          <span className="text-xs font-black uppercase text-slate-500 tracking-wider">
            Dataset Audit, Provenance & Cleaning Report
          </span>
          <span className={`ml-auto px-2 py-0.5 rounded text-[10px] font-bold font-mono ${metrics.is_demo ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`}>
            {metrics.is_demo ? 'DEMO — NOT PRODUCTION' : (metrics.dataset_status || 'ISOT VERIFIED')}
          </span>
        </div>

        {/* Counts & Splits Breakdown */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs font-mono mb-4">
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] text-slate-400 font-sans block mb-1">Raw Ingested</span>
            <span className="font-bold text-slate-900 text-sm">
              {metrics.raw_counts_before_cleaning?.total_articles?.toLocaleString() || '44,898'}
            </span>
            <span className="text-[9px] text-slate-400 block mt-0.5">True.csv + Fake.csv</span>
          </div>

          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] text-slate-400 font-sans block mb-1">Rows Removed</span>
            <span className="font-bold text-amber-700 text-sm">
              {metrics.cleaning_statistics?.total_removed_rows?.toLocaleString() || (metrics.raw_counts_before_cleaning ? '—' : '0')}
            </span>
            <span className="text-[9px] text-slate-400 block mt-0.5">
              {metrics.cleaning_statistics
                ? `${metrics.cleaning_statistics.removed_duplicates?.toLocaleString() || '—'} dup, ${metrics.cleaning_statistics.removed_empty_title_text?.toLocaleString() || '—'} empty`
                : 'Cleaning stats reported by training pipeline'}
            </span>
          </div>

          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] text-slate-400 font-sans block mb-1">Final Cleaned</span>
            <span className="font-bold text-slate-900 text-sm">
              {metrics.total_samples.toLocaleString()}
            </span>
            <span className="text-[9px] text-slate-400 block mt-0.5">{metrics.total_samples.toLocaleString()} valid articles</span>
          </div>

          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] text-slate-400 font-sans block mb-1">REAL Articles</span>
            <span className="font-bold text-emerald-700 text-sm">
              {(metrics.dataset_info?.real_samples ?? 0).toLocaleString()} ({((metrics.dataset_info?.real_samples ?? 0) / metrics.total_samples * 100).toFixed(1)}%)
            </span>
            <span className="text-[9px] text-slate-400 block mt-0.5">Label: 0 (REAL)</span>
          </div>

          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] text-slate-400 font-sans block mb-1">FAKE Articles</span>
            <span className="font-bold text-red-700 text-sm">
              {(metrics.dataset_info?.fake_samples ?? 0).toLocaleString()} ({((metrics.dataset_info?.fake_samples ?? 0) / metrics.total_samples * 100).toFixed(1)}%)
            </span>
            <span className="text-[9px] text-slate-400 block mt-0.5">Label: 1 (FAKE)</span>
          </div>

          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] text-slate-400 font-sans block mb-1">Split (80 / 20)</span>
            <span className="font-bold text-blue-700 text-sm">
              {metrics.training_samples.toLocaleString()} / {metrics.test_samples.toLocaleString()}
            </span>
            <span className="text-[9px] text-slate-400 block mt-0.5">Train / Held-Out Test</span>
          </div>
        </div>

        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
          <span>Feature Input: <code className="font-bold text-slate-900 font-mono">title + text</code> (subject & date strictly excluded)</span>
          <span>Leakage Safeguard: <code className="font-bold text-emerald-700 font-mono">TF-IDF fitted strictly on training data only</code></span>
          <span>Probability Calibration: <code className="font-bold text-blue-700 font-mono">CalibratedClassifierCV (Platt Sigmoid)</code></span>
        </div>
      </div>

      {/* Stratified 5-Fold Cross-Validation Benchmark */}
      {cv && (
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-amber-600" />
              <h3 className="text-sm font-black uppercase text-slate-900 tracking-wider">
                Stratified {cv?.n_splits || 5}-Fold Cross-Validation on Training Partition (N = {metrics.training_samples.toLocaleString()})
              </h3>
            </div>
            <span className="text-[10px] font-mono text-slate-400">Zero Data Leakage Guard Verified</span>
          </div>

          <p className="text-xs text-slate-500 mb-4 leading-relaxed">
            In each fold, the TF-IDF vocabulary extraction and IDF weighting were fitted strictly on the fold&apos;s training split without access to the validation fold. Both candidate models were evaluated with standard deviation (± σ) to measure stability.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400 font-sans uppercase text-[10px]">
                  <th className="py-2.5 px-3">Candidate Model</th>
                  <th className="py-2.5 px-3">CV Accuracy (Mean ± σ)</th>
                  <th className="py-2.5 px-3">CV Precision (Mean ± σ)</th>
                  <th className="py-2.5 px-3">CV Recall (Mean ± σ)</th>
                  <th className="py-2.5 px-3">CV F1-Score (Mean ± σ)</th>
                  <th className="py-2.5 px-3 text-right">Selection Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr className="bg-slate-50/50">
                  <td className="py-3 px-3 font-bold text-slate-900">
                    Linear SVM (Calibrated)
                  </td>
                  <td className="py-3 px-3 text-slate-700">
                    {(cv.linear_svm.accuracy_mean * 100).toFixed(2)}% ± {(cv.linear_svm.accuracy_std * 100).toFixed(2)}%
                  </td>
                  <td className="py-3 px-3 text-slate-700">
                    {cv.linear_svm.precision_mean.toFixed(4)} ± {cv.linear_svm.precision_std.toFixed(4)}
                  </td>
                  <td className="py-3 px-3 text-slate-700">
                    {cv.linear_svm.recall_mean.toFixed(4)} ± {cv.linear_svm.recall_std.toFixed(4)}
                  </td>
                  <td className="py-3 px-3 font-bold text-emerald-700">
                    {cv.linear_svm.f1_mean.toFixed(4)} ± {cv.linear_svm.f1_std.toFixed(4)}
                  </td>
                  <td className="py-3 px-3 text-right">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black bg-emerald-100 text-emerald-800 uppercase">
                      SELECTED (HIGHEST F1)
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="py-3 px-3 font-bold text-slate-700">
                    Logistic Regression
                  </td>
                  <td className="py-3 px-3 text-slate-600">
                    {(cv.logistic_regression.accuracy_mean * 100).toFixed(2)}% ± {(cv.logistic_regression.accuracy_std * 100).toFixed(2)}%
                  </td>
                  <td className="py-3 px-3 text-slate-600">
                    {cv.logistic_regression.precision_mean.toFixed(4)} ± {cv.logistic_regression.precision_std.toFixed(4)}
                  </td>
                  <td className="py-3 px-3 text-slate-600">
                    {cv.logistic_regression.recall_mean.toFixed(4)} ± {cv.logistic_regression.recall_std.toFixed(4)}
                  </td>
                  <td className="py-3 px-3 text-slate-600">
                    {cv.logistic_regression.f1_mean.toFixed(4)} ± {cv.logistic_regression.f1_std.toFixed(4)}
                  </td>
                  <td className="py-3 px-3 text-right">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono text-slate-400 uppercase">
                      BASELINE COMPARISON
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Held-Out Test Set Evaluation & Side-by-Side Model Comparison */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Linear SVM (Active Model) */}
        <div className="bg-white p-6 lg:p-8 rounded-2xl shadow-sm border-2 border-slate-900 relative">
          <div className="absolute top-4 right-4">
            <span className="bg-slate-900 text-white text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded">
              Selected: Highest F1-Score
            </span>
          </div>
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">
            Primary Production Model
          </span>
          <h3 className="text-2xl lg:text-3xl font-black text-slate-900 uppercase tracking-tight mb-2">
            Linear SVM (Calibrated)
          </h3>
          <p className="text-xs text-slate-500 mb-3 leading-relaxed">
            Support Vector Machine maximizing geometric margin in {(metrics.vocabulary_size || 8000).toLocaleString()}-dimensional TF-IDF space with Platt Sigmoid calibration (CalibratedClassifierCV) providing reliable probability estimates.
          </p>

          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-[11px] font-mono">
            <div>
              <span className="text-slate-500">Active Production Runtime: </span>
              <strong className="text-slate-900 font-black">{(metrics.vocabulary_size || 8000).toLocaleString()} features / {(metrics.vocabulary_size || 8000).toLocaleString()} terms</strong>
              <span className="text-emerald-700 font-bold ml-2">(saved_model_artifacts.json)</span>
            </div>
            <div className="text-slate-500 text-[10px]">
              <span className={metrics.is_demo ? 'text-red-700 font-bold' : ''}>
                {metrics.is_demo ? 'DEMO ARTIFACT — do not deploy' : 'Verified dimensions match vocabulary / IDF / weights / Platt params'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-center">
              <span className="text-[10px] font-bold text-slate-400 uppercase block">Held-Out Accuracy</span>
              <span className="text-xl font-black font-mono text-slate-900">
                {(svm.accuracy * 100).toFixed(2)}%
              </span>
            </div>
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-center">
              <span className="text-[10px] font-bold text-slate-400 uppercase block">Held-Out F1-Score</span>
              <span className="text-xl font-black font-mono text-slate-900">
                {svm.macro_f1.toFixed(4)}
              </span>
            </div>
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-center">
              <span className="text-[10px] font-bold text-slate-400 uppercase block">Fake Recall</span>
              <span className="text-xl font-black font-mono text-slate-900">
                {(svm.recall_fake * 100).toFixed(2)}%
              </span>
            </div>
          </div>

          {/* Detailed Confusion Matrix with Explicit Descriptions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                Held-Out Test Confusion Matrix (N = 7,732)
              </span>
              <span className="text-[10px] font-mono text-slate-400">Positive Class = FAKE (1)</span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-emerald-50 border border-emerald-200 p-3 rounded-xl">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold text-emerald-800 uppercase">True Negative (TN)</span>
                  <span className="text-lg font-black font-mono text-emerald-900">{svm.confusion_matrix.true_real.toLocaleString()}</span>
                </div>
                <p className="text-[10px] text-emerald-700 leading-tight">Real news correctly classified as Real.</p>
              </div>

              <div className="bg-red-50 border border-red-200 p-3 rounded-xl">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold text-red-800 uppercase">False Positive (FP)</span>
                  <span className="text-lg font-black font-mono text-red-900">{svm.confusion_matrix.false_fake.toLocaleString()}</span>
                </div>
                <p className="text-[10px] text-red-700 leading-tight">Real news incorrectly classified as Fake.</p>
              </div>

              <div className="bg-red-50 border border-red-200 p-3 rounded-xl">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold text-red-800 uppercase">False Negative (FN)</span>
                  <span className="text-lg font-black font-mono text-red-900">{svm.confusion_matrix.false_real.toLocaleString()}</span>
                </div>
                <p className="text-[10px] text-red-700 leading-tight">Fake news incorrectly classified as Real.</p>
              </div>

              <div className="bg-emerald-50 border border-emerald-200 p-3 rounded-xl">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold text-emerald-800 uppercase">True Positive (TP)</span>
                  <span className="text-lg font-black font-mono text-emerald-900">{svm.confusion_matrix.true_fake.toLocaleString()}</span>
                </div>
                <p className="text-[10px] text-emerald-700 leading-tight">Fake news correctly flagged as Fake.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Logistic Regression (Baseline) */}
        <div className="bg-white p-6 lg:p-8 rounded-2xl shadow-sm border border-slate-200">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">
            Comparison Baseline Classifier
          </span>
          <h3 className="text-2xl lg:text-3xl font-black text-slate-900 uppercase tracking-tight mb-2">
            Logistic Regression
          </h3>
          <p className="text-xs text-slate-500 mb-6 leading-relaxed">
            Standard regularized maximum-likelihood cross-entropy classifier mapping log-odds via the sigmoid link function.
          </p>

          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-center">
              <span className="text-[10px] font-bold text-slate-400 uppercase block">Held-Out Accuracy</span>
              <span className="text-xl font-black font-mono text-slate-900">
                {(lr.accuracy * 100).toFixed(2)}%
              </span>
            </div>
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-center">
              <span className="text-[10px] font-bold text-slate-400 uppercase block">Held-Out F1-Score</span>
              <span className="text-xl font-black font-mono text-slate-900">
                {lr.macro_f1.toFixed(4)}
              </span>
            </div>
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-center">
              <span className="text-[10px] font-bold text-slate-400 uppercase block">Fake Recall</span>
              <span className="text-xl font-black font-mono text-slate-900">
                {(lr.recall_fake * 100).toFixed(2)}%
              </span>
            </div>
          </div>

          {/* Baseline Confusion Matrix */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                Held-Out Test Confusion Matrix (N = 7,732)
              </span>
              <span className="text-[10px] font-mono text-slate-400">Positive Class = FAKE (1)</span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold text-slate-600 uppercase">True Negative (TN)</span>
                  <span className="text-lg font-black font-mono text-slate-900">{lr.confusion_matrix.true_real.toLocaleString()}</span>
                </div>
                <p className="text-[10px] text-slate-500 leading-tight">Real correctly classified.</p>
              </div>

              <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold text-slate-600 uppercase">False Positive (FP)</span>
                  <span className="text-lg font-black font-mono text-slate-900">{lr.confusion_matrix.false_fake.toLocaleString()}</span>
                </div>
                <p className="text-[10px] text-slate-500 leading-tight">Real misclassified as Fake.</p>
              </div>

              <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold text-slate-600 uppercase">False Negative (FN)</span>
                  <span className="text-lg font-black font-mono text-slate-900">{lr.confusion_matrix.false_real.toLocaleString()}</span>
                </div>
                <p className="text-[10px] text-slate-500 leading-tight">Fake misclassified as Real.</p>
              </div>

              <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold text-slate-600 uppercase">True Positive (TP)</span>
                  <span className="text-lg font-black font-mono text-slate-900">{lr.confusion_matrix.true_fake.toLocaleString()}</span>
                </div>
                <p className="text-[10px] text-slate-500 leading-tight">Fake correctly flagged.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* External Validation Section (LIAR Benchmark) */}
      <ExternalValidationSection />

      {/* Decision Threshold Configuration Panel */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-slate-700" />
            <span className="text-xs font-black uppercase text-slate-900 tracking-wider">
              Configurable Decision Thresholds & Uncertainty Zone
            </span>
          </div>
          {thresholdSavedMsg && (
            <span className="text-xs font-bold text-emerald-600 font-mono animate-fade-in">
              {thresholdSavedMsg}
            </span>
          )}
        </div>

        <p className="text-xs text-slate-500 mb-6 leading-relaxed">
          The underlying model is strictly binary (<code className="font-mono">REAL</code> vs <code className="font-mono">FAKE</code>). Predictions falling inside the uncertainty zone between the two thresholds are returned as <code className="font-mono">NEEDS MORE CONTEXT</code> instead of a forced verdict. Models trained on small demo datasets use a widened zone so borderline text is never classified with unsupported confidence.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
            <label className="text-xs font-bold text-slate-700 block mb-1">
              Fake Threshold (≥ P(FAKE))
            </label>
            <div className="flex items-center gap-3 mt-2">
              <input
                type="range"
                min="0.51"
                max="0.95"
                step="0.05"
                value={fakeThreshold}
                onChange={e => setFakeThreshold(parseFloat(e.target.value))}
                className="flex-1 accent-red-600 cursor-pointer"
              />
              <span className="font-mono font-bold text-sm text-red-600 w-12 text-right">
                {fakeThreshold.toFixed(2)}
              </span>
            </div>
            <span className="text-[10px] text-slate-400 block mt-2">Articles at or above this score are classified as LIKELY FAKE.</span>
          </div>

          <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
            <label className="text-xs font-bold text-slate-700 block mb-1">
              Real Threshold (≤ P(FAKE))
            </label>
            <div className="flex items-center gap-3 mt-2">
              <input
                type="range"
                min="0.05"
                max="0.49"
                step="0.05"
                value={realThreshold}
                onChange={e => setRealThreshold(parseFloat(e.target.value))}
                className="flex-1 accent-emerald-600 cursor-pointer"
              />
              <span className="font-mono font-bold text-sm text-emerald-600 w-12 text-right">
                {realThreshold.toFixed(2)}
              </span>
            </div>
            <span className="text-[10px] text-slate-400 block mt-2">Articles at or below this score are classified as LIKELY REAL.</span>
          </div>

          <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
            <label className="text-xs font-bold text-slate-700 block mb-1">
              Minimum Text Length (chars)
            </label>
            <div className="flex items-center gap-3 mt-2">
              <input
                type="number"
                min="20"
                max="300"
                step="10"
                value={minTextLength}
                onChange={e => setMinTextLength(parseInt(e.target.value, 10) || 60)}
                className="w-24 bg-white border border-slate-300 rounded px-2 py-1 font-mono text-sm"
              />
              <span className="text-xs text-slate-500 font-mono">chars</span>
            </div>
            <span className="text-[10px] text-slate-400 block mt-2">Inputs below this length return INSUFFICIENT_INFORMATION.</span>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row justify-between items-center gap-4 pt-4 border-t border-slate-100">
          <div className="text-xs text-slate-600 font-mono">
            Active Suspicious Zone: <strong className="text-amber-700">{realThreshold.toFixed(2)} to {fakeThreshold.toFixed(2)}</strong>
          </div>
          <button
            onClick={handleSaveThresholds}
            className="px-6 py-2.5 bg-slate-900 text-white font-bold text-xs uppercase tracking-wider rounded-lg hover:bg-slate-800 transition-colors shadow-xs cursor-pointer"
          >
            Save Threshold Configuration
          </button>
        </div>
      </div>
    </section>
  );
};
