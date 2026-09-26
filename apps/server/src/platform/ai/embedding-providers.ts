import type { EmbeddingProvider } from '../../shared-kernel/ai';
import { LlmError } from '../../shared-kernel/ai';

export const EMBEDDING_DIMENSIONS = 1024;

const STOPWORDS = new Set(
  (
    'a an and are as at be but by can do does for from has have how i if in into is it its of on or our ' +
    'so that the their then there these this to was we what when where which who why will with you your'
  ).split(' '),
);

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * Deterministic "embeddings" by feature hashing (the hashing trick): words, word pairs and
 * word prefixes are hashed into 1024 buckets with a ±1 sign, weighted by log term frequency,
 * then L2-normalised. Similar text shares features, so cosine similarity tracks lexical
 * overlap. No model, no network, no cost: this is what makes retrieval work offline and in CI.
 * It does not understand meaning (synonyms won't match); a real embedding model does.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hashing';
  readonly model = 'hashing-v1';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.embedOne(text)));
  }

  private embedOne(text: string): number[] {
    const vector = new Float64Array(this.dimensions);
    const tokens = tokenize(text);
    const features = new Map<string, number>();
    const add = (feature: string, weight: number) =>
      features.set(feature, (features.get(feature) ?? 0) + weight);
    tokens.forEach((token, i) => {
      add(`w:${token}`, 1);
      if (token.length > 5) add(`p:${token.slice(0, 5)}`, 0.5);
      const next = tokens[i + 1];
      if (next) add(`b:${token}_${next}`, 0.6);
    });
    for (const [feature, weight] of features) {
      const hash = fnv1a(feature);
      const index = hash % this.dimensions;
      const sign = (hash & 0x80000000) === 0 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign * Math.log1p(weight);
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    return Array.from(vector, (value) => Number((value / norm).toFixed(6)));
  }
}

/**
 * Any server implementing POST /v1/embeddings (OpenAI, Ollama, LM Studio, vLLM, Voyage-style gateways).
 * Vectors must match the schema width (1024); a different width fails loudly instead of
 * silently corrupting the index.
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai-compatible';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    private readonly options: {
      baseUrl: string;
      model: string;
      apiKey: string | null;
      sendDimensions: boolean;
      batchSize?: number;
    },
  ) {}

  get model(): string {
    return this.options.model;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const batchSize = this.options.batchSize ?? 64;
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      vectors.push(...(await this.embedBatch(texts.slice(i, i + batchSize), signal)));
    }
    return vectors;
  }

  private async embedBatch(input: string[], signal?: AbortSignal): Promise<number[][]> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          input,
          ...(this.options.sendDimensions ? { dimensions: this.dimensions } : {}),
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new LlmError('LLM_UNAVAILABLE', 'Embedding server unreachable', true, { cause: error });
    }
    if (response.status === 429)
      throw new LlmError('LLM_RATE_LIMITED', 'Embedding server rate limited', true);
    if (!response.ok) {
      const retryable = response.status >= 500;
      throw new LlmError(
        retryable ? 'LLM_UNAVAILABLE' : 'LLM_BAD_REQUEST',
        `Embedding request failed (${response.status})`,
        retryable,
      );
    }
    const body = (await response.json()) as { data?: { embedding: number[]; index?: number }[] };
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== input.length)
      throw new LlmError('LLM_INVALID_OUTPUT', 'Embedding count mismatch', false);
    return data.map(({ embedding }) => {
      if (embedding.length !== this.dimensions) {
        throw new LlmError(
          'LLM_INVALID_OUTPUT',
          `Model "${this.options.model}" returns ${embedding.length}-dimensional vectors; the schema stores ${this.dimensions}. ` +
            'Pick a 1024-dimension model (e.g. mxbai-embed-large, bge-m3) or enable EMBEDDING_SEND_DIMENSIONS.',
          false,
        );
      }
      return embedding;
    });
  }
}
