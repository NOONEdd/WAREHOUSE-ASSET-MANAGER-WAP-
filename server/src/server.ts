import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { describeDatabaseTarget, loadConfig, type Env } from './config.js'
import { createDatabase, createPool } from './db/connection.js'
import { assertDatabaseReadyForServer } from './db/safety.js'
import { MAINTENANCE_INTERVAL_MS, runMaintenance } from './maintenance.js'

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
    if (app === undefined) console.error(`idle database connection failed: ${err.message}`)
    else app.log.error({ err }, 'idle database connection failed')
  })
  const db = createDatabase(pool)
  try {
    await assertDatabaseReadyForServer(db)
    app = buildApp({
      db,
      publicOrigin: config.publicOrigin,
      sessions: config.sessions,
      mfaEncryptionKey: config.mfaEncryptionKey,
      logger: {
        level: config.logLevel,
        // Fastify's default request serializer logs no headers today; this
        // keeps credentials out of the logs if that ever changes.
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          censor: '[redacted]'
        }
      }
    })
    const url = await app.listen({ host: config.http.host, port: config.http.port })
    app.log.info(
      {
        environment: config.environment,
        publicOrigin: config.publicOrigin,
        database: describeDatabaseTarget(config.database.connectionString)
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
    return {
      app: running,
      url,
      close: async () => {
        clearInterval(maintenance)
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
