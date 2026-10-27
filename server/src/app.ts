import { randomUUID } from 'node:crypto'
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from './db/connection.js'
import { registerErrorHandling } from './http/errors.js'
import { registerHealthRoutes } from './http/health.js'

export interface AppOptions {
  readonly db: Kysely<Database>
  /** `false` disables logging (tests); otherwise pino options. */
  readonly logger: NonNullable<FastifyServerOptions['logger']>
  readonly readinessTimeoutMs?: number
}

/**
 * Builds the Fastify application without listening, so tests can drive it
 * with `app.inject()`. Takes its database from the caller: nothing here
 * reads environment variables.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger,
    // Request IDs are always generated here. A client-supplied
    // X-Request-Id is ignored so callers cannot forge or collide log
    // correlation IDs.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    // Not behind a proxy yet. When nginx is added (Phase 1E) this must be
    // set to the proxy's address, never `true`.
    trustProxy: false
  })

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id)
    // API responses are per-user data from Phase 1B-2 on; never let a
    // browser or proxy cache them.
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
    done()
  })

  registerErrorHandling(app)
  registerHealthRoutes(app, { db: options.db, readinessTimeoutMs: options.readinessTimeoutMs ?? 2_000 })
  return app
}
