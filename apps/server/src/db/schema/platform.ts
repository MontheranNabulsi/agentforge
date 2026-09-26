import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, idColumn, ts } from './columns';
import { users } from './identity';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Blob storage in Postgres, used by deployments without a persistent disk (free hosting
 * wipes the filesystem on every restart). Local development uses the filesystem adapter;
 * both implement the same BlobStorage port.
 */
export const blobs = pgTable('blobs', {
  key: text('key').primaryKey(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  content: bytea('content').notNull(),
  createdAt: createdAt(),
});

/**
 * Stored responses for Idempotency-Key requests. The key row is inserted in the same
 * transaction as the work it protects, so a retried request either replays the stored
 * response or waits for the first attempt to finish; the work never runs twice.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    scope: text('scope').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'idempotency_keys_pk', columns: [t.userId, t.key] }),
    index('idempotency_keys_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Transactional outbox. Domain writes and "please do X in the background" are committed
 * together here; the worker's relay moves rows to BullMQ. This removes the dual-write
 * problem: a crash can never commit the data but lose the job, or queue a job for data
 * that was rolled back.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: idColumn(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    availableAt: ts('available_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    index('outbox_events_pending_idx')
      .on(t.availableAt)
      .where(sql`${t.processedAt} IS NULL`),
    check('outbox_events_attempts_check', sql`${t.attempts} >= 0`),
  ],
);
