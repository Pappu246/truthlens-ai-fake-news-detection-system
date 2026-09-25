import { createExpressApp } from './server/appFactory';

// Render/Railway inject PORT at runtime; 3000 is only a local-dev fallback.
const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';
  const app = await createExpressApp({ isProduction, includeVite: true });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] TruthLens AI running at http://0.0.0.0:${PORT}`);
  });
}

// Only auto-start when run directly (Render, local dev)
// When imported as a module (Vercel serverless), the caller will create the app itself
if (process.env.VERCEL !== '1') {
  startServer().catch((err) => {
    console.error('[Server] Startup failure:', err);
    process.exit(1);
  });
}

// Export for Vercel serverless and testing
export { createExpressApp };
export default { createExpressApp };
