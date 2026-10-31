import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../appError.js'
import { safeErrorSummary } from '../logPrivacy.js'

// One error shape for every failed request:
//   { "error": { "code": "NOT_FOUND", "message": "Not found", "requestId": "…" } }
// The message is always a fixed text — for expected failures the one defined
// with the AppError code, otherwise a generic text chosen here — never an
// internal error message, which can contain SQL, file paths or data. The
// error is logged server-side under the same requestId, as its allowlisted
// summary only (finding NF-1: a database error's detail holds row values).

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

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      request.log.info({ code: error.code }, 'request rejected')
      return reply.status(error.status).send(errorBody(error.code, error.message, request.id, error.details))
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
