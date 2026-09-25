/**
 * SSRF endpoint tests — boot server, hit /api/article/extract with blocked URLs.
 */
import { createExpressApp } from '../server/appFactory';

async function main() {
  const app = await createExpressApp({ isProduction: true, includeVite: false });
  const server = await new Promise<any>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const cases: [string, any, number][] = [
    ['localhost', { url: 'http://localhost/x' }, 400],
    ['127.0.0.1', { url: 'http://127.0.0.1/x' }, 400],
    ['cloud metadata 169.254', { url: 'http://169.254.169.254/' }, 400],
    ['empty url', { url: '' }, 400],
    ['invalid url', { url: 'not-a-url' }, 400],
    ['private 10.x', { url: 'http://10.0.0.1/' }, 400],
    ['private 192.168.x', { url: 'http://192.168.1.1/' }, 400],
    ['file:// protocol', { url: 'file:///etc/passwd' }, 400],
  ];
  let pass = 0, fail = 0;
  for (const [name, body, exp] of cases) {
    const res = await fetch(base + '/api/article/extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === exp) {
      console.log(`✅ SSRF ${name} -> ${res.status}`);
      pass++;
    } else {
      console.error(`❌ SSRF ${name} -> ${res.status} (expected ${exp}) body=${JSON.stringify(data).slice(0, 200)}`);
      fail++;
    }
  }
  server.close();
  console.log(`\nSSRF TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
