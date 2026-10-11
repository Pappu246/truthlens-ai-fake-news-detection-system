import express from 'express';
import path from 'path';
import fs from 'fs';
// NOTE: 'vite' is intentionally NOT imported at module top-level.
// It is lazily imported inside createExpressApp() only for local dev
// (includeVite && !isProduction). A static import would force Vercel's
// serverless bundler to package all of Vite into the /api function,
// exploding bundle size / cold starts and risking init failure.
import { mlEngine } from './mlEngine.js';
import { validateDataset, validateDatasetContent } from './dataValidation.js';
import { verifyClaim, verifyArticleContent } from './verification/evidenceService.js';
import { extractClaims, extractPrimaryClaim } from './verification/claimExtractor.js';
import { evidenceProvider } from './verification/evidenceProvider.js';
import { evidenceEngine } from './verification/evidenceEngine.js';
import { claimModel, ClaimModelUnavailableError, ClaimSpeakerMetadata } from './claimModel.js';
import { sqliteHistory } from './sqliteHistory.js';
import { getExternalValidationReport } from './externalValidation.js';
import { validateUrlSecurity, safeFetchHtml, normalizeUrl } from './security/urlValidator.js';
import { extractArticleFromHtml } from './extraction/articleExtractor.js';
import { liveNewsService } from './news/newsService.js';
import { createRateLimiter } from './security/rateLimiter.js';
import { verifyClaimV2 } from './v2/pipeline.js';
import { PIPELINE_VERSION as V2_PIPELINE_VERSION } from './v2/provenance.js';

const DEMO_EXAMPLES = [
  {
    id: "real-1",
    title: "Likely Real (Peer-Reviewed Science)",
    category: "Science / Astrophysics",
    expected_outcome: "LIKELY REAL",
    source_url: "https://www.nasa.gov/press-release/james-webb-star-formation",
    text: "Astronomers utilizing the James Webb Space Telescope have captured unprecedented infrared observations of star-forming regions in the nearby NGC 346 cluster. According to peer-reviewed findings published this week in the Astrophysical Journal, spectroscopic data confirms molecular hydrogen density variations consistent with theoretical models of stellar nurseries. Dr. Elena Vance, lead astrophysicist at the Goddard Space Flight Center, stated that the observations provide critical calibration measurements for understanding galactic evolution during the cosmic noon epoch. Further telemetry data have been archived at the Space Telescope Science Institute for open academic inquiry."
  },
  {
    id: "fake-1",
    title: "Likely Fake (Sensational Conspiracy)",
    category: "Clickbait / Misinformation",
    expected_outcome: "LIKELY FAKE",
    source_url: "",
    text: "SHOCKING SECRET EXPOSED BY MILITARY WHISTLEBLOWER! Alien mothership over five miles wide is hovering in lunar orbit completely concealed from civilian telescopes using cloaking technology! The mainstream corrupt media and shadow government are desperately attempting to scrub this unbelievable miracle truth from the internet! Insiders confirm that world leaders signed a secret treaty allowing deep-state extraction operations in exchange for zero-point energy weapons! Share this before the global elites delete it forever! Wake up people!"
  },
  {
    id: "ambiguous-1",
    title: "Suspicious / Ambiguous (Unverified Rumor)",
    category: "Commercial PR / Unverified Rumor",
    expected_outcome: "NEEDS MORE CONTEXT",
    source_url: "https://unverified-tech-leaks.blog",
    text: "Insiders claim that a groundbreaking quantum computing processor may launch ahead of schedule next month, according to unconfirmed supply chain rumors circulating in Asian markets. Early reports suggest performance improvements of up to 400 percent over existing silicon architectures, though independent benchmarks have not yet been made public. Company representatives declined to comment on future product roadmaps or verify specifications."
  }
];

export async function createExpressApp(options?: { isProduction?: boolean; includeVite?: boolean }) {
  const isProduction = options?.isProduction ?? process.env.NODE_ENV === 'production';
  const includeVite = options?.includeVite ?? !isProduction;

  const app = express();
  app.disable('x-powered-by');
  // Trust one edge hop on Vercel. Other hosts opt in only when exactly one
  // trusted reverse proxy is guaranteed to precede this application.
  const trustOneProxy = process.env.VERCEL === '1' || process.env.TRUST_PROXY_HOPS === '1';
  app.set('trust proxy', trustOneProxy ? 1 : false);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  const productionModelLocked = isProduction || process.env.NODE_ENV === 'production';
  const productionMutationBlocked = (res: express.Response, operation: string): boolean => {
    if (!productionModelLocked) return false;
    res.status(403).json({
      error: 'Production model is locked.',
      code: 'PRODUCTION_MODEL_LOCKED',
      operation,
      detail: 'Model training, dataset replacement, threshold mutation, and demo reset are disabled on production deployments. Promote a verified candidate artifact through the audited model-governance workflow instead.'
    });
    return true;
  };

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '128kb', parameterLimit: 1000 }));

  // Phase 3 Rate Limiters
  const extractRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 30,
    message: 'Too many article extraction requests. Please wait a moment.'
  });

  const newsRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many live news requests. Please wait a moment.'
  });
  const apiRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 40,
    message: 'Too many API requests. Please try again shortly.'
  });
  const expensiveRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 12,
    message: 'Too many verification requests. Please wait before retrying.'
  });
  const datasetValidationRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 8,
    message: 'Too many dataset validation requests. Please try again shortly.'
  });
  // Remote history remains closed until per-user/session identity is implemented.
  const historyApiEnabledForLocalDevelopment =
    !productionModelLocked && process.env.TRUTHLENS_ENABLE_LOCAL_HISTORY_API === 'true';
  const rejectUnscopedHistory = (res: express.Response) => res.status(403).json({
    success: false,
    code: 'HISTORY_AUTH_REQUIRED',
    error: 'Remote history is disabled until authenticated, per-user history is implemented. Browser-local history remains available.'
  });

  // 1. Health Endpoint
  app.get('/api/health', (req, res) => {
    const modelTrained = mlEngine.isModelTrained();
    const calibrationExact = mlEngine.isCalibrationExact();
    const claimReady = claimModel.isReady();
    const degradedReasons: string[] = [];
    if (!modelTrained) degradedReasons.push('Article model artifact is unavailable.');
    if (!calibrationExact) {
      degradedReasons.push('Article model uses a legacy uncalibrated artifact; probability scores are withheld.');
    }
    if (!claimReady) degradedReasons.push('Claim model artifact is unavailable.');
    res.json({
      status: degradedReasons.length === 0 ? 'ok' : 'degraded',
      degraded_reasons: degradedReasons,
      service: 'TruthLens ML Engine',
      model: 'Linear SVM (Safety-Gated Legacy)',
      model_trained: modelTrained,
      article_model_version: mlEngine.getMetrics()?.model_version || null,
      article_inference_mode: mlEngine.getInferenceMode(),
      article_calibration_exact: calibrationExact,
      // The article model and the claim model are separate systems and are
      // reported separately. They are never combined into one number.
      components: {
        article_model: {
          role: 'article_model',
          dataset: 'ISOT',
          ready: modelTrained,
          status: modelTrained ? 'READY' : 'DEGRADED',
          model_version: mlEngine.getMetrics()?.model_version || null,
          inference_mode: mlEngine.getInferenceMode(),
          calibration_exact: calibrationExact
        },
        claim_model: {
          role: 'claim_model',
          dataset: 'LIAR',
          ready: claimReady,
          status: claimReady ? 'READY' : 'UNAVAILABLE',
          model_version: claimReady ? claimModel.getArtifact().model_version : null,
          error: claimReady ? null : claimModel.getLoadError()
        },
        evidence_engine: {
          role: 'evidence_engine',
          ready: true,
          status: 'READY',
          note: 'Retrieval health is reported per request; it depends on outbound network access.'
        },
        v2_research_stack: {
          role: 'v2_research_stack',
          ready: true,
          status: 'EXPERIMENTAL',
          pipeline_version: V2_PIPELINE_VERSION,
          note: 'TruthLens V2 evidence-grounded verification research stack (query expansion -> hybrid retrieval ' +
            '-> rerank -> NLI classification -> aggregation/abstention -> provenance). Additive research endpoint; ' +
            'does not affect the production article/claim model verdicts.'
        }
      },
      uptime_seconds: Math.round(process.uptime())
    });
  });

  // 1b. Dedicated CLAIM MODEL endpoints (LIAR specialist, separate from the
  //     ISOT article model -- the two are never merged into one metric).
  app.post('/api/claim/predict', apiRateLimiter, (req, res) => {
    try {
      const claimText = (req.body?.claim || req.body?.text || req.body?.statement || '').toString();
      if (!claimText.trim()) {
        return res.status(400).json({ error: 'A claim text is required.', field: 'claim' });
      }
      const rawMeta = req.body?.metadata || req.body?.speaker_metadata;
      const metadata: ClaimSpeakerMetadata | undefined = rawMeta && typeof rawMeta === 'object'
        ? {
            speaker: rawMeta.speaker,
            party: rawMeta.party,
            credit_history: rawMeta.credit_history || rawMeta.creditHistory
          }
        : undefined;
      const prediction = claimModel.predict(claimText, metadata);
      res.json(prediction);
    } catch (err: any) {
      if (err instanceof ClaimModelUnavailableError) {
        return res.status(503).json({
          error: 'Claim model artifact is not available in this runtime.',
          code: err.code,
          detail: err.message
        });
      }
      console.error('[API /api/claim/predict error]', err.message);
      res.status(400).json({ error: err.message || 'Claim prediction failed.' });
    }
  });

  app.get('/api/claim/metrics', (req, res) => {
    try {
      res.json(claimModel.getMetrics());
    } catch (err: any) {
      res.status(503).json({
        status: 'UNAVAILABLE',
        model_role: 'claim_model',
        error: 'Claim model artifact is not available in this runtime.',
        detail: err.message
      });
    }
  });

  // 1c. Evidence Engine: CLAIM -> SEARCH -> RELEVANCE -> SUPPORT/CONTRADICT
  //     -> VERIFICATION SIGNAL -> FINAL INTERPRETATION
  app.post('/api/evidence/verify', expensiveRateLimiter, async (req, res) => {
    try {
      const claimText = (req.body?.claim || req.body?.text || req.body?.statement || '').toString();
      if (!claimText.trim()) {
        return res.status(400).json({ error: 'A claim text is required.', field: 'claim' });
      }
      const report = await evidenceEngine.verifyClaim(claimText, {
        timeBudgetMs: Number(req.body?.time_budget_ms) || 12000,
        enabled: req.body?.enabled !== false
      });
      res.json(report);
    } catch (err: any) {
      console.error('[API /api/evidence/verify error]', err.message);
      res.status(500).json({ error: err.message || 'Evidence verification failed.' });
    }
  });

  // 1d. TRUTHLENS V2 RESEARCH STACK (EXPERIMENTAL, ADDITIVE):
  //     CLAIM -> QUERY EXPANSION -> HYBRID RETRIEVAL (lexical + dense)
  //           -> RERANKING -> NLI EVIDENCE CLASSIFICATION
  //           -> AGGREGATION/ABSTENTION -> PROVENANCE
  //     This is the first vertical slice of the V2 evidence-grounded
  //     verification architecture (see docs/V2_ARCHITECTURE.md). It is
  //     entirely separate from, and does not alter, the production
  //     `/api/evidence/verify` and `/api/analyze` verdict semantics above.
  app.post('/api/v2/evidence/verify', expensiveRateLimiter, async (req, res) => {
    try {
      const claimText = (req.body?.claim || req.body?.text || req.body?.statement || '').toString();
      if (!claimText.trim()) {
        return res.status(400).json({ error: 'A claim text is required.', field: 'claim' });
      }
      const result = await verifyClaimV2(claimText, {
        enableFullTextEnrichment: req.body?.enable_full_text_enrichment === true
      });
      res.json(result);
    } catch (err: any) {
      console.error('[API /api/v2/evidence/verify error]', err.message);
      res.status(500).json({ error: err.message || 'V2 evidence verification failed.' });
    }
  });

  // 2. Core News Analysis Endpoint (Text)
  app.post('/api/analyze', apiRateLimiter, async (req, res) => {
    try {
      const text = req.body?.text ?? req.body?.raw_text ?? '';
      const sourceUrl = req.body?.source_url ?? '';
      const inputType = req.body?.input_type || 'text';
      if (typeof text !== 'string' || typeof sourceUrl !== 'string') {
        return res.status(400).json({ detail: 'Article text and source URL must be strings.' });
      }
      if (text.length > 50000 || sourceUrl.length > 2048) {
        return res.status(400).json({ detail: 'Article text or source URL exceeds the allowed length.' });
      }
      if (!text.trim()) return res.status(400).json({ detail: 'Article text is required.' });
      const result = mlEngine.analyzeArticle(text, sourceUrl, {
        inputType,
        originalUrl: req.body.original_url || sourceUrl,
        canonicalUrl: req.body.canonical_url,
        articleTitle: req.body.article_title,
        sourceName: req.body.source_name,
        author: req.body.author,
        publishedAt: req.body.published_at,
        wordCount: req.body.word_count,
        extractionStatus: req.body.extraction_status,
        warnings: req.body.warnings,
        isHeadlineOnly: req.body.is_headline_only,
        contentSource: req.body.content_source
      });

      // ---- claim_model block -------------------------------------------
      // A dedicated LIAR claim prediction for the article's primary claim.
      // Reported alongside, never merged with, the ISOT article verdict.
      let claimBlock: any;
      try {
        const primary = extractPrimaryClaim(text);
        const primaryText = primary?.has_claim ? (primary.detected_claim || '').trim() : '';
        claimBlock = primaryText
          ? {
              status: 'AVAILABLE',
              source: 'primary claim extracted from the submitted text',
              ...claimModel.predict(primaryText)
            }
          : {
              status: 'NOT_APPLICABLE',
              reason: 'No checkable standalone claim could be extracted from this text, so the ' +
                      'claim model was not run. A claim-level score is withheld rather than guessed.'
            };
      } catch (err: any) {
        claimBlock = {
          status: err instanceof ClaimModelUnavailableError ? 'UNAVAILABLE' : 'NOT_APPLICABLE',
          reason: err.message
        };
      }
      result.claim_model = claimBlock;

      // ---- evidence engine ------------------------------------------------
      // Opt-out via include_evidence:false. When retrieval fails the engine
      // returns SEARCH_UNAVAILABLE / INSUFFICIENT_EVIDENCE -- never a verdict.
      const includeEvidence = req.body.include_evidence !== false;
      const evidenceClaim = (claimBlock?.claim_text || text || '').toString();
      result.evidence_verification = await evidenceEngine.verifyClaim(evidenceClaim, {
        enabled: includeEvidence,
        timeBudgetMs: Number(req.body.evidence_time_budget_ms) || 10000
      });

      res.json(result);
    } catch (err: any) {
      console.error('[API /api/analyze error]', err.message);
      res.status(400).json({ detail: err.message || 'Analysis failed' });
    }
  });

  // 2b. Phase 3: URL Article Extraction Endpoint (SSRF Protected & Robust Clean Extraction)
  app.post('/api/article/extract', extractRateLimiter, async (req, res) => {
    try {
      const urlValue = req.body?.url ?? '';
      if (typeof urlValue !== 'string') return res.status(400).json({ success: false, error: 'URL must be a string.' });
      if (urlValue.length > 2048) return res.status(400).json({ success: false, error: 'URL exceeds the 2,048-character limit.' });
      const rawUrl = urlValue.trim();
      if (!rawUrl) {
        return res.status(400).json({
          success: false,
          error: 'URL is required for article extraction.'
        });
      }

      // Pre-flight security & SSRF validation
      const validation = await validateUrlSecurity(rawUrl);
      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          error: validation.error || 'Invalid or insecure URL.'
        });
      }

      // Safe HTTP fetch with timeouts, size limits, and redirect validation
      const fetched = await safeFetchHtml(rawUrl);

      // Clean article and metadata extraction
      const extracted = extractArticleFromHtml({
        url: rawUrl,
        html: fetched.html,
        fallbackTitle: req.body.title
      });

      extracted.normalizedUrl = validation.normalizedUrl || normalizeUrl(rawUrl);

      res.json(extracted);
    } catch (err: any) {
      const message: string = err.message || 'Failed to extract article from URL.';
      console.error('[API /api/article/extract error]', message);

      // Correct HTTP semantics — never collapse publisher blocks into generic 502.
      let status = 502;
      if (/timed out/i.test(message)) status = 504;
      else if (/HTTP 404|Article not found/i.test(message)) status = 404;
      else if (/HTTP 429|Rate limited/i.test(message)) status = 429;
      else if (/HTTP 403|Access forbidden|blocked the extraction request/i.test(message)) status = 403;
      else if (/Invalid URL|Security violation|SSRF|forbidden protocol|DNS resolution failed|Could not resolve/i.test(message)) status = 400;

      res.status(status).json({
        success: false,
        error: message,
        httpStatus: status
      });
    }
  });

  // 2c. Phase 3: Full URL Analysis Pipeline (Validate -> Fetch -> Extract -> ISOT ML Inference)
  app.post('/api/analyze-url', extractRateLimiter, async (req, res) => {
    try {
      const urlValue = req.body?.url ?? '';
      if (typeof urlValue !== 'string') return res.status(400).json({ detail: 'URL must be a string.' });
      if (urlValue.length > 2048) return res.status(400).json({ detail: 'URL exceeds the 2,048-character limit.' });
      const rawUrl = urlValue.trim();
      if (!rawUrl) {
        return res.status(400).json({ detail: 'URL is required for URL analysis.' });
      }

      const validation = await validateUrlSecurity(rawUrl);
      if (!validation.isValid) {
        return res.status(400).json({ detail: validation.error || 'Security check failed for URL.' });
      }

      const fetched = await safeFetchHtml(rawUrl);

      const extracted = extractArticleFromHtml({
        url: rawUrl,
        html: fetched.html,
        fallbackTitle: req.body.title
      });

      if (extracted.extractionStatus === 'FAILED' || !extracted.content.trim()) {
        return res.status(422).json({
          detail: extracted.warnings[0] || 'No readable article content could be extracted from this webpage.'
        });
      }

      // Preserve the actual extraction state. A partial webpage must never be
      // mislabeled as a full article, because the ML safety policy abstains on
      // incomplete content rather than turning it into a confident verdict.
      const contentSource = extracted.isHeadlineOnly || extracted.wordCount < 40
        ? 'HEADLINE_ONLY'
        : extracted.extractionStatus === 'PARTIAL'
          ? 'PARTIAL_ARTICLE_EXTRACTED'
          : 'FULL_ARTICLE_EXTRACTED';

      const analysis = mlEngine.analyzeArticle(extracted.content, extracted.url, {
        inputType: 'url',
        originalUrl: rawUrl,
        canonicalUrl: extracted.canonicalUrl,
        articleTitle: extracted.title,
        sourceName: extracted.sourceName,
        author: extracted.author,
        publishedAt: extracted.publishedAt,
        wordCount: extracted.wordCount,
        extractionStatus: extracted.extractionStatus,
        warnings: extracted.warnings,
        isHeadlineOnly: extracted.isHeadlineOnly,
        contentSource
      });

      // URL analysis gets the same evidence-grounded verification layer as
      // direct text analysis. Evidence failure remains an abstention state;
      // it is never converted into FAKE.
      const includeEvidence = req.body.include_evidence !== false;
      const evidenceClaim = (analysis.detected_claim || extracted.title || extracted.content || '').toString();
      analysis.evidence_verification = await evidenceEngine.verifyClaim(evidenceClaim, {
        enabled: includeEvidence,
        timeBudgetMs: Number(req.body.evidence_time_budget_ms) || 10000
      });

      res.json(analysis);
    } catch (err: any) {
      const message: string = err.message || 'Failed to analyze article from URL.';
      console.error('[API /api/analyze-url error]', message);

      // Propagate precise HTTP status — never collapse 403/404/429/504 into generic 400.
      let status = 502;
      if (/timed out/i.test(message)) status = 504;
      else if (/HTTP 404|Article not found/i.test(message)) status = 404;
      else if (/HTTP 429|Rate limited/i.test(message)) status = 429;
      else if (/HTTP 403|Access forbidden|blocked the extraction request/i.test(message)) status = 403;
      else if (/Invalid URL|Security violation|SSRF|forbidden protocol|DNS resolution failed|Could not resolve|URL is required/i.test(message)) status = 400;

      res.status(status).json({ detail: message, httpStatus: status });
    }
  });

  // 2d. Phase 3: Live News Acquisition (RSS / Atom provider with caching & deduplication)
  app.get('/api/news/latest', newsRateLimiter, async (req, res) => {
    try {
      if ((req.query.category !== undefined && typeof req.query.category !== 'string') ||
          (req.query.language !== undefined && typeof req.query.language !== 'string') ||
          (req.query.limit !== undefined && typeof req.query.limit !== 'string')) {
        return res.status(400).json({ error: 'category, language, and limit must be supplied once as single query values.' });
      }
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      const language = typeof req.query.language === 'string' ? req.query.language : undefined;
      const parsedLimit = req.query.limit === undefined ? 25 : Number(req.query.limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
        return res.status(400).json({ error: 'limit must be an integer between 1 and 50.' });
      }
      const limit = parsedLimit;

      const newsData = await liveNewsService.getLatestNews({ category, language, limit });
      res.json(newsData);
    } catch (err: any) {
      console.error('[API /api/news/latest error]', err.message);
      res.status(500).json({
        articles: [],
        fetchedAt: new Date().toISOString(),
        provider: 'RSSNewsProvider',
        categories: [],
        warnings: [`Failed to retrieve news: ${err.message}`]
      });
    }
  });

  // 3. Model Diagnostics Endpoints
  const handleDiagnostics = (req: express.Request, res: express.Response) => {
    try {
      const diag = mlEngine.getDiagnostics();
      res.json(diag);
    } catch (err: any) {
      res.status(500).json({ detail: err.message });
    }
  };
  app.get('/api/model/diagnostics', handleDiagnostics);
  app.get('/api/models/diagnostics', handleDiagnostics);
  app.get('/api/model-specs', handleDiagnostics);

  // 4. Model Metrics & Evaluation Comparison
  const handleMetrics = (req: express.Request, res: express.Response) => {
    try {
      const articleMetrics = mlEngine.getMetrics();

      let claimMetrics: any;
      try {
        claimMetrics = claimModel.getMetrics();
      } catch (err: any) {
        claimMetrics = {
          status: 'UNAVAILABLE',
          model_role: 'claim_model',
          error: 'Claim model artifact is not available in this runtime.',
          detail: err.message
        };
      }

      // The two models are reported under separate keys and are NEVER averaged
      // or blended. They solve different tasks on different corpora, so a
      // single combined accuracy number would be misleading.
      res.json({
        ...articleMetrics,
        article_model: {
          role: 'article_model',
          task: 'full-article real/fake classification',
          dataset: 'ISOT',
          model_name: mlEngine.getInferenceMode() === 'legacy_single_svm'
            ? 'Linear SVM (Safety-Gated Legacy)'
            : (articleMetrics?.best_model?.name || 'Linear SVM (Calibrated)'),
          model_version: articleMetrics?.model_version,
          metrics: articleMetrics?.best_model?.metrics || null,
          thresholds: articleMetrics?.thresholds || null,
          dataset_info: articleMetrics?.dataset_info || null
        },
        claim_model: claimMetrics,
        benchmarks: {
          external_validation: getExternalValidationReport() || { status: 'NOT AVAILABLE' },
          note: 'Benchmarks are reported per model. The ISOT article score and the LIAR claim score ' +
                'measure different tasks and must not be combined into a single headline number.'
        },
        separation_policy: {
          article_model: mlEngine.getInferenceMode() === 'legacy_single_svm'
            ? 'ISOT Linear SVM (safety-gated legacy runtime)'
            : 'ISOT calibrated Linear SVM',
          claim_model: 'LIAR specialist (calibrated Linear SVM)',
          evidence_engine: 'external retrieval-based support/contradiction signal',
          rule: 'Never merged into one accuracy figure.'
        }
      });
    } catch (err: any) {
      res.status(500).json({ detail: err.message });
    }
  };
  app.get('/api/models/metrics', handleMetrics);
  app.get('/api/model/metrics', handleMetrics);
  app.get('/api/metrics', handleMetrics);

  // 4b. External Validation (LIAR Benchmark)
  const handleExternalValidation = (req: express.Request, res: express.Response) => {
    try {
      const report = getExternalValidationReport();
      if (!report) {
        return res.status(404).json({
          status: 'NOT AVAILABLE',
          message: 'External validation report has not been generated yet.'
        });
      }
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ detail: err.message });
    }
  };
  app.get('/api/external-validation', handleExternalValidation);
  app.get('/api/validation/liar', handleExternalValidation);

  // 5. Dataset Validation Endpoint
  app.get('/api/dataset/validation', (req, res) => {
    try {
      const audit = validateDataset();
      res.json(audit);
    } catch (err: any) {
      res.status(500).json({ detail: err.message });
    }
  });

  app.post('/api/dataset/validate', datasetValidationRateLimiter, (req, res) => {
    try {
      const csvContent = req.body?.csv_content;
      const filename = typeof req.body?.filename === 'string' ? req.body.filename.slice(0, 255) : 'uploaded_dataset.csv';
      if (typeof csvContent !== 'string' || !csvContent.trim()) {
        return res.status(400).json({ detail: 'CSV content must be a non-empty string.' });
      }
      if (Buffer.byteLength(csvContent, 'utf8') > 512 * 1024) {
        return res.status(413).json({ detail: 'Dataset validation payload exceeds the 512 KiB limit.' });
      }
      const validation = validateDatasetContent(csvContent, filename);
      res.json(validation);
    } catch (err: any) {
      res.status(400).json({ detail: err.message });
    }
  });

  app.post('/api/dataset/import', expensiveRateLimiter, (req, res) => {
    if (productionMutationBlocked(res, 'dataset-import')) return;
    try {
      const csvContent = req.body.csv_content || '';
      const filename = req.body.filename || 'imported_dataset.csv';
      if (!csvContent) {
        return res.status(400).json({ detail: 'No CSV content provided.' });
      }
      const result = mlEngine.importDataset(csvContent, filename);
      if (!result.success) {
        return res.status(400).json({
          status: 'error',
          detail: result.error,
          validation: result.validation
        });
      }
      res.json({
        status: 'success',
        validation: result.validation,
        metrics: result.metrics
      });
    } catch (err: any) {
      res.status(500).json({ detail: err.message });
    }
  });

  app.post('/api/dataset/reset-demo', expensiveRateLimiter, (req, res) => {
    if (productionMutationBlocked(res, 'reset-demo')) return;
    try {
      const backupPath = path.join(process.cwd(), 'data', 'news_demo_backup.csv');
      const activePath = path.join(process.cwd(), 'data', 'news.csv');
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, activePath);
      }
      const metrics = mlEngine.train();
      res.json({ status: 'success', message: 'Reset to demo dataset successfully.', metrics });
    } catch (err: any) {
      res.status(500).json({ detail: err.message });
    }
  });

  // 6. Claim Verification Endpoint
  app.post('/api/verify-claim', expensiveRateLimiter, async (req, res) => {
    try {
      const text = req.body?.text ?? req.body?.claim ?? '';
      const sourceUrl = req.body?.source_url ?? '';
      if (typeof text !== 'string' || typeof sourceUrl !== 'string') {
        return res.status(400).json({ detail: 'Claim text and source URL must be strings.' });
      }
      if (text.length > 5000 || sourceUrl.length > 2048) {
        return res.status(400).json({ detail: 'Claim text or source URL exceeds the allowed length.' });
      }
      if (!text.trim()) {
        return res.status(400).json({ detail: 'Claim text is required.' });
      }
      const verification = await verifyClaim(text, sourceUrl);
      res.json(verification);
    } catch (err: any) {
      res.status(400).json({ detail: err.message });
    }
  });

  // PHASE 4: CLAIM EXTRACTION & EVIDENCE ENDPOINTS
  app.post('/api/claims/extract', expensiveRateLimiter, async (req, res) => {
    try {
      const title = req.body?.title ?? '';
      const content = req.body?.content ?? req.body?.text ?? '';
      const description = req.body?.description ?? '';
      if ([title, content, description].some(value => typeof value !== 'string')) {
        return res.status(400).json({ error: 'Title, content, and description must be strings.' });
      }
      if (title.length > 1000 || content.length > 50000 || description.length > 5000) {
        return res.status(400).json({ error: 'Claim extraction input exceeds the allowed length.' });
      }

      if (!title.trim() && !content.trim() && !description.trim()) {
        return res.status(400).json({ error: 'Article title or content is required for claim extraction.' });
      }

      const claims = await extractClaims(title, content, description);
      res.json({
        claims,
        total: claims.length,
        extractedAt: new Date().toISOString()
      });
    } catch (err: any) {
      console.error('[API /api/claims/extract error]', err);
      res.status(500).json({ error: err.message || 'Failed to extract claims.' });
    }
  });

  app.post('/api/evidence/search', expensiveRateLimiter, async (req, res) => {
    try {
      const query = req.body?.query ?? '';
      if (typeof query !== 'string') return res.status(400).json({ error: 'Search query must be a string.' });
      if (req.body?.queries !== undefined &&
          (!Array.isArray(req.body.queries) || req.body.queries.length > 5 ||
           req.body.queries.some((q: unknown) => typeof q !== 'string' || q.length > 500))) {
        return res.status(400).json({ error: 'Provide at most 5 search queries, each no longer than 500 characters.' });
      }
      const queries: string[] = req.body?.queries ?? (query ? [query] : []);
      const claim = req.body?.claim;
      if (claim !== undefined && (!claim || typeof claim !== 'object' ||
          typeof claim.originalText !== 'string' || claim.originalText.length > 5000)) {
        return res.status(400).json({ error: 'Claim must be an object with originalText no longer than 5,000 characters.' });
      }

      if (!claim && queries.length === 0) {
        return res.status(400).json({ error: 'Search query or claim is required.' });
      }

      const targetClaim = claim || {
        claimId: 'custom-search',
        originalText: queries[0] || '',
        normalizedText: queries[0] || '',
        claimType: 'Other',
        importance: 'HIGH',
        entities: [],
        dates: [],
        locations: [],
        numbers: [],
        keywords: [],
        searchQueries: queries
      };

      const evidence = await evidenceProvider.searchEvidenceForClaim(targetClaim);
      res.json({
        query: query || queries.join('; '),
        evidence,
        count: evidence.length,
        retrievedAt: new Date().toISOString()
      });
    } catch (err: any) {
      console.error('[API /api/evidence/search error]', err);
      res.status(500).json({ error: err.message || 'Failed to search evidence.' });
    }
  });

  app.post('/api/verify-claims', expensiveRateLimiter, async (req, res) => {
    try {
      const claims = req.body?.claims;
      if (!Array.isArray(claims) || claims.length < 1 || claims.length > 20) {
        return res.status(400).json({ error: 'Provide an array of 1 to 20 claims.' });
      }
      if (claims.some((claim: any) => !claim || typeof claim !== 'object' ||
          typeof claim.originalText !== 'string' || claim.originalText.trim().length === 0 ||
          claim.originalText.length > 2000)) {
        return res.status(400).json({ error: 'Each claim must have originalText containing 1 to 2,000 characters.' });
      }

      const verified = await evidenceProvider.verifyClaims(claims);
      res.json({
        results: verified,
        count: verified.length,
        verifiedAt: new Date().toISOString()
      });
    } catch (err: any) {
      console.error('[API /api/verify-claims error]', err);
      res.status(500).json({ error: err.message || 'Failed to verify claims.' });
    }
  });

  app.post('/api/verify-article', expensiveRateLimiter, async (req, res) => {
    try {
      const title = req.body?.title ?? '';
      const content = req.body?.content ?? req.body?.text ?? '';
      const sourceUrl = req.body?.sourceUrl ?? req.body?.source_url ?? '';
      const analysisId = req.body?.analysisId ?? req.body?.analysis_id;
      let mlRiskLevel = req.body?.mlRisk ?? req.body?.mlRiskLevel ?? req.body?.risk_level;
      if ([title, content, sourceUrl].some(value => typeof value !== 'string')) {
        return res.status(400).json({ error: 'Article title, content, and source URL must be strings.' });
      }
      if (title.length > 1000 || content.length > 50000 || sourceUrl.length > 2048) {
        return res.status(400).json({ error: 'Article verification input exceeds the allowed length.' });
      }

      if (!content.trim() && !title.trim()) {
        return res.status(400).json({ error: 'Article content or title is required for verification.' });
      }

      if (!mlRiskLevel) {
        try {
          const mlResult = mlEngine.analyzeArticle(content || title, sourceUrl);
          mlRiskLevel = mlResult.risk_level;
        } catch {
          mlRiskLevel = 'UNDETERMINED';
        }
      }

      const verification = await verifyArticleContent({
        title,
        content,
        sourceUrl,
        mlRiskLevel,
        id: analysisId || Date.now().toString()
      });

      const insertedId = sqliteHistory.insertVerification({
        analysis_id: analysisId ? String(analysisId) : String(verification.id),
        title: verification.article.title,
        content_preview: verification.article.contentPreview,
        claims: verification.claims,
        summary: verification.summary,
        final_assessment: verification.finalAssessment,
        final_reasoning: verification.finalAssessmentReasoning,
        ml_risk: verification.mlRisk,
        ml_synthesis: verification.mlEvidenceSynthesis,
        warnings: verification.warnings
      });

      verification.id = insertedId;
      res.json(verification);
    } catch (err: any) {
      console.error('[API /api/verify-article error]', err);
      res.status(500).json({ error: err.message || 'Failed to verify article.' });
    }
  });

  app.get('/api/verification/:id', apiRateLimiter, (req, res) => {
    if (!historyApiEnabledForLocalDevelopment) return rejectUnscopedHistory(res);
    try {
      const verification = sqliteHistory.getVerificationById(req.params.id);
      if (!verification) {
        return res.status(404).json({ error: 'Verification record not found.' });
      }
      res.json(verification);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/model/thresholds', (req, res) => {
    res.json(mlEngine.getThresholds());
  });

  app.post('/api/model/thresholds', apiRateLimiter, (req, res) => {
    if (productionMutationBlocked(res, 'threshold-update')) return;
    try {
      const { fake_threshold, real_threshold, min_text_length } = req.body;
      const fake = typeof fake_threshold === 'number' ? fake_threshold : parseFloat(fake_threshold);
      const real = typeof real_threshold === 'number' ? real_threshold : parseFloat(real_threshold);
      const minLength = min_text_length !== undefined ? (typeof min_text_length === 'number' ? min_text_length : parseInt(min_text_length, 10)) : undefined;
      const updated = mlEngine.updateThresholds(fake, real, minLength);
      res.json({ status: 'success', thresholds: updated });
    } catch (err: any) {
      res.status(400).json({ detail: err.message });
    }
  });

  app.post('/api/train', expensiveRateLimiter, (req, res) => {
    if (productionMutationBlocked(res, 'train')) return;
    try {
      const results = mlEngine.train();
      res.json({ status: 'success', results });
    } catch (err: any) {
      res.status(500).json({ detail: err.message });
    }
  });

  app.get('/api/history', apiRateLimiter, (req, res) => {
    if (!historyApiEnabledForLocalDevelopment) return rejectUnscopedHistory(res);
    if (req.query.limit !== undefined && typeof req.query.limit !== 'string') {
      return res.status(400).json({ detail: 'limit must be supplied once as an integer.' });
    }
    const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 50;
    const history = mlEngine.getHistory(limit).map((record) => ({
      ...record,
      text_snippet: record.text_preview,
      full_text: undefined
    }));
    res.json(history);
  });

  app.get('/api/history/:id', apiRateLimiter, (req, res) => {
    if (!historyApiEnabledForLocalDevelopment) return rejectUnscopedHistory(res);
    if (!/^[1-9]\\d*$/.test(req.params.id)) return res.status(400).json({ detail: 'History ID must be a positive integer.' });
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ detail: 'History ID is outside the supported range.' });
    const item = mlEngine.getHistoryItem(id);
    if (!item) return res.status(404).json({ detail: 'History record not found' });
    res.json(item);
  });

  app.delete('/api/history/:id', apiRateLimiter, (req, res) => {
    if (!historyApiEnabledForLocalDevelopment) return rejectUnscopedHistory(res);
    if (!/^[1-9]\\d*$/.test(req.params.id)) return res.status(400).json({ detail: 'History ID must be a positive integer.' });
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ detail: 'History ID is outside the supported range.' });
    const deleted = mlEngine.deleteHistoryItem(id);
    if (!deleted) return res.status(404).json({ success: false, detail: 'History record not found or already deleted.' });
    res.json({ success: true });
  });

  app.delete('/api/history', apiRateLimiter, (req, res) => {
    if (!historyApiEnabledForLocalDevelopment) return rejectUnscopedHistory(res);
    const count = mlEngine.clearHistory();
    res.json({ success: true, count });
  });

  app.get('/api/examples', (req, res) => {
    res.json(DEMO_EXAMPLES);
  });

  app.get('/api/dataset/info', (req, res) => {
    const diag = mlEngine.getDiagnostics();
    res.json(diag.dataset_size);
  });

  app.all('/api/*', (req, res) => {
    res.status(404).json({
      ok: false,
      error: { code: 'NOT_FOUND', message: `No API route for ${req.method} ${req.path}` }
    });
  });

  if (includeVite) {
    if (!isProduction) {
      // Lazy import: dev-only. Never loaded in production (Render) or
      // serverless (Vercel, where includeVite=false skips this entirely).
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          allowedHosts: true as const,
        },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distPath = path.join(process.cwd(), 'dist');
      if (fs.existsSync(distPath)) {
        app.use(express.static(distPath));
        app.get('*', (req, res) => {
          res.sendFile(path.join(distPath, 'index.html'));
        });
      }
    }
  }

  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Server] Unhandled error:', err?.message || err);
    if (res.headersSent) return;
    const status = err?.status || err?.statusCode || 500;
    const tooLarge = status === 413 || err?.type === 'entity.too.large';
    res.status(tooLarge ? 413 : status).json({
      ok: false,
      error: {
        code: tooLarge ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
        message: tooLarge ? 'Request payload exceeds the allowed size.' :
          status === 400 ? 'The request body could not be parsed.' : 'An unexpected server error occurred.'
      }
    });
  });

  return app;
}
