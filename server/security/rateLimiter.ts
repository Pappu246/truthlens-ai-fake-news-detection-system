import { Request, Response, NextFunction } from 'express';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  message?: string;
}) {
  const ipMap = new Map<string, RateLimitRecord>();

  // Periodically sweep expired entries every 2 minutes to prevent memory leaks.
  // unref() so the timer never holds a serverless function (or test runner) open;
  // it still fires normally while the process is otherwise alive (e.g. Render).
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of ipMap.entries()) {
      if (now > record.resetTime) {
        ipMap.delete(ip);
      }
    }
  }, 120000);
  if (typeof (sweepTimer as any)?.unref === 'function') {
    sweepTimer.unref();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    // Vercel-safe IP extraction: req.socket may be unavailable in
    // serverless/mocked invocations -- never throw during client identification.
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      (req as any)?.socket?.remoteAddress ||
      (req as any)?.ip ||
      'unknown-client';

    const now = Date.now();
    const record = ipMap.get(clientIp);

    if (!record || now > record.resetTime) {
      ipMap.set(clientIp, {
        count: 1,
        resetTime: now + options.windowMs
      });
      return next();
    }

    if (record.count >= options.maxRequests) {
      const retryAfterSeconds = Math.ceil((record.resetTime - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        success: false,
        error:
          options.message ||
          `Rate limit exceeded: Maximum ${options.maxRequests} requests per ${Math.round(
            options.windowMs / 1000
          )} seconds. Please try again in ${retryAfterSeconds}s.`
      });
    }

    record.count++;
    next();
  };
}
