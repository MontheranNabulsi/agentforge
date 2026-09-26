import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Local development convenience: load a .env file (current directory or the repository root)
 * into process.env before configuration is read. Real environment variables always win, and
 * production hosts set variables directly, so the file is optional everywhere.
 */
export function loadEnvFile(): void {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (!existsSync(candidate)) continue;
    const before = { ...process.env };
    process.loadEnvFile(candidate);
    Object.assign(process.env, before);
    return;
  }
}
