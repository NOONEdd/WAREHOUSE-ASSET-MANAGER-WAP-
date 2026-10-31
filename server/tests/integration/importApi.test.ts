import { randomUUID } from 'node:crypto'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadAccess } from '../../src/access/access.js'
import type { Actor } from '../../src/admin/rules.js'
import { buildApp } from '../../src/app.js'
import { inDataContext } from '../../src/db/dataContext.js'
import { createBatch, getBatch, runImportRetention, stageRows, type ParsedRow } from '../../src/imports/imports.js'
import {
  appointAdministrator,
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

// Staged import (decision O-16; proposal §6) over HTTP, with invented rows only: there is no parser
// and no upload route, so batches are staged through the service, exactly as a parser would hand them
// over (rows keyed by internal field identifiers). The app under test is built with imports enabled;
// the default (disabled) is checked against a second app on the same database.

let h: Harness
let whA: number
let whB: number
const users: Record<string, number> = {}
const cookies: Record<string, string> = {}
const status: Record<string, number> = {}

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

const errorCode = (res: LightMyRequestResponse): string | undefined => res.json<{ error?: { code: string } }>().error?.code

async function warehouseUser(username: string, warehouseId: number, permissions: readonly string[]): Promise<void> {
  const id = await insertUser(h, { username })
  await assignWarehouseProfile(h, id, warehouseId, await insertProfile(h, `Profile ${username}`, 'warehouse', permissions))
  users[username] = id
}

/**
 * Stages a batch as the given user, in that user's warehouse context, as a parser would. Returns its id
 * and version (staging counts the rows, which is a change: the version is no longer 1).
 */
async function stage(who: string, warehouseId: number, rows: readonly ParsedRow[], fileName = 'synthetic-file.csv'): Promise<Staged> {
  const userId = users[who] ?? -1
  const actor: Actor = { userId, username: who, access: await loadAccess(h.appDb, userId, false) }
  return inDataContext(h.appDb, { warehouseIds: [warehouseId], actorUserId: userId, requestId: randomUUID() }, async (trx) => {
    const batch = await createBatch(trx, { requestId: null, sourceIp: null }, actor, warehouseId, {
      name: fileName,
      sha256: Buffer.alloc(32, 7),
      sizeBytes: 1234,
      format: 'csv'
    })
    await stageRows(trx, warehouseId, batch, rows)
    return { id: batch, version: (await getBatch(trx, warehouseId, batch, { limit: 1 })).batch.version }
  })
}

interface Staged {
  readonly id: number
  readonly version: number
}

const row = (rowNumber: number, cells: ParsedRow['cells']): ParsedRow => ({ sheetName: null, rowNumber, cells })
const importsUrl = (w: number, rest = '') => `/api/warehouses/${String(w)}/imports${rest}`
const assetUrl = (w: number, rest = '') => `/api/warehouses/${String(w)}/assets${rest}`

interface BatchBody {
  id: number
  state: string
  version: number
  rowCount: number | null
  fileName: string | null
}
interface Counts {
  create: number
  update: number
  unchanged: number
  suspected_duplicate: number
  invalid: number
}
interface RowBody {
  id: number
  rowNumber: number
  cells: Record<string, string>
  outcome: string
  issues: { code: string; column?: string }[]
  matchedAssetId: number | null
  appliedAt: string | null
}

async function batchOf(who: string, w: number, batch: number): Promise<{ batch: BatchBody; rows: RowBody[] }> {
  const res = await api(who, 'GET', importsUrl(w, `/${String(batch)}?limit=500`))
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}

async function preview(who: string, w: number, batch: number, version: number): Promise<{ batch: BatchBody; counts: Counts }> {
  const res = await api(who, 'POST', importsUrl(w, `/${String(batch)}/preview`), { version })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}

async function assetByCode(w: number, code: string): Promise<{ id: number; version: number; name: string; origin: string; originImportRowId: number | null } | undefined> {
  const res = await api('clerk.a', 'GET', assetUrl(w, `?q=${encodeURIComponent(code)}&limit=100`))
  return res.json<{ assets: { id: number; version: number; name: string; assetCode: string; origin: string; originImportRowId: number | null }[] }>()
    .assets.find((a) => a.assetCode === code)
}

const IMPORTER = ['asset.view', 'asset.import', 'audit.view'] as const
const CLERK = ['asset.view', 'asset.create', 'asset.edit', 'asset.change_status', 'audit.view'] as const

beforeAll(async () => {
  h = await createHarness({ importEnabled: true })
  whA = await insertWarehouse(h, 'SYN-IMP-A')
  whB = await insertWarehouse(h, 'SYN-IMP-B')
  await warehouseUser('importer.a', whA, IMPORTER)
  await warehouseUser('clerk.a', whA, CLERK)
  await warehouseUser('viewer.a', whA, ['asset.view', 'asset.create', 'asset.edit'])
  await warehouseUser('importer.b', whB, IMPORTER)
  await warehouseUser('clerk.b', whB, CLERK)
  users.outsider = await insertUser(h, { username: 'outsider' })
  const catalogAdmin = await insertUser(h, { username: 'catalog.admin' })
  await appointAdministrator(h, catalogAdmin, await insertProfile(h, 'Catalogue', 'system', ['catalog.manage']))
  for (const u of ['importer.a', 'clerk.a', 'viewer.a', 'importer.b', 'clerk.b', 'outsider', 'catalog.admin']) cookies[u] = await login(h, u)
  const { rows } = await sql<{ id: number; code: string }>`SELECT id, code FROM wam.asset_statuses WHERE is_system`.execute(h.ownerDb)
  for (const r of rows) status[r.code] = r.id
  for (const [kind, body] of [
    ['item-types', { name: 'Synthetic laptop' }],
    ['workshops', { name: 'North unit' }],
    ['countries', { name: 'Synthetic land', isoCode: 'ZZ' }]
  ] as const) {
    const res = await api('catalog.admin', 'POST', `/api/catalog/${kind}`, body)
    expect(res.statusCode, res.body).toBe(201)
  }
  const itemTypeId = (await api('outsider', 'GET', '/api/catalog/item-types')).json<{ entries: { id: number }[] }>().entries[0]?.id
  for (const [code, name] of [['IMP-0001', 'Old name'], ['IMP-0002', 'Kept name'], ['IMP-0100', 'Lookalike target']]) {
    const res = await api('clerk.a', 'POST', assetUrl(whA), { assetCode: code, name, itemTypeId, statusId: status.in_stock })
    expect(res.statusCode, res.body).toBe(201)
  }
}, 120_000)

afterAll(async () => {
  await h.close()
})

describe('disabled by default', () => {
  let disabled: FastifyInstance
  beforeAll(async () => {
    disabled = buildApp({ db: h.appDb, logger: false, publicOrigin: ORIGIN, sessions: SESSIONS, mfaEncryptionKey: h.mfaKey })
    await disabled.ready()
  })
  afterAll(async () => {
    await disabled.close()
  })

  it('has no import routes at all unless enabled', async () => {
    const { id: batch, version } = await stage('importer.a', whA, [row(2, { asset_code: 'IMP-OFF-1', name: 'Off', item_type: 'Synthetic laptop', status: 'in_stock' })])
    const cookie = cookies['importer.a'] ?? ''
    const list = await disabled.inject({ method: 'GET', url: importsUrl(whA), headers: { cookie } })
    expect(list.statusCode).toBe(404)
    for (const action of ['preview', 'commit', 'cancel']) {
      const res = await disabled.inject({
        method: 'POST',
        url: importsUrl(whA, `/${String(batch)}/${action}`),
        headers: { ...SAME_ORIGIN, cookie, 'idempotency-key': randomUUID() },
        payload: { version }
      })
      expect(res.statusCode, action).toBe(404)
    }
    // The same request succeeds on the app with imports enabled: the 404 above is the missing route.
    expect((await api('importer.a', 'GET', importsUrl(whA))).statusCode).toBe(200)
    expect((await api('importer.a', 'POST', importsUrl(whA, `/${String(batch)}/cancel`), { version })).statusCode).toBe(200)
  })
})

describe('stage, preview, commit', () => {
  let batch: number
  let staged: number
  let previewed: number
  const rows: ParsedRow[] = [
    row(2, {
      asset_code: 'IMP-1001',
      name: '  Synthetic chair  ',
      item_type: 'synthetic   LAPTOP',
      status: 'in_stock',
      country: 'ZZ',
      workshop: 'north unit',
      serial_number: ' SN-77 ',
      entry_date: '2026-01-05',
      notes: '   '
    }),
    row(3, { asset_code: 'IMP-0001', name: 'New name' }),
    row(4, { asset_code: 'IMP-0002', name: 'Kept name' }),
    row(5, { asset_code: 'imp 0100', name: 'Lookalike', item_type: 'Synthetic laptop', status: 'in_stock' }),
    row(6, { asset_code: 'IMP-2000', name: 'Twin one', item_type: 'Synthetic laptop', status: 'in_stock' }),
    row(7, { asset_code: 'imp-2000', name: 'Twin two', item_type: 'Synthetic laptop', status: 'in_stock' }),
    row(8, { asset_code: 'IMP-3000', name: 'No type', status: 'in_stock' }),
    row(9, { asset_code: 'IMP-3001', name: 'Unknown type', item_type: 'Secret-value-type', status: 'in_stock' }),
    row(10, { asset_code: 'IMP-3002', name: 'Bad date', item_type: 'Synthetic laptop', status: 'in_stock', entry_date: '2026-02-30' }),
    row(11, {
      asset_code: 'IMP-3003',
      name: 'Backwards',
      item_type: 'Synthetic laptop',
      status: 'in_stock',
      entry_date: '2026-03-01',
      exit_date: '2026-02-01'
    }),
    row(12, { asset_code: 'X'.repeat(101), name: 'Too long', item_type: 'Synthetic laptop', status: 'in_stock' }),
    row(13, { name: 'No code', item_type: 'Synthetic laptop', status: 'in_stock' })
  ]

  beforeAll(async () => {
    ;({ id: batch, version: staged } = await stage('importer.a', whA, rows, 'synthetic-secret-name.csv'))
  })

  it('stages rows as not yet previewed, dropping blank cells', async () => {
    const { batch: b, rows: stagedRows } = await batchOf('importer.a', whA, batch)
    expect(b).toMatchObject({ state: 'uploaded', version: staged, rowCount: rows.length, fileName: 'synthetic-secret-name.csv' })
    expect(stagedRows.map((r) => r.outcome)).toEqual(rows.map(() => 'invalid'))
    expect(stagedRows[0]?.issues).toEqual([{ code: 'not_previewed' }])
    expect(stagedRows[0]?.cells).not.toHaveProperty('notes')
    expect(stagedRows[0]?.cells.serial_number).toBe(' SN-77 ')
  })

  it('pages the rows of a batch', async () => {
    const first = (await api('importer.a', 'GET', importsUrl(whA, `/${String(batch)}?limit=5`))).json<{ rows: RowBody[]; nextAfter: number | null }>()
    expect(first.rows).toHaveLength(5)
    const rest = (await api('importer.a', 'GET', importsUrl(whA, `/${String(batch)}?limit=500&after=${String(first.nextAfter)}`)))
      .json<{ rows: RowBody[]; nextAfter: number | null }>()
    expect([first.rows.length + rest.rows.length, rest.nextAfter]).toEqual([rows.length, null])
  })

  it('previews: classifies every row with issue codes and field identifiers only', async () => {
    const result = await preview('importer.a', whA, batch, staged)
    expect(result.batch).toMatchObject({ state: 'previewed', version: staged + 1 })
    previewed = result.batch.version
    expect(result.counts).toEqual({ create: 1, update: 1, unchanged: 1, suspected_duplicate: 3, invalid: 6 })
    const byNumber = new Map((await batchOf('importer.a', whA, batch)).rows.map((r) => [r.rowNumber, r]))
    const issues = (n: number) => byNumber.get(n)?.issues
    expect(byNumber.get(2)).toMatchObject({ outcome: 'create', issues: [], matchedAssetId: null })
    expect(byNumber.get(3)).toMatchObject({ outcome: 'update', issues: [] })
    expect(byNumber.get(4)).toMatchObject({ outcome: 'unchanged', issues: [] })
    expect([byNumber.get(5)?.outcome, issues(5)]).toEqual(['suspected_duplicate', [{ code: 'similar_asset_exists', column: 'asset_code' }]])
    expect(issues(6)).toEqual([{ code: 'duplicate_in_file', column: 'asset_code' }])
    expect(issues(7)).toEqual([{ code: 'duplicate_in_file', column: 'asset_code' }])
    expect(issues(8)).toEqual([{ code: 'missing_required', column: 'item_type' }])
    expect(issues(9)).toEqual([{ code: 'unknown_value', column: 'item_type' }])
    expect(issues(10)).toEqual([{ code: 'invalid_date', column: 'entry_date' }])
    expect(issues(11)).toEqual([{ code: 'dates_out_of_order', column: 'exit_date' }])
    expect(issues(12)).toEqual([{ code: 'too_long', column: 'asset_code' }])
    expect(issues(13)).toEqual([{ code: 'missing_required', column: 'asset_code' }])
    // No cell value ever reaches the issue metadata (the schema refuses it; the service never tries).
    const { rows: stored } = await sql<{ text: string }>`
      SELECT issues::text AS text FROM wam.import_rows WHERE batch_id = ${batch}`.execute(h.ownerDb)
    for (const r of stored) expect(r.text).not.toMatch(/Secret-value|2026-02-30|Synthetic|IMP-/)
  })

  it('refuses a commit with a stale batch version', async () => {
    const res = await api('importer.a', 'POST', importsUrl(whA, `/${String(batch)}/commit`), { version: staged })
    expect([res.statusCode, errorCode(res)]).toEqual([409, 'VERSION_CONFLICT'])
  })

  it('commits create and update rows in one transaction, marks them applied, and audits without the file name', async () => {
    const key = randomUUID()
    const res = await api('importer.a', 'POST', importsUrl(whA, `/${String(batch)}/commit`), { version: previewed }, key)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json<{ batch: BatchBody; counts: Counts }>()
    expect(body.batch.state).toBe('committed')
    expect(body.counts).toMatchObject({ create: 1, update: 1, unchanged: 1 })
    const replay = await api('importer.a', 'POST', importsUrl(whA, `/${String(batch)}/commit`), { version: previewed }, key)
    expect([replay.statusCode, replay.headers['idempotency-replayed'], replay.json()]).toEqual([200, 'true', body])
    const again = await api('importer.a', 'POST', importsUrl(whA, `/${String(batch)}/commit`), { version: body.batch.version })
    expect([again.statusCode, errorCode(again)]).toEqual([409, 'IMPORT_STATE'])

    const created = await assetByCode(whA, 'IMP-1001')
    const updated = await assetByCode(whA, 'IMP-0001')
    const kept = await assetByCode(whA, 'IMP-0002')
    const byNumber = new Map((await batchOf('importer.a', whA, batch)).rows.map((r) => [r.rowNumber, r]))
    expect(created).toMatchObject({ name: 'Synthetic chair', origin: 'import', originImportRowId: byNumber.get(2)?.id })
    const detail = (await api('clerk.a', 'GET', assetUrl(whA, `/${String(created?.id)}`))).json<Record<string, unknown>>()
    expect(detail).toMatchObject({ serialNumber: ' SN-77 ', entryDate: '2026-01-05', notes: null, statusId: status.in_stock })
    expect([updated?.name, updated?.version, kept?.version]).toEqual(['New name', 2, 1])
    expect(await assetByCode(whA, 'IMP-2000')).toBeUndefined()
    expect([...byNumber.values()].filter((r) => r.appliedAt !== null).map((r) => r.rowNumber).sort((a, b) => a - b)).toEqual([2, 3])

    const history = (await api('clerk.a', 'GET', assetUrl(whA, `/${String(created?.id)}/history`))).json<{ statusChanges: { importRowId: number | null }[] }>()
    expect(history.statusChanges.map((c) => c.importRowId)).toEqual([byNumber.get(2)?.id])

    const { rows: events } = await sql<{ action: string; text: string }>`
      SELECT action, coalesce(details::text, '') AS text FROM wam.audit_events ORDER BY id`.execute(h.ownerDb)
    const actions = events.map((e) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['import.uploaded', 'import.previewed', 'import.committed', 'asset.created', 'asset.updated']))
    for (const e of events) expect(e.text).not.toContain('synthetic-secret-name')
    const imported = events.filter((e) => e.action === 'asset.created' && e.text.includes('"origin": "import"'))
    expect(imported).toHaveLength(1)
  })
})

describe('commit safety', () => {
  it('refuses a stale preview after the matched asset changed, keeping the batch previewed', async () => {
    const target = await assetByCode(whA, 'IMP-0002')
    const { id: batch, version } = await stage('importer.a', whA, [row(2, { asset_code: 'IMP-0002', name: 'Import rename' })])
    const previewed = await preview('importer.a', whA, batch, version)
    expect(previewed.counts.update).toBe(1)
    const edit = await api('clerk.a', 'PATCH', assetUrl(whA, `/${String(target?.id)}`), { version: target?.version, notes: 'edited meanwhile' })
    expect(edit.statusCode, edit.body).toBe(200)
    const stale = await api('importer.a', 'POST', importsUrl(whA, `/${String(batch)}/commit`), { version: previewed.batch.version })
    expect([stale.statusCode, errorCode(stale)]).toEqual([409, 'IMPORT_STALE'])
    expect((await batchOf('importer.a', whA, batch)).batch.state).toBe('previewed')
    expect((await assetByCode(whA, 'IMP-0002'))?.name).toBe('Kept name')
    // A fresh preview sees the new version and the commit then goes through.
    const again = await preview('importer.a', whA, batch, previewed.batch.version)
    const ok = await api('importer.a', 'POST', importsUrl(whA, `/${String(batch)}/commit`), { version: again.batch.version })
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await assetByCode(whA, 'IMP-0002'))?.name).toBe('Import rename')
  })

  it('rolls back the whole commit when a code is taken in another warehouse meanwhile', async () => {
    const { id: batch, version } = await stage('importer.a', whA, [
      row(2, { asset_code: 'IMP-ATOM-1', name: 'First', item_type: 'Synthetic laptop', status: 'in_stock' }),
      row(3, { asset_code: 'IMP-CROSS-1', name: 'Second', item_type: 'Synthetic laptop', status: 'in_stock' })
    ])
    const previewed = await preview('importer.a', whA, batch, version)
    expect(previewed.counts.create).toBe(2)
    const itemTypeId = (await api('outsider', 'GET', '/api/catalog/item-types')).json<{ entries: { id: number }[] }>().entries[0]?.id
    const inB = await api('clerk.b', 'POST', assetUrl(whB), { assetCode: 'IMP-CROSS-1', name: 'In B', itemTypeId, statusId: status.in_stock })
    expect(inB.statusCode, inB.body).toBe(201)
    const res = await api('importer.a', 'POST', importsUrl(whA, `/${String(batch)}/commit`), { version: previewed.batch.version })
    expect([res.statusCode, errorCode(res)]).toEqual([409, 'CODE_TAKEN'])
    expect(res.body).not.toContain('In B')
    expect(await assetByCode(whA, 'IMP-ATOM-1')).toBeUndefined()
    const after = await batchOf('importer.a', whA, batch)
    expect([after.batch.state, after.rows.every((r) => r.appliedAt === null)]).toEqual(['previewed', true])
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM wam.audit_events WHERE action = 'import.committed' AND target_id = ${String(batch)}`.execute(h.ownerDb)
    expect(rows[0]?.n).toBe('0')
  })

  it('cancels an open batch, after which nothing more can happen to it', async () => {
    const { id: batch, version } = await stage('importer.a', whA, [row(2, { asset_code: 'IMP-CANCEL', name: 'Cancel', item_type: 'Synthetic laptop', status: 'in_stock' })])
    const previewed = await preview('importer.a', whA, batch, version)
    const cancelled = await api('importer.a', 'POST', importsUrl(whA, `/${String(batch)}/cancel`), { version: previewed.batch.version })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    const closed = cancelled.json<BatchBody>()
    expect(closed.state).toBe('cancelled')
    for (const action of ['preview', 'commit', 'cancel']) {
      const res = await api('importer.a', 'POST', importsUrl(whA, `/${String(batch)}/${action}`), { version: closed.version })
      expect([res.statusCode, errorCode(res)], action).toEqual([409, 'IMPORT_STATE'])
    }
    await expect(
      inDataContext(h.appDb, { warehouseIds: [whA], actorUserId: users['importer.a'] ?? -1, requestId: randomUUID() }, (trx) =>
        stageRows(trx, whA, batch, [row(3, { asset_code: 'LATE' })])
      )
    ).rejects.toMatchObject({ code: 'IMPORT_STATE' })
    expect(await assetByCode(whA, 'IMP-CANCEL')).toBeUndefined()
  })

  it('refuses staging rows into a previewed batch', async () => {
    const { id: batch, version } = await stage('importer.a', whA, [row(2, { asset_code: 'IMP-LATE-0', name: 'x', item_type: 'Synthetic laptop', status: 'in_stock' })])
    await preview('importer.a', whA, batch, version)
    await expect(
      inDataContext(h.appDb, { warehouseIds: [whA], actorUserId: users['importer.a'] ?? -1, requestId: randomUUID() }, (trx) =>
        stageRows(trx, whA, batch, [row(3, { asset_code: 'IMP-LATE-1' })])
      )
    ).rejects.toMatchObject({ code: 'IMPORT_STATE' })
  })
})

describe('retention (PD-09)', () => {
  it('clears a cancelled batch 7 days after closing, as the server role, with one audit event per run', async () => {
    const { id: batch, version } = await stage('importer.a', whA, [row(2, { asset_code: 'IMP-RET', name: 'Retained', item_type: 'Synthetic laptop', status: 'in_stock' })])
    expect((await api('importer.a', 'POST', importsUrl(whA, `/${String(batch)}/cancel`), { version })).statusCode).toBe(200)
    const before = await runImportRetention(h.appDb)
    expect((await batchOf('importer.a', whA, batch)).batch.fileName).toBe('synthetic-file.csv')
    // Test-only time travel: a superuser bypasses the triggers to age the batch.
    await h.superDb.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx)
      await sql`UPDATE wam.import_batches SET updated_at = now() - interval '8 days', closed_at = now() - interval '8 days' WHERE id = ${batch}`.execute(trx)
    })
    const after = await runImportRetention(h.appDb)
    expect([before.clearedBatches, after.clearedBatches, after.clearedRows]).toEqual([0, 1, 1])
    const cleared = await batchOf('importer.a', whA, batch)
    expect([cleared.batch.fileName, cleared.batch.state, cleared.rows[0]?.cells, cleared.rows[0]?.rowNumber]).toEqual([null, 'cancelled', {}, 2])
    const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM wam.audit_events WHERE action = 'import.retention_applied'`.execute(h.ownerDb)
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(2)
  })
})

describe('warehouse isolation on every import endpoint', () => {
  let batchA: number
  let versionA: number
  beforeAll(async () => {
    ;({ id: batchA, version: versionA } = await stage('importer.a', whA, [
      row(2, { asset_code: 'IMP-ISO', name: 'Isolated', item_type: 'Synthetic laptop', status: 'in_stock' })
    ]))
  })

  const probes = (): [string, Method, string, unknown][] => [
    ['list', 'GET', importsUrl(whA), undefined],
    ['detail', 'GET', importsUrl(whA, `/${String(batchA)}`), undefined],
    ['preview', 'POST', importsUrl(whA, `/${String(batchA)}/preview`), { version: versionA }],
    ['commit', 'POST', importsUrl(whA, `/${String(batchA)}/commit`), { version: versionA }],
    ['cancel', 'POST', importsUrl(whA, `/${String(batchA)}/cancel`), { version: versionA }]
  ]

  it.each(['importer.b', 'outsider', 'viewer.a', 'clerk.a'])('answers 404 to %s on every import endpoint of warehouse A', async (who) => {
    for (const [label, method, url, payload] of probes()) {
      const res = await api(who, method, url, payload)
      expect(res.statusCode, `${label}: ${res.body}`).toBe(404)
    }
    expect((await batchOf('importer.a', whA, batchA)).batch).toMatchObject({ state: 'uploaded', version: versionA })
  })

  it('never serves another warehouse’s batch through the own warehouse’s URL', async () => {
    for (const [method, url, payload] of [
      ['GET', importsUrl(whB, `/${String(batchA)}`), undefined],
      ['POST', importsUrl(whB, `/${String(batchA)}/preview`), { version: versionA }],
      ['POST', importsUrl(whB, `/${String(batchA)}/commit`), { version: versionA }],
      ['POST', importsUrl(whB, `/${String(batchA)}/cancel`), { version: versionA }]
    ] as const) {
      const res = await api('importer.b', method, url, payload)
      expect([res.statusCode, errorCode(res)], url).toEqual([404, 'NOT_FOUND'])
    }
    const listB = (await api('importer.b', 'GET', importsUrl(whB))).json<{ batches: { id: number }[] }>().batches
    expect(listB.some((b) => b.id === batchA)).toBe(false)
    expect((await batchOf('importer.a', whA, batchA)).batch).toMatchObject({ state: 'uploaded', version: versionA })
  })

  it('hides a batch from a mismatched data context even if the service is asked for it (row-level security)', async () => {
    await expect(
      inDataContext(h.appDb, { warehouseIds: [whB], actorUserId: users['importer.b'] ?? -1, requestId: randomUUID() }, (trx) =>
        getBatch(trx, whA, batchA, { limit: 10 })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('shows import events only in their own warehouse’s audit trail', async () => {
    const auditA = (await api('importer.a', 'GET', `/api/warehouses/${String(whA)}/audit-events`)).json<{ events: { action: string; warehouseId: number | null }[] }>()
      .events
    expect(auditA.some((e) => e.action === 'import.uploaded')).toBe(true)
    expect(auditA.every((e) => e.warehouseId === whA)).toBe(true)
    const auditB = (await api('importer.b', 'GET', `/api/warehouses/${String(whB)}/audit-events`)).json<{ events: { action: string; warehouseId: number | null }[] }>()
      .events
    expect(auditB.some((e) => e.action.startsWith('import.'))).toBe(false)
  })
})
