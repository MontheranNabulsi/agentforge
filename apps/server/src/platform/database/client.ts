import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../../db/schema';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run a query: the pool-backed database or an open transaction. */
export type Executor = Database | Transaction;

export type DatabaseSsl = 'disable' | 'require' | 'verify';

export interface DatabaseHandle {
  pool: pg.Pool;
  db: Database;
  close(): Promise<void>;
}

export function sslOption(mode: DatabaseSsl): pg.PoolConfig['ssl'] {
  if (mode === 'disable') return false;
  // Managed Postgres poolers often present certificates from their own CA; "require"
  // encrypts without verifying the chain, "verify" also checks it against system CAs.
  return mode === 'verify' ? { rejectUnauthorized: true } : { rejectUnauthorized: false };
}

export function createDatabase(options: {
  url: string;
  ssl?: DatabaseSsl;
  maxConnections?: number;
  applicationName?: string;
}): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? 'agentforge',
    ssl: sslOption(options.ssl ?? 'disable'),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    close: () => pool.end(),
  };
}
