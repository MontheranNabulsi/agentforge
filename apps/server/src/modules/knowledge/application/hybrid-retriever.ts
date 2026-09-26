import { createHash } from 'node:crypto';
import type { SearchMode } from '@agentforge/contracts';
import type { EmbeddingProvider } from '../../../shared-kernel/ai';
import { reciprocalRankFusion, type RankedHit } from '../domain/rank-fusion';
import type { ChunkRepository, KeywordSearchRepository, VectorSearchRepository } from './ports';

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  headingPath: string;
  pageNumber: number | null;
  score: number;
  vectorScore: number | null;
  keywordScore: number | null;
  vectorRank: number | null;
  keywordRank: number | null;
}

export interface QueryEmbeddingCache {
  remember<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T>;
}

const STOP_TERMS = new Set(
  'a an and are as at be but by can do does for from has have how i if in into is it its of on or our so that the their then there these this to was we what when where which who why will with you your'.split(
    ' ',
  ),
);

/** Terms for the full-text half of the search: lowercase words, stopwords removed, tsquery-safe. */
export function keywordTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length > 1 && !STOP_TERMS.has(term)),
    ),
  ].slice(0, 16);
}

/**
 * Hybrid retrieval: pgvector similarity (meaning) + Postgres full-text rank (exact words such as
 * error codes and service names), fused with Reciprocal Rank Fusion. Each half fetches more
 * candidates than needed (limit × 3) so fusion has something to work with.
 */
export class HybridRetriever {
  constructor(
    private readonly deps: {
      vectors: VectorSearchRepository;
      keywords: KeywordSearchRepository;
      chunks: ChunkRepository;
      embeddings: EmbeddingProvider;
      cache: QueryEmbeddingCache;
    },
  ) {}

  async search(params: {
    projectId: string;
    query: string;
    limit: number;
    mode?: SearchMode;
  }): Promise<RetrievedChunk[]> {
    const { vectors, keywords, chunks } = this.deps;
    const mode = params.mode ?? 'hybrid';
    const candidates = Math.max(params.limit * 3, 20);

    const [vectorHits, keywordHits] = await Promise.all([
      mode === 'keyword'
        ? Promise.resolve([] as RankedHit[])
        : this.embedQuery(params.query).then(async (embedding) =>
            (
              await vectors.search({
                projectId: params.projectId,
                model: this.deps.embeddings.model,
                embedding,
                limit: candidates,
              })
            ).map((hit) => ({ id: hit.chunkId, score: hit.similarity })),
          ),
      mode === 'vector'
        ? Promise.resolve([] as RankedHit[])
        : keywords
            .search({
              projectId: params.projectId,
              terms: keywordTerms(params.query),
              limit: candidates,
            })
            .then((hits) => hits.map((hit) => ({ id: hit.chunkId, score: hit.rank }))),
    ]);

    const fused = reciprocalRankFusion([vectorHits, keywordHits]).slice(0, params.limit);
    const hydrated = new Map(
      (await chunks.hydrate(fused.map((f) => f.id))).map((c) => [c.chunkId, c]),
    );
    return fused.flatMap((hit) => {
      const chunk = hydrated.get(hit.id);
      if (!chunk) return [];
      return [
        {
          ...chunk,
          score: Number(hit.score.toFixed(6)),
          vectorScore: hit.scores[0] ?? null,
          keywordScore: hit.scores[1] ?? null,
          vectorRank: hit.ranks[0] ?? null,
          keywordRank: hit.ranks[1] ?? null,
        },
      ];
    });
  }

  /** Query embeddings are deterministic per model, so they cache well (cost and latency). */
  private embedQuery(query: string): Promise<number[]> {
    const { embeddings, cache } = this.deps;
    const key = `embedding:${embeddings.model}:${hashKey(query)}`;
    return cache.remember(key, 24 * 3600, async () => (await embeddings.embed([query]))[0]!);
  }
}

function hashKey(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
