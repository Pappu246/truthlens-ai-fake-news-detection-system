/**
 * V2 EVIDENCE (NLI) CLASSIFICATION — ADAPTER CONTRACT
 * ====================================================
 * `NliAdapter` is the seam between the pipeline and whatever model decides
 * the entailment relationship between a claim and a retrieved evidence
 * passage. Every adapter must return the model name + version it used so
 * provenance always states exactly which classifier produced a label —
 * required so a future swap to a real pretrained NLI model (e.g. a local
 * ONNX/transformers.js `cross-encoder/nli` style model) is a drop-in
 * replacement with no changes to the rest of the pipeline.
 */
import { ExtractedClaim } from '../../../src/types';
import { NliClassification } from '../types';

export interface NliAdapter {
  readonly modelName: string;
  readonly modelVersion: string;
  classify(claim: ExtractedClaim, passage: string, publishedAt?: string | null): NliClassification;
}
