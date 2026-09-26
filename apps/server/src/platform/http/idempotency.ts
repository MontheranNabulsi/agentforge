import { and, eq, lt } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { idempotencyKeys } from '../../db/schema';
import { conflict, unprocessable, validationError } from '../../shared-kernel/errors';
import type { TransactionRunner } from '../../shared-kernel/ports';
import type { Database } from '../database/client';
import { isUniqueViolation } from '../database/errors';
import { executor } from '../database/transaction';
import { sha256Hex } from '../security/secure-token';

const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;
const TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Idempotency-Key support (IETF draft "The Idempotency-Key HTTP Header Field").
 *
 * The key row is written in the SAME transaction as the work. Outcomes:
 * - first request: work runs, key + response committed together;
 * - retry after success: the stored response is replayed, work does not run again;
 * - concurrent duplicate: both run the work, but only one can insert the key; the loser's
 *   transaction (including its work) rolls back and the client is told to retry;
 * - same key, different body: 422, because that is a client bug, not a retry.
 */
export class IdempotencyStore {
  constructor(
    private readonly db: Database,
    private readonly tx: TransactionRunner,
  ) {}

  static keyFrom(request: FastifyRequest, required: boolean): string | null {
    const raw = request.headers['idempotency-key'];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key) {
      if (required)
        throw validationError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header');
      return null;
    }
    if (!KEY_PATTERN.test(key)) {
      throw validationError(
        'IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key must be 8–128 URL-safe characters',
      );
    }
    return key;
  }

  static fingerprint(scope: string, body: unknown): string {
    return sha256Hex(`${scope}\n${JSON.stringify(body ?? null)}`);
  }

  async execute<T>(params: {
    userId: string;
    key: string | null;
    scope: string;
    requestHash: string;
    work: () => Promise<{ status: number; body: T }>;
  }): Promise<IdempotentResult<T>> {
    const { userId, key, scope, requestHash, work } = params;
    if (!key) {
      const result = await this.tx.run(work);
      return { ...result, replayed: false };
    }
    try {
      return await this.tx.run(async () => {
        const q = executor(this.db);
        const [existing] = await q
          .select()
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)))
          .limit(1);
        if (existing && existing.expiresAt > new Date()) {
          if (existing.requestHash !== requestHash || existing.scope !== scope) {
            throw unprocessable(
              'IDEMPOTENCY_KEY_REUSED',
              'This Idempotency-Key was used for a different request',
            );
          }
          return {
            status: existing.responseStatus,
            body: existing.responseBody as T,
            replayed: true,
          };
        }
        if (existing) {
          await q
            .delete(idempotencyKeys)
            .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
        }
        const result = await work();
        await q.insert(idempotencyKeys).values({
          userId,
          key,
          scope,
          requestHash,
          responseStatus: result.status,
          responseBody: result.body as object,
          expiresAt: new Date(Date.now() + TTL_MS),
        });
        return { ...result, replayed: false };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'idempotency_keys_pk')) {
        throw conflict(
          'IDEMPOTENCY_IN_PROGRESS',
          'A request with this Idempotency-Key is in progress; retry shortly',
        );
      }
      throw error;
    }
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const deleted = await this.db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expiresAt, now))
      .returning({ key: idempotencyKeys.key });
    return deleted.length;
  }
}
