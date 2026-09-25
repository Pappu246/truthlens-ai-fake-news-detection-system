/**
 * Vercel Serverless Runtime Simulation
 *
 * Faithfully exercises the production Vercel code path:
 *   api/index.ts  ->  createExpressApp({ isProduction: true, includeVite: false })
 *
 * Run:  npx tsx scripts/vercel-sim.ts
 *
 * Exit code 0 = all checks passed. Non-zero = failure (prints which check failed).
 */
process.env.VERCEL = '1';
process.env.NODE_ENV = 'production';

async function main() {
  // 1. Prove the Vercel entry module itself loads without throwing
  //    (catches top-level import crashes that would 500 every /api route).
  const apiModule = await import('../api/index.js');
  const vercelHandler = apiModule.default;
  if (typeof vercelHandler !== 'function') {
    console.error('FAIL: api/index.ts default export is not a function');
    process.exit(1);
  }
  console.log('PASS: api/index.ts module loads, default handler export is a function');

  // 2. Create the app exactly the way api/index.ts does and serve over real HTTP.
  const { createExpressApp } = await import('../server/appFactory.js');
  const app = await createExpressApp({ isProduction: true, includeVite: false });
  console.log('PASS: createExpressApp({ isProduction: true, includeVite: false }) initialized');

  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  let failures = 0;
  const check = async (
    name: string,
    method: string,
    path: string,
    body: any,
    validate: (status: number, json: any) => string | null
  ) => {
    try {
      const res = await fetch(base + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000)
      });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* non-JSON */ }
      const problem = validate(res.status, json);
      if (problem) {
        failures++;
        console.error(`FAIL: ${name} -> HTTP ${res.status}: ${problem} | body=${text.slice(0, 300)}`);
      } else {
        console.log(`PASS: ${name} -> HTTP ${res.status}`);
      }
    } catch (err: any) {
      failures++;
      console.error(`FAIL: ${name} -> request error: ${err.message}`);
    }
  };

  const mustBeJson = (status: number, json: any) =>
    json === null ? 'response was not JSON (possible crash / empty reply)' : null;

  await check('GET /api/health', 'GET', '/api/health', null, (s, j) => {
    if (s !== 200) return `expected 200, got ${s}`;
    if (!j || (j.status !== 'ok' && j.status !== 'degraded')) return 'missing status field';
    return null;
  });

  await check('POST /api/analyze', 'POST', '/api/analyze', {
    text: 'Astronomers utilizing the James Webb Space Telescope have captured unprecedented infrared observations of star-forming regions in the nearby NGC 346 cluster. According to peer-reviewed findings published this week in the Astrophysical Journal, spectroscopic data confirms molecular hydrogen density variations consistent with theoretical models of stellar nurseries.',
    input_type: 'text'
  }, (s, j) => {
    if (s !== 200) return `expected 200, got ${s}`;
    if (!j || !j.prediction) return 'missing prediction field';
    return null;
  });

  await check('GET /api/history', 'GET', '/api/history?limit=5', null, (s, j) => {
    if (s !== 200) return `expected 200, got ${s}`;
    if (!Array.isArray(j)) return 'expected JSON array';
    return null;
  });

  await check('GET /api/models/metrics', 'GET', '/api/models/metrics', null, (s, j) => {
    if (s !== 200) return `expected 200, got ${s}`;
    return mustBeJson(s, j);
  });

  await check('GET /api/model/diagnostics', 'GET', '/api/model/diagnostics', null, (s, j) => {
    if (s !== 200) return `expected 200, got ${s}`;
    return mustBeJson(s, j);
  });

  await check('GET /api/news/latest', 'GET', '/api/news/latest?limit=5', null, (s, j) => {
    // newsService never throws: offline -> 200 with empty articles + warnings.
    if (s !== 200) return `expected 200, got ${s}`;
    if (!j || !Array.isArray(j.articles)) return 'missing articles array';
    return null;
  });

  await check('POST /api/article/extract (SSRF-blocked URL -> controlled 400)', 'POST', '/api/article/extract', {
    url: 'http://169.254.169.254/latest/meta-data/'
  }, (s, j) => {
    if (s !== 400) return `expected controlled 400 SSRF block, got ${s}`;
    if (!j || j.success !== false) return 'missing success:false envelope';
    return null;
  });

  await check('POST /api/article/extract (public URL -> 200 or designed gateway JSON, never a crash)', 'POST', '/api/article/extract', {
    url: 'https://www.nasa.gov/press-release/james-webb-star-formation'
  }, (s, j) => {
    // With internet: 200 (extracted) or designed 4xx/502/504 JSON.
    // Without internet (sandbox): designed 502 JSON. A thrown/hung handler would fail here.
    if (![200, 400, 404, 429, 502, 504].includes(s)) return `unexpected status ${s}`;
    if (s !== 200 && (!j || j.success !== false)) return 'missing success:false envelope';
    return mustBeJson(s, j);
  });

  // Rate-limiter must not crash when req.socket is unavailable (serverless/mocked invocations).
  await new Promise<void>((resolve) => {
    import('../server/security/rateLimiter.js').then(({ createRateLimiter }) => {
      try {
        const limiter: any = createRateLimiter({ windowMs: 60000, maxRequests: 5 });
        const fakeReq: any = { headers: {}, socket: undefined };
        let nextCalled = false;
        limiter(fakeReq, { set: () => {}, status: () => ({ json: () => {} }) }, () => { nextCalled = true; });
        if (nextCalled) console.log('PASS: rate limiter tolerates missing req.socket');
        else { failures++; console.error('FAIL: rate limiter did not call next() with missing socket'); }
      } catch (err: any) {
        failures++;
        console.error(`FAIL: rate limiter threw with missing req.socket: ${err.message}`);
      }
      resolve();
    });
  });

  server.close();
  console.log(failures === 0 ? '\nALL VERCEL SIMULATION CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL: simulation crashed:', err);
  process.exit(1);
});
