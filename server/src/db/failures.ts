// How a failed database operation is classified for the client (decision O-21 as recommended in the
// 2026-10-30 review): by SQLSTATE and Node error code, never by message text — except for the few errors
// node-postgres and pg-pool raise without any code, recognized by their fixed library texts.
//
//   unavailable  the database cannot be reached or dropped the connection: SQLSTATE class 08, 57P01–57P03
//                (shutdown, crash, starting up), 53300 (too many connections), a refused or broken socket,
//                pg-pool's connection-wait timeout
//   timeout      the statement was cancelled: 57014 (statement timeout), 55P03 (lock timeout)
//   transient    PostgreSQL rolled the transaction back to resolve a conflict: 40001, 40P01
//
// In all three cases PostgreSQL has rolled back whatever the transaction did — unless the connection broke
// while COMMIT was in flight (see transaction.ts).

export type DatabaseFailureKind = 'unavailable' | 'timeout' | 'transient'

const UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300'])
const TIMEOUT_SQLSTATES = new Set(['57014', '55P03'])
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01'])
const SOCKET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'])
// node-postgres 8 (lib/client.js) and pg-pool 3 (index.js) raise these as plain Errors.
const DRIVER_MESSAGES = new Set([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
  'timeout exceeded when trying to connect'
])

export function databaseFailureKind(err: unknown): DatabaseFailureKind | null {
  if (!(err instanceof Error)) return null
  const { code, syscall } = err as { code?: unknown; syscall?: unknown }
  if (typeof code === 'string') {
    if (/^08[0-9A-Z]{3}$/.test(code) || UNAVAILABLE_SQLSTATES.has(code)) return 'unavailable'
    if (TIMEOUT_SQLSTATES.has(code)) return 'timeout'
    if (TRANSIENT_SQLSTATES.has(code)) return 'transient'
    // A socket error while connecting (refused, missing Unix socket, unreachable host) or on an open connection.
    if (SOCKET_CODES.has(code) || syscall === 'connect') return 'unavailable'
  }
  return DRIVER_MESSAGES.has(err.message) ? 'unavailable' : null
}

/**
 * A write (one Idempotency-Key transaction) that failed because of the database, with what is known about its
 * effect: `not_applied` when it failed before COMMIT was sent (PostgreSQL rolled it back), `unknown` when the
 * connection broke while COMMIT was in flight. The client retries with the same Idempotency-Key in both cases.
 */
export class WriteFailure extends Error {
  readonly outcome: 'not_applied' | 'unknown'
  readonly failure: unknown

  constructor(outcome: 'not_applied' | 'unknown', failure: unknown) {
    super(outcome === 'unknown' ? 'database connection lost during commit' : 'database write failed', { cause: failure })
    this.name = 'WriteFailure'
    this.outcome = outcome
    this.failure = failure
  }
}
