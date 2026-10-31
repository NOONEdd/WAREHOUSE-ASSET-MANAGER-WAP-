import { randomUUID } from 'node:crypto'
import type { LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appointAdministrator,
  assignWarehouseProfile,
  call,
  createHarness,
  insertProfile,
  insertUser,
  insertWarehouse,
  login,
  type Harness
} from '../support/appHarness.js'

// The catalogue, asset and person APIs of Phase 1B-3 (decision O-16) over HTTP, with warehouse
// isolation probed on every endpoint. Synthetic data only.

let h: Harness
let whA: number
let whB: number
let whC: number
let itemType: number
const status: Record<string, number> = {}
const cookies: Record<string, string> = {}

type Method = 'GET' | 'POST' | 'PATCH'

function api(who: string, method: Method, url: string, payload?: unknown, key: string = randomUUID()): Promise<LightMyRequestResponse> {
  return call(h, {
    method,
    url,
    cookie: cookies[who],
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    ...(method === 'GET' ? {} : { headers: { 'idempotency-key': key } })
  })
}

async function warehouseUser(username: string, warehouseId: number, permissions: readonly string[]): Promise<number> {
  const id = await insertUser(h, { username })
  const profile = await insertProfile(h, `Profile ${username}`, 'warehouse', permissions)
  await assignWarehouseProfile(h, id, warehouseId, profile)
  return id
}

const ALL = ['asset.view', 'asset.create', 'asset.edit', 'asset.change_status', 'audit.view'] as const

beforeAll(async () => {
  h = await createHarness()
  whA = await insertWarehouse(h, 'SYN-A')
  whB = await insertWarehouse(h, 'SYN-B')
  whC = await insertWarehouse(h, 'SYN-C')
  await warehouseUser('clerk.a', whA, ALL)
  await warehouseUser('viewer.a', whA, ['asset.view'])
  await warehouseUser('clerk.b', whB, ALL)
  await warehouseUser('clerk.c', whC, ALL)
  await insertUser(h, { username: 'outsider' })
  const catalogAdmin = await insertUser(h, { username: 'catalog.admin' })
  await appointAdministrator(h, catalogAdmin, await insertProfile(h, 'Catalogue', 'system', ['catalog.manage']))
  const eraser = await insertUser(h, { username: 'person.eraser' })
  await appointAdministrator(h, eraser, await insertProfile(h, 'Erasure', 'system', ['person.erase']))
  for (const u of ['clerk.a', 'viewer.a', 'clerk.b', 'clerk.c', 'outsider', 'catalog.admin', 'person.eraser']) cookies[u] = await login(h, u)
  const { rows } = await sql<{ id: number; code: string }>`SELECT id, code FROM wam.asset_statuses WHERE is_system`.execute(h.ownerDb)
  for (const r of rows) status[r.code] = r.id
  const created = await api('catalog.admin', 'POST', '/api/catalog/item-types', { name: 'Synthetic laptop' })
  expect(created.statusCode, created.body).toBe(201)
  itemType = created.json<{ id: number }>().id
}, 120_000)

afterAll(async () => {
  await h.close()
})

const assetUrl = (w: number, rest = '') => `/api/warehouses/${String(w)}/assets${rest}`
const personUrl = (w: number, rest = '') => `/api/warehouses/${String(w)}/persons${rest}`
const newAsset = (code: string, extra: Record<string, unknown> = {}) => ({
  assetCode: code,
  name: 'Synthetic asset',
  itemTypeId: itemType,
  statusId: status.in_stock,
  ...extra
})

interface AssetBody {
  asset: { id: number; version: number; assetCode: string; serialNumber: string | null; statusId: number; receivedBy: unknown }
  suspectedDuplicates: { id: number; assetCode: string }[]
}

describe('catalogue', () => {
  it('is readable by anyone signed in and changeable only with catalog.manage', async () => {
    const statuses = await api('outsider', 'GET', '/api/catalog/statuses')
    expect(statuses.statusCode).toBe(200)
    expect(statuses.json<{ entries: { code: string | null }[] }>().entries.map((e) => e.code)).toEqual([
      'in_stock', 'issued', 'returned', 'damaged', 'missing'
    ])
    expect((await api('clerk.a', 'POST', '/api/catalog/workshops', { name: 'North unit' })).statusCode).toBe(403)
    expect((await api('catalog.admin', 'POST', '/api/catalog/workshops', { name: 'North unit' })).statusCode).toBe(201)
    const duplicate = await api('catalog.admin', 'POST', '/api/catalog/workshops', { name: '  north   UNIT ' })
    expect([duplicate.statusCode, duplicate.json<{ error: { code: string } }>().error.code]).toEqual([409, 'NAME_TAKEN'])
    // Punctuation counts in catalogue names (PD-10): these are different units.
    expect((await api('catalog.admin', 'POST', '/api/catalog/workshops', { name: 'North-unit 1/2' })).statusCode).toBe(201)
  })

  it('protects system statuses and detects stale versions', async () => {
    const missing = (await api('outsider', 'GET', '/api/catalog/statuses')).json<{ entries: { id: number; code: string | null; version: number }[] }>()
      .entries.find((e) => e.code === 'missing')
    const rename = await api('catalog.admin', 'PATCH', `/api/catalog/statuses/${String(missing?.id)}`, { version: missing?.version, name: 'Lost' })
    expect(rename.statusCode).toBe(403)
    const deactivate = await api('catalog.admin', 'PATCH', `/api/catalog/statuses/${String(missing?.id)}`, { version: missing?.version, isActive: false })
    expect(deactivate.statusCode).toBe(403)
    const type = await api('catalog.admin', 'POST', '/api/catalog/item-types', { name: 'Synthetic monitor' })
    const { id, version } = type.json<{ id: number; version: number }>()
    expect((await api('catalog.admin', 'PATCH', `/api/catalog/item-types/${String(id)}`, { version, name: 'Synthetic display' })).statusCode).toBe(200)
    expect((await api('catalog.admin', 'PATCH', `/api/catalog/item-types/${String(id)}`, { version, name: 'Again' })).statusCode).toBe(409)
  })
})

describe('assets', () => {
  it('creates an asset, keeps identifiers exactly as written and reports suspected duplicates', async () => {
    const first = await api('clerk.a', 'POST', assetUrl(whA), newAsset('SYN-0001', { serialNumber: '0042' }))
    expect(first.statusCode, first.body).toBe(201)
    const body = first.json<AssetBody>()
    expect(body.asset).toMatchObject({ assetCode: 'SYN-0001', serialNumber: '0042', version: 1 })
    expect(body.suspectedDuplicates).toEqual([])
    const lookalike = await api('clerk.a', 'POST', assetUrl(whA), newAsset('syn 0001'))
    expect(lookalike.statusCode, lookalike.body).toBe(201)
    expect(lookalike.json<AssetBody>().suspectedDuplicates).toEqual([{ id: body.asset.id, assetCode: 'SYN-0001' }])
    // Exact codes are unique across warehouses (PD-01); the error reveals nothing else.
    const taken = await api('clerk.b', 'POST', assetUrl(whB), newAsset('SYN-0001'))
    expect([taken.statusCode, taken.json<{ error: { code: string } }>().error.code]).toEqual([409, 'CODE_TAKEN'])
    expect((await api('clerk.a', 'POST', assetUrl(whA), newAsset(' -/ '))).statusCode).toBe(400)
    expect((await api('clerk.a', 'POST', assetUrl(whA), newAsset('SYN-0002', { warehouseId: whB }))).statusCode).toBe(400)
  })

  it('replays an idempotent create instead of creating twice', async () => {
    const key = randomUUID()
    const once = await api('clerk.a', 'POST', assetUrl(whA), newAsset('SYN-IDEM'), key)
    const again = await api('clerk.a', 'POST', assetUrl(whA), newAsset('SYN-IDEM'), key)
    expect([once.statusCode, again.statusCode, again.headers['idempotency-replayed']]).toEqual([201, 201, 'true'])
    expect(again.json<AssetBody>().asset.id).toBe(once.json<AssetBody>().asset.id)
  })

  it('lists, counts, searches and reads within the warehouse', async () => {
    const list = await api('viewer.a', 'GET', assetUrl(whA, '?limit=100'))
    expect(list.statusCode).toBe(200)
    const codes = list.json<{ assets: { assetCode: string; warehouseId: number }[] }>().assets
    expect(codes.length).toBeGreaterThanOrEqual(3)
    expect(new Set(codes.map((a) => a.warehouseId))).toEqual(new Set([whA]))
    const search = await api('viewer.a', 'GET', assetUrl(whA, `?q=${encodeURIComponent('ＳＹＮ０００１')}`))
    expect(search.json<{ assets: { assetCode: string }[] }>().assets.map((a) => a.assetCode).sort()).toEqual(['SYN-0001', 'syn 0001'])
    const count = await api('viewer.a', 'GET', assetUrl(whA, '/count'))
    expect(count.json<{ count: number }>().count).toBe(codes.length)
    const id = codes.length > 0 ? list.json<{ assets: { id: number }[] }>().assets[0]?.id : 0
    expect((await api('viewer.a', 'GET', assetUrl(whA, `/${String(id)}`))).statusCode).toBe(200)
    expect((await api('viewer.a', 'POST', assetUrl(whA), newAsset('SYN-VIEW'))).statusCode).toBe(404)
  })

  it('edits with set, clear and unchanged fields, versions and audit before/after', async () => {
    const created = (await api('clerk.a', 'POST', assetUrl(whA), newAsset('SYN-EDIT', { model: 'M1', serialNumber: 'S-1' }))).json<AssetBody>().asset
    const edited = await api('clerk.a', 'PATCH', assetUrl(whA, `/${String(created.id)}`), { version: 1, model: null, notes: 'Synthetic note' })
    expect(edited.statusCode, edited.body).toBe(200)
    expect(edited.json<AssetBody>().asset).toMatchObject({ version: 2, serialNumber: 'S-1' })
    const stale = await api('clerk.a', 'PATCH', assetUrl(whA, `/${String(created.id)}`), { version: 1, notes: 'x' })
    expect(stale.statusCode).toBe(409)
    expect((await api('clerk.a', 'PATCH', assetUrl(whA, `/${String(created.id)}`), { version: 2, statusId: status.issued })).statusCode).toBe(400)
    expect((await api('clerk.a', 'PATCH', assetUrl(whA, `/${String(created.id)}`), { version: 2, name: null })).statusCode).toBe(400)
    const { rows } = await sql<{ details: { changed: Record<string, unknown> } }>`
      SELECT details FROM wam.audit_events WHERE action = 'asset.updated' AND target_id = ${String(created.id)}`.execute(h.ownerDb)
    expect(rows).toEqual([{ details: { changed: { model: { before: 'M1', after: null }, notes: { before: null, after: 'Synthetic note' } } } }])
  })

  it('changes status with a reason and handover parties, recorded in the history by id', async () => {
    const created = (await api('clerk.a', 'POST', assetUrl(whA), newAsset('SYN-STAT'))).json<AssetBody>().asset
    const person = (await api('clerk.a', 'POST', personUrl(whA), { displayName: 'Synthetic Recipient' })).json<{ id: number }>()
    const changed = await api('clerk.a', 'POST', assetUrl(whA, `/${String(created.id)}/status`), {
      version: 1,
      statusId: status.issued,
      reason: 'synthetic handover',
      receivedBy: { personId: person.id }
    })
    expect(changed.statusCode, changed.body).toBe(200)
    const history = (await api('viewer.a', 'GET', assetUrl(whA, `/${String(created.id)}/history`))).json<{
      statusChanges: { toStatusId: number; reason: string | null; receivedBy: unknown }[]
      moves: unknown[]
    }>()
    expect(history.statusChanges.map((s) => [s.toStatusId, s.reason, s.receivedBy])).toEqual([
      [status.in_stock, null, null],
      [status.issued, 'synthetic handover', { personId: person.id }]
    ])
    expect(history.moves).toHaveLength(1)
    const same = await api('clerk.a', 'POST', assetUrl(whA, `/${String(created.id)}/status`), { version: 2, statusId: status.issued })
    expect(same.statusCode).toBe(400)
  })
})

describe('persons (PD-05)', () => {
  it('records no names in the audit trail, refuses persons of another warehouse, and erases only with person.erase', async () => {
    const name = 'Synthetic Erasable Person'
    const person = (await api('clerk.a', 'POST', personUrl(whA), { displayName: name })).json<{ id: number; version: number }>()
    const renamed = await api('clerk.a', 'PATCH', personUrl(whA, `/${String(person.id)}`), { version: person.version, displayName: `${name} Two` })
    expect(renamed.statusCode).toBe(200)
    const personB = (await api('clerk.b', 'POST', personUrl(whB), { displayName: 'Synthetic Person B' })).json<{ id: number }>()
    const foreign = await api('clerk.a', 'POST', assetUrl(whA), newAsset('SYN-PER', { receivedBy: { personId: personB.id } }))
    expect(foreign.statusCode).toBe(400)
    expect((await api('clerk.a', 'POST', personUrl(whA, `/${String(person.id)}/erase`), { version: 2 })).statusCode).toBe(403)
    expect((await api('person.eraser', 'POST', personUrl(whB, `/${String(person.id)}/erase`), { version: 2 })).statusCode).toBe(404)
    const erased = await api('person.eraser', 'POST', personUrl(whA, `/${String(person.id)}/erase`), { version: 2 })
    expect(erased.statusCode, erased.body).toBe(200)
    expect(erased.json()).toMatchObject({ displayName: null, erased: true })
    const reuse = await api('clerk.a', 'POST', assetUrl(whA), newAsset('SYN-PER2', { receivedBy: { personId: person.id } }))
    expect([reuse.statusCode, reuse.json<{ error: { code: string } }>().error.code]).toEqual([409, 'PERSON_ERASED'])
    const { rows } = await sql<{ text: string }>`SELECT details::text AS text FROM wam.audit_events WHERE action LIKE 'person.%'`.execute(h.ownerDb)
    expect(rows.length).toBeGreaterThanOrEqual(3)
    for (const r of rows) expect(r.text).not.toContain('Synthetic')
  })
})

describe('warehouse isolation on every endpoint', () => {
  let assetA: number
  let personA: number
  beforeAll(async () => {
    assetA = (await api('clerk.a', 'POST', assetUrl(whA), newAsset('SYN-ISO'))).json<AssetBody>().asset.id
    personA = (await api('clerk.a', 'POST', personUrl(whA), { displayName: 'Synthetic Isolated' })).json<{ id: number }>().id
  })

  const probes = (): [string, Method, string, unknown][] => [
    ['list', 'GET', assetUrl(whA), undefined],
    ['search', 'GET', assetUrl(whA, '?q=SYN'), undefined],
    ['count', 'GET', assetUrl(whA, '/count'), undefined],
    ['detail', 'GET', assetUrl(whA, `/${String(assetA)}`), undefined],
    ['history', 'GET', assetUrl(whA, `/${String(assetA)}/history`), undefined],
    ['create', 'POST', assetUrl(whA), newAsset('SYN-ISO-X')],
    ['edit', 'PATCH', assetUrl(whA, `/${String(assetA)}`), { version: 1, notes: 'x' }],
    ['status', 'POST', assetUrl(whA, `/${String(assetA)}/status`), { version: 1, statusId: status.damaged }],
    ['persons list', 'GET', personUrl(whA), undefined],
    ['person create', 'POST', personUrl(whA), { displayName: 'Synthetic X' }],
    ['person rename', 'PATCH', personUrl(whA, `/${String(personA)}`), { version: 1, displayName: 'Synthetic Y' }],
    ['audit', 'GET', `/api/warehouses/${String(whA)}/audit-events`, undefined]
  ]

  it.each(['clerk.b', 'outsider'])('answers 404 to %s on every endpoint of another warehouse', async (who) => {
    for (const [label, method, url, payload] of probes()) {
      const res = await api(who, method, url, payload)
      expect(res.statusCode, `${label}: ${res.body}`).toBe(404)
    }
  })

  it('never serves another warehouse’s record through the own warehouse’s URL', async () => {
    expect((await api('clerk.b', 'GET', assetUrl(whB, `/${String(assetA)}`))).statusCode).toBe(404)
    expect((await api('clerk.b', 'GET', assetUrl(whB, `/${String(assetA)}/history`))).statusCode).toBe(404)
    expect((await api('clerk.b', 'PATCH', assetUrl(whB, `/${String(assetA)}`), { version: 1, notes: 'x' })).statusCode).toBe(404)
    expect((await api('clerk.b', 'POST', assetUrl(whB, `/${String(assetA)}/status`), { version: 1, statusId: status.damaged })).statusCode).toBe(404)
    expect((await api('clerk.b', 'PATCH', personUrl(whB, `/${String(personA)}`), { version: 1, displayName: 'x' })).statusCode).toBe(404)
    const listB = (await api('clerk.b', 'GET', assetUrl(whB, '?limit=100'))).json<{ assets: { warehouseId: number }[] }>().assets
    expect(listB.every((a) => a.warehouseId === whB)).toBe(true)
    const searchB = (await api('clerk.b', 'GET', assetUrl(whB, '?q=SYN-ISO'))).json<{ assets: unknown[] }>().assets
    expect(searchB).toEqual([])
    const countB = (await api('clerk.b', 'GET', assetUrl(whB, '/count'))).json<{ count: number }>().count
    const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM wam.assets WHERE warehouse_id = ${whB}`.execute(h.ownerDb)
    expect(countB).toBe(Number(rows[0]?.n))
    const personsB = (await api('clerk.b', 'GET', personUrl(whB))).json<{ persons: { id: number }[] }>().persons
    expect(personsB.map((p) => p.id)).not.toContain(personA)
  })

  it('shows asset events only in their own warehouse’s audit trail', async () => {
    const auditA = await api('clerk.a', 'GET', `/api/warehouses/${String(whA)}/audit-events`)
    expect(auditA.statusCode).toBe(200)
    const actions = auditA.json<{ events: { action: string; warehouseId: number | null }[] }>().events
    expect(actions.some((e) => e.action === 'asset.created')).toBe(true)
    expect(actions.every((e) => e.warehouseId === whA)).toBe(true)
  })
})

describe('inactive warehouse (PD-07)', () => {
  it('stays readable but refuses every asset and person write', async () => {
    const asset = (await api('clerk.c', 'POST', assetUrl(whC), newAsset('SYN-INA'))).json<AssetBody>().asset
    await sql`UPDATE wam.warehouses SET is_active = false WHERE id = ${whC}`.execute(h.ownerDb)
    for (const [method, url, payload] of [
      ['POST', assetUrl(whC), newAsset('SYN-INA2')],
      ['PATCH', assetUrl(whC, `/${String(asset.id)}`), { version: 1, notes: 'x' }],
      ['POST', assetUrl(whC, `/${String(asset.id)}/status`), { version: 1, statusId: status.damaged }],
      ['POST', personUrl(whC), { displayName: 'Synthetic Z' }]
    ] as const) {
      const res = await api('clerk.c', method, url, payload)
      expect([res.statusCode, res.json<{ error: { code: string } }>().error.code], url).toEqual([409, 'WAREHOUSE_INACTIVE'])
    }
    expect((await api('clerk.c', 'GET', assetUrl(whC, `/${String(asset.id)}`))).statusCode).toBe(200)
  })
})
