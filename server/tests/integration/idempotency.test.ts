import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { sendIdempotent } from '../../src/http/idempotency.js'
import { runMaintenance } from '../../src/maintenance.js'
import { createHarness, insertUser, login, ORIGIN, SAME_ORIGIN, SESSIONS, type Harness } from '../support/appHarness.js'

// The retry-safety mechanism of the online-only application (decision D-05;
// identity-and-access §6.1), exercised through a test-only route that
// creates a job title. The admin API uses the same mechanism (1B-2b).

let h: Harness
let app: FastifyInstance
let cookie: string

beforeAll(async () => {
  h = await createHarness()
  app = buildApp({ db: h.appDb, logger: false, publicOrigin: ORIGIN, sessions: SESSIONS })
  app.post(
    '/test/job-titles',
    {
      config: { access: { kind: 'authenticated' } },
      schema: {
        body: {
          type: 'object',
          properties: { name: { type: 'string' }, failAfterWrite: { type: 'boolean' }, delayMs: { type: 'integer' } },
          required: ['name'],
          additionalProperties: false
        }
      }
    },
    (request, reply) =>
      sendIdempotent(h.appDb, request, reply, async (trx) => {
        const body = request.body as { name: string; failAfterWrite?: boolean; delayMs?: number }
        const row = await trx.insertInto('job_titles').values({ name: body.name }).returning(['id', 'name']).executeTakeFirstOrThrow()
        if (body.delayMs !== undefined) await sql`SELECT pg_sleep(${body.delayMs / 1000})`.execute(trx)
        // Simulates the connection or server failing after the write but before commit.
        if (body.failAfterWrite === true) throw new Error('simulated failure after the write, before commit')
        return { status: 201, body: row }
      })
  )
  await app.ready()
  await insertUser(h, { username: 'retry.user' })
  await insertUser(h, { username: 'other.user' })
  cookie = await login(h, 'retry.user')
})

afterAll(async () => {
  await app.close()
  await h.close()
})

const post = (payload: Record<string, unknown>, key: string | undefined, as = cookie) =>
  app.inject({
    method: 'POST',
    url: '/test/job-titles',
    payload,
    headers: { ...SAME_ORIGIN, cookie: as, ...(key === undefined ? {} : { 'idempotency-key': key }) }
  })

const count = async (name: string): Promise<number> => {
  const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM wam.job_titles WHERE name = ${name}`.execute(h.ownerDb)
  return rows[0]?.n ?? -1
}

describe('Idempotency-Key', () => {
  it('is required for the operation', async () => {
    for (const key of [undefined, 'not-a-uuid']) {
      const res = await post({ name: 'Needs key' }, key)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } })
    }
    expect(await count('Needs key')).toBe(0)
  })

  it('replays the original result when a request is retried after a lost response — the change happens once', async () => {
    const key = randomUUID()
    const first = await post({ name: 'Keeper' }, key)
    const retry = await post({ name: 'Keeper' }, key)
    expect(first.statusCode).toBe(201)
    expect(first.headers['idempotency-replayed']).toBe('false')
    expect(retry.statusCode).toBe(201)
    expect(retry.headers['idempotency-replayed']).toBe('true')
    expect(retry.json()).toEqual(first.json())
    expect(await count('Keeper')).toBe(1)
  })

  it('treats concurrent duplicates (double-click, retry while the first is still running) as one operation', async () => {
    const key = randomUUID()
    const results = await Promise.all([post({ name: 'Concurrent', delayMs: 200 }, key), post({ name: 'Concurrent', delayMs: 200 }, key)])
    expect(results.map((r) => r.statusCode)).toEqual([201, 201])
    expect(results.map((r) => r.headers['idempotency-replayed']).sort()).toEqual(['false', 'true'])
    expect(await count('Concurrent')).toBe(1)
  })

  it('refuses the same key for a different request', async () => {
    const key = randomUUID()
    expect((await post({ name: 'Original' }, key)).statusCode).toBe(201)
    const res = await post({ name: 'Different' }, key)
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } })
    expect(await count('Different')).toBe(0)
  })

  it('stores nothing when the operation fails before commit, so the retry runs it exactly once', async () => {
    const key = randomUUID()
    const failed = await post({ name: 'Unconfirmed', failAfterWrite: true }, key)
    expect(failed.statusCode).toBe(500)
    expect(await count('Unconfirmed')).toBe(0) // the write was rolled back, not half-saved
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM wam.idempotency_keys WHERE key = ${key}::uuid`.execute(h.ownerDb)
    expect(rows[0]?.n).toBe(0)

    const retry = await post({ name: 'Unconfirmed' }, key)
    expect(retry.statusCode).toBe(201)
    expect(retry.headers['idempotency-replayed']).toBe('false')
    expect(await count('Unconfirmed')).toBe(1)
  })

  it('keeps keys per user: another user’s identical key is an independent request', async () => {
    const key = randomUUID()
    expect((await post({ name: 'Per user A' }, key)).statusCode).toBe(201)
    const other = await login(h, 'other.user')
    const res = await post({ name: 'Per user B' }, key, other)
    expect(res.statusCode).toBe(201)
    expect(res.headers['idempotency-replayed']).toBe('false')
  })

  it('does not depend on the order of fields in the retried body', async () => {
    const key = randomUUID()
    expect((await post({ name: 'Ordered', delayMs: 0 }, key)).statusCode).toBe(201)
    const reordered = await app.inject({
      method: 'POST',
      url: '/test/job-titles',
      headers: { ...SAME_ORIGIN, cookie, 'idempotency-key': key, 'content-type': 'application/json' },
      payload: '{"delayMs":0,"name":"Ordered"}'
    })
    expect(reordered.headers['idempotency-replayed']).toBe('true')
  })
})

describe('maintenance', () => {
  it('removes only expired security records, never audit events', async () => {
    await sql`UPDATE wam.idempotency_keys SET created_at = now() - interval '2 days'`.execute(h.superDb)
    await sql`UPDATE wam.sessions SET revoked_at = now() - interval '8 days', revoked_reason = 'logout', created_at = now() - interval '9 days'`.execute(
      h.superDb
    )
    const before = await sql<{ n: number }>`SELECT count(*)::int AS n FROM wam.audit_events`.execute(h.ownerDb)
    const result = await runMaintenance(h.appDb)
    expect(result.idempotencyKeys).toBeGreaterThan(0)
    expect(result.sessions).toBeGreaterThan(0)
    const after = await sql<{ n: number }>`SELECT count(*)::int AS n FROM wam.audit_events`.execute(h.ownerDb)
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
  })
})
