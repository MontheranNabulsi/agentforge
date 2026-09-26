import type { Page } from '@agentforge/contracts';
import type { Chunk, TextPage } from '../domain/chunker';
import type { DocumentKind, DocumentStatus, SupportedType } from '../domain/document-rules';

export interface DocumentRecord {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  kind: DocumentKind;
  sourceFilename: string | null;
  mimeType: string;
  sizeBytes: number;
  contentSha256: string;
  storageKey: string;
  status: DocumentStatus;
  errorCode: string | null;
  errorMessage: string | null;
  pageCount: number | null;
  chunkCount: number;
  tokenCount: number;
  injectionFlags: string[];
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  indexedAt: Date | null;
  deletedAt: Date | null;
}

export interface DocumentRepository {
  insert(document: Omit<DocumentRecord, 'uploadedByName'>): Promise<void>;
  findById(id: string): Promise<DocumentRecord | null>;
  findLiveByHash(projectId: string, sha256: string): Promise<DocumentRecord | null>;
  findByTitle(projectId: string, title: string): Promise<DocumentRecord | null>;
  list(filter: {
    projectId: string;
    limit: number;
    cursor?: string;
    status?: DocumentStatus;
  }): Promise<Page<DocumentRecord>>;
  setStatus(
    id: string,
    status: DocumentStatus,
    patch: Partial<
      Pick<
        DocumentRecord,
        | 'errorCode'
        | 'errorMessage'
        | 'pageCount'
        | 'chunkCount'
        | 'tokenCount'
        | 'injectionFlags'
        | 'indexedAt'
      >
    >,
    now: Date,
  ): Promise<void>;
  markDeleted(id: string, now: Date): Promise<void>;
  /**
   * Compare-and-set start of ingestion: succeeds for an uploaded/failed document, or one whose
   * previous ingestion stalled (no progress since staleBefore). Duplicate jobs lose the race.
   */
  claimForIngestion(id: string, now: Date, staleBefore: Date): Promise<boolean>;
  countLive(projectId: string): Promise<number>;
}

export interface StoredChunk extends Chunk {
  id: string;
}

export interface ChunkRepository {
  replaceForDocument(
    document: { id: string; organizationId: string; projectId: string },
    chunks: StoredChunk[],
  ): Promise<void>;
  deleteForDocument(documentId: string): Promise<void>;
  listForDocument(documentId: string, limit: number, offset: number): Promise<StoredChunk[]>;
  hydrate(chunkIds: string[]): Promise<HydratedChunk[]>;
}

export interface HydratedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  headingPath: string;
  pageNumber: number | null;
}

/**
 * The vector index port. The pgvector adapter keeps vectors in chunk_embeddings; a Qdrant or
 * Pinecone adapter would implement the same three methods and the rest of the system would
 * not notice. Chunk text stays in Postgres either way (the source of truth).
 */
export interface VectorSearchRepository {
  upsert(
    entries: {
      chunkId: string;
      organizationId: string;
      projectId: string;
      model: string;
      embedding: number[];
    }[],
  ): Promise<void>;
  deleteForDocument(documentId: string): Promise<void>;
  search(query: {
    projectId: string;
    model: string;
    embedding: number[];
    limit: number;
  }): Promise<{ chunkId: string; similarity: number }[]>;
}

export interface KeywordSearchRepository {
  search(query: {
    projectId: string;
    terms: string[];
    limit: number;
  }): Promise<{ chunkId: string; rank: number }[]>;
}

export interface BlobStorage {
  readonly kind: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export interface ExtractedText {
  pages: TextPage[];
  pageCount: number | null;
}

export interface TextExtractor {
  extract(type: SupportedType, bytes: Uint8Array): Promise<ExtractedText>;
}
