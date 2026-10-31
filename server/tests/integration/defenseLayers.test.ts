import { randomUUID } from 'node:crypto'
import { sql, type Transaction } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadAccess } from '../../src/access/access.js'
import type { Actor } from '../../src/admin/rules.js'
import { createAsset, editAsset, getAsset, getAssetHistory, listAssets, updateAssetAtVersion } from '../../src/assets/assets.js'
import { createPerson, renamePerson } from '../../src/assets/persons.js'
import type { Database } from '../../src/db/connection.js'
import { inDataContext, setDataContext, type DataContext } from '../../src/db/dataContext.js'
import { commitBatch, createBatch, getBatch, previewBatch, stageRows } from '../../src/imports/imports.js'
import { assignWarehouseProfile, createHarness, insertProfile, insertUser, insertWarehouse, type Harness } from '../support/appHarness.js'

// Review finding S-6: each protection tested on its own, so that removing one is detected even while the
// others still refuse the request. Layers: the row lock taken before an asset change, the version
// comparison after it, the version condition of the UPDATE itself, the import commit's lock of matched
// assets, the commit's re-validation, the services' explicit warehouse filter, and row-level security.
// (The database triggers that guard import rows are tested directly in assetSchema.test.ts.)

let h: Harness
let whA: number
let whB: number
let userA: number
let actorA: Actor
let itemType: number
let inStock: number
const AUDIT = { requestId: null, sourceIp: null }
const ctxA = (): DataContext => ({ warehouseIds: [whA], actorUserId: userA, requestId: randomUUID() })

const BASE = { model: null, serialNumber: null, countryId: null, workshopId: null, entryDate: null, exitDate: null, deliveredBy: null, receivedBy: null, notes: null }

async function newAsset(code: string, warehouse = whA): Promise<{ id: number; version: number }> {
  const ctx = { ...ctxA(), warehouseIds: [warehouse] }
  const { asset } = await inDataContext(h.appDb, ctx, (trx) =>
    createAsset(trx, AUDIT, actorA, warehouse, { ...BASE, assetCode: code, name: 'Synthetic', itemTypeId: itemType, statusId: inStock })
  )
  return asset
}

/** Runs `work` in a transaction that stays open until released, holding whatever locks `work` took. */
function heldTransaction(ctx: DataContext, work: (trx: Transaction<Database>) => Promise<unknown>) {
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let ready = (): void => undefined
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  const done = h.appDb.transaction().execute(async (trx) => {
    await setDataContext(trx, ctx)
    await work(trx)
    ready()
    await gate
  })
  return { started, done, release }
}

/** The statements of the server's role that are waiting for a lock right now (polled until one appears). */
async function waitingStatements(): Promise<string[]> {
  for (let i = 0; i < 60; i += 1) {
    const { rows } = await sql<{ query: string }>`
      SELECT query FROM pg_stat_activity
       WHERE datname = current_database() AND usename = 'wam_app' AND wait_event_type = 'Lock'`.execute(h.superDb)
    if (rows.length > 0) return rows.map((r) => r.query.replace(/\s+/g, ' ').trim())
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return []
}

beforeAll(async () => {
  h = await createHarness()
  whA = await insertWarehouse(h, 'SYN-LAYER-A')
  whB = await insertWarehouse(h, 'SYN-LAYER-B')
  userA = await insertUser(h, { username: 'layer.a' })
  const perms = ['asset.view', 'asset.create', 'asset.edit', 'asset.change_status', 'asset.import'] as const
  await assignWarehouseProfile(h, userA, whA, await insertProfile(h, 'Layer A', 'warehouse', perms))
  await assignWarehouseProfile(h, userA, whB, await insertProfile(h, 'Layer B', 'warehouse', perms))
  actorA = { userId: userA, username: 'layer.a', access: await loadAccess(h.appDb, userA, false) }
  itemType = Number((await sql<{ id: number }>`INSERT INTO wam.item_types (name) VALUES ('Synthetic layer type') RETURNING id`.execute(h.ownerDb)).rows[0]?.id)
  inStock = Number((await sql<{ id: number }>`SELECT id FROM wam.asset_statuses WHERE code = 'in_stock'`.execute(h.ownerDb)).rows[0]?.id)
}, 120_000)

afterAll(async () => {
  await h.close()
})

describe('asset changes', () => {
  it('lock: a concurrent edit waits on the locking read, before it compares versions', async () => {
    const asset = await newAsset('SYN-LAYER-LOCK')
    const first = heldTransaction(ctxA(), (trx) => editAsset(trx, AUDIT, actorA, whA, asset.id, { version: asset.version, changes: { notes: 'first' } }))
    await first.started
    const second = inDataContext(h.appDb, ctxA(), (trx) =>
      editAsset(trx, AUDIT, actorA, whA, asset.id, { version: asset.version, changes: { notes: 'second' } })
    ).then(
      () => null,
      (err: unknown) => err
    )
    let waiting: string[]
    try {
      waiting = await waitingStatements()
    } finally {
      first.release()
      await first.done
    }
    // The waiting statement is the SELECT … FOR UPDATE of findAsset; without that lock it would be the UPDATE.
    expect(waiting.length, 'one edit waits').toBe(1)
    expect(waiting[0], 'it waits on the lock, not on the UPDATE').toMatch(/^SELECT .* FROM wam\.assets .* FOR UPDATE$/)
    // Locked first, then compared: the conflict is found by the comparison, which reports the current version.
    expect(await second).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: asset.version + 1 } })
    const final = await inDataContext(h.appDb, ctxA(), (trx) => getAsset(trx, whA, asset.id))
    expect([final.notes, final.version]).toEqual(['first', asset.version + 1])
  })

  it('version comparison: a stale edit is refused by the comparison after the lock (it names the current version)', async () => {
    const asset = await newAsset('SYN-LAYER-CMP')
    await inDataContext(h.appDb, ctxA(), (trx) => editAsset(trx, AUDIT, actorA, whA, asset.id, { version: asset.version, changes: { notes: 'v2' } }))
    await expect(
      inDataContext(h.appDb, ctxA(), (trx) => editAsset(trx, AUDIT, actorA, whA, asset.id, { version: asset.version, changes: { notes: 'stale' } }))
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: asset.version + 1 } })
  })

  it('version condition: the UPDATE itself changes nothing at a stale version, whatever the caller checked', async () => {
    const asset = await newAsset('SYN-LAYER-UPD')
    await inDataContext(h.appDb, ctxA(), (trx) => editAsset(trx, AUDIT, actorA, whA, asset.id, { version: asset.version, changes: { notes: 'v2' } }))
    await expect(
      inDataContext(h.appDb, ctxA(), (trx) => updateAssetAtVersion(trx, whA, asset.id, asset.version, { notes: 'stale write' }))
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    const final = await inDataContext(h.appDb, ctxA(), (trx) => getAsset(trx, whA, asset.id))
    expect([final.notes, final.version]).toEqual(['v2', asset.version + 1])
  })
})

describe('import commit', () => {
  async function previewed(rows: { code: string; name: string }[]): Promise<{ batch: number; version: number }> {
    const batch = await inDataContext(h.appDb, ctxA(), async (trx) => {
      const id = await createBatch(trx, AUDIT, actorA, whA, { name: 'layers.csv', sha256: Buffer.alloc(32, 5), sizeBytes: 1, format: 'csv' })
      await stageRows(
        trx,
        whA,
        id,
        rows.map((r, i) => ({ sheetName: null, rowNumber: i + 2, cells: { asset_code: r.code, name: r.name, item_type: 'Synthetic layer type', status: 'in_stock' } }))
      )
      return id
    })
    const staged = await inDataContext(h.appDb, ctxA(), (trx) => getBatch(trx, whA, batch, { limit: 1 }))
    const p = await inDataContext(h.appDb, ctxA(), (trx) => previewBatch(trx, AUDIT, actorA, whA, batch, staged.batch.version))
    return { batch, version: p.batch.version }
  }

  it('lock: the commit locks every matched asset first, in id order, before it re-validates or writes', async () => {
    const asset = await newAsset('SYN-LAYER-CL')
    const { batch, version } = await previewed([{ code: 'SYN-LAYER-CL', name: 'Renamed by import' }])
    // Another transaction holds the matched asset (it changes nothing).
    const holder = heldTransaction(ctxA(), (trx) => sql`SELECT id FROM wam.assets WHERE id = ${asset.id} FOR UPDATE`.execute(trx))
    await holder.started
    const committing = inDataContext(h.appDb, ctxA(), (trx) => commitBatch(trx, AUDIT, actorA, whA, batch, version))
    let waiting: string[]
    try {
      waiting = await waitingStatements()
    } finally {
      holder.release()
      await holder.done
    }
    expect(waiting.length).toBe(1)
    expect(waiting[0], 'the commit waits on its lock statement, not on a later UPDATE').toMatch(/^SELECT id FROM wam\.assets WHERE id = ANY .* ORDER BY id FOR UPDATE$/)
    expect((await committing).counts.update).toBe(1)
  })

  it('re-validation: an asset created after the preview that looks like a new row makes the commit refuse', async () => {
    const { batch, version } = await previewed([{ code: 'SYN-LAYER-RV-1', name: 'New' }])
    // Not the same code (no unique violation), not a version (the row is a create): only re-validation sees it.
    await newAsset('syn layer rv 1')
    await expect(inDataContext(h.appDb, ctxA(), (trx) => commitBatch(trx, AUDIT, actorA, whA, batch, version))).rejects.toMatchObject({
      code: 'IMPORT_STALE'
    })
    const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM wam.assets WHERE asset_code = 'SYN-LAYER-RV-1'`.execute(h.ownerDb)
    expect(rows[0]?.n).toBe('0')
  })
})

describe('warehouse isolation: the explicit filter and row-level security, each alone', () => {
  it('filter: with a scope covering both warehouses, the services still return nothing of the other warehouse', async () => {
    const assetB = await newAsset('SYN-LAYER-FB', whB)
    const personB = await inDataContext(h.appDb, { ...ctxA(), warehouseIds: [whB] }, (trx) => createPerson(trx, AUDIT, actorA, whB, 'Synthetic Filter Person'))
    const batchB = await inDataContext(h.appDb, { ...ctxA(), warehouseIds: [whB] }, (trx) =>
      createBatch(trx, AUDIT, actorA, whB, { name: 'b.csv', sha256: Buffer.alloc(32, 6), sizeBytes: 1, format: 'csv' })
    )
    // A deliberately wide scope: row-level security would allow warehouse B; only the filter can refuse.
    const wide: DataContext = { ...ctxA(), warehouseIds: [whA, whB] }
    await expect(inDataContext(h.appDb, wide, (trx) => getAsset(trx, whA, assetB.id))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(inDataContext(h.appDb, wide, (trx) => getAssetHistory(trx, whA, assetB.id))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(inDataContext(h.appDb, wide, (trx) => getBatch(trx, whA, batchB, { limit: 1 }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      inDataContext(h.appDb, wide, (trx) => renamePerson(trx, AUDIT, actorA, whA, personB.id, { version: personB.version, displayName: 'x' }))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const listed = await inDataContext(h.appDb, wide, (trx) => listAssets(trx, whA, { limit: 100 }))
    expect(listed.assets.every((a) => a.warehouseId === whA)).toBe(true)
  })

  it('row-level security: with the scope of warehouse B, the services find nothing of warehouse A even when asked for it', async () => {
    const assetA = await newAsset('SYN-LAYER-RLS')
    const batchA = await inDataContext(h.appDb, ctxA(), (trx) =>
      createBatch(trx, AUDIT, actorA, whA, { name: 'a.csv', sha256: Buffer.alloc(32, 7), sizeBytes: 1, format: 'csv' })
    )
    // The filter allows warehouse A here (it is the warehouse asked for); only the policy can hide the rows.
    const scopeB: DataContext = { ...ctxA(), warehouseIds: [whB] }
    await expect(inDataContext(h.appDb, scopeB, (trx) => getAsset(trx, whA, assetA.id))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(inDataContext(h.appDb, scopeB, (trx) => getBatch(trx, whA, batchA, { limit: 1 }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await inDataContext(h.appDb, scopeB, (trx) => listAssets(trx, whA, { limit: 100 }))).assets).toEqual([])
    await expect(
      inDataContext(h.appDb, scopeB, (trx) => updateAssetAtVersion(trx, whA, assetA.id, assetA.version, { notes: 'through the wrong scope' }))
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' }) // nothing visible to update
  })
})
