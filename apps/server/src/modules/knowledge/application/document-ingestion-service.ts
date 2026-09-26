import { LlmError, type EmbeddingProvider } from '../../../shared-kernel/ai';
import { AppError, unprocessable } from '../../../shared-kernel/errors';
import { newId } from '../../../shared-kernel/ids';
import type { Clock, TransactionRunner } from '../../../shared-kernel/ports';
import { chunkDocument } from '../domain/chunker';
import { detectInjectionMarkers, type SupportedType } from '../domain/document-rules';
import type {
  BlobStorage,
  ChunkRepository,
  DocumentRepository,
  TextExtractor,
  VectorSearchRepository,
} from './ports';

const TYPE_BY_MIME: Record<string, SupportedType> = {
  'text/markdown': 'markdown',
  'text/plain': 'text',
  'application/pdf': 'pdf',
};

/**
 * The ingestion pipeline, run by a background job:
 *
 *   uploaded → extracting → chunking → embedding → indexed   (or → failed)
 *
 * Idempotent: running it twice for the same document produces the same chunks (they are
 * replaced, not appended) and the same vectors (upserted). That is what makes job retries,
 * duplicate deliveries and "reindex" safe.
 *
 * Error policy: bad input (unreadable PDF, no text) fails the document immediately; provider
 * or database trouble is rethrown so the queue retries with backoff, and only the final
 * failure marks the document failed.
 */
export class DocumentIngestionService {
  constructor(
    private readonly deps: {
      documents: DocumentRepository;
      chunks: ChunkRepository;
      vectors: VectorSearchRepository;
      blobs: BlobStorage;
      extractor: TextExtractor;
      embeddings: EmbeddingProvider;
      tx: TransactionRunner;
      clock: Clock;
      onIndexed?: (projectId: string) => Promise<void>;
    },
  ) {}

  async ingest(
    documentId: string,
    signal?: AbortSignal,
  ): Promise<{ status: 'indexed' | 'skipped' | 'failed' }> {
    const { documents, chunks, vectors, blobs, extractor, embeddings, tx, clock } = this.deps;
    const document = await documents.findById(documentId);
    if (!document || document.deletedAt) return { status: 'skipped' };
    if (document.status === 'indexed') return { status: 'skipped' };
    // At-least-once delivery means the same job can arrive twice: only one ingestion may run.
    const now = clock.now();
    if (
      !(await documents.claimForIngestion(documentId, now, new Date(now.getTime() - 5 * 60_000)))
    ) {
      return { status: 'skipped' };
    }

    try {
      const bytes = await blobs.get(document.storageKey);
      if (!bytes)
        throw unprocessable(
          'BLOB_MISSING',
          'The uploaded file is no longer available; upload it again',
        );
      const type = TYPE_BY_MIME[document.mimeType];
      if (!type)
        throw unprocessable('UNSUPPORTED_FILE_TYPE', `Unsupported type ${document.mimeType}`);
      const extracted = await extractor.extract(type, bytes);
      const fullText = extracted.pages.map((p) => p.text).join('\n');
      if (fullText.replace(/\s/g, '').length < 20) {
        throw unprocessable(
          'NO_EXTRACTABLE_TEXT',
          type === 'pdf'
            ? 'No text found; scanned PDFs need OCR, which is not supported yet'
            : 'The document has no text',
        );
      }

      await documents.setStatus(
        documentId,
        'chunking',
        { pageCount: extracted.pageCount },
        clock.now(),
      );
      const pieces = chunkDocument(extracted.pages).map((chunk) => ({ ...chunk, id: newId() }));
      const flags = detectInjectionMarkers(fullText);
      await chunks.replaceForDocument(document, pieces);

      await documents.setStatus(
        documentId,
        'embedding',
        { chunkCount: pieces.length, injectionFlags: flags },
        clock.now(),
      );
      const vectorsForChunks = await embeddings.embed(
        pieces.map((piece) =>
          piece.headingPath ? `${piece.headingPath}\n${piece.content}` : piece.content,
        ),
        signal,
      );
      await tx.run(async () => {
        await vectors.upsert(
          pieces.map((piece, i) => ({
            chunkId: piece.id,
            organizationId: document.organizationId,
            projectId: document.projectId,
            model: embeddings.model,
            embedding: vectorsForChunks[i]!,
          })),
        );
        await documents.setStatus(
          documentId,
          'indexed',
          {
            chunkCount: pieces.length,
            tokenCount: pieces.reduce((sum, piece) => sum + piece.tokenCount, 0),
            indexedAt: clock.now(),
          },
          clock.now(),
        );
      });
      await this.deps.onIndexed?.(document.projectId);
      return { status: 'indexed' };
    } catch (error) {
      if (isPermanent(error)) {
        const appError = error as AppError | LlmError;
        await documents.setStatus(
          documentId,
          'failed',
          { errorCode: appError.code, errorMessage: appError.message },
          clock.now(),
        );
        return { status: 'failed' };
      }
      // Transient failure (embedding API down…): release the claim so the retry can take it.
      await documents
        .setStatus(
          documentId,
          'uploaded',
          {
            errorCode: 'RETRYING',
            errorMessage: error instanceof Error ? error.message.slice(0, 300) : 'retrying',
          },
          clock.now(),
        )
        .catch(() => undefined);
      throw error;
    }
  }

  /** Called by the job host once retries are exhausted. */
  async markFailed(documentId: string, reason: string): Promise<void> {
    await this.deps.documents.setStatus(
      documentId,
      'failed',
      { errorCode: 'INGESTION_FAILED', errorMessage: reason.slice(0, 500) },
      this.deps.clock.now(),
    );
  }
}

function isPermanent(error: unknown): boolean {
  if (error instanceof AppError)
    return ['validation', 'unprocessable', 'not_found'].includes(error.kind);
  if (error instanceof LlmError) return !error.retryable;
  return false;
}
