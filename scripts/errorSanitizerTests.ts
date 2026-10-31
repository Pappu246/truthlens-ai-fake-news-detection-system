import fs from 'node:fs';
import { safePublicErrorMessage } from '../server/security/errorSanitizer';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

const secret = 'DATABASE_PASSWORD=/srv/private/secrets.env';
assert(
  safePublicErrorMessage(new Error(secret), 'The request could not be completed.') === 'The request could not be completed.',
  'exception details are replaced with the authored fallback'
);
assert(
  !safePublicErrorMessage(new Error(secret), 'The request could not be completed.').includes(secret),
  'filesystem paths and secret-like exception text are not reflected'
);
assert(
  safePublicErrorMessage(secret, 'Safe fallback') === 'Safe fallback',
  'non-Error thrown values are also not reflected'
);
assert(
  safePublicErrorMessage(new Error(secret), '   ') === 'The request could not be completed.',
  'empty fallbacks use the safe default'
);

const appFactory = fs.readFileSync(new URL('../server/appFactory.ts', import.meta.url), 'utf8');
assert(
  appFactory.includes("import { safePublicErrorMessage } from './security/errorSanitizer.js';"),
  'API routes import the central sanitizer'
);
assert(
  !/res\.status\([^\n]+\)\.json\([^\n]*(?:err|error)\.message/.test(appFactory),
  'route-level JSON responses do not directly interpolate exception messages'
);
assert(
  !/detail:\s*message[,}]/.test(appFactory) && !/error:\s*message[,}]/.test(appFactory),
  'URL route responses do not return raw exception-derived messages'
);

console.log('ERROR SANITIZER TESTS: 7 passed, 0 failed');
