/**
 * V2 EVIDENCE (NLI) CLASSIFICATION — ADAPTER CONTRACT
 * ====================================================
 * The classifier seam deliberately accepts either a synchronous result or a
 * Promise. Deterministic/offline adapters stay synchronous, while production
 * deployments may call a remote/local pretrained model without duplicating
 * pipeline orchestration.
 */
import { ExtractedClaim } from '../../../src/types';
import { NliClassification } from '../types';

export interface NliAdapter {
  readonly modelName: string;
  readonly modelVersion: string;
  classify(
    claim: ExtractedClaim,
    passage: string,
    publishedAt?: string | null
  ): NliClassification | Promise<NliClassification>;
}
