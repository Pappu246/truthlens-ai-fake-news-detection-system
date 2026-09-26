/**
 * Provisions the sealed comparison-only DistilBERT MNLI model used by the
 * V2.1 external report.
 *
 * V2.2: the byte seals and pinned mirror now live in ONE place — the
 * `EXPERIMENTAL_NLI_CANDIDATES` registry in server/v2/ml/modelManifest.ts —
 * so every experimental model shares the same fail-closed provisioning path.
 * This wrapper keeps the original `npm run download:v2-eval-model` entry
 * point working. It is intentionally NOT part of ALL_MODEL_MANIFESTS and can
 * never become the default adapter through this script.
 */
import { DISTILBERT_MNLI_CANDIDATE } from '../server/v2/ml/modelManifest';
import { provisionCandidateById } from './v2DownloadCandidateModel';

provisionCandidateById(DISTILBERT_MNLI_CANDIDATE.id).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
