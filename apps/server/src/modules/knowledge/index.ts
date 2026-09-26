/** Public API of the knowledge module: documents, ingestion, retrieval. */
export { DocumentIngestionService } from './application/document-ingestion-service';
export { HybridRetriever, keywordTerms, type RetrievedChunk } from './application/hybrid-retriever';
export { KnowledgeUseCases, toDocumentDto } from './application/knowledge-use-cases';
export type { BlobStorage, DocumentRecord } from './application/ports';
export { chunkDocument, DEFAULT_CHUNKER_OPTIONS, type Chunk } from './domain/chunker';
export { detectDocumentType, detectInjectionMarkers } from './domain/document-rules';
export { reciprocalRankFusion } from './domain/rank-fusion';
export { FilesystemBlobStorage, PostgresBlobStorage } from './infrastructure/blob-storages';
export {
  DrizzleChunkRepository,
  DrizzleDocumentRepository,
  PgvectorSearchRepository,
  PostgresKeywordSearchRepository,
} from './infrastructure/drizzle-knowledge-repositories';
export { DefaultTextExtractor } from './infrastructure/text-extractor';
export { knowledgeRoutes } from './presentation/http/knowledge-routes';
