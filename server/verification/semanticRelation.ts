/**
 * Optional semantic evidence relation hardening.
 *
 * The production lexical classifier remains the deterministic baseline.
 * When TRUTHLENS_ENABLE_REMOTE_NLI=true and HF_TOKEN is configured, ambiguous
 * fetched publisher passages can be refined by the existing opt-in NLI adapter.
 *
 * This module is deliberately fail-safe:
 * - no model download or model weights are introduced;
 * - no semantic call is made for unverified provenance;
 * - numerical contradictions remain authoritative;
 * - low-confidence / neutral NLI output never creates a directional verdict;
 * - adapter/network failures fall back to the deterministic relation.
 */
import { ExtractedClaim, ClaimEvidenceRelation } from '../../src/types';
import { NliAdapter } from '../v2/nli/nliAdapter';
import { createConfiguredNliAdapter } from '../v2/nli/huggingFaceNliAdapter';

export interface SemanticRelationResult {
  relation: ClaimEvidenceRelation;
  confidence: number;
  margin: number;
  modelName: string;
  modelVersion: string;
  basis: string;
}

let configuredAdapter: NliAdapter | null | undefined;

function getConfiguredAdapter(): NliAdapter | null {
  if (configuredAdapter !== undefined) return configuredAdapter;
  configuredAdapter = createConfiguredNliAdapter();
  return configuredAdapter;
}

function topTwo(scores: { supports: number; refutes: number; neutral: number; unclear: number }): [number, number] {
  const values = [scores.supports, scores.refutes, scores.neutral, scores.unclear].sort((a, b) => b - a);
  return [values[0] ?? 0, values[1] ?? 0];
}

/**
 * Refine only when the deterministic classifier is ambiguous. This avoids
 * paying a remote-model call for already-clear evidence and keeps CI/offline
 * behaviour deterministic.
 */
export async function refineEvidenceRelationSemantically(
  claim: ExtractedClaim,
  passage: string,
  lexicalRelation: ClaimEvidenceRelation,
  relevanceScore: number,
  options?: { adapter?: NliAdapter | null; minConfidence?: number; minMargin?: number }
): Promise<SemanticRelationResult | null> {
  if (relevanceScore < 0.22) return null;

  const adapter = options?.adapter ?? getConfiguredAdapter();
  if (!adapter) return null;

  // Numerical contradictions are handled by the caller and must not be
  // overridden by a semantic model.
  if (lexicalRelation === 'SUPPORTS' || lexicalRelation === 'CONTRADICTS') {
    return null;
  }

  try {
    const result = await adapter.classify(claim, passage);
    const confidence = Number.isFinite(result.confidence) ? result.confidence : 0;
    const [top, second] = topTwo(result.scores);
    const margin = top - second;
    const minConfidence = options?.minConfidence ?? 0.70;
    const minMargin = options?.minMargin ?? 0.15;

    if (confidence < minConfidence || margin < minMargin) {
      return {
        relation: 'MIXED',
        confidence,
        margin,
        modelName: result.modelName,
        modelVersion: result.modelVersion,
        basis:
          'semantic NLI abstained: label=' + result.label +
          ', confidence=' + confidence.toFixed(3) +
          ', margin=' + margin.toFixed(3) +
          '; deterministic relation retained'
      };
    }

    if (result.label === 'SUPPORTS') {
      return {
        relation: 'SUPPORTS',
        confidence,
        margin,
        modelName: result.modelName,
        modelVersion: result.modelVersion,
        basis: 'semantic NLI SUPPORTS with confidence=' + confidence.toFixed(3) +
          ', margin=' + margin.toFixed(3)
      };
    }

    if (result.label === 'REFUTES') {
      return {
        relation: 'CONTRADICTS',
        confidence,
        margin,
        modelName: result.modelName,
        modelVersion: result.modelVersion,
        basis: 'semantic NLI REFUTES with confidence=' + confidence.toFixed(3) +
          ', margin=' + margin.toFixed(3)
      };
    }

    return {
      relation: 'MIXED',
      confidence,
      margin,
      modelName: result.modelName,
      modelVersion: result.modelVersion,
      basis: 'semantic NLI is non-directional (' + result.label + '); deterministic relation retained'
    };
  } catch {
    return null;
  }
}

export function resetSemanticRelationAdapterForTests(): void {
  configuredAdapter = undefined;
}
