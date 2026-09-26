/**
 * TRUTHLENS V2 — OPTIONAL HUGGING FACE NLI ADAPTER
 * ==================================================
 * Uses the Hugging Face Inference Providers zero-shot endpoint with an
 * NLI-trained model. It is intentionally opt-in: CI/offline runs keep using
 * the deterministic heuristic adapter unless TRUTHLENS_ENABLE_REMOTE_NLI=true
 * and HF_TOKEN are present.
 *
 * The current HF zero-shot API accepts a passage plus candidate labels. The
 * default model is facebook/bart-large-mnli, which is trained for NLI and is
 * exposed for zero-shot classification. This is not a replacement for a
 * dedicated pairwise cross-encoder; it is a real pretrained model path that
 * upgrades the first vertical slice without making the test suite network
 * dependent.
 */
import { ExtractedClaim } from '../../../src/types';
import { NliClassification, NliLabel } from '../types';
import { NliAdapter } from './nliAdapter';

interface HfLabelScore {
  label?: string;
  score?: number;
}

interface HfZeroShotResponse {
  labels?: string[];
  scores?: number[];
}

const DEFAULT_MODEL = 'facebook/bart-large-mnli';
const ENDPOINT_BASE = 'https://router.huggingface.co/hf-inference/models/';

const CANDIDATE_LABELS = [
  'supports the claim',
  'refutes the claim',
  'does not determine the claim'
] as const;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mapLabel(label: string): NliLabel {
  const normalized = label.toLowerCase();
  if (normalized.includes('supports')) return 'SUPPORTS';
  if (normalized.includes('refutes')) return 'REFUTES';
  return 'NEUTRAL';
}

function endpointFor(model: string): string {
  const encoded = model.split('/').map(part => encodeURIComponent(part)).join('/');
  return `${ENDPOINT_BASE}${encoded}`;
}

export interface HuggingFaceNliOptions {
  token?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HuggingFaceNliAdapter implements NliAdapter {
  public readonly modelName: string;
  public readonly modelVersion = 'remote-inference-providers';
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HuggingFaceNliOptions = {}) {
    this.token = options.token ?? process.env.HF_TOKEN ?? '';
    this.modelName = options.model ?? process.env.TRUTHLENS_NLI_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (!this.token) {
      throw new Error('HF_TOKEN is required for HuggingFaceNliAdapter.');
    }
  }

  public async classify(
    claim: ExtractedClaim,
    passage: string,
    _publishedAt?: string | null
  ): Promise<NliClassification> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(endpointFor(this.modelName), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inputs: passage,
          parameters: {
            candidate_labels: [...CANDIDATE_LABELS],
            hypothesis_template: `This passage {}.`,
            multi_label: false
          }
        }),
        signal: controller.signal
      });

      const raw = await response.json() as HfZeroShotResponse | HfLabelScore[] | { error?: string };
      if (!response.ok) {
        const detail = typeof raw === 'object' && raw && 'error' in raw ? raw.error : undefined;
        throw new Error(`Hugging Face NLI request failed (${response.status})${detail ? `: ${detail}` : ''}`);
      }

      const ranked: HfLabelScore[] = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as HfZeroShotResponse).labels)
          ? (raw as HfZeroShotResponse).labels!.map((label, index) => ({
              label,
              score: (raw as HfZeroShotResponse).scores?.[index] ?? 0
            }))
          : [];

      if (ranked.length === 0) {
        throw new Error('Hugging Face NLI response contained no class scores.');
      }

      const scores = { supports: 0, refutes: 0, neutral: 0, unclear: 0 };
      for (const item of ranked) {
        const mapped = mapLabel(item.label ?? '');
        const score = clamp01(safeNumber(item.score));
        if (mapped === 'SUPPORTS') scores.supports = Math.max(scores.supports, score);
        else if (mapped === 'REFUTES') scores.refutes = Math.max(scores.refutes, score);
        else scores.neutral = Math.max(scores.neutral, score);
      }

      const top = [
        { label: 'SUPPORTS' as const, score: scores.supports },
        { label: 'REFUTES' as const, score: scores.refutes },
        { label: 'NEUTRAL' as const, score: scores.neutral }
      ].sort((a, b) => b.score - a.score)[0];

      const topTwo = [
        scores.supports,
        scores.refutes,
        scores.neutral
      ].sort((a, b) => b - a);

      const label: NliLabel = top.label;
      const confidence = Math.round(clamp01(top.score) * 1000) / 1000;
      const margin = topTwo[0] - topTwo[1];

      return {
        label,
        scores: {
          supports: Math.round(scores.supports * 1000) / 1000,
          refutes: Math.round(scores.refutes * 1000) / 1000,
          neutral: Math.round(scores.neutral * 1000) / 1000,
          unclear: 0
        },
        confidence,
        modelName: this.modelName,
        modelVersion: this.modelVersion,
        basis: `HF zero-shot NLI model=${this.modelName}; top=${top.label}; confidence=${confidence.toFixed(3)}; margin=${margin.toFixed(3)}`
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createConfiguredNliAdapter(): NliAdapter | null {
  const enabled = /^(1|true|yes)$/i.test(process.env.TRUTHLENS_ENABLE_REMOTE_NLI ?? '');
  const token = process.env.HF_TOKEN?.trim();
  if (!enabled || !token) return null;
  return new HuggingFaceNliAdapter({ token });
}
