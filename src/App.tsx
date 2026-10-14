import React, { useState, useEffect } from 'react';
import { Header, NavTab } from './components/Header';
import { InputSection } from './components/InputSection';
import { AnalysisView } from './components/AnalysisView';
import { HistoryView } from './components/HistoryView';
import { ModelSpecsView } from './components/ModelSpecsView';
import { AboutView } from './components/AboutView';
import { AnalysisResult, ContentSource, HistoryItem, ModelComparisonData } from './types';
import { INITIAL_METRICS_DATA } from './data/mockData';
import {
  executeNewsAnalysis,
  extractArticleApi,
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
  const [historyRetestId, setHistoryRetestId] = useState<number | null>(null);
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
    contentSource?: ContentSource;
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

  // Re-test must perform a fresh analysis, not just switch tabs with an old preview.
  // When a source URL exists, retrieve the publisher page again and analyze the fresh body.
  // Browser history stores only a short preview, so source-less entries cannot be
  // safely re-scored unless their full text was explicitly retained.
  const handleRetestHistoryItem = async (item: HistoryItem) => {
    setActiveTab('analyze');
    setErrorMessage(null);
    setAnalysisResult(null);

    const url = (item.canonical_url || item.original_url || item.source_url || '').trim();
    const storedFullText = (item.full_text || '').trim();

    if (url) {
      setHistoryRetestId(item.id);
      try {
        const article = await extractArticleApi(url, item.article_title);
        const content = (article.content || '').trim();
        if (!content) {
          throw new Error('The publisher returned no readable article text.');
        }

        const isHeadlineOnly = Boolean(article.isHeadlineOnly) || article.wordCount < 40;
        const contentSource: ContentSource = isHeadlineOnly
          ? 'HEADLINE_ONLY'
          : article.extractionStatus === 'PARTIAL'
            ? 'PARTIAL_ARTICLE_EXTRACTED'
            : 'FULL_ARTICLE_EXTRACTED';

        await handleAnalyze({
          inputType: item.input_type === 'live_news' ? 'live_news' : 'url',
          originalUrl: item.original_url || url,
          canonicalUrl: article.canonicalUrl || item.canonical_url || url,
          articleTitle: article.title || item.article_title,
          sourceName: article.sourceName || item.source_name,
          author: article.author,
          publishedAt: article.publishedAt || item.published_at,
          wordCount: article.wordCount,
          extractionStatus: article.extractionStatus,
          warnings: article.warnings,
          isHeadlineOnly,
          contentSource,
          contentOverride: content,
          sourceUrlOverride: article.url || url
        });
      } catch (err: any) {
        // Never call the model on text_snippet: it is only a truncated history preview.
        setArticleText(storedFullText || item.text_snippet || '');
        setSourceUrl(url);
        setErrorMessage(
          `Re-test could not retrieve the full article (${err?.message || 'publisher unavailable'}). ` +
          'This history entry stores only a short preview. Paste the full article text in Text mode to analyze it; the preview was not scored.'
        );
      } finally {
        setHistoryRetestId(null);
      }
      return;
    }

    if (storedFullText.length >= 200) {
      setArticleText(storedFullText);
      setSourceUrl('');
      await handleAnalyze({
        inputType: item.input_type || 'text',
        articleTitle: item.article_title,
        sourceName: item.source_name,
        publishedAt: item.published_at,
        contentOverride: storedFullText,
        sourceUrlOverride: ''
      });
      return;
    }

    setArticleText(item.text_snippet || '');
    setSourceUrl('');
    setErrorMessage(
      'This entry has no retrievable source URL and stores only a short preview. ' +
      'To re-test it accurately, paste the original full article in Text mode. ' +
      'TruthLens will not classify a truncated history preview as a full article.'
    );
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
          <AnalysisView result={analysisResult} metrics={metrics} articleText={articleText} />
        )}

        {activeTab === 'history' && (
          <HistoryView
            history={history}
            onRetest={handleRetestHistoryItem}
            retestingId={historyRetestId}
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
