import React from 'react';
import { HistoryItem } from '../types';
import { Trash2, ExternalLink, ArrowRight } from 'lucide-react';

interface HistoryViewProps {
  history: HistoryItem[];
  onSelectSnippet: (snippet: string, url: string) => void;
  onDeleteItem: (id: number) => void;
  onClearAll: () => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  history,
  onSelectSnippet,
  onDeleteItem,
  onClearAll
}) => {
  return (
    <section className="flex-1 p-6 lg:p-10 bg-slate-50 overflow-y-auto flex flex-col justify-between">
      <div>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
          <div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">
              Audit Logs // SQLite Database
            </span>
            <h2 className="text-4xl lg:text-5xl font-black uppercase tracking-tighter text-slate-900">
              Analysis History
            </h2>
          </div>
          {history.length > 0 && (
            <button
              onClick={onClearAll}
              className="border border-slate-300 text-slate-600 hover:text-red-600 hover:border-red-300 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-2 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear History</span>
            </button>
          )}
        </div>

        {history.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center max-w-md mx-auto my-12">
            <h3 className="text-xl font-black uppercase tracking-tight text-slate-900 mb-2">
              No Analysis Records Yet
            </h3>
            <p className="text-sm text-slate-500 mb-6 leading-relaxed">
              Analyze your first news article on the Analyze tab to generate an audit log entry.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {history.map((item) => {
              const isFake = item.prediction.includes('FAKE');
              const isReal = item.prediction.includes('REAL');
              const badgeClass = isFake
                ? 'bg-red-100 text-red-600'
                : isReal
                ? 'bg-emerald-100 text-emerald-600'
                : 'bg-amber-100 text-amber-600';

              return (
                <div
                  key={item.id}
                  className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-6 hover:border-slate-300 transition-all"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                      <span className={`px-2.5 py-0.5 rounded text-[10px] font-black uppercase tracking-wider ${badgeClass}`}>
                        {item.prediction}
                      </span>
                      {item.input_type && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-700 font-mono">
                          {item.input_type === 'url' ? 'URL' : item.input_type === 'live_news' ? 'LIVE WIRE' : 'RAW TEXT'}
                        </span>
                      )}
                      <span className="text-[11px] font-mono text-slate-400 font-bold">
                        ID: #{item.id.toString().slice(-5)}
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">
                        {new Date(item.created_at).toLocaleString()}
                      </span>
                      <span className="text-[10px] font-bold text-slate-500 uppercase">
                        Model: {item.model_used}
                      </span>
                    </div>

                    {item.article_title && (
                      <h4 className="text-sm font-bold text-slate-900 mb-1 leading-snug">
                        {item.article_title}
                      </h4>
                    )}

                    <p className="text-slate-800 text-sm font-medium leading-snug line-clamp-2">
                      "{item.text_snippet}"
                    </p>

                    {item.detected_claim && (
                      <p className="text-xs text-slate-500 mt-1 font-mono">
                        <span className="font-bold text-slate-700">Claim:</span> {item.detected_claim}
                      </p>
                    )}

                    {item.source_url && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-400 font-mono">
                        <ExternalLink className="w-3 h-3 text-slate-400" />
                        <span className="truncate max-w-sm">{item.source_url}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-6 shrink-0 w-full md:w-auto justify-between md:justify-end">
                    <div className="text-right">
                      <span className={`text-2xl font-black font-mono ${
                        item.confidence_score === null || item.confidence_score === undefined
                          ? 'text-slate-400'
                          : 'text-slate-900'
                      }`}>
                        {item.confidence_score === null || item.confidence_score === undefined
                          ? 'N/A'
                          : `${item.confidence_score}%`}
                      </span>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                        Confidence
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onSelectSnippet(item.text_snippet, item.source_url)}
                        className="bg-slate-900 text-white font-bold px-3 py-2 rounded-lg text-xs uppercase tracking-wider hover:bg-slate-800 transition-colors flex items-center gap-1 cursor-pointer"
                        title="Re-analyze or view"
                      >
                        <span>Re-test</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDeleteItem(item.id)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                        title="Delete log"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-12 pt-6 border-t border-slate-200 flex justify-between items-center text-[10px] font-bold uppercase text-slate-400 tracking-wider">
        <span>Total Logged Records: {history.length}</span>
        <span>Storage: Local Persistent Registry</span>
      </div>
    </section>
  );
};
