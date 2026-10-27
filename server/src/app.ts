import { randomUUID } from 'node:crypto'
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import { MAX_SESSIONS_PER_USER, type SessionSettings } from './auth/sessions.js'
import type { SessionConfig } from './config.js'
import type { Database } from './db/connection.js'
import { registerAuthorization } from './http/authorization.js'
import { cookieSettingsFor } from './http/cookies.js'
import { registerErrorHandling } from './http/errors.js'
import { registerForgeryProtection } from './http/forgery.js'
import { registerHealthRoutes } from './http/health.js'
import { registerAdminCatalogRoutes } from './http/routes/adminCatalogRoutes.js'
import { registerAdminUserRoutes } from './http/routes/adminUserRoutes.js'
import { registerAuthRoutes } from './http/routes/authRoutes.js'
import { registerMeRoutes } from './http/routes/meRoutes.js'

export interface AppOptions {
  readonly db: Kysely<Database>
  /** `false` disables logging (tests); otherwise pino options. */
  readonly logger: NonNullable<FastifyServerOptions['logger']>
  /** See AppConfig.publicOrigin. */
  readonly publicOrigin: string
  readonly sessions: SessionConfig
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
    // set to the proxy's address, never `true` (ASVS 5.0.0 V15.3.4).
    trustProxy: false,
    // API bodies are small JSON documents; file uploads get their own limits.
    bodyLimit: 64 * 1024,
    // Reject fields a schema does not list instead of silently dropping
    // them (Fastify's default), so mass assignment fails loudly (V15.3.3).
    ajv: { customOptions: { removeAdditional: false } }
  })

  const https = options.publicOrigin.startsWith('https://')
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id)
    // API responses are per-user data; never let a browser or proxy cache them (ASVS 5.0.0 V14.3.2).
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff') // V3.4.4
    reply.header('referrer-policy', 'no-referrer') // V3.4.5
    // JSON responses need no content and must never be framed (V3.4.3, V3.4.6).
    // The web UI (Phase 1C) sets its own policy for its pages.
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
    if (https) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains') // V3.4.1
    done()
  })

  const sessions: SessionSettings = { ...options.sessions, maxPerUser: MAX_SESSIONS_PER_USER }
  const cookie = cookieSettingsFor(options.publicOrigin)

  registerErrorHandling(app)
  registerForgeryProtection(app, { db: options.db, publicOrigin: options.publicOrigin })
  // Before any route: it rejects routes without an access declaration.
  registerAuthorization(app, { db: options.db, sessions, cookie })

  registerHealthRoutes(app, { db: options.db, readinessTimeoutMs: options.readinessTimeoutMs ?? 2_000 })
  registerAuthRoutes(app, { db: options.db, sessions, cookie })
  registerMeRoutes(app, { db: options.db, sessions })
  registerAdminUserRoutes(app, { db: options.db })
  registerAdminCatalogRoutes(app, { db: options.db })
  return app
}
