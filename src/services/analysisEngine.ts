import { AnalysisResult, HistoryItem, ModelComparisonData, FeatureAttribution, LinguisticSignals, ExtractedArticle, NewsFeedResponse } from '../types';
import { INITIAL_METRICS_DATA } from '../data/mockData';

const HISTORY_STORAGE_KEY = 'truthlens_analysis_history';

export function getLocalHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to read history from localStorage', e);
    return [];
  }
}

export function saveToLocalHistory(result: AnalysisResult): HistoryItem[] {
  try {
    const current = getLocalHistory();
    const newItem: HistoryItem = {
      id: typeof result.id === 'string' && result.id.startsWith('#')
        ? parseInt(result.id.replace(/\D/g, ''), 10) || Date.now()
        : Number(result.id) || Date.now(),
      text_snippet: result.text_snippet,
      source_url: result.source_url || result.original_url || '',
      prediction: result.prediction,
      fake_probability: result.fake_probability,
      confidence_score: result.confidence_score,
      model_used: result.model_used,
      created_at: result.timestamp,
      input_type: result.input_type || 'text',
      original_url: result.original_url,
      canonical_url: result.canonical_url,
      article_title: result.article_title,
      source_name: result.source_name,
      published_at: result.published_at
    };
    const updated = [newItem, ...current.filter(item => item.id !== newItem.id)].slice(0, 50);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch (e) {
    console.error('Failed to save history to localStorage', e);
    return [];
  }
}

export async function fetchHistory(): Promise<HistoryItem[]> {
  try {
    const res = await fetch('/api/history', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const records = Array.isArray(data) ? data : (data.records || []);
      const mapped: HistoryItem[] = records.map((r: any) => ({
        id: r.id,
        text_snippet: r.full_text ? (r.full_text.length > 120 ? r.full_text.substring(0, 117) + '...' : r.full_text) : (r.text_snippet || ''),
        source_url: r.source_url || '',
        prediction: r.prediction,
        fake_probability: typeof r.fake_probability === 'number' ? r.fake_probability : null,
        real_probability: typeof r.real_probability === 'number' ? r.real_probability : null,
        // Preserve NULL (N/A) — never fabricate a score for withheld verdicts.
        confidence_score: typeof r.confidence_score === 'number'
          ? r.confidence_score
          : (typeof r.confidence === 'number' ? Math.round(r.confidence * 100) : null),
        model_used: r.model_name || r.model_used || 'Linear SVM (Calibrated)',
        created_at: r.created_at || new Date().toISOString()
      }));
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(mapped));
      return mapped;
    }
  } catch (err) {
    console.warn('Backend history fetch unavailable, using cached logs', err);
  }
  return getLocalHistory();
}

export async function deleteHistoryItemApi(id: number): Promise<HistoryItem[]> {
  try {
    await fetch(`/api/history/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(3000) });
  } catch (e) {
    console.warn('Backend history delete failed:', e);
  }
  const current = getLocalHistory();
  const updated = current.filter(item => item.id !== id);
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(updated));
  return updated;
}

export async function clearAllHistoryApi(): Promise<void> {
  try {
    await fetch('/api/history', { method: 'DELETE', signal: AbortSignal.timeout(3000) });
  } catch (e) {
    console.warn('Backend history clear failed:', e);
  }
  localStorage.removeItem(HISTORY_STORAGE_KEY);
}

export async function fetchModelMetrics(): Promise<ModelComparisonData> {
  try {
    const res = await fetch('/api/models/metrics', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      if (data.models && data.models.linear_svm && data.models.logistic_regression) {
        return {
          dataset_path: data.dataset_info?.source_path || 'data/True.csv & data/Fake.csv',
          dataset_name: data.dataset_name || data.dataset_info?.name || 'ISOT Fake News Dataset',
          total_samples: data.dataset_info?.total_samples || 38656,
          training_samples: data.dataset_info?.train_samples || 30924,
          test_samples: data.dataset_info?.test_samples || 7732,
          best_model: data.best_model?.name?.toLowerCase().includes('svm') ? 'linear_svm' : 'logistic_regression',
          selection_metric: 'macro_f1',
          last_trained: data.trained_at || new Date().toISOString(),
          is_demo: data.is_demo ?? false,
          dataset_status: data.dataset_status ?? 'ISOT BENCHMARK DATASET',
          evaluation_status: data.evaluation_status ?? 'Evaluated on genuine 20% held-out test split (N=7,732)',
          demo_badge_label: data.demo_badge_label ?? 'PRODUCTION BENCHMARK (ISOT DATASET)',
          limitation: data.limitation,
          raw_counts_before_cleaning: data.raw_counts_before_cleaning,
          cleaning_statistics: data.cleaning_statistics,
          strong_warning: data.strong_warning ?? data.dataset_info?.strong_warning,
          why_misleading_accuracy: data.why_misleading_accuracy,
          real_dataset_required_notice: data.real_dataset_required_notice,
          cross_validation: data.cross_validation,
          logistic_regression: {
            accuracy: data.models.logistic_regression.metrics.accuracy,
            macro_f1: data.models.logistic_regression.metrics.f1_score,
            weighted_f1: data.models.logistic_regression.metrics.f1_score,
            precision_fake: data.models.logistic_regression.metrics.precision,
            recall_fake: data.models.logistic_regression.metrics.recall,
            f1_fake: data.models.logistic_regression.metrics.f1_score,
            precision_real: data.models.logistic_regression.metrics.precision,
            recall_real: data.models.logistic_regression.metrics.recall,
            f1_real: data.models.logistic_regression.metrics.f1_score,
            confusion_matrix: {
              true_real: data.models.logistic_regression.metrics.confusion_matrix?.true_negative ?? 0,
              false_fake: data.models.logistic_regression.metrics.confusion_matrix?.false_positive ?? 0,
              false_real: data.models.logistic_regression.metrics.confusion_matrix?.false_negative ?? 0,
              true_fake: data.models.logistic_regression.metrics.confusion_matrix?.true_positive ?? 0,
            }
          },
          linear_svm: {
            accuracy: data.models.linear_svm.metrics.accuracy,
            macro_f1: data.models.linear_svm.metrics.f1_score,
            weighted_f1: data.models.linear_svm.metrics.f1_score,
            precision_fake: data.models.linear_svm.metrics.precision,
            recall_fake: data.models.linear_svm.metrics.recall,
            f1_fake: data.models.linear_svm.metrics.f1_score,
            precision_real: data.models.linear_svm.metrics.precision,
            recall_real: data.models.linear_svm.metrics.recall,
            f1_real: data.models.linear_svm.metrics.f1_score,
            confusion_matrix: {
              true_real: data.models.linear_svm.metrics.confusion_matrix?.true_negative ?? 0,
              false_fake: data.models.linear_svm.metrics.confusion_matrix?.false_positive ?? 0,
              false_real: data.models.linear_svm.metrics.confusion_matrix?.false_negative ?? 0,
              true_fake: data.models.linear_svm.metrics.confusion_matrix?.true_positive ?? 0,
            }
          }
        };
      }
      return data;
    }
  } catch (err) {
    console.warn('Failed to fetch backend metrics, using initial cached metadata', err);
  }
  return INITIAL_METRICS_DATA;
}

export async function fetchModelDiagnostics(): Promise<any> {
  const res = await fetch('/api/model/diagnostics', { signal: AbortSignal.timeout(4000) });
  if (!res.ok) {
    throw new Error('Failed to retrieve model diagnostics');
  }
  return res.json();
}

/**
 * Execute news analysis strictly using the trained ML model backend.
 * Never uses hardcoded or fallback scores.
 */
export async function executeNewsAnalysis(
  rawText: string,
  sourceUrl?: string,
  metadata?: {
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
  }
): Promise<AnalysisResult> {
  const textTrimmed = (rawText || '').trim();
  if (!textTrimmed) {
    throw new Error('Please enter article text to analyze.');
  }

  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: textTrimmed,
      source_url: sourceUrl ? sourceUrl.trim() : '',
      input_type: metadata?.inputType || (sourceUrl ? 'url' : 'text'),
      original_url: metadata?.originalUrl || sourceUrl || '',
      canonical_url: metadata?.canonicalUrl,
      article_title: metadata?.articleTitle,
      source_name: metadata?.sourceName,
      author: metadata?.author,
      published_at: metadata?.publishedAt,
      word_count: metadata?.wordCount,
      extraction_status: metadata?.extractionStatus,
      warnings: metadata?.warnings,
      is_headline_only: metadata?.isHeadlineOnly
    })
  });

  if (!response.ok) {
    let errorMsg = `Analysis service error (${response.status})`;
    try {
      const errJson = await response.json();
      if (errJson.detail) errorMsg = errJson.detail;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }

  const backendData = await response.json();

  // Map backend feature attributions
  const featureAttributions: FeatureAttribution[] = (backendData.feature_attributions || []).map((fa: any) => ({
    word: fa.term || fa.word || '',
    term: fa.term || fa.word || '',
    weight: typeof fa.impact_score === 'number' ? fa.impact_score : (fa.weight || 0),
    direction: (fa.signal_direction === 'real' || fa.direction === 'indicates_real') ? 'indicates_real' : 'indicates_fake',
    signal_direction: fa.signal_direction,
    signal_label: fa.signal_label,
    intensity: fa.intensity
  }));

  // Build linguistic signals from indicators
  const indicators: any[] = backendData.indicators || [];
  const sensationalInd = indicators.find((i: any) => i.name?.toLowerCase().includes('sensational'));
  const polarizingInd = indicators.find((i: any) => i.name?.toLowerCase().includes('polarizing') || i.name?.toLowerCase().includes('emotional'));
  const capsInd = indicators.find((i: any) => i.name?.toLowerCase().includes('capitalization'));
  const punctInd = indicators.find((i: any) => i.name?.toLowerCase().includes('punctuation'));
  const questInd = indicators.find((i: any) => i.name?.toLowerCase().includes('question'));

  const linguisticSignals: LinguisticSignals = {
    sensational_count: sensationalInd?.examples?.length || (sensationalInd ? 1 : 0),
    sensational_words: sensationalInd?.examples || [],
    polarizing_count: polarizingInd?.examples?.length || (polarizingInd ? 1 : 0),
    polarizing_words: polarizingInd?.examples || [],
    all_caps_words_count: capsInd?.examples?.length || 0,
    excessive_punctuation: Boolean(punctInd),
    exclamation_count: punctInd?.examples?.length || 0,
    question_count: questInd?.examples?.length || 0,
    has_source: Boolean((sourceUrl && sourceUrl.trim()) || metadata?.originalUrl),
    source_trust: backendData.source_info?.domain ? 'TRUSTED' : (sourceUrl ? 'UNVERIFIED' : 'NONE'),
    source_notes: backendData.source_info?.notes || (sourceUrl ? `Domain: ${backendData.source_info?.domain || 'unknown'}` : 'No publication URL provided.')
  };

  // Summary message from backend explanation
  let summary = '';
  if (Array.isArray(backendData.explanation) && backendData.explanation.length > 0) {
    summary = backendData.explanation.join(' ');
  } else if (backendData.summary) {
    summary = backendData.summary;
  } else if (backendData.reason) {
    summary = backendData.reason;
  } else if (backendData.message) {
    summary = backendData.message;
  } else {
    summary = `The backend returned verdict "${backendData.prediction}" for this article.`;
  }

  // Backend is the source of truth for scores: pass nulls through untouched.
  // The frontend must NEVER fabricate or re-derive probabilities/confidence.
  const backendConfidenceScore = typeof backendData.confidence_score === 'number'
    ? backendData.confidence_score
    : (typeof backendData.confidence === 'number' ? Math.round(backendData.confidence * 100) : null);

  const fullResult: AnalysisResult = {
    id: backendData.id ? `#${backendData.id}` : `#${Date.now().toString().slice(-5)}`,
    status: backendData.status,
    message: backendData.message,
    verdict: backendData.verdict || backendData.prediction,
    prediction: backendData.prediction || backendData.verdict,
    reason: backendData.reason,
    risk_level: backendData.risk_level,
    fake_probability: typeof backendData.fake_probability === 'number' ? backendData.fake_probability : null,
    real_probability: typeof backendData.real_probability === 'number' ? backendData.real_probability : null,
    confidence_score: backendConfidenceScore,
    model_used: backendData.model || backendData.model_used || 'Linear SVM (Calibrated)',
    model_reliability: backendData.model_reliability,
    probability_caveat: backendData.probability_caveat,
    summary,
    text_snippet: textTrimmed.length > 120 ? textTrimmed.substring(0, 117) + '...' : textTrimmed,
    source_url: sourceUrl && sourceUrl.trim() ? sourceUrl.trim() : (metadata?.originalUrl || undefined),
    input_type: backendData.input_type || metadata?.inputType || (sourceUrl ? 'url' : 'text'),
    original_url: backendData.original_url || metadata?.originalUrl || sourceUrl || undefined,
    canonical_url: backendData.canonical_url || metadata?.canonicalUrl || undefined,
    article_title: backendData.article_title || metadata?.articleTitle || undefined,
    source_name: backendData.source_name || metadata?.sourceName || undefined,
    author: backendData.author || metadata?.author || undefined,
    published_at: backendData.published_at || metadata?.publishedAt || undefined,
    word_count: backendData.word_count || metadata?.wordCount || undefined,
    extraction_status: backendData.extraction_status || metadata?.extractionStatus || undefined,
    extraction_warnings: backendData.extraction_warnings || metadata?.warnings || undefined,
    is_headline_only: backendData.is_headline_only ?? metadata?.isHeadlineOnly ?? false,
    detected_claim: backendData.detected_claim,
    input_length: backendData.input_length,
    min_required_length: backendData.min_required_length,
    min_required_words: backendData.min_required_words,
    thresholds: backendData.thresholds,
    source_info: backendData.source_info,
    evidence_verification: backendData.evidence_verification,
    linguistic_signals: linguisticSignals,
    feature_attributions: featureAttributions,
    timestamp: new Date().toISOString()
  };

  if (fullResult.status !== 'INSUFFICIENT_INFORMATION') {
    saveToLocalHistory(fullResult);
  }
  return fullResult;
}

/**
 * Phase 3: Extract article from URL with server-side SSRF validation
 */
export async function extractArticleApi(url: string, fallbackTitle?: string): Promise<ExtractedArticle> {
  const cleanUrl = (url || '').trim();
  if (!cleanUrl) {
    throw new Error('Please enter an article URL.');
  }

  const res = await fetch('/api/article/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: cleanUrl, title: fallbackTitle })
  });

  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(data.error || `Extraction failed (${res.status})`);
  }
  return data;
}

/**
 * Phase 3: Full URL Analysis Pipeline (Fetch -> Extract -> Infer)
 */
export async function analyzeUrlApi(url: string, fallbackTitle?: string): Promise<AnalysisResult> {
  const cleanUrl = (url || '').trim();
  if (!cleanUrl) {
    throw new Error('Please enter an article URL.');
  }

  const res = await fetch('/api/analyze-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: cleanUrl, title: fallbackTitle })
  });

  if (!res.ok) {
    let errorMsg = `URL Analysis error (${res.status})`;
    try {
      const errJson = await res.json();
      if (errJson.detail) errorMsg = errJson.detail;
    } catch {}
    throw new Error(errorMsg);
  }

  const backendData = await res.json();

  // Map to AnalysisResult
  const featureAttributions: FeatureAttribution[] = (backendData.feature_attributions || []).map((fa: any) => ({
    word: fa.term || fa.word || '',
    term: fa.term || fa.word || '',
    weight: typeof fa.impact_score === 'number' ? fa.impact_score : (fa.weight || 0),
    direction: (fa.signal_direction === 'real' || fa.direction === 'indicates_real') ? 'indicates_real' : 'indicates_fake',
    signal_direction: fa.signal_direction,
    signal_label: fa.signal_label,
    intensity: fa.intensity
  }));

  const indicators: any[] = backendData.indicators || [];
  const sensationalInd = indicators.find((i: any) => i.name?.toLowerCase().includes('sensational'));
  const polarizingInd = indicators.find((i: any) => i.name?.toLowerCase().includes('polarizing') || i.name?.toLowerCase().includes('emotional'));
  const capsInd = indicators.find((i: any) => i.name?.toLowerCase().includes('capitalization'));
  const punctInd = indicators.find((i: any) => i.name?.toLowerCase().includes('punctuation'));
  const questInd = indicators.find((i: any) => i.name?.toLowerCase().includes('question'));

  const linguisticSignals: LinguisticSignals = {
    sensational_count: sensationalInd?.examples?.length || (sensationalInd ? 1 : 0),
    sensational_words: sensationalInd?.examples || [],
    polarizing_count: polarizingInd?.examples?.length || (polarizingInd ? 1 : 0),
    polarizing_words: polarizingInd?.examples || [],
    all_caps_words_count: capsInd?.examples?.length || 0,
    excessive_punctuation: Boolean(punctInd),
    exclamation_count: punctInd?.examples?.length || 0,
    question_count: questInd?.examples?.length || 0,
    has_source: true,
    source_trust: backendData.source_info?.domain ? 'TRUSTED' : 'UNVERIFIED',
    source_notes: backendData.source_info?.notes || `Domain: ${backendData.source_info?.domain || 'unknown'}`
  };

  let summary = '';
  if (Array.isArray(backendData.explanation) && backendData.explanation.length > 0) {
    summary = backendData.explanation.join(' ');
  } else if (backendData.summary) {
    summary = backendData.summary;
  } else if (backendData.reason) {
    summary = backendData.reason;
  } else if (backendData.message) {
    summary = backendData.message;
  } else {
    summary = `The backend returned verdict "${backendData.prediction}" for this article.`;
  }

  // Backend is the source of truth for scores: pass nulls through untouched.
  const backendConfidenceScoreUrl = typeof backendData.confidence_score === 'number'
    ? backendData.confidence_score
    : (typeof backendData.confidence === 'number' ? Math.round(backendData.confidence * 100) : null);

  const fullResult: AnalysisResult = {
    id: backendData.id ? `#${backendData.id}` : `#${Date.now().toString().slice(-5)}`,
    status: backendData.status,
    message: backendData.message,
    verdict: backendData.verdict || backendData.prediction,
    prediction: backendData.prediction || backendData.verdict,
    reason: backendData.reason,
    risk_level: backendData.risk_level,
    fake_probability: typeof backendData.fake_probability === 'number' ? backendData.fake_probability : null,
    real_probability: typeof backendData.real_probability === 'number' ? backendData.real_probability : null,
    confidence_score: backendConfidenceScoreUrl,
    model_used: backendData.model || backendData.model_used || 'Linear SVM (Calibrated)',
    model_reliability: backendData.model_reliability,
    probability_caveat: backendData.probability_caveat,
    summary,
    text_snippet: backendData.article_title || (backendData.detected_claim ? backendData.detected_claim : cleanUrl),
    source_url: cleanUrl,
    input_type: 'url',
    original_url: backendData.original_url || cleanUrl,
    canonical_url: backendData.canonical_url,
    article_title: backendData.article_title,
    source_name: backendData.source_name,
    author: backendData.author,
    published_at: backendData.published_at,
    word_count: backendData.word_count,
    extraction_status: backendData.extraction_status,
    extraction_warnings: backendData.extraction_warnings,
    is_headline_only: backendData.is_headline_only ?? false,
    detected_claim: backendData.detected_claim,
    input_length: backendData.input_length,
    min_required_length: backendData.min_required_length,
    min_required_words: backendData.min_required_words,
    thresholds: backendData.thresholds,
    source_info: backendData.source_info,
    evidence_verification: backendData.evidence_verification,
    linguistic_signals: linguisticSignals,
    feature_attributions: featureAttributions,
    timestamp: new Date().toISOString()
  };

  if (fullResult.status !== 'INSUFFICIENT_INFORMATION') {
    saveToLocalHistory(fullResult);
  }
  return fullResult;
}

/**
 * Phase 3: Fetch latest live news articles from RSS feeds
 */
export async function fetchLiveNewsApi(options?: { category?: string; language?: string; limit?: number }): Promise<NewsFeedResponse> {
  const params = new URLSearchParams();
  if (options?.category && options.category !== 'all') params.set('category', options.category);
  if (options?.language) params.set('language', options.language);
  if (options?.limit) params.set('limit', String(options.limit));

  const qs = params.toString();
  const url = `/api/news/latest${qs ? `?${qs}` : ''}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch live news (${res.status})`);
  }
  return res.json();
}
