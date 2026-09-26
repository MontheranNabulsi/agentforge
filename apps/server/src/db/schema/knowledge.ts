import { desc, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { createdAt, idColumn, sqlList, ts, tsvector, updatedAt } from './columns';
import { users } from './identity';
import { projectTenantFk } from './projects';

/**
 * Vector width is part of the schema. Changing embedding models with a different width
 * means a migration plus re-embedding (a new chunk_embeddings model row per chunk).
 */
export const EMBEDDING_DIMENSIONS = 1024;

export const DOCUMENT_STATUSES = [
  'uploaded',
  'extracting',
  'chunking',
  'embedding',
  'indexed',
  'failed',
] as const;
export const DOCUMENT_KINDS = ['file', 'note'] as const;

export const documents = pgTable(
  'documents',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    title: text('title').notNull(),
    kind: text('kind').notNull().default('file'),
    sourceFilename: text('source_filename'),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    contentSha256: text('content_sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status').notNull().default('uploaded'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    pageCount: integer('page_count'),
    chunkCount: integer('chunk_count').notNull().default(0),
    tokenCount: integer('token_count').notNull().default(0),
    injectionFlags: jsonb('injection_flags').$type<string[]>().notNull().default([]),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    indexedAt: ts('indexed_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    projectTenantFk('documents_project_tenant_fk', t.projectId, t.organizationId),
    // Re-uploading the same bytes into a project is a no-op, not a duplicate.
    uniqueIndex('documents_project_hash_unique')
      .on(t.projectId, t.contentSha256)
      .where(sql`${t.deletedAt} IS NULL`),
    index('documents_project_created_idx').on(t.projectId, desc(t.createdAt)),
    index('documents_in_progress_idx')
      .on(t.status)
      .where(sql`${t.status} NOT IN ('indexed', 'failed')`),
    check('documents_status_check', sql.raw(`status IN ${sqlList(DOCUMENT_STATUSES)}`)),
    check('documents_kind_check', sql.raw(`kind IN ${sqlList(DOCUMENT_KINDS)}`)),
  ],
);

export const documentChunks = pgTable(
  'document_chunks',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    headingPath: text('heading_path').notNull().default(''),
    pageNumber: integer('page_number'),
    charStart: integer('char_start').notNull(),
    charEnd: integer('char_end').notNull(),
    tokenCount: integer('token_count').notNull(),
    // STORED, not virtual: only stored generated columns can be indexed.
    contentTsv: tsvector('content_tsv').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(heading_path, '') || ' ' || content)`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    projectTenantFk('document_chunks_project_tenant_fk', t.projectId, t.organizationId),
    unique('document_chunks_document_index_unique').on(t.documentId, t.chunkIndex),
    index('document_chunks_tsv_idx').using('gin', t.contentTsv),
    index('document_chunks_project_idx').on(t.projectId),
  ],
);

/**
 * Vectors live apart from chunk text so a new embedding model can be backfilled side by
 * side (same chunk, new model row) and switched without downtime. Searches always filter
 * by model: vectors from different models are not comparable even at equal width.
 */
export const chunkEmbeddings = pgTable(
  'chunk_embeddings',
  {
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => documentChunks.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'chunk_embeddings_pk', columns: [t.chunkId, t.model] }),
    projectTenantFk('chunk_embeddings_project_tenant_fk', t.projectId, t.organizationId),
    index('chunk_embeddings_project_model_idx').on(t.projectId, t.model),
    index('chunk_embeddings_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);
