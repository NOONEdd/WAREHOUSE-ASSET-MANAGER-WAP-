import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { createDatabase, createPool, type Database } from '../../src/db/connection.js'
import { databaseFailureKind } from '../../src/db/failures.js'
import { databaseFailureError } from '../../src/http/errors.js'
import {
  assignWarehouseProfile,
  call,
  createHarness,
  insertProfile,
  insertUser,
  insertWarehouse,
  login,
  ORIGIN,
  SAME_ORIGIN,
  SESSIONS,
  type Harness
} from '../support/appHarness.js'

// Decision O-21 as recommended (2026-10-30 review): database failures answer 503 with Retry-After, and a write
// says what is known about its effect. Every failure here is real: a terminated backend, a statement that runs
// out of time, a COMMIT that loses its connection, a database that cannot be reached, a real deadlock.

let h: Harness
let warehouseId: number
let cookie: string

interface ErrorJson {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> }
}

const personsUrl = () => `/api/warehouses/${String(warehouseId)}/persons`
const createPerson = (name: string, key: string) =>
  call(h, { method: 'POST', url: personsUrl(), cookie, headers: { 'idempotency-key': key }, payload: { displayName: name } })
const renamePerson = (id: number, version: number, name: string, key: string) =>
  call(h, { method: 'PATCH', url: `${personsUrl()}/${String(id)}`, cookie, headers: { 'idempotency-key': key }, payload: { version, displayName: name } })

/** The server's backend that is running `query`, once it shows up; null if it does not within ~5 s. */
async function serverBackend(match: (query: string, waitEvent: string | null) => boolean): Promise<number | null> {
  for (let i = 0; i < 250; i += 1) {
    const { rows } = await sql<{ pid: number; query: string; wait_event: string | null }>`
      SELECT pid, query, wait_event FROM pg_stat_activity
       WHERE usename = 'wam_app' AND datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()`.execute(h.superDb)
    const found = rows.find((r) => match(r.query, r.wait_event))
    if (found !== undefined) return found.pid
    await new Promise((r) => setTimeout(r, 20))
  }
  return null
}

function expect503(res: LightMyRequestResponse, code: string, retryAfter: string, outcome?: string): void {
  expect(res.statusCode, res.body).toBe(503)
  expect(res.headers['retry-after']).toBe(retryAfter)
  const { error } = res.json<ErrorJson>()
  expect(error.code).toBe(code)
  expect(error.details).toEqual(outcome === undefined ? undefined : { outcome })
  // Nothing internal: no SQLSTATE, role, table, SQL or driver text.
  expect(res.body).not.toMatch(/57P01|57014|wam_app|persons|terminat|canceling|SELECT|COMMIT/i)
}

async function personRow(id: number): Promise<{ display_name: string | null; version: number }> {
  return h.ownerDb.selectFrom('persons').select(['display_name', 'version']).where('id', '=', String(id)).executeTakeFirstOrThrow()
}
const keyRows = async (key: string) =>
  Number((await sql<{ n: string }>`SELECT count(*) AS n FROM wam.idempotency_keys WHERE key = ${key}::uuid`.execute(h.ownerDb)).rows[0]?.n)

beforeAll(async () => {
  h = await createHarness({ appStatementTimeoutMs: 1_500 })
  warehouseId = await insertWarehouse(h, 'SYN-FAIL')
  const userId = await insertUser(h, { username: 'failure.clerk' })
  await assignWarehouseProfile(h, userId, warehouseId, await insertProfile(h, 'Failure clerk', 'warehouse', ['asset.view', 'asset.edit']))
  cookie = await login(h, 'failure.clerk')
}, 120_000)

afterAll(async () => {
  await h.close()
})

describe('O-21: a write that fails because of the database', () => {
  it('connection terminated before COMMIT: 503 SERVICE_UNAVAILABLE, outcome not_applied, nothing written; the same key then applies it once', async () => {
    const created = await createPerson('Synthetic Before', randomUUID())
    expect(created.statusCode).toBe(201)
    const person = created.json<{ id: number; version: number }>()
    const key = randomUUID()
    // Hold the person's row so the rename waits inside its transaction, then terminate the server's backend.
    const result = await h.superDb.connection().execute(async (conn) => {
      await sql`BEGIN`.execute(conn)
      await sql`SELECT 1 FROM wam.persons WHERE id = ${person.id} FOR UPDATE`.execute(conn)
      const pending = renamePerson(person.id, person.version, 'Synthetic After', key)
      const pid = await serverBackend((_q, wait) => wait === 'transactionid' || wait === 'tuple')
      expect(pid).not.toBeNull()
      await sql`SELECT pg_terminate_backend(${pid ?? -1})`.execute(h.superDb)
      const res = await pending
      await sql`ROLLBACK`.execute(conn)
      return res
    })
    expect503(result, 'SERVICE_UNAVAILABLE', '5', 'not_applied')
    expect(await personRow(person.id)).toEqual({ display_name: 'Synthetic Before', version: person.version })
    expect(await keyRows(key)).toBe(0)

    const retried = await renamePerson(person.id, person.version, 'Synthetic After', key)
    expect(retried.statusCode).toBe(200)
    expect(retried.headers['idempotency-replayed']).toBe('false')
    expect(await personRow(person.id)).toEqual({ display_name: 'Synthetic After', version: person.version + 1 })
    const replayed = await renamePerson(person.id, person.version, 'Synthetic After', key)
    expect([replayed.statusCode, replayed.headers['idempotency-replayed']]).toEqual([200, 'true'])
  })

  it('statement timeout: 503 DATABASE_TIMEOUT, outcome not_applied, nothing written', async () => {
    const person = (await createPerson('Synthetic Slow', randomUUID())).json<{ id: number; version: number }>()
    const key = randomUUID()
    const res = await h.superDb.connection().execute(async (conn) => {
      await sql`BEGIN`.execute(conn)
      await sql`SELECT 1 FROM wam.persons WHERE id = ${person.id} FOR UPDATE`.execute(conn)
      const r = await renamePerson(person.id, person.version, 'Synthetic Late', key) // waits past the 1.5 s statement timeout
      await sql`ROLLBACK`.execute(conn)
      return r
    })
    expect503(res, 'DATABASE_TIMEOUT', '2', 'not_applied')
    expect(await personRow(person.id)).toEqual({ display_name: 'Synthetic Slow', version: person.version })
    expect(await keyRows(key)).toBe(0)
  })

  it('connection lost while COMMIT is in flight: 503 OUTCOME_UNKNOWN; repeating with the same key settles it, applying the change once', async () => {
    // A deferred trigger makes COMMIT take a while, so the backend can be terminated during it.
    await sql.raw(`
      CREATE FUNCTION wam.zq_slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER zq_slow_commit AFTER INSERT ON wam.persons DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wam.zq_slow_commit();`).execute(h.superDb)
    const key = randomUUID()
    let res: LightMyRequestResponse
    try {
      const pending = createPerson('Synthetic Uncertain', key)
      const pid = await serverBackend((query, wait) => /^\s*commit\s*;?\s*$/i.test(query) && wait === 'PgSleep')
      expect(pid).not.toBeNull()
      await sql`SELECT pg_terminate_backend(${pid ?? -1})`.execute(h.superDb)
      res = await pending
    } finally {
      await sql.raw('DROP TRIGGER IF EXISTS zq_slow_commit ON wam.persons; DROP FUNCTION IF EXISTS wam.zq_slow_commit()').execute(h.superDb)
    }
    expect503(res, 'OUTCOME_UNKNOWN', '2', 'unknown')
    expect(res.json<ErrorJson>().error.message).toMatch(/same Idempotency-Key/)

    // Repeating with the same key is safe whichever way the COMMIT went: here it did not commit, so it applies once.
    const retried = await createPerson('Synthetic Uncertain', key)
    expect(retried.statusCode).toBe(201)
    const again = await createPerson('Synthetic Uncertain', key)
    expect([again.statusCode, again.headers['idempotency-replayed']]).toEqual([201, 'true'])
    const count = (await sql<{ n: string }>`SELECT count(*) AS n FROM wam.persons WHERE display_name = 'Synthetic Uncertain'`.execute(h.ownerDb)).rows[0]?.n
    expect(Number(count)).toBe(1)
  })

  it('a COMMIT that PostgreSQL refuses is a definite failure, not an unknown outcome', async () => {
    await sql.raw(`
      CREATE FUNCTION wam.zq_refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused' USING ERRCODE = 'P0001'; END $$;
      CREATE CONSTRAINT TRIGGER zq_refuse_commit AFTER INSERT ON wam.persons DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wam.zq_refuse_commit();`).execute(h.superDb)
    try {
      // More refused COMMITs than the pool has connections: a connection kept after a failed COMMIT would
      // exhaust the pool and the requests below would time out waiting for one.
      for (let i = 0; i < 3; i += 1) {
        const key = randomUUID()
        const res = await createPerson('Synthetic Refused', key)
        expect(res.statusCode).toBe(500)
        expect(res.json<ErrorJson>().error.code).toBe('INTERNAL_ERROR')
        expect(await keyRows(key)).toBe(0)
      }
    } finally {
      await sql.raw('DROP TRIGGER IF EXISTS zq_refuse_commit ON wam.persons; DROP FUNCTION IF EXISTS wam.zq_refuse_commit()').execute(h.superDb)
    }
    // The pool is still healthy afterwards (each failed COMMIT released its connection).
    const started = Date.now()
    for (let i = 0; i < 4; i += 1) expect((await call(h, { method: 'GET', url: personsUrl(), cookie })).statusCode).toBe(200)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

describe('O-21: reads and sign-in when the database cannot be reached', () => {
  let down: ReturnType<typeof buildApp>
  let downDb: Kysely<Database>

  beforeAll(async () => {
    downDb = createDatabase(
      createPool({ connectionString: 'postgresql://wam_app@%2Ftmp%2Fwam-no-such-socket-dir:5432/wam', poolMax: 2, statementTimeoutMs: 1_000 }, () => undefined)
    )
    down = buildApp({ db: downDb, logger: false, publicOrigin: ORIGIN, sessions: SESSIONS, mfaEncryptionKey: h.mfaKey })
    await down.ready()
  })
  afterAll(async () => {
    await down.close()
    await downDb.destroy()
  })

  it('answers 503 SERVICE_UNAVAILABLE with Retry-After, never 401 or 500; liveness stays 200 and readiness 503', async () => {
    // A well-formed session token, so the server has to ask the database about it.
    const me = await down.inject({ method: 'GET', url: '/api/me', headers: { cookie: `wam_session=${'A'.repeat(43)}` } })
    expect503(me, 'SERVICE_UNAVAILABLE', '5')
    const signIn = await down.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: SAME_ORIGIN,
      payload: { username: 'failure.clerk', password: 'whatever-it-is' }
    })
    expect503(signIn, 'SERVICE_UNAVAILABLE', '5')
    expect((await down.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200)
    expect((await down.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503)
  })
})

describe('O-21: classification', () => {
  it('a real deadlock (40P01) is transient: 503 SERVICE_UNAVAILABLE; an ordinary constraint failure is not a database failure', async () => {
    const a = h.superDb
    const b = createDatabase(createPool({ connectionString: h.tdb.urls.superuser, poolMax: 1, statementTimeoutMs: 10_000 }, () => undefined))
    let deadlock: unknown
    try {
      await sql.raw('CREATE TABLE public.zq_deadlock (id int PRIMARY KEY); INSERT INTO public.zq_deadlock VALUES (1), (2)').execute(a)
      const run = (db: Kysely<Database>, first: number, second: number) =>
        db.transaction().execute(async (trx) => {
          await sql`UPDATE public.zq_deadlock SET id = id WHERE id = ${first}`.execute(trx)
          await new Promise((r) => setTimeout(r, 200))
          await sql`UPDATE public.zq_deadlock SET id = id WHERE id = ${second}`.execute(trx)
        })
      const results = await Promise.allSettled([run(a, 1, 2), run(b, 2, 1)])
      deadlock = results.find((r) => r.status === 'rejected')?.reason
    } finally {
      await sql.raw('DROP TABLE IF EXISTS public.zq_deadlock').execute(a)
      await b.destroy()
    }
    expect((deadlock as { code?: string }).code).toBe('40P01')
    expect(databaseFailureKind(deadlock)).toBe('transient')
    expect(databaseFailureError(deadlock)?.code).toBe('SERVICE_UNAVAILABLE')

    const unique = await sql`INSERT INTO wam.warehouses (code, name) VALUES ('SYN-FAIL', 'Duplicate')`.execute(h.ownerDb).catch((e: unknown) => e)
    expect((unique as { code?: string }).code).toBe('23505')
    expect(databaseFailureKind(unique)).toBeNull()
    expect(databaseFailureError(unique)).toBeNull()
  })
})
