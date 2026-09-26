import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionRunner } from '../../shared-kernel/ports';
import type { Database, Executor, Transaction } from './client';

/**
 * Ambient transactions.
 *
 * `run(work)` opens a transaction and stores it in AsyncLocalStorage for the duration of
 * `work`. Repositories ask `executor()` for "the transaction if one is open, otherwise
 * the pool", so a use case can call several modules' repositories and have all writes
 * commit or roll back together, without threading a `tx` argument through every call.
 *
 * Trade-off: the transaction boundary is invisible at the call site of a repository
 * method. Keep `run()` calls in application services (never in repositories) so the
 * boundary stays easy to find.
 */
const storage = new AsyncLocalStorage<Transaction>();

export class DrizzleTransactionRunner implements TransactionRunner {
  constructor(private readonly db: Database) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    if (storage.getStore()) return work(); // join the outer transaction
    return this.db.transaction((tx) => storage.run(tx, work));
  }
}

/** The open transaction for the current async context, or the pool-backed database. */
export function executor(db: Database): Executor {
  return storage.getStore() ?? db;
}

export function inTransaction(): boolean {
  return storage.getStore() !== undefined;
}
