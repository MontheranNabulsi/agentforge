import type { JsonCache } from '../platform/cache/json-cache';
import type { Database } from '../platform/database/client';
import type { Logger } from '../platform/observability/logger';
import type { BackgroundJobs } from '../shared-kernel/jobs';
import type { Clock, TransactionRunner } from '../shared-kernel/ports';
import type { AuditLog } from '../modules/audit';
import {
  DefaultTextExtractor,
  DocumentIngestionService,
  DrizzleChunkRepository,
  DrizzleDocumentRepository,
  FilesystemBlobStorage,
  HybridRetriever,
  KnowledgeUseCases,
  PgvectorSearchRepository,
  PostgresBlobStorage,
  PostgresKeywordSearchRepository,
} from '../modules/knowledge';
import type { ProjectAccess } from '../modules/projects';
import type { AiProviders } from './ai-providers';
import type { AppConfig } from './config';

export function buildKnowledgeModule(deps: {
  config: AppConfig;
  db: Database;
  tx: TransactionRunner;
  clock: Clock;
  jobs: BackgroundJobs;
  audit: AuditLog;
  projectAccess: ProjectAccess;
  cache: JsonCache;
  ai: AiProviders;
  logger: Logger;
}) {
  const { config, db, tx, clock, jobs, audit, projectAccess, cache, ai } = deps;
  const documents = new DrizzleDocumentRepository(db);
  const chunks = new DrizzleChunkRepository(db);
  const vectors = new PgvectorSearchRepository(db);
  const keywords = new PostgresKeywordSearchRepository(db);
  const blobs =
    config.storage.kind === 'postgres'
      ? new PostgresBlobStorage(db)
      : new FilesystemBlobStorage(config.storage.blobDir);
  const retriever = new HybridRetriever({
    vectors,
    keywords,
    chunks,
    embeddings: ai.embeddings,
    cache,
  });
  const useCases = new KnowledgeUseCases({
    documents,
    chunks,
    vectors,
    blobs,
    retriever,
    projectAccess,
    audit,
    jobs,
    tx,
    clock,
  });
  const ingestion = new DocumentIngestionService({
    documents,
    chunks,
    vectors,
    blobs,
    extractor: new DefaultTextExtractor(),
    embeddings: ai.embeddings,
    tx,
    clock,
    onIndexed: (projectId) => cache.delete(`project-overview:${projectId}`),
  });
  return { useCases, ingestion, retriever, blobs, embeddingModel: () => ai.embeddings.model };
}

export type KnowledgeModule = ReturnType<typeof buildKnowledgeModule>;
