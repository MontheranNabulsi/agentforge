import { z } from 'zod';
import { Id, PageQuery, Timestamp } from './common';

export const DOCUMENT_STATUSES = [
  'uploaded',
  'extracting',
  'chunking',
  'embedding',
  'indexed',
  'failed',
] as const;
export const DocumentStatus = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const SUPPORTED_UPLOAD_EXTENSIONS = ['.md', '.markdown', '.txt', '.pdf'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const DocumentDto = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  kind: z.enum(['file', 'note']),
  sourceFilename: z.string().nullable(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  status: DocumentStatus,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  chunkCount: z.number().int(),
  tokenCount: z.number().int(),
  injectionFlags: z.array(z.string()),
  uploadedBy: z.object({ id: Id, name: z.string() }).nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  indexedAt: Timestamp.nullable(),
});
export type DocumentDto = z.infer<typeof DocumentDto>;

export const UploadDocumentResponse = z.object({
  document: DocumentDto,
  duplicate: z.boolean(),
});
export type UploadDocumentResponse = z.infer<typeof UploadDocumentResponse>;

export const DocumentListQuery = PageQuery.extend({
  status: DocumentStatus.optional(),
});
export type DocumentListQuery = z.infer<typeof DocumentListQuery>;

export const ChunkDto = z.object({
  id: Id,
  index: z.number().int(),
  content: z.string(),
  headingPath: z.string(),
  pageNumber: z.number().int().nullable(),
  tokenCount: z.number().int(),
});
export type ChunkDto = z.infer<typeof ChunkDto>;

export const SearchMode = z.enum(['hybrid', 'vector', 'keyword']);
export type SearchMode = z.infer<typeof SearchMode>;

export const KnowledgeSearchInput = z.object({
  query: z.string().trim().min(1).max(500),
  topK: z.number().int().min(1).max(20).default(8),
  mode: SearchMode.default('hybrid'),
});
export type KnowledgeSearchInput = z.infer<typeof KnowledgeSearchInput>;

export const SearchResultDto = z.object({
  chunkId: Id,
  documentId: Id,
  documentTitle: z.string(),
  content: z.string(),
  headingPath: z.string(),
  pageNumber: z.number().int().nullable(),
  score: z.number(),
  vectorScore: z.number().nullable(),
  keywordScore: z.number().nullable(),
  vectorRank: z.number().int().nullable(),
  keywordRank: z.number().int().nullable(),
});
export type SearchResultDto = z.infer<typeof SearchResultDto>;

export const KnowledgeSearchResponse = z.object({
  results: z.array(SearchResultDto),
  embeddingModel: z.string(),
  tookMs: z.number().int(),
});
export type KnowledgeSearchResponse = z.infer<typeof KnowledgeSearchResponse>;
