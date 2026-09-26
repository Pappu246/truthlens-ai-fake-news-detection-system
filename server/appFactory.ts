import express from 'express';
import path from 'path';
import fs from 'fs';
// NOTE: 'vite' is intentionally NOT imported at module top-level.
// It is lazily imported inside createExpressApp() only for local dev
// (includeVite && !isProduction). A static import would force Vercel's
// serverless bundler to package all of Vite into the /api function,
// exploding bundle size / cold starts and risking init failure.
import { mlEngine } from './mlEngine';
import { validateDataset, validateDatasetContent } from './dataValidation';
import { verifyClaim, verifyArticleContent } from './verification/evidenceService';
import { extractClaims, extractPrimaryClaim } from './verification/claimExtractor';
import { evidenceProvider } from './verification/evidenceProvider';
import { evidenceEngine } from './verification/evidenceEngine';
import { claimModel, ClaimModelUnavailableError, ClaimSpeakerMetadata } from './claimModel';
import { sqliteHistory } from './sqliteHistory';
import { getExternalValidationReport } from './externalValidation';
import { validateUrlSecurity, safeFetchHtml, normalizeUrl } from './security/urlValidator';
import { extractArticleFromHtml } from './extraction/articleExtractor';
import { liveNewsService } from './news/newsService';
import { createRateLimiter } from './security/rateLimiter';

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

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

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

  // 1. Health Endpoint
  app.get('/api/health', (req, res) => {
    const modelTrained = mlEngine.isModelTrained();
    const claimReady = claimModel.isReady();
    res.json({
      status: modelTrained ? 'ok' : 'degraded',
      service: 'TruthLens ML Engine',
      model: 'Linear SVM (Calibrated)',
      model_trained: modelTrained,
      // The article model and the claim model are separate systems and are
      // reported separately. They are never combined into one number.
      components: {
        article_model: {
          role: 'article_model',
          dataset: 'ISOT',
          ready: modelTrained,
          status: modelTrained ? 'READY' : 'DEGRADED'
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
        }
      },
      uptime_seconds: Math.round(process.uptime())
    });
  });

  // 1b. Dedicated CLAIM MODEL endpoints (LIAR specialist, separate from the
  //     ISOT article model -- the two are never merged into one metric).
  app.post('/api/claim/predict', (req, res) => {
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
  app.post('/api/evidence/verify', extractRateLimiter, async (req, res) => {
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

  // 2. Core News Analysis Endpoint (Text)
  app.post('/api/analyze', async (req, res) => {
    try {
      const text = req.body.text || req.body.raw_text || '';
      const sourceUrl = req.body.source_url || '';
      const inputType = req.body.input_type || 'text';
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
      const rawUrl = (req.body.url || '').trim();
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
      const rawUrl = (req.body.url || '').trim();
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
        contentSource: 'FULL_ARTICLE_EXTRACTED'
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
      const category = (req.query.category as string) || undefined;
      const language = (req.query.language as string) || undefined;
      const limit = parseInt(req.query.limit as string, 10) || 25;

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
          model_name: articleMetrics?.best_model?.name || 'Linear SVM (Calibrated)',
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
          article_model: 'ISOT calibrated Linear SVM',
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

  app.post('/api/dataset/validate', (req, res) => {
    try {
      const csvContent = req.body.csv_content || '';
      const filename = req.body.filename || 'uploaded_dataset.csv';
      if (!csvContent) {
        return res.status(400).json({ detail: 'No CSV content provided for validation.' });
      }
      const validation = validateDatasetContent(csvContent, filename);
      res.json(validation);
    } catch (err: any) {
      res.status(400).json({ detail: err.message });
    }
  });

  app.post('/api/dataset/import', (req, res) => {
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

  app.post('/api/dataset/reset-demo', (req, res) => {
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
  app.post('/api/verify-claim', (req, res) => {
    try {
      const text = req.body.text || req.body.claim || '';
      const sourceUrl = req.body.source_url || '';
      const verification = verifyClaim(text, sourceUrl);
      res.json(verification);
    } catch (err: any) {
      res.status(400).json({ detail: err.message });
    }
  });

  // PHASE 4: CLAIM EXTRACTION & EVIDENCE ENDPOINTS
  app.post('/api/claims/extract', async (req, res) => {
    try {
      const title = req.body.title || '';
      const content = req.body.content || req.body.text || '';
      const description = req.body.description || '';

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

  app.post('/api/evidence/search', async (req, res) => {
    try {
      const query = req.body.query || '';
      const queries = req.body.queries || (query ? [query] : []);
      const claim = req.body.claim;

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

  app.post('/api/verify-claims', async (req, res) => {
    try {
      const claims = req.body.claims;
      if (!Array.isArray(claims)) {
        return res.status(400).json({ error: 'Array of claims is required in request body.' });
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

  app.post('/api/verify-article', async (req, res) => {
    try {
      const title = req.body.title || '';
      const content = req.body.content || req.body.text || '';
      const sourceUrl = req.body.sourceUrl || req.body.source_url || '';
      const analysisId = req.body.analysisId || req.body.analysis_id;
      let mlRiskLevel = req.body.mlRisk || req.body.mlRiskLevel || req.body.risk_level;

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

  app.get('/api/verification/:id', (req, res) => {
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

  app.post('/api/model/thresholds', (req, res) => {
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

  app.post('/api/train', (req, res) => {
    try {
      const results = mlEngine.train();
      res.json({ status: 'success', results });
    } catch (err: any) {
      res.status(500).json({ detail: err.message });
    }
  });

  app.get('/api/history', (req, res) => {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const history = mlEngine.getHistory(limit);
    res.json(history);
  });

  app.get('/api/history/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const item = mlEngine.getHistoryItem(id);
    if (!item) {
      return res.status(404).json({ detail: 'History record not found' });
    }
    res.json(item);
  });

  app.delete('/api/history/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const deleted = mlEngine.deleteHistoryItem(id);
    res.json({ success: deleted });
  });

  app.delete('/api/history', (req, res) => {
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
    res.status(status).json({
      ok: false,
      error: {
        code: status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
        message: status === 400 ? 'The request body could not be parsed.' : 'An unexpected server error occurred.'
      }
    });
  });

  return app;
}
