/**
 * Cross-module ports: capabilities several modules need, defined as interfaces so the
 * application layer never imports a concrete database or clock.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * Runs work inside one database transaction. Repositories called inside `work`
 * automatically join it (see platform/database/transaction.ts), so a use case can write
 * to several modules atomically without passing transaction handles around.
 * Nested calls join the outer transaction.
 */
export interface TransactionRunner {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/** The authenticated principal performing an operation. */
export interface Actor {
  userId: string;
  sessionId: string | null;
}
