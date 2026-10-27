import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '../../src/db/connection.js'
import { ConfigError } from '../../src/config.js'
import { createMigrator } from '../../src/db/migrator.js'
import { DatabaseNotReadyError } from '../../src/db/safety.js'
import { startServer } from '../../src/server.js'
import { connect, createTestDatabase, serverEnv, type TestDatabase } from '../support/testDatabase.js'

// The real entry path (startServer → listen on a real port) against a real
// database, as `npm start` runs it.

let tdb: TestDatabase
let superuser: Kysely<Database>

beforeAll(async () => {
  tdb = await createTestDatabase()
  superuser = connect(tdb.urls.superuser)
  const owner = connect(tdb.urls.owner)
  try {
    const { error } = await createMigrator(owner).migrateToLatest()
    expect(error).toBeUndefined()
  } finally {
    await owner.destroy()
  }
})

afterAll(async () => {
  await superuser.destroy()
  await tdb.drop()
})

describe('startServer', () => {
  it('serves /health/live and /health/ready over HTTP when connected as wam_app', async () => {
    const server = await startServer(serverEnv(tdb.urls.app))
    try {
      const live = await fetch(`${server.url}/health/live`)
      expect([live.status, await live.json()]).toEqual([200, { status: 'ok' }])
      const ready = await fetch(`${server.url}/health/ready`)
      expect([ready.status, await ready.json()]).toEqual([200, { status: 'ok' }])
    } finally {
      await server.close()
    }
  })

  it('reports not-ready (503) when the database stops accepting the server, while staying live', async () => {
    const server = await startServer(serverEnv(tdb.urls.app))
    try {
      expect((await fetch(`${server.url}/health/ready`)).status).toBe(200)
      await sql.raw(`REVOKE CONNECT ON DATABASE "${tdb.name}" FROM wam_app`).execute(superuser)
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                WHERE datname = ${tdb.name} AND usename = 'wam_app'`.execute(superuser)

      const ready = await fetch(`${server.url}/health/ready`)
      expect([ready.status, await ready.json()]).toEqual([503, { status: 'unavailable' }])
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200)
    } finally {
      await sql.raw(`GRANT CONNECT ON DATABASE "${tdb.name}" TO wam_app`).execute(superuser)
      await server.close()
    }
  })

  it('refuses to start as the migration role', async () => {
    await expect(startServer(serverEnv(tdb.urls.owner))).rejects.toBeInstanceOf(DatabaseNotReadyError)
  })

  it('refuses to start with invalid configuration, before connecting to anything', async () => {
    await expect(startServer(serverEnv(tdb.urls.app, { WAM_ENV: 'staging' }))).rejects.toBeInstanceOf(ConfigError)
  })
})
