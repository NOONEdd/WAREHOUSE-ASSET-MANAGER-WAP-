// Recognizing PostgreSQL constraint errors, so the services can turn a
// constraint the database enforced into a precise client error.

interface PgError {
  readonly code?: unknown
  readonly constraint?: unknown
}

function pgError(err: unknown): PgError | null {
  return typeof err === 'object' && err !== null ? err : null
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = pgError(err)
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint)
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgError(err)?.code === '23503'
}
