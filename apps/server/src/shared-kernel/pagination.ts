import { validationError } from './errors';

/**
 * Keyset pagination. Lists are ordered by (created_at DESC, id DESC); the cursor is the
 * (created_at, id) of the last row on the previous page, encoded so clients treat it as
 * opaque. Unlike OFFSET, a keyset cursor stays correct while rows are being inserted and
 * costs the same on page 1 and page 1,000.
 */
export interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      t?: unknown;
      i?: unknown;
    };
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') throw new Error('shape');
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime())) throw new Error('date');
    return { createdAt, id: parsed.i };
  } catch {
    throw validationError('INVALID_CURSOR', 'The pagination cursor is invalid');
  }
}

/** Given limit+1 fetched rows, split into the page and the next cursor. */
export function toPage<T extends { createdAt: Date; id: string }, D>(
  rows: T[],
  limit: number,
  map: (row: T) => D,
): { data: D[]; page: { nextCursor: string | null } } {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    data: pageRows.map(map),
    page: { nextCursor: hasMore && last ? encodeCursor(last) : null },
  };
}
