/**
 * Vercel Serverless Function Entry Point
 * 
 * This file is the entry for Vercel deployment.
 * It creates the Express app without Vite middleware (production static is handled by Vercel)
 * and exports it as a serverless function handler.
 * 
 * Architecture:
 * Browser -> Vercel (static frontend from dist + serverless /api/* from this file)
 * 
 * The Express app factory is shared with server.ts (used by Render) to avoid duplicate API logic.
 * All routes are defined in server/appFactory.ts — this file only adapts it for Vercel.
 */

import { createExpressApp } from '../server/appFactory';

let app: any = null;

async function getApp() {
  if (!app) {
    // In Vercel, isProduction=true, includeVite=false (static files served by Vercel CDN, not Express)
    app = await createExpressApp({ isProduction: true, includeVite: false });
  }
  return app;
}

// Vercel expects a default export that is a request handler
export default async function handler(req: any, res: any) {
  const expressApp = await getApp();
  return expressApp(req, res);
}
