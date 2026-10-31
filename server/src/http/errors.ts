import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError, type AppErrorCode } from '../appError.js'
import { databaseFailureKind, WriteFailure } from '../db/failures.js'
import { safeErrorSummary } from '../logPrivacy.js'

// One error shape for every failed request:
//   { "error": { "code": "NOT_FOUND", "message": "Not found", "requestId": "…" } }
// The message is always a fixed text — for expected failures the one defined
// with the AppError code, otherwise a generic text chosen here — never an
// internal error message, which can contain SQL, file paths or data. The
// error is logged server-side under the same requestId, as its allowlisted
// summary only (finding NF-1: a database error's detail holds row values).
//
// Database failures (decision O-21 as recommended): an unreachable database or a dropped connection answers
// 503 SERVICE_UNAVAILABLE, a cancelled statement 503 DATABASE_TIMEOUT, a write whose COMMIT was in flight when
// the connection broke 503 OUTCOME_UNKNOWN, each with Retry-After. For a write (an Idempotency-Key request)
// `details.outcome` says what is known: `not_applied` or `unknown`; the client repeats the request with the same
// Idempotency-Key either way, which returns the stored response if it was applied and applies it once if not.

export interface ErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly requestId: string
    readonly details?: Readonly<Record<string, unknown>>
  }
}

const CLIENT_ERRORS: Readonly<Record<number, readonly [code: string, message: string]>> = {
  400: ['BAD_REQUEST', 'Bad request'],
  401: ['UNAUTHENTICATED', 'Authentication required'],
  403: ['FORBIDDEN', 'Forbidden'],
  404: ['NOT_FOUND', 'Not found'],
  405: ['METHOD_NOT_ALLOWED', 'Method not allowed'],
  406: ['NOT_ACCEPTABLE', 'Not acceptable'],
  409: ['CONFLICT', 'Conflict'],
  413: ['PAYLOAD_TOO_LARGE', 'Payload too large'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type'],
  429: ['TOO_MANY_REQUESTS', 'Too many requests']
}

export function errorBody(
  code: string,
  message: string,
  requestId: string,
  details?: Readonly<Record<string, unknown>>
): ErrorBody {
  return { error: details === undefined ? { code, message, requestId } : { code, message, requestId, details } }
}

/** Seconds a client should wait before repeating a request refused with these codes. */
const RETRY_AFTER_SECONDS: Partial<Record<AppErrorCode, number>> = {
  SEARCH_BUSY: 1,
  SERVICE_UNAVAILABLE: 5,
  DATABASE_TIMEOUT: 2,
  OUTCOME_UNKNOWN: 2
}

/** The 503 a database failure answers, or null when the error is not one. */
export function databaseFailureError(error: unknown): AppError | null {
  const failure = error instanceof WriteFailure ? error.failure : error
  const kind = databaseFailureKind(failure)
  if (error instanceof WriteFailure && error.outcome === 'unknown') return new AppError('OUTCOME_UNKNOWN', { outcome: 'unknown' })
  if (kind === null) return null
  const details = error instanceof WriteFailure ? { outcome: error.outcome } : undefined
  return new AppError(kind === 'timeout' ? 'DATABASE_TIMEOUT' : 'SERVICE_UNAVAILABLE', details)
}

function sendAppError(reply: FastifyReply, request: FastifyRequest, error: AppError): FastifyReply {
  const retryAfter = RETRY_AFTER_SECONDS[error.code]
  if (retryAfter !== undefined) void reply.header('retry-after', String(retryAfter))
  return reply.status(error.status).send(errorBody(error.code, error.message, request.id, error.details))
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      request.log.info({ code: error.code }, 'request rejected')
      return sendAppError(reply, request, error)
    }
    const unavailable = databaseFailureError(error)
    if (unavailable !== null) {
      const cause = error instanceof WriteFailure ? error.failure : error
      request.log.error({ err: safeErrorSummary(cause), code: unavailable.code, route: request.routeOptions.url ?? null }, 'request failed: database')
      return sendAppError(reply, request, unavailable)
    }
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500
    if (status >= 500) {
      request.log.error({ err: safeErrorSummary(error), route: request.routeOptions.url ?? null }, 'request failed')
      return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Internal server error', request.id))
    }
    request.log.info({ err: safeErrorSummary(error), route: request.routeOptions.url ?? null }, 'request rejected')
    if (error.validation !== undefined) {
      return reply.status(400).send(errorBody('VALIDATION_FAILED', 'Request validation failed', request.id))
    }
    const [code, message] = CLIENT_ERRORS[status] ?? ['REQUEST_REJECTED', 'Request rejected']
    return reply.status(status).send(errorBody(code, message, request.id))
  })

  app.setNotFoundHandler((request, reply) => reply.status(404).send(errorBody('NOT_FOUND', 'Not found', request.id)))
}
