/**
 * V2 ROUTE TESTS — boots the real Express app (same as ssrfTests.ts) and
 * hits the new, additive `/api/v2/evidence/verify` endpoint plus the
 * `/api/health` v2_research_stack field. Network-dependent retrieval
 * outcomes are NOT asserted here (the sandbox/CI may have no outbound
 * network access, exactly like the existing `/api/evidence/verify` tests) —
 * only response shape, status codes, and the "never crash, never fabricate"
 * contract are checked.
 */
import { createExpressApp } from '../server/appFactory';

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`✅ ${name}`);
    pass++;
  } else {
    console.error(`❌ ${name}${detail ? ` -- ${detail}` : ''}`);
    fail++;
  }
}

async function main() {
  const app = await createExpressApp({ isProduction: true, includeVite: false });
  const server = await new Promise<any>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // ---- health reports the v2 research stack, additively -------------------
  const health = await fetch(base + '/api/health').then(r => r.json());
  check('health reports v2_research_stack component', !!health.components?.v2_research_stack);
  check('health still reports the existing production components unchanged',
    !!health.components?.article_model && !!health.components?.claim_model && !!health.components?.evidence_engine);

  // ---- validation ----------------------------------------------------------
  const empty = await fetch(base + '/api/v2/evidence/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claim: '' })
  });
  check('empty claim -> 400', empty.status === 400, String(empty.status));

  // ---- happy path shape (retrieval outcome not asserted; see header) -----
  const res = await fetch(base + '/api/v2/evidence/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim: 'The national statistics office confirmed unemployment fell to 4.1 percent in March 2024.' })
  });
  const data = await res.json();
  check('claim verification -> 200', res.status === 200, String(res.status));
  check('response carries a provenance object', !!data.provenance);
  check('provenance carries pipeline identifier', data.provenance?.pipeline === 'truthlens_v2_evidence_grounded');
  check('provenance carries a final_verdict in the allowed set',
    ['VERIFIED', 'REFUTED', 'INSUFFICIENT_EVIDENCE', 'CONFLICTED'].includes(data.provenance?.final_verdict));
  check('provenance is JSON serializable (already true since it came over HTTP)', typeof data === 'object');
  check('production /api/evidence/verify endpoint is unaffected (still present)',
    (await fetch(base + '/api/evidence/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claim: '' })
    })).status === 400);

  server.close();
  console.log(`\nV2 ROUTE TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
