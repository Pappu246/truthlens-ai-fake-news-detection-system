import React from 'react';
import { Shield, BrainCircuit, Terminal, Scale } from 'lucide-react';

export const AboutView: React.FC = () => {
  return (
    <section className="flex-1 p-6 lg:p-10 bg-slate-50 overflow-y-auto flex flex-col justify-between">
      <div>
        <div className="mb-8">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">
            System Architecture // Scientific Methodology
          </span>
          <h2 className="text-4xl lg:text-5xl font-black uppercase tracking-tighter text-slate-900">
            About TruthLens AI
          </h2>
          <p className="text-slate-600 max-w-2xl text-base mt-2 leading-relaxed">
            TruthLens is an explainable machine learning system designed to perform rapid probabilistic linguistic risk analysis on news articles and digital claims.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
          <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
            <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center mb-4">
              <Scale className="w-5 h-5" />
            </div>
            <h3 className="text-xl font-black uppercase tracking-tight text-slate-900 mb-2">
              Linear SVM & Margin Separation
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              Text classification utilizes a Linear Support Vector Machine (LinearSVC) mapped in high-dimensional TF-IDF feature space. SVM finds the maximum-margin hyperplane separating credible reporting patterns from manipulative clickbait vectors.
            </p>
          </div>

          <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
            <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center mb-4">
              <BrainCircuit className="w-5 h-5" />
            </div>
            <h3 className="text-xl font-black uppercase tracking-tight text-slate-900 mb-2">
              Explainable AI (XAI) Attributions
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              Rather than a black-box neural net, our pipeline extracts Sparse Linear Feature Attributions. Each term's mathematical contribution toward or against misinformation risk is calculated by multiplying its TF-IDF frequency by the model's learned coefficient.
            </p>
          </div>

          <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
            <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center mb-4">
              <Shield className="w-5 h-5" />
            </div>
            <h3 className="text-xl font-black uppercase tracking-tight text-slate-900 mb-2">
              Linguistic Indicator Lexicons
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              Real-time heuristic signal extractors scan text for sensational headlines, false certainty claims ("100% cure", "hidden truth"), excessive punctuation, and all-caps emphasis commonly utilized to exploit cognitive biases.
            </p>
          </div>

          <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
            <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center mb-4">
              <Terminal className="w-5 h-5" />
            </div>
            <h3 className="text-xl font-black uppercase tracking-tight text-slate-900 mb-2">
              Domain & Source Attribution
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              Published source URLs are checked against an indexed registry of verified news agencies and academic repositories, while penalizing known low-reputation top-level domains.
            </p>
          </div>
        </div>

        <div className="bg-slate-900 text-white p-8 rounded-2xl mb-6">
          <h4 className="text-lg font-black uppercase tracking-tight mb-2">
            Ethical AI & Probabilistic Risk Disclaimer
          </h4>
          <p className="text-xs text-slate-300 leading-relaxed">
            TruthLens is a statistical decision-support tool. It measures rhetorical patterns and stylistic markers associated with historical misinformation datasets. It is not an arbiter of factual truth. Users should always consult multiple authoritative primary sources before drawing conclusions.
          </p>
        </div>

        <div className="p-6 bg-amber-50 border border-amber-200 rounded-2xl text-amber-950 mb-6">
          <h4 className="text-sm font-black uppercase tracking-tight mb-1 text-amber-900">
            Model Scope & Generalization Boundaries (ISOT Benchmark)
          </h4>
          <p className="text-xs text-amber-900/90 leading-relaxed">
            The machine learning model is trained on the ISOT Fake News Dataset (38,656 cleaned articles), which primarily contains English news from an older time period. Performance may not generalize to current news, Hindi/Hinglish content, satire, or domains outside the training distribution.
          </p>
        </div>

        <div className="p-6 bg-slate-100 border border-slate-200 rounded-2xl text-slate-800">
          <h4 className="text-sm font-black uppercase tracking-tight mb-1 text-slate-900">
            External Validation Benchmark (LIAR Dataset)
          </h4>
          <p className="text-xs text-slate-600 leading-relaxed">
            To evaluate out-of-domain transfer, the frozen production pipeline was subjected to external validation on the <strong>LIAR benchmark (test.tsv)</strong> with zero retraining or contamination. Due to the domain shift between long-form journalistic news articles and short isolated political claim quotes, performance diverges as expected in empirical NLP, confirming the importance of domain-matched training. Full metrics and confusion matrices are available in the Model Specs section.
          </p>
        </div>
      </div>

      <div className="mt-8 pt-4 border-t border-slate-200 flex justify-between items-center text-[10px] font-bold uppercase text-slate-400 tracking-wider">
        <span>TruthLens AI // Production Build</span>
        <span>Version 3.1.0-liar-validated</span>
      </div>
    </section>
  );
};
