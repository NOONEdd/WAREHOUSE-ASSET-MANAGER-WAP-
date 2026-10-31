import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/appError.js'
import { databaseFailureKind, WriteFailure } from '../../src/db/failures.js'
import { databaseFailureError } from '../../src/http/errors.js'

// Decision O-21 as recommended: which failures answer 503, by SQLSTATE and Node error code.

function dbError(code: string): pg.DatabaseError {
  return Object.assign(new pg.DatabaseError('synthetic', 9, 'error'), { code })
}
function systemError(code: string, syscall?: string): Error {
  return Object.assign(new Error(`${code} synthetic`), { code, ...(syscall === undefined ? {} : { syscall }) })
}

describe('databaseFailureKind', () => {
  it('classifies connection loss, timeouts and transient conflicts, and nothing else', () => {
    for (const code of ['08000', '08003', '08006', '08P01', '57P01', '57P02', '57P03', '53300']) expect(databaseFailureKind(dbError(code)), code).toBe('unavailable')
    for (const code of ['57014', '55P03']) expect(databaseFailureKind(dbError(code)), code).toBe('timeout')
    for (const code of ['40001', '40P01']) expect(databaseFailureKind(dbError(code)), code).toBe('transient')
    for (const code of ['23505', '23514', '23503', '42501', '42P01', '22P02', 'P0001', '53100', '28P01']) expect(databaseFailureKind(dbError(code)), code).toBeNull()
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']) expect(databaseFailureKind(systemError(code)), code).toBe('unavailable')
    expect(databaseFailureKind(systemError('ENOENT', 'connect'))).toBe('unavailable') // a missing Unix socket
    expect(databaseFailureKind(systemError('ENOENT', 'open'))).toBeNull()
    for (const message of ['Connection terminated unexpectedly', 'timeout exceeded when trying to connect', 'Client has encountered a connection error and is not queryable']) {
      expect(databaseFailureKind(new Error(message)), message).toBe('unavailable')
    }
    expect(databaseFailureKind(new Error('Connection terminated unexpectedly, and more'))).toBeNull() // exact texts only
    expect(databaseFailureKind(new AppError('NOT_FOUND'))).toBeNull()
    expect(databaseFailureKind('57P01')).toBeNull()
    expect(databaseFailureKind(null)).toBeNull()
  })

  it('maps to 503 codes, with the outcome only for writes', () => {
    expect(databaseFailureError(dbError('57P01'))).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503, details: undefined })
    expect(databaseFailureError(dbError('57014'))).toMatchObject({ code: 'DATABASE_TIMEOUT', status: 503 })
    expect(databaseFailureError(new WriteFailure('not_applied', dbError('57014')))).toMatchObject({ code: 'DATABASE_TIMEOUT', details: { outcome: 'not_applied' } })
    expect(databaseFailureError(new WriteFailure('not_applied', dbError('40P01')))).toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { outcome: 'not_applied' } })
    expect(databaseFailureError(new WriteFailure('unknown', new Error('Connection terminated unexpectedly')))).toMatchObject({ code: 'OUTCOME_UNKNOWN', details: { outcome: 'unknown' } })
    expect(databaseFailureError(dbError('23505'))).toBeNull()
    expect(databaseFailureError(new Error('a bug'))).toBeNull()
  })
})
