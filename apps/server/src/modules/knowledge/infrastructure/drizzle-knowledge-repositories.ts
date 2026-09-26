import type { Page } from '@agentforge/contracts';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { chunkEmbeddings, documentChunks, documents, users } from '../../../db/schema';
import type { Database } from '../../../platform/database/client';
import { executor } from '../../../platform/database/transaction';
import { decodeCursor, toPage } from '../../../shared-kernel/pagination';
import type { DocumentStatus } from '../domain/document-rules';
import type {
  ChunkRepository,
  DocumentRecord,
  DocumentRepository,
  HydratedChunk,
  KeywordSearchRepository,
  StoredChunk,
  VectorSearchRepository,
} from '../application/ports';

const documentColumns = {
  document: documents,
  uploadedByName: users.name,
};

type DocumentRow = { document: typeof documents.$inferSelect; uploadedByName: string | null };

const toRecord = ({ document, uploadedByName }: DocumentRow): DocumentRecord => ({
  ...document,
  kind: document.kind as DocumentRecord['kind'],
  status: document.status as DocumentStatus,
  uploadedByName,
});

export class DrizzleDocumentRepository implements DocumentRepository {
  constructor(private readonly db: Database) {}

  private select() {
    return executor(this.db)
      .select(documentColumns)
      .from(documents)
      .leftJoin(users, eq(users.id, documents.uploadedBy));
  }

  async insert(document: Omit<DocumentRecord, 'uploadedByName'>): Promise<void> {
    await executor(this.db).insert(documents).values(document);
  }

  async findById(id: string): Promise<DocumentRecord | null> {
    const [row] = await this.select().where(eq(documents.id, id)).limit(1);
    return row ? toRecord(row) : null;
  }

  async findLiveByHash(projectId: string, sha256: string): Promise<DocumentRecord | null> {
    const [row] = await this.select()
      .where(
        and(
          eq(documents.projectId, projectId),
          eq(documents.contentSha256, sha256),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async findByTitle(projectId: string, title: string): Promise<DocumentRecord | null> {
    const escaped = title.replace(/[%_\\]/g, '');
    const [row] = await this.select()
      .where(
        and(
          eq(documents.projectId, projectId),
          isNull(documents.deletedAt),
          ilike(documents.title, `%${escaped}%`),
        ),
      )
      .orderBy(sql`length(${documents.title})`)
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async list(filter: {
    projectId: string;
    limit: number;
    cursor?: string;
    status?: DocumentStatus;
  }): Promise<Page<DocumentRecord>> {
    const cursor = decodeCursor(filter.cursor);
    const conditions: SQL[] = [
      eq(documents.projectId, filter.projectId),
      isNull(documents.deletedAt),
    ];
    if (filter.status) conditions.push(eq(documents.status, filter.status));
    if (cursor) {
      conditions.push(
        or(
          lt(documents.createdAt, cursor.createdAt),
          and(eq(documents.createdAt, cursor.createdAt), lt(documents.id, cursor.id)),
        )!,
      );
    }
    const rows = await this.select()
      .where(and(...conditions))
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(filter.limit + 1);
    const records = rows.map(toRecord);
    return toPage(records, filter.limit, (r) => r);
  }

  async setStatus(
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
  ): Promise<void> {
    await executor(this.db)
      .update(documents)
      .set({ ...patch, status, updatedAt: now })
      .where(eq(documents.id, id));
  }

  async claimForIngestion(id: string, now: Date, staleBefore: Date): Promise<boolean> {
    const claimed = await executor(this.db)
      .update(documents)
      .set({ status: 'extracting', errorCode: null, errorMessage: null, updatedAt: now })
      .where(
        and(
          eq(documents.id, id),
          isNull(documents.deletedAt),
          or(
            inArray(documents.status, ['uploaded', 'failed']),
            and(
              inArray(documents.status, ['extracting', 'chunking', 'embedding']),
              lt(documents.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning({ id: documents.id });
    return claimed.length > 0;
  }

  async markDeleted(id: string, now: Date): Promise<void> {
    await executor(this.db)
      .update(documents)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(documents.id, id));
  }

  async countLive(projectId: string): Promise<number> {
    const [row] = await executor(this.db)
      .select({ value: count() })
      .from(documents)
      .where(and(eq(documents.projectId, projectId), isNull(documents.deletedAt)));
    return row?.value ?? 0;
  }
}

export class DrizzleChunkRepository implements ChunkRepository {
  constructor(private readonly db: Database) {}

  /** Replace, never append: re-ingesting a document must not duplicate its chunks. */
  async replaceForDocument(
    document: { id: string; organizationId: string; projectId: string },
    chunks: StoredChunk[],
  ): Promise<void> {
    const run = async (q: ReturnType<typeof executor>) => {
      await q.delete(documentChunks).where(eq(documentChunks.documentId, document.id));
      for (let i = 0; i < chunks.length; i += 200) {
        const batch = chunks.slice(i, i + 200);
        if (batch.length === 0) continue;
        await q.insert(documentChunks).values(
          batch.map((chunk) => ({
            id: chunk.id,
            organizationId: document.organizationId,
            projectId: document.projectId,
            documentId: document.id,
            chunkIndex: chunk.index,
            content: chunk.content,
            headingPath: chunk.headingPath,
            pageNumber: chunk.pageNumber,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
            tokenCount: chunk.tokenCount,
          })),
        );
      }
    };
    const current = executor(this.db);
    if (current !== this.db) await run(current);
    else await this.db.transaction((tx) => run(tx));
  }

  async deleteForDocument(documentId: string): Promise<void> {
    await executor(this.db).delete(documentChunks).where(eq(documentChunks.documentId, documentId));
  }

  async listForDocument(documentId: string, limit: number, offset: number): Promise<StoredChunk[]> {
    const rows = await executor(this.db)
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.documentId, documentId))
      .orderBy(asc(documentChunks.chunkIndex))
      .limit(limit)
      .offset(offset);
    return rows.map((row) => ({
      id: row.id,
      index: row.chunkIndex,
      content: row.content,
      headingPath: row.headingPath,
      pageNumber: row.pageNumber,
      charStart: row.charStart,
      charEnd: row.charEnd,
      tokenCount: row.tokenCount,
    }));
  }

  async hydrate(chunkIds: string[]): Promise<HydratedChunk[]> {
    if (chunkIds.length === 0) return [];
    const rows = await executor(this.db)
      .select({
        chunkId: documentChunks.id,
        documentId: documentChunks.documentId,
        documentTitle: documents.title,
        content: documentChunks.content,
        headingPath: documentChunks.headingPath,
        pageNumber: documentChunks.pageNumber,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documents.id, documentChunks.documentId))
      .where(
        and(
          inArray(documentChunks.id, chunkIds),
          isNull(documents.deletedAt),
          eq(documents.status, 'indexed'),
        ),
      );
    return rows;
  }
}

/**
 * pgvector adapter. Cosine distance (<=>) on normalised vectors; similarity = 1 - distance.
 * On pgvector ≥ 0.8 we enable iterative index scans so a project filter doesn't starve the
 * HNSW index of candidates (the classic "filtered ANN returns too few rows" problem).
 */
export class PgvectorSearchRepository implements VectorSearchRepository {
  private iterativeScan: Promise<boolean> | null = null;

  constructor(private readonly db: Database) {}

  async upsert(
    entries: {
      chunkId: string;
      organizationId: string;
      projectId: string;
      model: string;
      embedding: number[];
    }[],
  ): Promise<void> {
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100);
      if (batch.length === 0) continue;
      await executor(this.db)
        .insert(chunkEmbeddings)
        .values(batch)
        .onConflictDoUpdate({
          target: [chunkEmbeddings.chunkId, chunkEmbeddings.model],
          set: { embedding: sql`excluded.embedding` },
        });
    }
  }

  async deleteForDocument(documentId: string): Promise<void> {
    await executor(this.db)
      .delete(chunkEmbeddings)
      .where(
        inArray(
          chunkEmbeddings.chunkId,
          executor(this.db)
            .select({ id: documentChunks.id })
            .from(documentChunks)
            .where(eq(documentChunks.documentId, documentId)),
        ),
      );
  }

  async search(query: { projectId: string; model: string; embedding: number[]; limit: number }) {
    const vector = `[${query.embedding.join(',')}]`;
    const distance = sql<number>`${chunkEmbeddings.embedding} <=> ${vector}::vector`;
    const run = async (q: ReturnType<typeof executor>) =>
      q
        .select({ chunkId: chunkEmbeddings.chunkId, distance })
        .from(chunkEmbeddings)
        .where(
          and(
            eq(chunkEmbeddings.projectId, query.projectId),
            eq(chunkEmbeddings.model, query.model),
          ),
        )
        .orderBy(distance)
        .limit(query.limit);
    let rows: { chunkId: string; distance: number }[];
    if (await this.supportsIterativeScan()) {
      rows = await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
        return run(tx);
      });
    } else {
      rows = await run(executor(this.db));
    }
    return rows.map((row) => ({
      chunkId: row.chunkId,
      similarity: Number((1 - Number(row.distance)).toFixed(6)),
    }));
  }

  private supportsIterativeScan(): Promise<boolean> {
    this.iterativeScan ??= this.db
      .execute<{ extversion: string }>(
        sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
      )
      .then(({ rows }) => {
        const [major = 0, minor = 0] = (rows[0]?.extversion ?? '0.0').split('.').map(Number);
        return major > 0 || minor >= 8;
      })
      .catch(() => false);
    return this.iterativeScan;
  }
}

/** Full-text half of hybrid search: OR of stemmed terms, ranked by cover density. */
export class PostgresKeywordSearchRepository implements KeywordSearchRepository {
  constructor(private readonly db: Database) {}

  async search(query: {
    projectId: string;
    terms: string[];
    limit: number;
  }): Promise<{ chunkId: string; rank: number }[]> {
    const terms = query.terms.map((term) => term.replace(/[^a-z0-9]/g, '')).filter(Boolean);
    if (terms.length === 0) return [];
    const tsquery = terms.join(' | ');
    const { rows } = await executor(this.db).execute<{ chunk_id: string; rank: number }>(sql`
      SELECT dc.id AS chunk_id, ts_rank_cd(dc.content_tsv, q, 32) AS rank
      FROM document_chunks dc, to_tsquery('english', ${tsquery}) AS q
      WHERE dc.project_id = ${query.projectId} AND dc.content_tsv @@ q
      ORDER BY rank DESC, dc.id
      LIMIT ${query.limit}`);
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      rank: Number(Number(row.rank).toFixed(6)),
    }));
  }
}
