import type { Container } from './container';
import { runMigrations } from '../platform/database/migrate';
import { setupCheckpointTables } from '../modules/agents';

/** Schema migrations plus the LangGraph checkpoint tables (their own schema, managed by the library). */
export async function migrateAll(container: Container): Promise<void> {
  const started = Date.now();
  await runMigrations(container.db);
  await setupCheckpointTables(container.database.pool);
  container.logger.info({ durationMs: Date.now() - started }, 'database migrated');
}

/** SIGTERM/SIGINT: stop taking work, finish what is in flight, close connections, exit. */
export function onShutdown(container: Container, stoppers: (() => Promise<void>)[]): void {
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    container.logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 25_000);
    timer.unref();
    try {
      for (const stop of stoppers) await stop();
      await container.close();
      process.exit(0);
    } catch (error) {
      container.logger.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) =>
    container.errors.capture(reason, { where: 'unhandledRejection' }),
  );
}
