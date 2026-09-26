import { sql } from 'drizzle-orm';
import type pg from 'pg';
import type { JobTopic } from '../../shared-kernel/jobs';
import type { Database } from '../database/client';
import type { Logger } from '../observability/logger';
import { OUTBOX_CHANNEL } from './outbox';
import { jobIdFor, TOPIC_ROUTES, type QueueRegistry } from './queues';

interface OutboxRow extends Record<string, unknown> {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  attempts: number;
}

/**
 * Moves committed outbox rows into BullMQ.
 *
 * - Wakes immediately on NOTIFY (sub-10 ms latency for chat), and polls as a safety net.
 * - `FOR UPDATE SKIP LOCKED` lets several relays run without double-processing a row.
 * - Enqueueing is at-least-once: if the process dies after `add` but before marking the row,
 *   the row is sent again. The jobId (dedupe key) makes that duplicate a no-op in BullMQ, and
 *   job handlers are idempotent for the cases where it isn't.
 */
export class OutboxRelay {
  private listener: pg.PoolClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly deps: {
      db: Database;
      pool: pg.Pool;
      queues: QueueRegistry;
      logger: Logger;
      pollIntervalMs: number;
      batchSize?: number;
    },
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    try {
      this.listener = await this.deps.pool.connect();
      this.listener.on('notification', () => this.trigger());
      this.listener.on('error', (error) => {
        this.deps.logger.warn(
          { err: error },
          'outbox listener connection error; relying on polling',
        );
      });
      await this.listener.query(`LISTEN ${OUTBOX_CHANNEL}`);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'could not LISTEN for outbox events; polling only');
    }
    this.timer = setInterval(() => this.trigger(), this.deps.pollIntervalMs);
    this.trigger();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.listener) {
      try {
        await this.listener.query(`UNLISTEN ${OUTBOX_CHANNEL}`);
      } catch {
        // connection may already be gone
      }
      this.listener.release();
      this.listener = null;
    }
  }

  /** Coalesces bursts of notifications into sequential drains. */
  private trigger(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.rerun = true;
      return;
    }
    this.draining = true;
    void this.drainUntilEmpty()
      .catch((error: unknown) => this.deps.logger.error({ err: error }, 'outbox drain failed'))
      .finally(() => {
        this.draining = false;
        if (this.rerun) {
          this.rerun = false;
          this.trigger();
        }
      });
  }

  private async drainUntilEmpty(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      const moved = await this.drainOnce();
      if (moved < (this.deps.batchSize ?? 50)) return;
    }
  }

  /** Processes one batch; returns how many rows it handled. Exposed for tests. */
  async drainOnce(): Promise<number> {
    const { db, queues, logger } = this.deps;
    return db.transaction(async (tx) => {
      const result = await tx.execute<OutboxRow>(sql`
        SELECT id, topic, payload, dedupe_key, attempts
        FROM outbox_events
        WHERE processed_at IS NULL AND available_at <= now()
        ORDER BY created_at
        LIMIT ${this.deps.batchSize ?? 50}
        FOR UPDATE SKIP LOCKED`);
      const rows = result.rows;
      for (const row of rows) {
        try {
          if (!(row.topic in TOPIC_ROUTES)) throw new Error(`unknown outbox topic ${row.topic}`);
          await queues.addForTopic(row.topic as JobTopic, row.payload, {
            jobId: jobIdFor(row.dedupe_key ?? `outbox-${row.id}`),
          });
          await tx.execute(sql`UPDATE outbox_events SET processed_at = now() WHERE id = ${row.id}`);
        } catch (error) {
          const attempts = row.attempts + 1;
          const backoffSeconds = Math.min(300, 2 ** Math.min(attempts, 8));
          logger.warn(
            { err: error, outboxId: row.id, topic: row.topic, attempts },
            'outbox enqueue failed',
          );
          await tx.execute(sql`
            UPDATE outbox_events
            SET attempts = ${attempts},
                last_error = ${error instanceof Error ? error.message : String(error)},
                available_at = now() + make_interval(secs => ${backoffSeconds})
            WHERE id = ${row.id}`);
        }
      }
      return rows.length;
    });
  }
}
