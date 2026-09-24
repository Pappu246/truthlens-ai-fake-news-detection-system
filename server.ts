import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { mlEngine } from './server/mlEngine';
import { validateDataset, validateDatasetContent } from './server/dataValidation';
import { verifyClaim, verifyArticleContent } from './server/verification/evidenceService';
import { extractClaims } from './server/verification/claimExtractor';
import { evidenceProvider } from './server/verification/evidenceProvider';
import { sqliteHistory } from './server/sqliteHistory';
import { getExternalValidationReport } from './server/externalValidation';
import { validateUrlSecurity, safeFetchHtml, normalizeUrl } from './server/security/urlValidator';
import { extractArticleFromHtml } from './server/extraction/articleExtractor';
import { liveNewsService } from './server/news/newsService';
import { createRateLimiter } from './server/security/rateLimiter';

// Render/Railway inject PORT at runtime; 3000 is only a local-dev fallback.
const PORT = Number(process.env.PORT) || 3000;

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

async function startServer() {
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
    res.json({
      status: modelTrained ? 'ok' : 'degraded',
      service: 'TruthLens ML Engine',
      model: 'Linear SVM (Calibrated)',
      model_trained: modelTrained,
      uptime_seconds: Math.round(process.uptime())
    });
  });

  // 2. Core News Analysis Endpoint (Text)
  app.post('/api/analyze', (req, res) => {
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
        isHeadlineOnly: req.body.is_headline_only
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

      // Anything reaching this catch happened AFTER our own input/SSRF
      // validation already passed (those return their own 400s above), so
      // it's always the target site or network that failed — never a bad
      // client request. Map to the status that actually describes it.
      let status = 502; // default: upstream/target site failure
      if (/timed out/i.test(message)) status = 504;
      else if (/HTTP 404/.test(message)) status = 404;
      else if (/HTTP 429/.test(message)) status = 429;

      res.status(status).json({ success: false, error: message });
    }
  });

  // 2c. Phase 3: Full URL Analysis Pipeline (Validate -> Fetch -> Extract -> ISOT ML Inference)
  app.post('/api/analyze-url', extractRateLimiter, async (req, res) => {
    try {
      const rawUrl = (req.body.url || '').trim();
      if (!rawUrl) {
        return res.status(400).json({ detail: 'URL is required for URL analysis.' });
      }

      // Step 1: Pre-flight security & SSRF validation
      const validation = await validateUrlSecurity(rawUrl);
      if (!validation.isValid) {
        return res.status(400).json({ detail: validation.error || 'Security check failed for URL.' });
      }

      // Step 2: Safe HTTP fetch
      const fetched = await safeFetchHtml(rawUrl);

      // Step 3: Semantic article extraction
      const extracted = extractArticleFromHtml({
        url: rawUrl,
        html: fetched.html,
        fallbackTitle: req.body.title
      });

      if (extracted.extractionStatus === 'FAILED' || !extracted.content.trim()) {
        return res.status(400).json({
          detail: extracted.warnings[0] || 'No readable article content could be extracted from this webpage.'
        });
      }

      // Step 4: Run through frozen ISOT-calibrated ML pipeline
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
        isHeadlineOnly: extracted.isHeadlineOnly
      });

      res.json(analysis);
    } catch (err: any) {
      console.error('[API /api/analyze-url error]', err.message);
      res.status(400).json({ detail: err.message || 'Failed to analyze article from URL.' });
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
      const metrics = mlEngine.getMetrics();
      res.json(metrics);
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

  // Validate uploaded dataset content without applying
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

  // Import and retrain on new dataset
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

  // Reset to original demo dataset if desired
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

  // ==========================================
  // PHASE 4: CLAIM EXTRACTION & EVIDENCE ENDPOINTS
  // ==========================================

  // 6a. Extract factual claims from article content
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

  // 6b. Search live evidence for specific queries or a claim
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

  // 6c. Verify a batch of claims against external evidence
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

  // 6d. Complete End-to-End Article Verification Pipeline
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

      // If ML Risk wasn't provided, evaluate linguistic ML risk independently
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

      // Persist in SQLite
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

  // 6e. Get Verification by ID (or Analysis ID)
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

  // 7. Decision Thresholds Configuration
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

  // 6. Retrain Pipeline
  app.post('/api/train', (req, res) => {
    try {
      const results = mlEngine.train();
      res.json({ status: 'success', results });
    } catch (err: any) {
      res.status(500).json({ detail: err.message });
    }
  });

  // 7. Analysis History Endpoints
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

  // 8. Demo Examples
  app.get('/api/examples', (req, res) => {
    res.json(DEMO_EXAMPLES);
  });

  // 9. Dataset Info
  app.get('/api/dataset/info', (req, res) => {
    const diag = mlEngine.getDiagnostics();
    res.json(diag.dataset_size);
  });

  // Any /api/* path that didn't match a route above is a genuinely missing
  // endpoint — return a clean JSON 404 instead of falling through to the
  // SPA catch-all (which would otherwise serve index.html with a 200).
  app.all('/api/*', (req, res) => {
    res.status(404).json({
      ok: false,
      error: { code: 'NOT_FOUND', message: `No API route for ${req.method} ${req.path}` }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // Accept proxied preview hosts (e.g. cloud sandboxes) — the app is
        // intended to be reachable from the user's browser via any host.
        allowedHosts: true as const,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Global error handler — guarantees every error (including malformed JSON
  // bodies from express.json(), which throw before any route handler runs)
  // comes back as consistent JSON instead of Express's default HTML page.
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] TruthLens AI running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Server] Startup failure:', err);
  process.exit(1);
});
