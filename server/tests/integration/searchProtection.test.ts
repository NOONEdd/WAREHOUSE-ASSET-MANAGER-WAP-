import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMigrator } from '../../src/db/migrator.js'
import {
  assignWarehouseProfile,
  call,
  createHarness,
  insertProfile,
  insertUser,
  insertWarehouse,
  login,
  type Harness
} from '../support/appHarness.js'

// Decision O-20 (search cost), technical part: stored search keys (migration 0009) and the concurrency cap on
// searches (src/http/searchLimiter.ts). Searches are held in flight by a real lock on wam.assets, so "at once"
// means at once.

let h: Harness
let warehouseId: number
const cookies: Record<string, string> = {}

const assetsUrl = (rest = '') => `/api/warehouses/${String(warehouseId)}/assets${rest}`
const personsUrl = (rest = '') => `/api/warehouses/${String(warehouseId)}/persons${rest}`
const get = (who: string, url: string) => call(h, { method: 'GET', url, cookie: cookies[who] })
const busy = (res: LightMyRequestResponse) => {
  expect(res.statusCode, res.body).toBe(429)
  expect(res.headers['retry-after']).toBe('1')
  expect(res.json<{ error: { code: string } }>().error.code).toBe('SEARCH_BUSY')
}

/** Runs `fn` while a transaction holds ACCESS EXCLUSIVE on wam.assets, so every asset query waits. */
async function withAssetsLocked<T>(fn: () => Promise<T>): Promise<T> {
  return h.superDb.connection().execute(async (conn) => {
    await sql`BEGIN`.execute(conn)
    await sql`LOCK TABLE wam.assets IN ACCESS EXCLUSIVE MODE`.execute(conn)
    try {
      return await fn()
    } finally {
      await sql`ROLLBACK`.execute(conn)
    }
  })
}

/** Waits until `n` server backends are blocked on a lock. */
async function waitingBackends(n: number): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'wam_app' AND datname = current_database() AND wait_event_type = 'Lock'`.execute(h.superDb)
    if (Number(rows[0]?.n) >= n) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`expected ${String(n)} waiting searches`)
}

beforeAll(async () => {
  h = await createHarness({ searchLimits: { perUser: 2, total: 3 }, appPoolMax: 8 })
  warehouseId = await insertWarehouse(h, 'SYN-SEARCH')
  const profile = await insertProfile(h, 'Search clerk', 'warehouse', ['asset.view', 'asset.create', 'asset.edit'])
  for (const u of ['search.a', 'search.b', 'search.c']) {
    await assignWarehouseProfile(h, await insertUser(h, { username: u }), warehouseId, profile)
    cookies[u] = await login(h, u)
  }
  cookies['search.a2'] = await login(h, 'search.a') // a second session of the same user
}, 120_000)

afterAll(async () => {
  await h.close()
})

describe('O-20: at most 2 searches per user and 3 in all at once (as configured here)', () => {
  it('refuses the excess at once with 429 SEARCH_BUSY and Retry-After, counts sessions of one user together, and never limits ordinary requests', async () => {
    const results = await withAssetsLocked(async () => {
      const held = [get('search.a', assetsUrl('?q=zq')), get('search.a2', assetsUrl('/count?q=zq'))]
      await waitingBackends(2)
      const third = await get('search.a', assetsUrl('?q=zq')) // user a, first session: its 2 slots are taken
      const otherSession = await get('search.a2', personsUrl('?q=zq')) // user a, second session: same user
      const started = Date.now()
      held.push(get('search.b', assetsUrl('?q=zq'))) // user b: the 3rd and last global slot
      await waitingBackends(3)
      const global = await get('search.c', assetsUrl('?q=zq')) // user c: nothing left globally
      const refusedWithin = Date.now() - started
      const ordinary = get('search.c', assetsUrl()) // no q: not a search, not limited (it waits for the lock like the rest)
      await waitingBackends(4)
      return { third, otherSession, global, refusedWithin, settled: Promise.all([...held, ordinary]) }
    })
    busy(results.third)
    busy(results.otherSession)
    busy(results.global)
    expect(results.refusedWithin).toBeLessThan(2_000)
    for (const res of await results.settled) expect(res.statusCode).toBe(200)
    // Every slot was released: the same searches succeed now.
    for (const who of ['search.a', 'search.a2', 'search.b', 'search.c']) expect((await get(who, assetsUrl('?q=zq'))).statusCode).toBe(200)
  })

  it('a blank q is not a search', async () => {
    const res = await withAssetsLocked(async () => {
      const held = [get('search.a', assetsUrl('?q=zq')), get('search.a', assetsUrl('?q=zq'))]
      await waitingBackends(2)
      const blank = get('search.a', assetsUrl('?q=%20%20'))
      await waitingBackends(3)
      return { settled: Promise.all([...held, blank]) } // awaited only once the lock is released
    })
    expect((await res.settled).map((r) => r.statusCode)).toEqual([200, 200, 200])
  })
})

describe('O-20: stored search keys (migration 0009)', () => {
  const tricky = [
    'Laptop  Dell XPS', // NBSP and a double space
    'لپ‌تاپ ديل', // ZWNJ and Arabic yeh
    'كامپيوتر رومیزی', // Arabic kaf and yeh, Persian yeh
    'Ｍｏｎｉｔｏｒ ２４', // full-width letters and digits (NFKC)
    'Router ۱۲۳', // Persian digits
    'Cámera', // combining accent
    'Printer​‏HP' // zero-width space and RLM
  ]
  const terms = ['dell', 'لپتاپ', 'ديل', 'کامپیوتر', 'monitor 24', '123', 'cámera', 'printerhp', 'printer', 'xps', 'zz-no-match']

  it('match exactly what the name function matched, for assets and persons, and follow every rename', async () => {
    const owner = h.ownerDb
    const actor = await insertUser(h, { username: 'search.fixture', password: null })
    const itemType = Number((await sql<{ id: number }>`INSERT INTO wam.item_types (name) VALUES ('Synthetic search type') RETURNING id`.execute(owner)).rows[0]?.id)
    const status = Number((await sql<{ id: number }>`SELECT id FROM wam.asset_statuses WHERE code = 'in_stock'`.execute(owner)).rows[0]?.id)
    await owner.transaction().execute(async (trx) => {
      await sql`SELECT set_config('wam.warehouse_scope', ${String(warehouseId)}, true), set_config('wam.actor_user_id', ${String(actor)}, true)`.execute(trx)
      for (const [i, name] of tricky.entries()) {
        await sql`INSERT INTO wam.assets (warehouse_id, asset_code, name, item_type_id, status_id, origin) VALUES (${warehouseId}, ${`SYN-SK-${String(i)}`}, ${name}, ${itemType}, ${status}, 'manual')`.execute(trx)
        await sql`INSERT INTO wam.persons (warehouse_id, display_name) VALUES (${warehouseId}, ${name})`.execute(trx)
      }
    })
    const compare = async () => {
      for (const term of terms) {
        const { rows } = await sql<{ stored: string; computed: string; pstored: string; pcomputed: string }>`
          SELECT (SELECT string_agg(id::text, ',' ORDER BY id) FROM wam.assets WHERE strpos(name_key, wam.name_key(${term})) > 0) AS stored,
                 (SELECT string_agg(id::text, ',' ORDER BY id) FROM wam.assets WHERE strpos(wam.name_key(name), wam.name_key(${term})) > 0) AS computed,
                 (SELECT string_agg(id::text, ',' ORDER BY id) FROM wam.persons WHERE strpos(display_name_key, wam.name_key(${term})) > 0) AS pstored,
                 (SELECT string_agg(id::text, ',' ORDER BY id) FROM wam.persons WHERE strpos(wam.name_key(display_name), wam.name_key(${term})) > 0) AS pcomputed`.execute(owner)
        expect(rows[0]?.stored, term).toBe(rows[0]?.computed)
        expect(rows[0]?.pstored, term).toBe(rows[0]?.pcomputed)
      }
      const drift = await sql<{ n: string }>`
        SELECT (SELECT count(*) FROM wam.assets WHERE name_key IS DISTINCT FROM wam.name_key(name))
             + (SELECT count(*) FROM wam.persons WHERE display_name_key IS DISTINCT FROM wam.name_key(display_name)) AS n`.execute(owner)
      expect(drift.rows[0]?.n).toBe('0')
    }
    await compare()
    // The API finds through the stored key (a Persian-digit term against Latin digits, and the other way round).
    expect((await get('search.a', assetsUrl('?q=%DB%B1%DB%B2%DB%B3'))).json<{ assets: unknown[] }>().assets).toHaveLength(1)
    expect((await get('search.a', assetsUrl('/count?q=MONITOR%2024'))).json<{ count: number }>().count).toBe(1)

    // A rename recomputes the key; an erasure removes it with the name (PD-05).
    const person = (await get('search.a', personsUrl('?q=dell'))).json<{ persons: { id: number; version: number }[] }>().persons[0]
    expect(person).toBeDefined()
    const renamed = await call(h, {
      method: 'PATCH',
      url: personsUrl(`/${String(person?.id)}`),
      cookie: cookies['search.a'],
      headers: { 'idempotency-key': randomUUID() },
      payload: { version: person?.version, displayName: 'Synthetic Renamed' }
    })
    expect(renamed.statusCode).toBe(200)
    expect((await get('search.a', personsUrl('?q=dell'))).json<{ persons: unknown[] }>().persons).toHaveLength(0)
    expect((await get('search.a', personsUrl('?q=renamed'))).json<{ persons: unknown[] }>().persons).toHaveLength(1)
    const eraser = await insertUser(h, { username: 'search.owner', isOwner: true, password: null })
    await owner.transaction().execute(async (trx) => {
      await sql`SELECT set_config('wam.warehouse_scope', ${String(warehouseId)}, true), set_config('wam.actor_user_id', ${String(eraser)}, true)`.execute(trx)
      await sql`UPDATE wam.persons SET display_name = NULL, erased_at = now() WHERE id = ${person?.id ?? 0}`.execute(trx)
    })
    const erased = await sql<{ key: string | null }>`SELECT display_name_key AS key FROM wam.persons WHERE id = ${person?.id ?? 0}`.execute(owner)
    expect(erased.rows).toEqual([{ key: null }])
    await compare()
  })

  it('cannot be written by the server role, and revert and reapply cleanly', async () => {
    const refused = await sql`UPDATE wam.assets SET name_key = 'x'`.execute(h.appDb).catch((e: unknown) => e)
    expect((refused as { code?: string }).code).toMatch(/^(42501|428C9)$/) // no privilege, or a generated column
    const fresh = await createHarness()
    try {
      const migrator = createMigrator(fresh.ownerDb)
      const { results } = await migrator.migrateDown()
      expect(results?.map((r) => [r.migrationName, r.status])).toEqual([['0009_search_keys', 'Success']])
      const cols = async () =>
        (await sql<{ n: string }>`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'wam' AND column_name IN ('name_key', 'display_name_key')`.execute(fresh.ownerDb)).rows[0]?.n
      expect(await cols()).toBe('0')
      expect((await migrator.migrateToLatest()).error).toBeUndefined()
      expect(await cols()).toBe('2')
    } finally {
      await fresh.close()
    }
  }, 120_000)
})
