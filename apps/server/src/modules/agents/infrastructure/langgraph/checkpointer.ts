import { MemorySaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type pg from 'pg';

export const CHECKPOINT_SCHEMA = 'langgraph';

/**
 * Durable checkpoints in Postgres (schema "langgraph", one thread per run). setup() creates the
 * tables and is run by the migrate command, not at every boot.
 */
export function createPostgresCheckpointer(pool: pg.Pool): PostgresSaver {
  return new PostgresSaver(pool, undefined, { schema: CHECKPOINT_SCHEMA });
}

export async function setupCheckpointTables(pool: pg.Pool): Promise<void> {
  await createPostgresCheckpointer(pool).setup();
}

/** For unit tests and single-process experiments: checkpoints live in memory only. */
export function createMemoryCheckpointer(): MemorySaver {
  return new MemorySaver();
}
