/**
 * Production-safe evidence verification telemetry.
 *
 * This module records aggregate operational signals only. It deliberately
 * excludes claim text, article content, URLs, headers, tokens, prompts, and
 * environment values so observability cannot become a second data-leak path.
 */
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
