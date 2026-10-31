import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/connection.js'
import { safeErrorSummary } from '../logPrivacy.js'

// Health endpoints for the reverse proxy / process supervisor. They report
// only "ok" or "unavailable": no version, hostname, database name or error
// text, none of which an unauthenticated caller needs.
//
//   GET /health/live   the process is up and serving HTTP (never touches the database)
//   GET /health/ready  the database answers a trivial query within the timeout

const statusSchema = {
  type: 'object',
  properties: { status: { type: 'string' } },
  required: ['status'],
  additionalProperties: false
} as const

export interface HealthOptions {
  readonly db: Kysely<Database>
  readonly readinessTimeoutMs: number
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthOptions): void {
  const config = { access: { kind: 'public' } } as const
  app.get('/health/live', { config, schema: { response: { 200: statusSchema } } }, () => ({ status: 'ok' }))

  app.get('/health/ready', { config, schema: { response: { 200: statusSchema, 503: statusSchema } } }, async (request, reply) => {
    try {
      await withTimeout(sql`SELECT 1`.execute(options.db), options.readinessTimeoutMs)
      return { status: 'ok' }
    } catch (err) {
      request.log.warn({ err: safeErrorSummary(err) }, 'readiness check failed: database unavailable')
      return reply.status(503).send({ status: 'unavailable' })
    }
  })
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms`))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
