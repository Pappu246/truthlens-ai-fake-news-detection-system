/**
 * TRUTHLENS V2 — EVALUATION CLOCK (research-integrity fix)
 * =========================================================
 * The V2.1 research review recorded a MEDIUM finding: `rerankEvidence()`
 * computed the freshness signal from `Date.now()`. Evidence documents in the
 * fixture/benchmark corpora carry FIXED publication dates, so rerank weights,
 * vote weights, confidences — and potentially threshold crossings — drifted
 * with wall-clock time. A benchmark run was therefore only reproducible on
 * the day it was recorded.
 *
 * This module introduces ONE injectable clock for the V2 research stack:
 *
 *   - production/live callers: unchanged behaviour (`Date.now()`);
 *   - evaluation harnesses: pass an explicit `nowMs`, or export
 *     `TRUTHLENS_V2_FROZEN_NOW` (ISO-8601 timestamp or epoch milliseconds).
 *
 * NOTHING about the decision policy, thresholds, weights or the freshness
 * FORMULA changes here — only WHERE "now" comes from. Freezing the clock is
 * what makes "deterministic evaluation" literally true.
 */

export const FROZEN_NOW_ENV_VAR = 'TRUTHLENS_V2_FROZEN_NOW';

/**
 * Canonical frozen instant for TruthLens V2 offline evaluation runs.
 * Chosen to equal the frozen `retrievedAt` stamp already used by the SciFact
 * external harness, so retrieval timestamps and freshness share one clock.
 */
export const DEFAULT_FROZEN_EVALUATION_INSTANT = '2026-09-26T00:00:00.000Z';

export class FrozenClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrozenClockError';
  }
}

/** Parses a frozen-clock specification (ISO-8601 or epoch milliseconds). */
export function parseFrozenNow(raw: string): number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    if (!Number.isFinite(ms)) {
      throw new FrozenClockError(`${FROZEN_NOW_ENV_VAR}='${raw}' is not a finite epoch-millisecond value.`);
    }
    return ms;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new FrozenClockError(
      `${FROZEN_NOW_ENV_VAR}='${raw}' is neither epoch milliseconds nor a parsable ISO-8601 timestamp. ` +
      'Refusing to silently fall back to wall-clock time in a run that asked to be frozen.'
    );
  }
  return parsed;
}

/**
 * Resolves the "now" used by time-dependent V2 signals.
 *
 * Precedence: explicit argument > `TRUTHLENS_V2_FROZEN_NOW` > `Date.now()`.
 */
export function resolveNowMs(explicitNowMs?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (typeof explicitNowMs === 'number') {
    if (!Number.isFinite(explicitNowMs)) {
      throw new FrozenClockError(`Explicit nowMs=${explicitNowMs} is not a finite epoch-millisecond value.`);
    }
    return explicitNowMs;
  }
  const frozen = env[FROZEN_NOW_ENV_VAR];
  if (frozen && frozen.trim().length > 0) return parseFrozenNow(frozen);
  return Date.now();
}

/** True when this process is running against a frozen evaluation clock. */
export function isClockFrozen(explicitNowMs?: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof explicitNowMs === 'number') return true;
  const frozen = env[FROZEN_NOW_ENV_VAR];
  return Boolean(frozen && frozen.trim().length > 0);
}

/** Human-readable description for provenance/limitations. */
export function describeClock(explicitNowMs?: number, env: NodeJS.ProcessEnv = process.env): string {
  const nowMs = resolveNowMs(explicitNowMs, env);
  return isClockFrozen(explicitNowMs, env)
    ? `frozen evaluation clock at ${new Date(nowMs).toISOString()} (time-dependent freshness signal is reproducible)`
    : 'live wall clock (Date.now())';
}
