import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client';

/**
 * Migrations live in src/db/migrations during development and are copied next to the
 * bundle (dist/migrations) by the build. Resolve whichever exists.
 */
export function resolveMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MIGRATIONS_DIR,
    resolve(here, 'migrations'),
    resolve(here, '../migrations'),
    resolve(here, '../../db/migrations'),
    resolve(process.cwd(), 'src/db/migrations'),
    resolve(process.cwd(), 'apps/server/src/db/migrations'),
  ].filter((p): p is string => typeof p === 'string');
  const found = candidates.find((p) => existsSync(resolve(p, 'meta/_journal.json')));
  if (!found) throw new Error(`Migrations folder not found (looked in: ${candidates.join(', ')})`);
  return found;
}

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
}
