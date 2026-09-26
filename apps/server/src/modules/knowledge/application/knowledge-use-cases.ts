import { createHash } from 'node:crypto';
import type { DocumentDto, Page } from '@agentforge/contracts';
import { notFound } from '../../../shared-kernel/errors';
import { newId } from '../../../shared-kernel/ids';
import type { BackgroundJobs } from '../../../shared-kernel/jobs';
import type { Actor, Clock, TransactionRunner } from '../../../shared-kernel/ports';
import type { AuditActor, AuditLog } from '../../audit';
import type { ProjectAccess } from '../../projects';
import {
  detectDocumentType,
  MIME_TYPES,
  safeFilename,
  titleFromFilename,
  type DocumentStatus,
} from '../domain/document-rules';
import type { HybridRetriever, RetrievedChunk } from './hybrid-retriever';
import type {
  BlobStorage,
  ChunkRepository,
  DocumentRecord,
  DocumentRepository,
  StoredChunk,
  VectorSearchRepository,
} from './ports';

export const toDocumentDto = (doc: DocumentRecord): DocumentDto => ({
  id: doc.id,
  projectId: doc.projectId,
  title: doc.title,
  kind: doc.kind,
  sourceFilename: doc.sourceFilename,
  mimeType: doc.mimeType,
  sizeBytes: doc.sizeBytes,
  status: doc.status,
  errorCode: doc.errorCode,
  errorMessage: doc.errorMessage,
  pageCount: doc.pageCount,
  chunkCount: doc.chunkCount,
  tokenCount: doc.tokenCount,
  injectionFlags: doc.injectionFlags,
  uploadedBy: doc.uploadedBy ? { id: doc.uploadedBy, name: doc.uploadedByName ?? 'Unknown' } : null,
  createdAt: doc.createdAt.toISOString(),
  updatedAt: doc.updatedAt.toISOString(),
  indexedAt: doc.indexedAt?.toISOString() ?? null,
});

type NamedActor = Actor & { name?: string };

export interface KnowledgeDeps {
  documents: DocumentRepository;
  chunks: ChunkRepository;
  vectors: VectorSearchRepository;
  blobs: BlobStorage;
  retriever: HybridRetriever;
  projectAccess: ProjectAccess;
  audit: AuditLog;
  jobs: BackgroundJobs;
  tx: TransactionRunner;
  clock: Clock;
}

export class KnowledgeUseCases {
  constructor(private readonly deps: KnowledgeDeps) {}

  /**
   * Upload = validate + store + record + enqueue. Everything slow (extraction, embedding)
   * happens in the worker. Uploading identical bytes again returns the existing document.
   */
  async upload(
    actor: NamedActor,
    projectId: string,
    file: { filename: string; bytes: Uint8Array },
  ): Promise<{ document: DocumentRecord; duplicate: boolean }> {
    const { documents, blobs, projectAccess, tx, clock } = this.deps;
    const { project } = await projectAccess.require(actor, projectId, 'document:upload');
    const type = detectDocumentType(file.filename, file.bytes);
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');

    const existing = await documents.findLiveByHash(projectId, sha256);
    if (existing) return { document: existing, duplicate: true };

    const now = clock.now();
    const id = newId(now.getTime());
    const storageKey = `${project.organizationId}/${projectId}/${id}/${sha256.slice(0, 16)}`;
    await blobs.put(storageKey, file.bytes, MIME_TYPES[type]);

    const document = await tx.run(async () => {
      const record: Omit<DocumentRecord, 'uploadedByName'> = {
        id,
        organizationId: project.organizationId,
        projectId,
        title: titleFromFilename(file.filename),
        kind: 'file',
        sourceFilename: safeFilename(file.filename),
        mimeType: MIME_TYPES[type],
        sizeBytes: file.bytes.length,
        contentSha256: sha256,
        storageKey,
        status: 'uploaded',
        errorCode: null,
        errorMessage: null,
        pageCount: null,
        chunkCount: 0,
        tokenCount: 0,
        injectionFlags: [],
        uploadedBy: actor.userId,
        createdAt: now,
        updatedAt: now,
        indexedAt: null,
        deletedAt: null,
      };
      await documents.insert(record);
      await this.recordAudit(
        project.organizationId,
        projectId,
        { type: 'user', id: actor.userId, ...(actor.name ? { name: actor.name } : {}) },
        'document.uploaded',
        id,
        {
          title: record.title,
          sizeBytes: record.sizeBytes,
          mimeType: record.mimeType,
        },
      );
      await this.deps.jobs.enqueue(
        'document.ingest',
        { documentId: id },
        { dedupeKey: `ingest-${id}-1` },
      );
      return record;
    });
    return { document: { ...document, uploadedByName: actor.name ?? null }, duplicate: false };
  }

  /**
   * Notes written by agents (create_knowledge_note tool, after approval). Stored and ingested
   * exactly like uploads, so they are searchable the same way.
   */
  async createNote(params: {
    organizationId: string;
    projectId: string;
    title: string;
    content: string;
    actor: AuditActor;
    createdByUserId: string;
    runId: string | null;
    idempotencyKey: string;
  }): Promise<DocumentRecord> {
    const { documents, blobs, tx, clock } = this.deps;
    const markdown = `# ${params.title}\n\n${params.content.trim()}\n`;
    const bytes = new TextEncoder().encode(markdown);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = await documents.findLiveByHash(params.projectId, sha256);
    if (existing) return existing;
    const now = clock.now();
    const id = newId(now.getTime());
    const storageKey = `${params.organizationId}/${params.projectId}/${id}/${sha256.slice(0, 16)}`;
    await blobs.put(storageKey, bytes, 'text/markdown');
    return tx.run(async () => {
      const record: Omit<DocumentRecord, 'uploadedByName'> = {
        id,
        organizationId: params.organizationId,
        projectId: params.projectId,
        title: params.title.slice(0, 200),
        kind: 'note',
        sourceFilename: null,
        mimeType: 'text/markdown',
        sizeBytes: bytes.length,
        contentSha256: sha256,
        storageKey,
        status: 'uploaded',
        errorCode: null,
        errorMessage: null,
        pageCount: null,
        chunkCount: 0,
        tokenCount: 0,
        injectionFlags: [],
        uploadedBy: params.createdByUserId,
        createdAt: now,
        updatedAt: now,
        indexedAt: null,
        deletedAt: null,
      };
      await documents.insert(record);
      await this.recordAudit(
        params.organizationId,
        params.projectId,
        params.actor,
        'note.created',
        id,
        {
          title: record.title,
          idempotencyKey: params.idempotencyKey,
        },
        params.runId,
      );
      await this.deps.jobs.enqueue(
        'document.ingest',
        { documentId: id },
        { dedupeKey: `ingest-${id}-1` },
      );
      return { ...record, uploadedByName: null };
    });
  }

  async list(
    actor: Actor,
    projectId: string,
    filter: { limit: number; cursor?: string; status?: DocumentStatus },
  ): Promise<Page<DocumentRecord>> {
    await this.deps.projectAccess.require(actor, projectId, 'document:read');
    return this.deps.documents.list({ projectId, ...filter });
  }

  async get(actor: Actor, documentId: string): Promise<DocumentRecord> {
    const document = await this.deps.documents.findById(documentId);
    if (!document || document.deletedAt) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await this.deps.projectAccess.require(actor, document.projectId, 'document:read');
    return document;
  }

  async chunks(
    actor: Actor,
    documentId: string,
    page: { limit: number; offset: number },
  ): Promise<StoredChunk[]> {
    const document = await this.get(actor, documentId);
    return this.deps.chunks.listForDocument(document.id, page.limit, page.offset);
  }

  async remove(actor: NamedActor, documentId: string): Promise<void> {
    const { documents, chunks, vectors, tx, clock, projectAccess } = this.deps;
    const document = await documents.findById(documentId);
    if (!document || document.deletedAt) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await projectAccess.require(actor, document.projectId, 'document:delete');
    await tx.run(async () => {
      await vectors.deleteForDocument(document.id);
      await chunks.deleteForDocument(document.id);
      await documents.markDeleted(document.id, clock.now());
      await this.recordAudit(
        document.organizationId,
        document.projectId,
        { type: 'user', id: actor.userId, ...(actor.name ? { name: actor.name } : {}) },
        'document.deleted',
        document.id,
        {
          title: document.title,
        },
      );
    });
    await this.deps.blobs.delete(document.storageKey).catch(() => undefined);
  }

  async reindex(actor: NamedActor, documentId: string): Promise<DocumentRecord> {
    const { documents, projectAccess, tx, clock, jobs } = this.deps;
    const document = await documents.findById(documentId);
    if (!document || document.deletedAt) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await projectAccess.require(actor, document.projectId, 'document:upload');
    await tx.run(async () => {
      await documents.setStatus(
        document.id,
        'uploaded',
        { errorCode: null, errorMessage: null },
        clock.now(),
      );
      await this.recordAudit(
        document.organizationId,
        document.projectId,
        { type: 'user', id: actor.userId, ...(actor.name ? { name: actor.name } : {}) },
        'document.reindexed',
        document.id,
        {},
      );
      await jobs.enqueue(
        'document.ingest',
        { documentId: document.id },
        { dedupeKey: `ingest-${document.id}-${clock.now().getTime()}` },
      );
    });
    return (await documents.findById(document.id))!;
  }

  async search(
    actor: Actor,
    projectId: string,
    input: { query: string; topK: number; mode: 'hybrid' | 'vector' | 'keyword' },
  ): Promise<RetrievedChunk[]> {
    await this.deps.projectAccess.require(actor, projectId, 'document:read');
    return this.deps.retriever.search({
      projectId,
      query: input.query,
      limit: input.topK,
      mode: input.mode,
    });
  }

  /** For agents: search without an actor (the run already passed authorization). */
  retrieve(projectId: string, query: string, limit: number): Promise<RetrievedChunk[]> {
    return this.deps.retriever.search({ projectId, query, limit });
  }

  async lookupDocument(
    projectId: string,
    titleOrId: string,
  ): Promise<{ document: DocumentRecord; preview: StoredChunk[] } | null> {
    const { documents, chunks } = this.deps;
    const byId = /^[0-9a-f-]{36}$/i.test(titleOrId) ? await documents.findById(titleOrId) : null;
    const document =
      byId && byId.projectId === projectId
        ? byId
        : await documents.findByTitle(projectId, titleOrId);
    if (!document || document.deletedAt) return null;
    return { document, preview: await chunks.listForDocument(document.id, 3, 0) };
  }

  countDocuments(projectId: string): Promise<number> {
    return this.deps.documents.countLive(projectId);
  }

  private recordAudit(
    organizationId: string,
    projectId: string,
    actor: AuditActor,
    action: 'document.uploaded' | 'document.deleted' | 'document.reindexed' | 'note.created',
    documentId: string,
    metadata: Record<string, unknown>,
    runId?: string | null,
  ) {
    return this.deps.audit.record({
      organizationId,
      projectId,
      actor,
      action,
      target: { type: 'document', id: documentId },
      metadata,
      ...(runId ? { runId } : {}),
    });
  }
}
