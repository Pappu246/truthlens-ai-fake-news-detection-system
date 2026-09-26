/**
 * OPTIONAL HUGGING FACE SENTENCE EMBEDDING MODEL
 * ================================================
 * Uses the Hugging Face Inference Providers feature-extraction task. It is
 * intentionally opt-in so deterministic CI remains offline.
 */
import { EmbeddingModel } from './embeddings';

const DEFAULT_MODEL = 'BAAI/bge-small-en-v1.5';
const ENDPOINT_BASE = 'https://router.huggingface.co/hf-inference/models/';

function endpointFor(model: string): string {
  const encoded = model.split('/').map(part => encodeURIComponent(part)).join('/');
  return `${ENDPOINT_BASE}${encoded}`;
}

function normalise(values: number[]): number[] {
  let normSq = 0;
  for (const value of values) normSq += value * value;
  const norm = Math.sqrt(normSq) || 1;
  return values.map(value => value / norm);
}

function flattenAndMean(input: unknown): number[] {
  if (!Array.isArray(input) || input.length === 0) return [];

  if (typeof input[0] === 'number') {
    return (input as unknown[]).map(Number);
  }

  const rows: number[][] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value) || value.length === 0) return;
    if (typeof value[0] === 'number') {
      rows.push(value.map(Number));
      return;
    }
    for (const child of value) visit(child);
  };
  visit(input);

  if (rows.length === 0) return [];
  const dimension = Math.max(...rows.map(row => row.length));
  const pooled = new Array(dimension).fill(0);
  for (const row of rows) {
    for (let i = 0; i < dimension; i++) pooled[i] += row[i] ?? 0;
  }
  return pooled.map(value => value / rows.length);
}

export interface HuggingFaceEmbeddingOptions {
  token?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HuggingFaceEmbeddingModel implements EmbeddingModel {
  public readonly name: string;
  public readonly version = 'remote-inference-providers';
  public readonly dimensions: number;

  private readonly token: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HuggingFaceEmbeddingOptions = {}) {
    this.token = options.token ?? process.env.HF_TOKEN ?? '';
    this.model = options.model ?? process.env.TRUTHLENS_EMBEDDING_MODEL ?? DEFAULT_MODEL;
    this.name = `huggingface:${this.model}`;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dimensions = 0;

    if (!this.token) {
      throw new Error('HF_TOKEN is required for HuggingFaceEmbeddingModel.');
    }
  }

  public async embed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(endpointFor(this.model), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inputs: text,
          normalize: true
        }),
        signal: controller.signal
      });

      const raw = await response.json() as unknown;
      if (!response.ok) {
        const detail = typeof raw === 'object' && raw && 'error' in raw ? String((raw as { error?: unknown }).error ?? '') : '';
        throw new Error(`Hugging Face embedding request failed (${response.status})${detail ? `: ${detail}` : ''}`);
      }

      const vector = normalise(flattenAndMean(raw));
      if (vector.length === 0) {
        throw new Error('Hugging Face embedding response did not contain numeric vectors.');
      }
      return vector;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createConfiguredEmbeddingModel(): EmbeddingModel | null {
  const enabled = /^(1|true|yes)$/i.test(process.env.TRUTHLENS_ENABLE_REMOTE_EMBEDDINGS ?? '');
  const token = process.env.HF_TOKEN?.trim();
  if (!enabled || !token) return null;
  return new HuggingFaceEmbeddingModel({ token });
}
