import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool } from '../../src/db/connection.js'
import { connect, createTestDatabase, type TestDatabase } from '../support/testDatabase.js'

// System-test finding ST-1, asserted directly: every pooled client has the server's error listener, so a
// connection that breaks while a request holds it reaches that listener instead of becoming an unhandled
// 'error' event (which ends the process). These assertions do not depend on the test runner's handling of
// unhandled errors.

let tdb: TestDatabase

beforeAll(async () => {
  tdb = await createTestDatabase()
}, 60_000)

afterAll(async () => {
  await tdb.drop()
})

describe('pooled connections and their error listener', () => {
  it('gives every physical client exactly one listener of its own, however often it is checked out', async () => {
    const pool = createPool({ connectionString: tdb.urls.app, poolMax: 2, statementTimeoutMs: 5_000 }, () => undefined)
    const seen = new Map<unknown, { held: Set<number>; idle: Set<number> }>()
    try {
      for (let i = 0; i < 500; i += 1) {
        const client = await pool.connect()
        const entry = seen.get(client) ?? { held: new Set(), idle: new Set() }
        entry.held.add(client.listenerCount('error'))
        seen.set(client, entry)
        client.release()
        entry.idle.add(client.listenerCount('error'))
      }
    } finally {
      await pool.end()
    }
    expect(seen.size).toBeGreaterThanOrEqual(1)
    for (const entry of seen.values()) {
      expect([...entry.held]).toEqual([1]) // the server's own listener; pg-pool detaches its idle listener while held
      expect([...entry.idle]).toEqual([2]) // the server's plus pg-pool's idle listener — constant, not growing
    }
  })

  it('reports a connection terminated while it is checked out to the server, and the pool serves again', async () => {
    const reported: Error[] = []
    const pool = createPool({ connectionString: tdb.urls.app, poolMax: 2, statementTimeoutMs: 5_000 }, (err) => reported.push(err))
    const superuser = connect(tdb.urls.superuser)
    try {
      const client = await pool.connect()
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
      await sql`SELECT pg_terminate_backend(${pid ?? -1})`.execute(superuser)
      await expect(client.query('SELECT 1')).rejects.toBeInstanceOf(Error)
      for (let i = 0; i < 50 && reported.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20))
      client.release(true)
      expect(reported.length).toBeGreaterThanOrEqual(1)
      expect(reported[0]).toBeInstanceOf(Error)
      expect((await pool.query<{ one: number }>('SELECT 1 AS one')).rows[0]?.one).toBe(1)
    } finally {
      await pool.end()
      await superuser.destroy()
    }
  })
})
