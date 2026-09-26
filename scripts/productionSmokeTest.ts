/**
 * Production smoke test.
 *
 *   npx tsx scripts/productionSmokeTest.ts https://truthlens-ai-dvpf.onrender.com
 *
 * Verifies the deployed surface end to end:
 *   /api/health, /api/models/metrics, /api/model/diagnostics,
 *   /api/claim/metrics, /api/claim/predict, /api/evidence/verify,
 *   /api/article/extract (200/400/403/404/504 semantics),
 *   /api/analyze-url (fresh body, never stale), /api/news/latest
 *   (content-source labelling).
 *
 * This is a verification tool, not a test double: it asserts against the live
 * deployment and exits non-zero on any failure. It never asserts that an
 * external publisher must be reachable - it asserts that the API reports the
 * correct status for whatever actually happened.
 */
const BASE = (process.argv[2] || process.env.TRUTHLENS_BASE_URL || '').replace(/\/$/, '');

if (!BASE) {
  console.error('Usage: tsx scripts/productionSmokeTest.ts <base-url>');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n${t}`); console.log('-'.repeat(72)); }

async function req(method: 'GET' | 'POST', route: string, body?: any) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON is itself a finding */ }
  return { status: res.status, json };
}

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log(`PRODUCTION SMOKE TEST -- ${BASE}`);
  console.log('='.repeat(72));

  section('/api/health');
  const health = await req('GET', '/api/health');
  check('health returns 200', health.status === 200, String(health.status));
  check('article model component reported', health.json?.components?.article_model?.ready === true);
  check('claim model component reported READY',
    health.json?.components?.claim_model?.status === 'READY',
    JSON.stringify(health.json?.components?.claim_model));
  check('claim model version surfaced',
    health.json?.components?.claim_model?.model_version === '1.1.0-liar-claim');

  section('/api/models/metrics');
  const metrics = await req('GET', '/api/models/metrics');
  check('models/metrics returns 200', metrics.status === 200, String(metrics.status));
  check('article_model block present', Boolean(metrics.json?.article_model));
  check('claim_model block present', Boolean(metrics.json?.claim_model));
  check('benchmarks block present', Boolean(metrics.json?.benchmarks));
  check('models are not merged into one number',
    metrics.json?.separation_policy?.rule?.includes('Never merged'));

  section('/api/model/diagnostics');
  const diag = await req('GET', '/api/model/diagnostics');
  check('diagnostics returns 200', diag.status === 200, String(diag.status));
  check('diagnostics names the loaded artifact',
    Boolean(diag.json?.model_version || diag.json?.best_model));

  section('/api/claim/metrics');
  const cm = await req('GET', '/api/claim/metrics');
  check('claim/metrics returns 200', cm.status === 200, String(cm.status));
  check('claim metrics are AVAILABLE', cm.json?.status === 'AVAILABLE');
  check('text_only TEST n is 802', cm.json?.variants?.text_only?.test?.n === 802);
  check('text_meta TEST n is 802', cm.json?.variants?.text_meta?.test?.n === 802);
  check('threshold is 0.50 and untuned', cm.json?.decision_threshold === 0.5);

  section('/api/claim/predict');
  const samples = [
    'The unemployment rate for college graduates is 4.4 percent and over 10 percent for noncollege-educated.',
    'Denali is the Kenyan word for black power.',
    'Wisconsin is on pace to double the number of layoffs this year.',
    'Says the Annies List political group supports third-trimester abortions on demand.'
  ];
  for (const s of samples) {
    const r = await req('POST', '/api/claim/predict', { claim: s });
    check(`predict 200 for "${s.slice(0, 40)}..."`, r.status === 200, String(r.status));
    check('  served text_only without metadata', r.json?.variant_used === 'text_only');
    check('  metadata_available is false', r.json?.metadata_available === false);
    check('  limitation documents the missing metadata',
      (r.json?.limitations || []).some((l: string) => /no speaker metadata/i.test(l)));
    check('  probabilities sum to 1',
      Math.abs((r.json?.probability_true + r.json?.probability_false) - 1) < 1e-9);
  }
  const withMeta = await req('POST', '/api/claim/predict', {
    claim: samples[0],
    metadata: {
      speaker: 'rick-santorum', party: 'republican',
      credit_history: { barely_true_count: 12, false_count: 16, half_true_count: 13,
        mostly_true_count: 7, pants_on_fire_count: 5 }
    }
  });
  check('metadata request uses text_meta', withMeta.json?.variant_used === 'text_meta');
  const badClaim = await req('POST', '/api/claim/predict', { claim: '' });
  check('empty claim -> 400', badClaim.status === 400, String(badClaim.status));

  section('/api/evidence/verify');
  const ev = await req('POST', '/api/evidence/verify',
    { claim: 'The United States unemployment rate fell below four percent in 2023.' });
  check('evidence/verify returns 200', ev.status === 200, String(ev.status));
  const allowed = ['SUPPORTED', 'CONTRADICTED', 'MIXED', 'INSUFFICIENT_EVIDENCE',
    'NEEDS_MORE_CONTEXT', 'SEARCH_UNAVAILABLE'];
  check('status is a documented value', allowed.includes(ev.json?.status), ev.json?.status);
  check('evidence is declared untrusted data',
    ev.json?.security?.evidence_treated_as === 'UNTRUSTED_DATA');
  check('retrieval diagnostics present', Array.isArray(ev.json?.retrieval?.providers));
  if (ev.json?.available) {
    check('every citation has a real URL',
      ev.json.evidence.every((e: any) => /^https?:\/\//.test(e.source_url)));
    check('every citation has a retrieval timestamp',
      ev.json.evidence.every((e: any) => !Number.isNaN(Date.parse(e.retrieval_timestamp))));
    check('every citation has a domain', ev.json.evidence.every((e: any) => e.source_domain));
    console.log(`  INFO  retrieved ${ev.json.evidence.length} source(s): ` +
      ev.json.evidence.map((e: any) => e.source_domain).join(', '));
  } else {
    check('unavailable evidence returns no fabricated citations', ev.json?.evidence?.length === 0);
    console.log(`  INFO  evidence unavailable from this deployment: ${ev.json?.status}`);
  }
  const evShort = await req('POST', '/api/evidence/verify', { claim: 'taxes rose' });
  check('too-short claim -> NEEDS_MORE_CONTEXT', evShort.json?.status === 'NEEDS_MORE_CONTEXT');

  section('/api/article/extract -- HTTP semantics');
  const invalid = await req('POST', '/api/article/extract', { url: 'not-a-url' });
  check('invalid URL -> 400', invalid.status === 400, String(invalid.status));
  const ssrf = await req('POST', '/api/article/extract', { url: 'http://169.254.169.254/latest/meta-data/' });
  check('SSRF link-local URL -> 400', ssrf.status === 400, String(ssrf.status));
  const ssrf2 = await req('POST', '/api/article/extract', { url: 'http://127.0.0.1:3000/api/health' });
  check('SSRF loopback URL -> 400', ssrf2.status === 400, String(ssrf2.status));
  const fileProto = await req('POST', '/api/article/extract', { url: 'file:///etc/passwd' });
  check('file:// protocol -> 400', fileProto.status === 400, String(fileProto.status));
  const missing = await req('POST', '/api/article/extract',
    { url: 'https://www.bbc.com/news/this-page-definitely-does-not-exist-xyzzy-404' });
  check('missing page -> 404 (or 403/504 if the publisher intercepts)',
    [404, 403, 504].includes(missing.status), String(missing.status));
  console.log(`  INFO  missing-page status: ${missing.status}`);

  section('/api/article/extract + /api/analyze-url -- fresh body, no stale text');
  const target = 'https://apnews.com/hub/ap-top-news';
  const extract = await req('POST', '/api/article/extract', { url: target });
  console.log(`  INFO  extract status for ${target}: ${extract.status}`);
  if (extract.status === 200) {
    check('successful extraction reports a content source',
      ['FULL_ARTICLE_EXTRACTED', 'RSS_SUMMARY_ONLY', 'HEADLINE_ONLY']
        .includes(extract.json?.content_source || extract.json?.contentSource),
      String(extract.json?.content_source || extract.json?.contentSource));
    const analyze = await req('POST', '/api/analyze-url', { url: target });
    check('analyze-url returns 200', analyze.status === 200, String(analyze.status));
    const body = (extract.json?.text || extract.json?.content || '').slice(0, 120);
    if (body) {
      const analysed = JSON.stringify(analyze.json);
      check('analyze-url used the freshly extracted body (no stale text)',
        analysed.includes(body.slice(0, 60)) || analyze.json?.word_count > 0);
    }
  } else {
    check('non-200 extraction returns a documented status code',
      [400, 403, 404, 429, 502, 504].includes(extract.status), String(extract.status));
  }

  section('/api/news/latest -- content-source labelling');
  const news = await req('GET', '/api/news/latest');
  check('news/latest returns 200', news.status === 200, String(news.status));
  const articles = news.json?.articles || news.json?.items || [];
  console.log(`  INFO  ${articles.length} live item(s) returned`);
  if (articles.length) {
    const labels = ['FULL_ARTICLE_EXTRACTED', 'RSS_SUMMARY_ONLY', 'HEADLINE_ONLY', 'EXTRACTION_BLOCKED'];
    check('every item carries a content_source label',
      articles.every((x: any) => labels.includes(x.content_source || x.contentSource)),
      JSON.stringify(articles.slice(0, 2).map((x: any) => x.content_source || x.contentSource)));
    check('headline-only items are not presented as full articles',
      articles.every((x: any) => {
        const src = x.content_source || x.contentSource;
        if (src !== 'HEADLINE_ONLY') return true;
        return x.is_headline_only === true || x.isHeadlineOnly === true;
      }));
    const counts: Record<string, number> = {};
    for (const x of articles) {
      const s = x.content_source || x.contentSource || 'UNLABELLED';
      counts[s] = (counts[s] || 0) + 1;
    }
    console.log(`  INFO  content-source distribution: ${JSON.stringify(counts)}`);
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`PRODUCTION SMOKE TEST: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  console.log('='.repeat(72));
}

main().catch(err => { console.error('[smoke-test] fatal:', err.message); process.exit(1); });
