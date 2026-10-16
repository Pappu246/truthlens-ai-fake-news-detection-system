/**
 * Production-safe evidence verification telemetry.
 *
 * This module records aggregate operational signals only. It deliberately
 * excludes claim text, article content, URLs, headers, tokens, prompts, and
 * environment values so observability cannot become a second data-leak path.
 */
export interface EvidenceProviderDiagnosticInput {
  provider: string;
  stage?: string;
  state?: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  ok: boolean;
  httpStatus?: number;
  resultCount?: number;
  error?: string;
  sourceHost?: string;
  finalHost?: string;
  readableTextChars?: number;
  elapsedMs?: number;
}

export interface EvidenceProviderTelemetry {
  provider: string;
  stage: 'SEARCH' | 'PUBLISHER_FETCH' | 'PROVENANCE' | 'URL_RESOLUTION' | 'OTHER';
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  ok: boolean;
  resultCount: number;
  httpStatus?: number;
  elapsedMs?: number;
  sourceHost?: string;
  finalHost?: string;
  readableTextChars?: number;
  failureCode?: string;
}

export const MAX_TELEMETRY_PROVIDER_DIAGNOSTICS = 24;

export interface EvidenceTelemetryEvent {
  status: string;
  evidenceOutcome: string;
  evidenceCount: number;
  supportCount: number;
  contradictCount: number;
  unclearCount: number;
  retrievalAttempted: boolean;
  providerCount: number;
  providerFailures: number;
  publisherFetchFailures: number;
  provenanceRejections: number;
  semanticNliEnabled: boolean;
  durationMs: number;
  /** Host-only, error-classified summaries. Never pass raw diagnostics here. */
  providers?: EvidenceProviderTelemetry[];
  providerDiagnosticsTruncated?: boolean;
}

function safeIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
  return safe || fallback;
}

function safeHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const host = value.trim().toLowerCase().replace(/^www\./, '');
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
    return undefined;
  }
  return host;
}

function boundedInteger(value: unknown, maximum: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value), maximum);
}

function classifyFailureCode(error: unknown, httpStatus?: number): string {
  if (typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) {
    return `HTTP_${httpStatus}`;
  }
  const message = typeof error === 'string' ? error : '';
  if (/\b(timeout|timed out|aborted|aborterror|etimedout|und_err_connect_timeout)\b/i.test(message)) return 'TIMEOUT';
  if (/\b(?:budget exceeded|exceeded .* budget)\b/i.test(message)) return 'BUDGET_EXCEEDED';
  if (/non[- ]?json|invalid json|json parse|unexpected token/i.test(message)) return 'INVALID_RESPONSE';
  if (/ssrf|unsafe (?:url|target)|private (?:host|address)|dns resolution failed/i.test(message)) return 'URL_REJECTED';
  if (/provenance|publisher.{0,20}mismatch|source identity/i.test(message)) return 'PROVENANCE_REJECTED';
  if (/\b(?:403|401)\b|forbidden|unauthori[sz]ed|access blocked/i.test(message)) return 'ACCESS_BLOCKED';
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return 'RATE_LIMITED';
  if (/fetch failed|network|socket|econn|enotfound|eai_again|dns/i.test(message)) return 'NETWORK_ERROR';
  return 'PROVIDER_ERROR';
}

/**
 * Convert raw retrieval diagnostics to a small production-safe summary.
 * Claim/search text, raw errors, source names, URLs, and headers are deliberately
 * omitted; error strings are mapped to stable categories before they reach logs.
 */
export function summarizeProviderDiagnostics(
  diagnostics: readonly EvidenceProviderDiagnosticInput[]
): EvidenceProviderTelemetry[] {
  const stateOf = (diagnostic: EvidenceProviderDiagnosticInput): 'PENDING' | 'SUCCEEDED' | 'FAILED' =>
    diagnostic.state === 'PENDING' || diagnostic.state === 'SUCCEEDED' || diagnostic.state === 'FAILED'
      ? diagnostic.state
      : diagnostic.ok ? 'SUCCEEDED' : 'FAILED';
  return [...diagnostics]
    .sort((a, b) => Number(stateOf(b) === 'FAILED') - Number(stateOf(a) === 'FAILED'))
    .slice(0, MAX_TELEMETRY_PROVIDER_DIAGNOSTICS)
    .map((diagnostic) => {
      const stage = diagnostic.stage === 'SEARCH' || diagnostic.stage === 'PUBLISHER_FETCH' ||
        diagnostic.stage === 'PROVENANCE' || diagnostic.stage === 'URL_RESOLUTION'
        ? diagnostic.stage
        : 'OTHER';
      const state = stateOf(diagnostic);
      const summary: EvidenceProviderTelemetry = {
        provider: safeIdentifier(diagnostic.provider, 'unknown'),
        stage,
        state,
        ok: state === 'SUCCEEDED' && Boolean(diagnostic.ok),
        resultCount: boundedInteger(diagnostic.resultCount, 1000) ?? 0
      };
      const httpStatus = boundedInteger(diagnostic.httpStatus, 599);
      const elapsedMs = boundedInteger(diagnostic.elapsedMs, 60000);
      const readableTextChars = boundedInteger(diagnostic.readableTextChars, 1000000);
      const sourceHost = safeHost(diagnostic.sourceHost);
      const finalHost = safeHost(diagnostic.finalHost);
      if (httpStatus !== undefined && httpStatus >= 100) summary.httpStatus = httpStatus;
      if (elapsedMs !== undefined) summary.elapsedMs = elapsedMs;
      if (readableTextChars !== undefined) summary.readableTextChars = readableTextChars;
      if (sourceHost) summary.sourceHost = sourceHost;
      if (finalHost) summary.finalHost = finalHost;
      if (state === 'FAILED') summary.failureCode = classifyFailureCode(diagnostic.error, summary.httpStatus);
      return summary;
    });
}

export function recordEvidenceTelemetry(event: EvidenceTelemetryEvent): void {
  try {
    console.info(JSON.stringify({
      event: 'truthlens.evidence.verification',
      timestamp: new Date().toISOString(),
      ...event
    }));
  } catch {
    // Telemetry must never affect verification behavior.
  }
}
