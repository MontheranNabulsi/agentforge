import { sql } from 'drizzle-orm';
import { outboxEvents } from '../../db/schema';
import { newId } from '../../shared-kernel/ids';
import type { BackgroundJobs, EnqueueOptions, JobTopic, JobTopics } from '../../shared-kernel/jobs';
import type { Database } from '../database/client';
import { executor } from '../database/transaction';
import { requestContext } from '../observability/request-context';

export const OUTBOX_CHANNEL = 'outbox_events';

/**
 * Writes background-work requests to the outbox table using the *current* transaction,
 * then signals the relay with NOTIFY (delivered only when that transaction commits).
 */
export class OutboxWriter implements BackgroundJobs {
  constructor(private readonly db: Database) {}

  async enqueue<T extends JobTopic>(
    topic: T,
    payload: JobTopics[T],
    options: EnqueueOptions = {},
  ): Promise<void> {
    const ctx = requestContext.get();
    const q = executor(this.db);
    await q.insert(outboxEvents).values({
      id: newId(),
      topic,
      payload: { ...payload, meta: { requestId: ctx?.requestId, traceparent: ctx?.traceId } },
      dedupeKey: options.dedupeKey ?? null,
      availableAt: new Date(Date.now() + (options.delayMs ?? 0)),
    });
    await q.execute(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, ${topic})`);
  }
}
