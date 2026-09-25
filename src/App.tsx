import React, { useState, useEffect } from 'react';
import { Header, NavTab } from './components/Header';
import { InputSection } from './components/InputSection';
import { AnalysisView } from './components/AnalysisView';
import { HistoryView } from './components/HistoryView';
import { ModelSpecsView } from './components/ModelSpecsView';
import { AboutView } from './components/AboutView';
import { AnalysisResult, HistoryItem, ModelComparisonData } from './types';
import { INITIAL_METRICS_DATA } from './data/mockData';
import {
  executeNewsAnalysis,
  fetchHistory,
  clearAllHistoryApi,
  deleteHistoryItemApi,
  fetchModelMetrics
} from './services/analysisEngine';
import { AlertCircle } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('analyze');
  const [articleText, setArticleText] = useState<string>('');
  const [sourceUrl, setSourceUrl] = useState<string>('');
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [metrics, setMetrics] = useState<ModelComparisonData>(INITIAL_METRICS_DATA);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [systemStatus, setSystemStatus] = useState<string>('CONNECTING...');

  // Load history and metrics on startup from real backend API
  useEffect(() => {
    // Check backend health endpoint
    fetch('/api/health', { signal: AbortSignal.timeout(3000) })
      .then((res) => {
        if (res.ok) {
          setSystemStatus('ACTIVE // API CONNECTED');
        } else {
          setSystemStatus('ACTIVE // INITIALIZING');
        }
      })
      .catch(() => {
        setSystemStatus('OFFLINE // RETRYING');
      });

    // Fetch real metrics
    fetchModelMetrics().then((data) => {
      setMetrics(data);
    });

    // Fetch history from SQLite backend
    fetchHistory().then((items) => {
      setHistory(items);
    });
  }, []);

  const handleAnalyze = async (options?: {
    inputType?: 'text' | 'url' | 'live_news';
    originalUrl?: string;
    canonicalUrl?: string;
    articleTitle?: string;
    sourceName?: string;
    author?: string;
    publishedAt?: string;
    wordCount?: number;
    extractionStatus?: 'SUCCESS' | 'PARTIAL' | 'FAILED';
    warnings?: string[];
    isHeadlineOnly?: boolean;
    contentOverride?: string;
    sourceUrlOverride?: string;
  }) => {
    // Use contentOverride if provided (for Live News secure extraction pipeline to avoid React state race)
    // Otherwise fall back to current articleText state
    const effectiveText = options?.contentOverride?.trim() || articleText.trim();
    const effectiveSourceUrl = options?.sourceUrlOverride?.trim() || sourceUrl.trim();
    if (!effectiveText) return;
    setIsLoading(true);
    setErrorMessage(null);
    // Clear any stale result before starting a new analysis so the UI never
    // shows an outdated verdict while the new one is in flight.
    setAnalysisResult(null);
    try {
      const result = await executeNewsAnalysis(effectiveText, effectiveSourceUrl, options);
      setAnalysisResult(result);
      // Refresh history from backend
      const updatedHistory = await fetchHistory();
      setHistory(updatedHistory);
      setActiveTab('analyze');
    } catch (err: any) {
      console.error('Analysis error:', err);
      setErrorMessage(err.message || 'Failed to analyze article.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClear = () => {
    setArticleText('');
    setSourceUrl('');
    setErrorMessage(null);
  };

  const handleDeleteHistoryItem = async (id: number) => {
    const updated = await deleteHistoryItemApi(id);
    setHistory(updated);
  };

  const handleClearAllHistory = async () => {
    await clearAllHistoryApi();
    setHistory([]);
  };

  const handleSelectSnippetFromHistory = (snippet: string, url: string) => {
    setArticleText(snippet);
    setSourceUrl(url);
    setActiveTab('analyze');
  };

  const handleRetrainPipeline = async () => {
    try {
      const res = await fetch('/api/train', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.results) {
          setMetrics(data.results);
        }
      } else {
        const fresh = await fetchModelMetrics();
        setMetrics(fresh);
      }
    } catch (e) {
      console.warn('Retrain trigger warning:', e);
    }
  };

  return (
    <div className="flex flex-col h-screen w-full bg-slate-50 font-sans text-slate-900 overflow-hidden">
      {/* Top Header */}
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        systemStatus={systemStatus}
      />

      {errorMessage && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-2.5 flex items-center justify-between text-red-700 text-xs font-semibold">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
            <span>{errorMessage}</span>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-500 hover:text-red-700 uppercase font-black tracking-wider text-[10px] ml-4 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Container */}
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Left Side: Input Sidebar */}
        <InputSection
          text={articleText}
          onTextChange={setArticleText}
          sourceUrl={sourceUrl}
          onSourceUrlChange={setSourceUrl}
          onAnalyze={handleAnalyze}
          onClear={handleClear}
          onClearResult={() => setAnalysisResult(null)}
          isLoading={isLoading}
        />

        {/* Right Side: Tabbed Views */}
        {activeTab === 'analyze' && (
          <AnalysisView result={analysisResult} metrics={metrics} />
        )}

        {activeTab === 'history' && (
          <HistoryView
            history={history}
            onSelectSnippet={handleSelectSnippetFromHistory}
            onDeleteItem={handleDeleteHistoryItem}
            onClearAll={handleClearAllHistory}
          />
        )}

        {activeTab === 'specs' && (
          <ModelSpecsView metrics={metrics} onRetrain={handleRetrainPipeline} />
        )}

        {activeTab === 'about' && <AboutView />}
      </main>
    </div>
  );
}
