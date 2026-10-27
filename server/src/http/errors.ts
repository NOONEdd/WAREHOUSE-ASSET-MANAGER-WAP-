import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

// One error shape for every failed request:
//   { "error": { "code": "NOT_FOUND", "message": "Not found", "requestId": "…" } }
// The message is always a fixed, generic text chosen here — never the
// internal error message, which can contain SQL, file paths or data. The
// full error is logged server-side under the same requestId.

export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string }
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

export function errorBody(code: string, message: string, requestId: string): ErrorBody {
  return { error: { code, message, requestId } }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed')
      return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Internal server error', request.id))
    }
    request.log.info({ err: error }, 'request rejected')
    if (error.validation !== undefined) {
      return reply.status(400).send(errorBody('VALIDATION_FAILED', 'Request validation failed', request.id))
    }
    const [code, message] = CLIENT_ERRORS[status] ?? ['REQUEST_REJECTED', 'Request rejected']
    return reply.status(status).send(errorBody(code, message, request.id))
  })

  app.setNotFoundHandler((request, reply) => reply.status(404).send(errorBody('NOT_FOUND', 'Not found', request.id)))
}
