import { randomUUID } from 'node:crypto'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadAccess } from '../../src/access/access.js'
import type { Actor } from '../../src/admin/rules.js'
import { buildApp } from '../../src/app.js'
import { createDatabase, createPool, type Database } from '../../src/db/connection.js'
import { inDataContext, setChangeReason, setDataContext, setImportRow } from '../../src/db/dataContext.js'
import { commitBatch, createBatch, getBatch, previewBatch, stageRows } from '../../src/imports/imports.js'
import {
  assignWarehouseProfile,
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

// Review finding S-1: the request context (wam.warehouse_scope, wam.actor_user_id, wam.request_id,
// wam.change_reason, wam.import_row_id) is set with set_config(…, true) and must end with its transaction —
// committed, rolled back, or aborted by an error — so it can never reach the next request on a pooled
// connection. Everything here runs on ONE physical PostgreSQL connection (a pool of size 1), and each check
// asserts that the backend process id is unchanged, so "the next request" really is on the same connection.

let h: Harness
let single: Kysely<Database>
let app: FastifyInstance
let pid: number
let whA: number
let whB: number
let clerkA: number
let clerkB: number
let assetA: { id: number; version: number }
let itemType: number
const status: Record<string, number> = {}
const cookies: Record<string, string> = {}

interface Context {
  readonly pid: number
  readonly scope: string
  readonly actor: string
  readonly request: string
  readonly reason: string
  readonly importRow: string
  readonly visibleAssets: number
}

/** Reads the context the connection carries now, outside any transaction, on the single connection. */
async function connectionContext(): Promise<Context> {
  const { rows } = await sql<{ pid: number; scope: string; actor: string; request: string; reason: string; import_row: string; assets: string }>`
    SELECT pg_backend_pid() AS pid,
           coalesce(current_setting('wam.warehouse_scope', true), '') AS scope,
           coalesce(current_setting('wam.actor_user_id', true), '') AS actor,
           coalesce(current_setting('wam.request_id', true), '') AS request,
           coalesce(current_setting('wam.change_reason', true), '') AS reason,
           coalesce(current_setting('wam.import_row_id', true), '') AS import_row,
           (SELECT count(*) FROM wam.assets) AS assets`.execute(single)
  const r = rows[0]
  if (r === undefined) throw new Error('no row')
  return { pid: r.pid, scope: r.scope, actor: r.actor, request: r.request, reason: r.reason, importRow: r.import_row, visibleAssets: Number(r.assets) }
}

const EMPTY = { scope: '', actor: '', request: '', reason: '', importRow: '', visibleAssets: 0 }

async function expectClean(label: string): Promise<void> {
  const ctx = await connectionContext()
  expect(ctx.pid, `${label}: same physical connection`).toBe(pid)
  expect({ ...ctx, pid: undefined }, label).toEqual({ ...EMPTY, pid: undefined })
}

function inject(who: string, options: InjectOptions): Promise<LightMyRequestResponse> {
  const safe = options.method === undefined || options.method === 'GET'
  return app.inject({
    ...options,
    headers: { ...(safe ? {} : { ...SAME_ORIGIN, 'idempotency-key': randomUUID() }), cookie: cookies[who] ?? '', ...options.headers }
  })
}

async function actorOf(userId: number, username: string): Promise<Actor> {
  return { userId, username, access: await loadAccess(h.appDb, userId, false) }
}

beforeAll(async () => {
  h = await createHarness()
  single = createDatabase(createPool({ connectionString: h.tdb.urls.app, poolMax: 1, statementTimeoutMs: 10_000 }, () => undefined))
  app = buildApp({ db: single, logger: false, publicOrigin: ORIGIN, sessions: SESSIONS, mfaEncryptionKey: h.mfaKey })
  await app.ready()
  whA = await insertWarehouse(h, 'SYN-CTX-A')
  whB = await insertWarehouse(h, 'SYN-CTX-B')
  const perms = ['asset.view', 'asset.create', 'asset.edit', 'asset.change_status', 'asset.import'] as const
  clerkA = await insertUser(h, { username: 'ctx.a' })
  await assignWarehouseProfile(h, clerkA, whA, await insertProfile(h, 'Ctx A', 'warehouse', perms))
  clerkB = await insertUser(h, { username: 'ctx.b' })
  await assignWarehouseProfile(h, clerkB, whB, await insertProfile(h, 'Ctx B', 'warehouse', perms))
  cookies.a = await login(h, 'ctx.a')
  cookies.b = await login(h, 'ctx.b')
  itemType = Number((await sql<{ id: number }>`INSERT INTO wam.item_types (name) VALUES ('Synthetic ctx type') RETURNING id`.execute(h.ownerDb)).rows[0]?.id)
  const { rows } = await sql<{ id: number; code: string }>`SELECT id, code FROM wam.asset_statuses WHERE is_system`.execute(h.ownerDb)
  for (const r of rows) status[r.code] = r.id
  status.retired_kind = Number(
    (await sql<{ id: number }>`INSERT INTO wam.asset_statuses (name, is_active) VALUES ('Synthetic inactive status', false) RETURNING id`.execute(h.ownerDb)).rows[0]?.id
  )
  const created = await inject('a', {
    method: 'POST',
    url: `/api/warehouses/${String(whA)}/assets`,
    payload: { assetCode: 'SYN-CTX-1', name: 'Synthetic', itemTypeId: itemType, statusId: status.in_stock }
  })
  expect(created.statusCode, created.body).toBe(201)
  assetA = created.json<{ asset: { id: number; version: number } }>().asset
  pid = (await connectionContext()).pid
}, 120_000)

afterAll(async () => {
  await app.close()
  await single.destroy()
  await h.close()
})

describe('request context is transaction-local on a reused physical connection', () => {
  it('uses exactly one physical connection for every request in this file', async () => {
    const pids = new Set<number>()
    for (let i = 0; i < 5; i += 1) {
      await inject('a', { method: 'GET', url: `/api/warehouses/${String(whA)}/assets` })
      pids.add((await connectionContext()).pid)
    }
    expect([...pids]).toEqual([pid])
  })

  it('leaves nothing behind after a committed request that set every value it can (scope, actor, request, reason)', async () => {
    const res = await inject('a', {
      method: 'POST',
      url: `/api/warehouses/${String(whA)}/assets/${String(assetA.id)}/status`,
      payload: { version: assetA.version, statusId: status.damaged, reason: 'Synthetic committed reason' }
    })
    expect(res.statusCode, res.body).toBe(200)
    assetA = res.json<{ id: number; version: number }>()
    await expectClean('after a committed status change')
  })

  it('leaves nothing behind after a committed transaction whose context carries a reason and an import row', async () => {
    await inDataContext(single, { warehouseIds: [whA], actorUserId: clerkA, requestId: randomUUID(), reason: 'Synthetic context reason' }, async (trx) => {
      await setImportRow(trx, '424242')
      await setChangeReason(trx, 'Synthetic explicit reason')
      const { rows } = await sql<{ scope: string; row: string; reason: string }>`
        SELECT current_setting('wam.warehouse_scope') AS scope, current_setting('wam.import_row_id') AS row,
               current_setting('wam.change_reason') AS reason`.execute(trx)
      expect(rows[0]).toEqual({ scope: String(whA), row: '424242', reason: 'Synthetic explicit reason' })
    })
    await expectClean('after a committed transaction')
  })

  it('leaves nothing behind after a rolled-back transaction', async () => {
    await expect(
      single.transaction().execute(async (trx) => {
        await setDataContext(trx, { warehouseIds: [whA], actorUserId: clerkA, requestId: randomUUID(), reason: 'Synthetic rolled-back reason' })
        await setImportRow(trx, '515151')
        await setChangeReason(trx, 'Synthetic rolled-back explicit reason')
        throw new Error('synthetic rollback')
      })
    ).rejects.toThrow('synthetic rollback')
    await expectClean('after a rollback')
  })

  it('leaves nothing behind after a request that fails inside its transaction, after the reason was set', async () => {
    // The status is inactive: the database refuses the update after the change reason was set.
    const res = await inject('a', {
      method: 'POST',
      url: `/api/warehouses/${String(whA)}/assets/${String(assetA.id)}/status`,
      payload: { version: assetA.version, statusId: status.retired_kind, reason: 'Synthetic failing reason' }
    })
    expect(res.statusCode).toBe(400)
    await expectClean('after a failed request')
  })

  it('leaves nothing behind after an import commit that fails after setting an import row', async () => {
    const actor = await actorOf(clerkA, 'ctx.a')
    const ctx = { warehouseIds: [whA], actorUserId: clerkA, requestId: randomUUID() }
    const audit = { requestId: null, sourceIp: null }
    const batch = await inDataContext(single, ctx, async (trx) => {
      const id = await createBatch(trx, audit, actor, whA, { name: 'ctx.csv', sha256: Buffer.alloc(32, 3), sizeBytes: 1, format: 'csv' })
      await stageRows(trx, whA, id, [
        { sheetName: null, rowNumber: 2, cells: { asset_code: 'SYN-CTX-IMP-1', name: 'One', item_type: 'Synthetic ctx type', status: 'in_stock' } },
        { sheetName: null, rowNumber: 3, cells: { asset_code: 'SYN-CTX-TAKEN', name: 'Two', item_type: 'Synthetic ctx type', status: 'in_stock' } }
      ])
      return id
    })
    const version = await inDataContext(single, ctx, async (trx) => (await getBatch(trx, whA, batch, { limit: 1 })).batch.version)
    const previewed = await inDataContext(single, ctx, (trx) => previewBatch(trx, audit, actor, whA, batch, version))
    // Meanwhile the second code is taken in warehouse B: the commit fails on its second row, after
    // wam.import_row_id was set for it.
    const taken = await inject('b', {
      method: 'POST',
      url: `/api/warehouses/${String(whB)}/assets`,
      payload: { assetCode: 'SYN-CTX-TAKEN', name: 'Synthetic', itemTypeId: itemType, statusId: status.in_stock }
    })
    expect(taken.statusCode).toBe(201)
    await expect(inDataContext(single, ctx, (trx) => commitBatch(trx, audit, actor, whA, batch, previewed.batch.version))).rejects.toMatchObject({
      code: 'CODE_TAKEN'
    })
    await expectClean('after a failed import commit')
  })

  it('gives a request without a context nothing, even right after another request on the same connection', async () => {
    await inject('a', { method: 'GET', url: `/api/warehouses/${String(whA)}/assets` })
    await single.transaction().execute(async (trx) => {
      const { rows } = await sql<{ pid: number; n: string }>`SELECT pg_backend_pid() AS pid, (SELECT count(*) FROM wam.assets) AS n`.execute(trx)
      expect([rows[0]?.pid, rows[0]?.n]).toEqual([pid, '0'])
    })
    // Without an actor and scope the database refuses a write as well.
    await expect(
      single.transaction().execute((trx) => sql`INSERT INTO wam.persons (warehouse_id, display_name) VALUES (${whA}, 'Synthetic')`.execute(trx))
    ).rejects.toThrow()
    await expectClean('after a context-less transaction')
  })

  it("does not let a request of warehouse B inherit warehouse A's scope", async () => {
    await inject('a', { method: 'GET', url: `/api/warehouses/${String(whA)}/assets` })
    const res = await inject('b', { method: 'GET', url: `/api/warehouses/${String(whB)}/assets?limit=100` })
    expect(res.statusCode).toBe(200)
    const assets = res.json<{ assets: { warehouseId: number }[] }>().assets
    expect(assets.length).toBeGreaterThan(0)
    expect(assets.every((x) => x.warehouseId === whB)).toBe(true)
    await inDataContext(single, { warehouseIds: [whB], actorUserId: clerkB, requestId: randomUUID() }, async (trx) => {
      const { rows } = await sql<{ pid: number; scope: string; n: string }>`
        SELECT pg_backend_pid() AS pid, current_setting('wam.warehouse_scope') AS scope,
               (SELECT count(*) FROM wam.assets WHERE warehouse_id = ${whA}) AS n`.execute(trx)
      expect(rows[0]).toEqual({ pid, scope: String(whB), n: '0' })
    })
    await expectClean('after a request of another warehouse')
  })
})
