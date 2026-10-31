import type { FastifyInstance, FastifyRequest } from 'fastify'
import { buildApp } from './app.js'
import { describeDatabaseTarget, loadConfig, type Env, type LogLevel } from './config.js'
import { createDatabase, createPool } from './db/connection.js'
import { assertDatabaseReadyForServer } from './db/safety.js'
import { runImportRetention } from './imports/imports.js'
import { IMPORT_RETENTION_INTERVAL_MS, MAINTENANCE_INTERVAL_MS, runMaintenance } from './maintenance.js'

/**
 * What a request log line records: Fastify's default fields, with the URL's query string left out. Query
 * strings carry search terms — a person's name among them (`/persons?q=…`) — and a log line is beyond the
 * reach of erasure (decision PD-05; found by the system test). Path parameters are ids only.
 */
export function requestLogFields(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url.split('?')[0],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort
  }
}

/** The server's pino options (JSON lines on stdout). */
export function loggerOptions(level: LogLevel) {
  return {
    level,
    // Fastify's default request serializer logs no headers today; this
    // keeps credentials out of the logs if that ever changes.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]'
    },
    serializers: { req: requestLogFields }
  }
}

export interface RunningServer {
  readonly app: FastifyInstance
  /** For example http://127.0.0.1:3000 */
  readonly url: string
  /** Stops accepting requests, waits for in-flight ones, then closes the pool. */
  close(): Promise<void>
}

/**
 * Validates configuration, refuses an unsafe database (src/db/safety.ts),
 * then listens. Nothing is listening if any step fails, and the pool is
 * closed again before the error propagates.
 */
export async function startServer(env: Env): Promise<RunningServer> {
  const config = loadConfig(env)
  let app: FastifyInstance | undefined
  const pool = createPool(config.database, (err) => {
    if (app === undefined) console.error(`database connection failed: ${err.message}`)
    else app.log.error({ err }, 'database connection failed')
  })
  const db = createDatabase(pool)
  try {
    await assertDatabaseReadyForServer(db)
    app = buildApp({
      db,
      publicOrigin: config.publicOrigin,
      sessions: config.sessions,
      mfaEncryptionKey: config.mfaEncryptionKey,
      importEnabled: config.importEnabled,
      logger: loggerOptions(config.logLevel)
    })
    const url = await app.listen({ host: config.http.host, port: config.http.port })
    app.log.info(
      {
        environment: config.environment,
        publicOrigin: config.publicOrigin,
        database: describeDatabaseTarget(config.database.connectionString),
        importEnabled: config.importEnabled
      },
      'server started'
    )
    const running = app
    const maintenance = setInterval(() => {
      runMaintenance(db).then(
        (result) => {
          running.log.info({ removed: result }, 'maintenance completed')
        },
        (err: unknown) => {
          running.log.error({ err }, 'maintenance failed')
        }
      )
    }, MAINTENANCE_INTERVAL_MS)
    maintenance.unref()
    let retentionRun: Promise<void> = Promise.resolve()
    const retention = (): void => {
      retentionRun = runImportRetention(db).then(
        (result) => {
          running.log.info({ retention: result }, 'import retention completed')
        },
        (err: unknown) => {
          running.log.error({ err }, 'import retention failed')
        }
      )
    }
    retention()
    const retentionTimer = setInterval(retention, IMPORT_RETENTION_INTERVAL_MS)
    retentionTimer.unref()
    return {
      app: running,
      url,
      close: async () => {
        clearInterval(maintenance)
        clearInterval(retentionTimer)
        await retentionRun
        await running.close()
        await db.destroy()
      }
    }
  } catch (err) {
    await app?.close()
    await db.destroy()
    throw err
  }
}
