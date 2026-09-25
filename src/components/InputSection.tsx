import React, { useState, useEffect } from 'react';
import { DemoExample, AnalysisInputMode, ExtractedArticle, NewsArticle } from '../types';
import { DEFAULT_DEMO_EXAMPLES } from '../data/mockData';
import { extractArticleApi, fetchLiveNewsApi } from '../services/analysisEngine';
import {
  Sparkles,
  Loader2,
  FileText,
  Globe,
  Radio,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Clock,
  ShieldCheck
} from 'lucide-react';

interface InputSectionProps {
  text: string;
  onTextChange: (text: string) => void;
  sourceUrl: string;
  onSourceUrlChange: (url: string) => void;
  onAnalyze: (options?: {
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
  }) => void;
  onClear: () => void;
  onClearResult: () => void;
  isLoading: boolean;
}

export const InputSection: React.FC<InputSectionProps> = ({
  text,
  onTextChange,
  sourceUrl,
  onSourceUrlChange,
  onAnalyze,
  onClear,
  onClearResult,
  isLoading
}) => {
  const [inputMode, setInputMode] = useState<AnalysisInputMode>('text');

  // URL Mode state
  const [targetUrl, setTargetUrl] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractedData, setExtractedData] = useState<ExtractedArticle | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  // Live News Mode state
  const [newsCategory, setNewsCategory] = useState<string>('all');
  const [newsArticles, setNewsArticles] = useState<NewsArticle[]>([]);
  const [isFetchingNews, setIsFetchingNews] = useState(false);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [selectedNewsId, setSelectedNewsId] = useState<string | null>(null);
  const [isLiveExtracting, setIsLiveExtracting] = useState(false);
  const [liveExtractError, setLiveExtractError] = useState<string | null>(null);

  // Load live news when switching to live news tab
  useEffect(() => {
    if (inputMode === 'live_news' && newsArticles.length === 0 && !isFetchingNews) {
      loadNews(newsCategory);
    }
  }, [inputMode]);

  const loadNews = async (cat = newsCategory) => {
    setIsFetchingNews(true);
    setNewsError(null);
    try {
      const resp = await fetchLiveNewsApi({ category: cat, limit: 15 });
      setNewsArticles(resp.articles || []);
    } catch (err: any) {
      setNewsError(err.message || 'Failed to acquire live news feed.');
    } finally {
      setIsFetchingNews(false);
    }
  };

  const handleSelectExample = (example: DemoExample) => {
    setInputMode('text');
    onTextChange(example.text);
    onSourceUrlChange(example.source_url);
  };

  // Safe URL extraction trigger
  const handleExtractUrl = async () => {
    if (!targetUrl.trim()) return;
    setIsExtracting(true);
    setUrlError(null);
    onClearResult();
    try {
      const article = await extractArticleApi(targetUrl);
      setExtractedData(article);
      onTextChange(article.content);
      onSourceUrlChange(article.url);
    } catch (err: any) {
      setUrlError(err.message || 'Article extraction failed.');
      setExtractedData(null);
    } finally {
      setIsExtracting(false);
    }
  };

  // Direct URL Analysis
  const handleAnalyzeUrlDirectly = async () => {
    if (!targetUrl.trim()) return;
    onClearResult();
    if (extractedData && extractedData.content) {
      onAnalyze({
        inputType: 'url',
        originalUrl: extractedData.url,
        canonicalUrl: extractedData.canonicalUrl,
        articleTitle: extractedData.title,
        sourceName: extractedData.sourceName,
        author: extractedData.author,
        publishedAt: extractedData.publishedAt,
        wordCount: extractedData.wordCount,
        extractionStatus: extractedData.extractionStatus,
        warnings: extractedData.warnings,
        isHeadlineOnly: extractedData.isHeadlineOnly,
        contentOverride: extractedData.content,
        sourceUrlOverride: extractedData.url
      });
      return;
    }

    // If not extracted yet, extract first then analyze
    setIsExtracting(true);
    setUrlError(null);
    try {
      const article = await extractArticleApi(targetUrl);
      setExtractedData(article);
      onTextChange(article.content);
      onSourceUrlChange(article.url);
      onAnalyze({
        inputType: 'url',
        originalUrl: article.url,
        canonicalUrl: article.canonicalUrl,
        articleTitle: article.title,
        sourceName: article.sourceName,
        author: article.author,
        publishedAt: article.publishedAt,
        wordCount: article.wordCount,
        extractionStatus: article.extractionStatus,
        warnings: article.warnings,
        isHeadlineOnly: article.isHeadlineOnly,
        contentOverride: article.content,
        sourceUrlOverride: article.url
      });
    } catch (err: any) {
      setUrlError(err.message || 'Article extraction failed.');
    } finally {
      setIsExtracting(false);
    }
  };

  // Analyze a live news item — SECURE PIPELINE:
  // RSS article -> actual article URL -> secure extraction -> extracted content -> analysis
  // Reuses the existing SSRF-protected extraction pipeline (extractArticleApi -> /api/article/extract)
  const handleSelectAndAnalyzeNews = async (item: NewsArticle) => {
    setSelectedNewsId(item.id);
    setLiveExtractError(null);
    onClearResult();

    // If no URL is available from RSS, fall back to RSS summary with clear semantics
    if (!item.url || !item.url.trim()) {
      const fallbackContent = item.content || item.summary || item.title;
      onTextChange(fallbackContent);
      onSourceUrlChange('');
      onAnalyze({
        inputType: 'live_news',
        originalUrl: '',
        canonicalUrl: '',
        articleTitle: item.title,
        sourceName: item.sourceName,
        author: item.author,
        publishedAt: item.publishedAt,
        wordCount: fallbackContent.split(/\s+/).filter(Boolean).length,
        extractionStatus: 'FAILED',
        warnings: ['No article URL available from RSS feed. Using RSS summary.'],
        isHeadlineOnly: !item.content && !item.summary,
        contentOverride: fallbackContent,
        sourceUrlOverride: ''
      });
      return;
    }

    // Attempt secure full-article extraction via existing pipeline
    setIsLiveExtracting(true);
    try {
      const article = await extractArticleApi(item.url);
      // Success: use extracted full article content — pass override to avoid React state race
      onTextChange(article.content);
      onSourceUrlChange(article.url);
      onAnalyze({
        inputType: 'live_news',
        originalUrl: article.url,
        canonicalUrl: article.canonicalUrl || article.url,
        articleTitle: article.title || item.title,
        sourceName: article.sourceName || item.sourceName,
        author: article.author || item.author,
        publishedAt: article.publishedAt || item.publishedAt,
        wordCount: article.wordCount,
        extractionStatus: article.extractionStatus,
        warnings: article.warnings,
        isHeadlineOnly: article.isHeadlineOnly,
        contentOverride: article.content,
        sourceUrlOverride: article.url
      });
    } catch (err: any) {
      const errMsg = err?.message || 'Article extraction failed';
      // Graceful degradation: preserve fallback behavior per spec
      // Show user-facing message but still allow manual paste / fallback analysis
      setLiveExtractError('Article extraction is currently unavailable. You can paste the article text manually.');

      // Fallback: use RSS summary/content so user still has something to analyze manually
      const fallbackContent = item.content || item.summary || item.title;
      onTextChange(fallbackContent);
      onSourceUrlChange(item.url);

      // Only auto-analyze fallback if we have at least summary/content; otherwise let user paste
      // If extraction failed due to SSRF/security/timeout, we still provide RSS content as fallback
      // but mark extraction as FAILED and include warning for transparency
      if (fallbackContent && fallbackContent.trim().length >= 20) {
        onAnalyze({
          inputType: 'live_news',
          originalUrl: item.url,
          canonicalUrl: item.url,
          articleTitle: item.title,
          sourceName: item.sourceName,
          author: item.author,
          publishedAt: item.publishedAt,
          wordCount: fallbackContent.split(/\s+/).filter(Boolean).length,
          extractionStatus: 'FAILED',
          warnings: [
            `Full article extraction failed: ${errMsg}. Falling back to RSS summary. For full verification, paste the article text manually.`
          ],
          isHeadlineOnly: !item.content && !item.summary,
          contentOverride: fallbackContent,
          sourceUrlOverride: item.url
        });
      }
      // If fallback is too short, we leave it in the textarea for manual paste without auto-analyzing
      // The error banner will instruct the user
    } finally {
      setIsLiveExtracting(false);
    }
  };

  return (
    <section className="w-full md:w-[420px] lg:w-[450px] bg-white border-r border-slate-200 p-6 lg:p-7 flex flex-col shrink-0 overflow-y-auto">
      <div className="mb-4">
        <h1 className="text-3xl lg:text-4xl font-black leading-tight tracking-tighter mb-1.5 uppercase text-slate-900">
          TruthLens AI
        </h1>
        <p className="text-slate-500 text-xs leading-relaxed">
          Calibrated Linear SVM verification engine for news content, safe web URL extraction, and live RSS wire feeds.
        </p>
      </div>

      {/* Input Mode Switcher */}
      <div className="grid grid-cols-3 gap-1 bg-slate-100 p-1 rounded-xl mb-5 border border-slate-200">
        <button
          type="button"
          onClick={() => setInputMode('text')}
          className={`flex items-center justify-center gap-1.5 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all cursor-pointer ${
            inputMode === 'text'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Text</span>
        </button>
        <button
          type="button"
          onClick={() => setInputMode('url')}
          className={`flex items-center justify-center gap-1.5 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all cursor-pointer ${
            inputMode === 'url'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
          }`}
        >
          <Globe className="w-3.5 h-3.5" />
          <span>URL</span>
        </button>
        <button
          type="button"
          onClick={() => setInputMode('live_news')}
          className={`flex items-center justify-center gap-1.5 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-all cursor-pointer ${
            inputMode === 'live_news'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
          }`}
        >
          <Radio className="w-3.5 h-3.5 text-red-500 animate-pulse" />
          <span>Live News</span>
        </button>
      </div>

      {/* MODE 1: RAW TEXT INPUT */}
      {inputMode === 'text' && (
        <div className="flex flex-col gap-4 flex-1">
          {/* Preset demo quick-fill */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkles className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                Quick Test Samples
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {DEFAULT_DEMO_EXAMPLES.map((eg) => (
                <button
                  key={eg.id}
                  type="button"
                  onClick={() => handleSelectExample(eg)}
                  className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded transition-colors text-left cursor-pointer"
                >
                  {eg.expected_outcome === 'LIKELY FAKE' && <span className="text-red-600 mr-1 font-black">●</span>}
                  {eg.expected_outcome === 'LIKELY REAL' && <span className="text-emerald-600 mr-1 font-black">●</span>}
                  {(eg.expected_outcome === 'SUSPICIOUS' || eg.expected_outcome === 'NEEDS MORE CONTEXT') && <span className="text-amber-600 mr-1 font-black">●</span>}
                  {eg.category}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between items-center">
              <label htmlFor="article-text-input" className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                News Article Text
              </label>
              <span className="text-[10px] font-mono text-slate-400">
                {text.length} chars
              </span>
            </div>
            <textarea
              id="article-text-input"
              value={text}
              onChange={(e) => onTextChange(e.target.value)}
              className="w-full h-44 p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 resize-none font-sans"
              placeholder="Paste news article headline and body text here..."
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="source-url-input" className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Source URL (Optional Metadata)
            </label>
            <input
              id="source-url-input"
              type="text"
              value={sourceUrl}
              onChange={(e) => onSourceUrlChange(e.target.value)}
              className="w-full p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
              placeholder="https://example.com/news-story"
            />
          </div>

          <button
            id="analyze-news-btn"
            type="button"
            onClick={() => onAnalyze({ inputType: 'text' })}
            disabled={isLoading || !text.trim()}
            className="w-full bg-slate-900 text-white font-black py-3.5 rounded-lg uppercase tracking-widest hover:bg-slate-800 active:scale-[0.99] transition-all shadow-md mt-2 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-xs"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-white" />
                <span>Running Inference...</span>
              </>
            ) : (
              'Analyze News Text'
            )}
          </button>

          <button
            id="clear-fields-btn"
            type="button"
            onClick={onClear}
            className="w-full border border-slate-200 text-slate-500 font-bold py-2.5 rounded-lg uppercase tracking-widest text-[11px] hover:bg-slate-50 active:bg-slate-100 transition-all cursor-pointer"
          >
            Clear Fields
          </button>
        </div>
      )}

      {/* MODE 2: SAFE URL ARTICLE EXTRACTION */}
      {inputMode === 'url' && (
        <div className="flex flex-col gap-4 flex-1">
          <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-xs text-slate-600">
            <div className="flex items-center gap-1.5 font-bold text-slate-800 mb-1">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>SSRF-Protected Article Extraction</span>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Fetches live HTML, checks against internal/loopback IP blocks, strips boilerplate DOM elements, and extracts article body for ML evaluation.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="article-url-input" className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Web Article URL
            </label>
            <div className="relative">
              <input
                id="article-url-input"
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleExtractUrl(); }}
                className="w-full p-3 pl-9 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 font-mono text-xs"
                placeholder="https://www.reuters.com/world/..."
              />
              <Globe className="w-4 h-4 text-slate-400 absolute left-3 top-3.5" />
            </div>
          </div>

          {/* Quick preset URLs for testing */}
          <div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
              Sample Article URLs
            </span>
            <div className="flex flex-col gap-1 text-[11px]">
              <button
                type="button"
                onClick={() => setTargetUrl('https://apnews.com/article/nasa-webb-telescope-space-discovery')}
                className="text-left text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200/80 px-2.5 py-1.5 rounded truncate font-mono cursor-pointer"
              >
                AP News: NASA Webb discovery
              </button>
              <button
                type="button"
                onClick={() => setTargetUrl('https://www.bbc.com/news/technology-quantum-computing-advancement')}
                className="text-left text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200/80 px-2.5 py-1.5 rounded truncate font-mono cursor-pointer"
              >
                BBC News: Quantum computing
              </button>
            </div>
          </div>

          {urlError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <div className="leading-snug">
                <span className="font-bold block">Extraction Notice:</span>
                <span>{urlError}</span>
              </div>
            </div>
          )}

          {/* Extracted preview card */}
          {extractedData && (
            <div className="bg-white border border-slate-200 rounded-xl p-3.5 text-xs shadow-xs">
              <div className="flex items-center justify-between mb-2 pb-2 border-b border-slate-100">
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Article Extracted ({extractedData.wordCount} words)
                </span>
                <span className="font-mono text-[10px] text-slate-400">
                  {extractedData.sourceName || 'Web Page'}
                </span>
              </div>
              <h4 className="font-bold text-slate-900 mb-1 text-xs line-clamp-2">
                {extractedData.title}
              </h4>
              <p className="text-slate-500 text-[11px] line-clamp-3 mb-2 font-mono">
                {extractedData.content.substring(0, 180)}...
              </p>
              {extractedData.warnings && extractedData.warnings.length > 0 && (
                <div className="text-[10px] text-amber-700 bg-amber-50 p-1.5 rounded mb-2">
                  ⚠️ {extractedData.warnings.join(' ')}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 mt-2">
            <button
              type="button"
              onClick={handleExtractUrl}
              disabled={isExtracting || !targetUrl.trim()}
              className="bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold py-3 rounded-lg uppercase tracking-wider text-[11px] flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {isExtracting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Extracting...</span>
                </>
              ) : (
                'Extract Article'
              )}
            </button>
            <button
              type="button"
              onClick={handleAnalyzeUrlDirectly}
              disabled={isLoading || isExtracting || !targetUrl.trim()}
              className="bg-slate-900 hover:bg-slate-800 text-white font-black py-3 rounded-lg uppercase tracking-wider text-[11px] flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Analyzing...</span>
                </>
              ) : (
                'Analyze URL'
              )}
            </button>
          </div>
        </div>
      )}

      {/* MODE 3: LIVE NEWS FEED */}
      {inputMode === 'live_news' && (
        <div className="flex flex-col gap-3 flex-1 min-h-0">
          {/* Feed header & Category selector */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Live Wire Dispatches
            </span>
            <button
              type="button"
              onClick={() => loadNews(newsCategory)}
              disabled={isFetchingNews}
              className="text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${isFetchingNews ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>

          <div className="flex gap-1 overflow-x-auto pb-1 text-[10px] font-bold">
            {['all', 'general', 'technology', 'science', 'business', 'health'].map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => {
                  setNewsCategory(cat);
                  loadNews(cat);
                }}
                className={`px-2.5 py-1 rounded-full uppercase tracking-wider transition-colors shrink-0 cursor-pointer ${
                  newsCategory === cat
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {newsError && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 p-3 rounded-lg text-xs">
              {newsError}
            </div>
          )}

          {liveExtractError && (
            <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
              <div>
                <span className="font-bold block">Extraction Notice:</span>
                <span>{liveExtractError}</span>
              </div>
            </div>
          )}

          {isLiveExtracting && (
            <div className="bg-slate-900 text-white p-3 rounded-lg text-xs flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Extracting full article via secure pipeline...</span>
            </div>
          )}

          {isFetchingNews && newsArticles.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-12 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin mb-2" />
              <span className="text-xs font-mono">Fetching live wire feeds...</span>
            </div>
          ) : newsArticles.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-12 text-slate-400 text-center px-4">
              <Radio className="w-8 h-8 text-slate-300 mb-2" />
              <p className="font-bold text-slate-700 text-xs uppercase tracking-wider mb-1">
                No live news feeds are configured.
              </p>
              <p className="text-[11px] text-slate-500 leading-relaxed max-w-xs">
                {newsError || 'No live articles were returned for this category. Check RSS/Atom configuration or network availability.'}
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
              {newsArticles.map((article) => {
                const isSelected = selectedNewsId === article.id;
                const isThisExtracting = isSelected && isLiveExtracting;
                return (
                  <div
                    key={article.id}
                    onClick={() => !isLiveExtracting && handleSelectAndAnalyzeNews(article)}
                    className={`p-3 rounded-xl border transition-all text-left ${
                      isLiveExtracting ? 'opacity-60 pointer-events-none' : 'cursor-pointer'
                    } ${
                      isSelected
                        ? 'bg-slate-900 text-white border-slate-900 shadow-md'
                        : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[10px] mb-1 font-mono">
                      <span className={`font-bold ${isSelected ? 'text-amber-400' : 'text-slate-600'}`}>
                        {article.sourceName}
                      </span>
                      <span className={isSelected ? 'text-slate-300' : 'text-slate-400'}>
                        {article.publishedAt ? new Date(article.publishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                      </span>
                    </div>
                    <h4 className={`text-xs font-bold leading-snug line-clamp-2 ${isSelected ? 'text-white' : 'text-slate-900'}`}>
                      {article.title}
                    </h4>
                    {article.summary && (
                      <p className={`text-[11px] mt-1 line-clamp-2 ${isSelected ? 'text-slate-300' : 'text-slate-500'}`}>
                        {article.summary}
                      </p>
                    )}
                    <div className="mt-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider">
                      <span className={isSelected ? 'text-emerald-400' : 'text-slate-500'}>
                        {article.category || 'News'}
                      </span>
                      <span className={`flex items-center gap-1 ${isSelected ? 'text-amber-300' : 'text-slate-900'}`}>
                        {isThisExtracting ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>Extracting...</span>
                          </>
                        ) : (
                          <>
                            <span>Click to Analyze</span>
                            <span>→</span>
                          </>
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
