/** Postgres error helpers: map constraint violations to domain meaning at the edge of infrastructure. */

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

function pgError(error: unknown): PgErrorLike | null {
  let current: unknown = error;
  // drizzle wraps driver errors; walk the cause chain.
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      const candidate = current as PgErrorLike;
      if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code))
        return candidate;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = pgError(error);
  return pg?.code === '23505' && (constraint === undefined || pg.constraint === constraint);
}

export function isForeignKeyViolation(error: unknown): boolean {
  return pgError(error)?.code === '23503';
}

export function violatedConstraint(error: unknown): string | undefined {
  return pgError(error)?.constraint;
}
