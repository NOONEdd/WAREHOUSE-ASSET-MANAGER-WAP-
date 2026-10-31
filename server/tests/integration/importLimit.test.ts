import { randomUUID } from 'node:crypto'
import type { LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadAccess } from '../../src/access/access.js'
import type { Actor } from '../../src/admin/rules.js'
import { inDataContext } from '../../src/db/dataContext.js'
import {
  commitBatch,
  createBatch,
  getBatch,
  isBlankRow,
  MAX_IMPORT_BATCH_ROWS,
  previewBatch,
  stageRows,
  type ParsedRow
} from '../../src/imports/imports.js'
import { assignWarehouseProfile, call, createHarness, insertProfile, insertUser, insertWarehouse, login, type Harness } from '../support/appHarness.js'

// Decision O-17: one import batch holds at most 5,000 non-blank data rows (valid or invalid). Enforced by the
// server in staging (cumulatively per batch, under the batch row lock, atomically) and again, independently,
// in preview and commit against the rows actually stored. Synthetic rows only; the parser does not exist, so
// rows arrive as a parser would hand them over (keyed by field identifiers; the header already consumed).

let h: Harness
let wh: number
let userId: number
let actor: Actor
let cookie: string
const AUDIT = { requestId: null, sourceIp: null }
const NBSP = String.fromCodePoint(0xa0)
const ZWNJ = String.fromCodePoint(0x200c)

const ctx = () => ({ warehouseIds: [wh], actorUserId: userId, requestId: randomUUID() })

function dataRows(count: number, tag: string, start = 0): ParsedRow[] {
  return Array.from({ length: count }, (_, i) => ({
    sheetName: null,
    rowNumber: start + i + 2, // row 1 of the sheet is the header, consumed by the parser
    cells: { asset_code: `LIM-${tag}-${String(start + i)}`, name: 'Synthetic', item_type: 'Synthetic limit type', status: 'in_stock' }
  }))
}

const blank = (rowNumber: number, cells: ParsedRow['cells'] = {}): ParsedRow => ({ sheetName: null, rowNumber, cells })

async function newBatch(): Promise<number> {
  return inDataContext(h.appDb, ctx(), (trx) =>
    createBatch(trx, AUDIT, actor, wh, { name: 'limit.csv', sha256: Buffer.alloc(32, 9), sizeBytes: 1, format: 'csv' })
  )
}

const stage = (batch: number, rows: readonly ParsedRow[]) => inDataContext(h.appDb, ctx(), (trx) => stageRows(trx, wh, batch, rows))

async function stored(batch: number): Promise<{ rows: number; rowCount: number | null; state: string; version: number }> {
  const { rows } = await sql<{ rows: string; row_count: number | null; state: string; version: number }>`
    SELECT (SELECT count(*) FROM wam.import_rows WHERE batch_id = ${batch}) AS rows, row_count, state, version
      FROM wam.import_batches WHERE id = ${batch}`.execute(h.ownerDb)
  const r = rows[0]
  if (r === undefined) throw new Error('no batch')
  return { rows: Number(r.rows), rowCount: r.row_count, state: r.state, version: r.version }
}

const versionOf = async (batch: number) => (await stored(batch)).version

function api(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return call(h, { method, url, cookie, ...(payload === undefined ? {} : { payload }), ...(method === 'GET' ? {} : { headers: { 'idempotency-key': randomUUID() } }) })
}

/** Test-only database manipulation that bypasses every service and trigger (superuser, replica role). */
async function bypass(statement: ReturnType<typeof sql>): Promise<void> {
  await h.superDb.transaction().execute(async (trx) => {
    await sql`SET LOCAL session_replication_role = replica`.execute(trx)
    await statement.execute(trx)
  })
}

beforeAll(async () => {
  h = await createHarness({ importEnabled: true })
  wh = await insertWarehouse(h, 'SYN-LIMIT')
  userId = await insertUser(h, { username: 'limit.importer' })
  await assignWarehouseProfile(h, userId, wh, await insertProfile(h, 'Limit import', 'warehouse', ['asset.view', 'asset.import']))
  actor = { userId, username: 'limit.importer', access: await loadAccess(h.appDb, userId, false) }
  cookie = await login(h, 'limit.importer')
  await sql`INSERT INTO wam.item_types (name) VALUES ('Synthetic limit type')`.execute(h.ownerDb)
}, 120_000)

afterAll(async () => {
  await h.close()
})

describe('O-17: the limit and the blank-row rule', () => {
  it('is the constant 5,000', () => {
    expect(MAX_IMPORT_BATCH_ROWS).toBe(5_000)
  })

  it('treats a row as blank when every cell is missing, empty or whitespace (String.prototype.trim), and nothing else', () => {
    expect(isBlankRow(blank(2))).toBe(true)
    expect(isBlankRow(blank(2, { asset_code: '', name: '   ', notes: `\t${NBSP}\n` }))).toBe(true)
    // An invisible formatting character is not whitespace under that rule: the row counts.
    expect(isBlankRow(blank(2, { notes: ZWNJ }))).toBe(false)
    expect(isBlankRow(blank(2, { model: 'x' }))).toBe(false)
  })
})

describe('O-17: staging', () => {
  it('accepts exactly 5,000 non-blank data rows (the header already consumed), then previews and commits them', async () => {
    const batch = await newBatch()
    const result = await stage(batch, dataRows(5_000, 'MAX'))
    expect(result).toEqual({ staged: 5_000, blank: 0, total: 5_000 })
    expect(await stored(batch)).toMatchObject({ rows: 5_000, rowCount: 5_000 })
    const p = await inDataContext(h.appDb, ctx(), async (trx) => previewBatch(trx, AUDIT, actor, wh, batch, await versionOf(batch)))
    expect(p.counts.create).toBe(5_000)
    const c = await inDataContext(h.appDb, ctx(), (trx) => commitBatch(trx, AUDIT, actor, wh, batch, p.batch.version))
    expect([c.batch.state, c.counts.create]).toEqual(['committed', 5_000])
  }, 120_000)

  it('refuses 5,001 non-blank rows in one call, staging nothing', async () => {
    const batch = await newBatch()
    await expect(stage(batch, dataRows(5_001, 'OVER'))).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE', details: { limit: 5_000, rows: 5_001 } })
    expect(await stored(batch)).toMatchObject({ rows: 0, rowCount: null, state: 'uploaded' })
  })

  it('does not count blank rows: 5,000 data rows among 20,000 blank and whitespace-only rows are accepted, and the blank rows are not staged', async () => {
    const batch = await newBatch()
    const rows: ParsedRow[] = []
    const data = dataRows(5_000, 'BLANK')
    for (let i = 0; i < 25_000; i += 1) {
      if (i % 5 === 0) rows.push(data[i / 5] as ParsedRow)
      else rows.push(blank(100_000 + i, i % 2 === 0 ? {} : { name: '  ', notes: NBSP }))
    }
    expect(await stage(batch, rows)).toEqual({ staged: 5_000, blank: 20_000, total: 5_000 })
    expect(await stored(batch)).toMatchObject({ rows: 5_000, rowCount: 5_000 })
  })

  it('counts invalid non-blank rows: 4,999 valid plus 2 invalid rows are refused', async () => {
    const batch = await newBatch()
    const invalid: ParsedRow[] = [blank(9_000, { name: 'No code' }), blank(9_001, { asset_code: 'LIM-INVALID', exit_date: 'not a date' })]
    await expect(stage(batch, [...dataRows(4_999, 'INV'), ...invalid])).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE', details: { rows: 5_001 } })
    expect((await stored(batch)).rows).toBe(0)
    // The same invalid rows within the limit are staged and counted (they become `invalid` at preview).
    expect(await stage(batch, invalid)).toEqual({ staged: 2, blank: 0, total: 2 })
  })

  it('counts every call of one batch together, and refuses the call that would exceed the limit as a whole', async () => {
    const batch = await newBatch()
    expect((await stage(batch, dataRows(3_000, 'ACC'))).total).toBe(3_000)
    await expect(stage(batch, dataRows(2_001, 'ACC', 3_000))).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE', details: { rows: 5_001 } })
    expect(await stored(batch)).toMatchObject({ rows: 3_000, rowCount: 3_000 })
    expect((await stage(batch, dataRows(2_000, 'ACC', 3_000))).total).toBe(5_000)
    await expect(stage(batch, dataRows(1, 'ACC', 5_000))).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE' })
    // Blank rows can still be passed to a full batch: they are skipped and change nothing.
    expect(await stage(batch, [blank(99_999)])).toEqual({ staged: 0, blank: 1, total: 5_000 })
    expect(await stored(batch)).toMatchObject({ rows: 5_000, rowCount: 5_000 })
  })

  it('lets only one of two concurrent staging calls of 2,600 rows succeed (the batch row lock)', async () => {
    const batch = await newBatch()
    const results = await Promise.allSettled([stage(batch, dataRows(2_600, 'CONC-A')), stage(batch, dataRows(2_600, 'CONC-B', 10_000))])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = results.find((r) => r.status === 'rejected')
    expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: 'IMPORT_TOO_LARGE', details: { rows: 5_200 } })
    expect(await stored(batch)).toMatchObject({ rows: 2_600, rowCount: 2_600 })
  }, 60_000)
})

describe('O-17: preview and commit check the stored rows independently', () => {
  it('refuses to preview a batch holding more rows than the limit (rows added around the service), changing nothing', async () => {
    const batch = await newBatch()
    await stage(batch, dataRows(5_000, 'PRE'))
    await bypass(sql`INSERT INTO wam.import_rows (batch_id, warehouse_id, row_number, cells, outcome, issues)
                     VALUES (${batch}, ${wh}, 9999, '{"asset_code": "LIM-PRE-EXTRA"}'::jsonb, 'invalid', '[{"code": "not_previewed"}]'::jsonb)`)
    const before = await stored(batch)
    await expect(inDataContext(h.appDb, ctx(), (trx) => previewBatch(trx, AUDIT, actor, wh, batch, before.version))).rejects.toMatchObject({
      code: 'IMPORT_TOO_LARGE',
      details: { rows: 5_001 }
    })
    expect(await stored(batch)).toEqual(before)
    // The same refusal over HTTP: the server enforces it whatever the client does.
    const res = await api('POST', `/api/warehouses/${String(wh)}/imports/${String(batch)}/preview`, { version: before.version })
    expect([res.statusCode, res.json<{ error: { code: string } }>().error.code]).toEqual([422, 'IMPORT_TOO_LARGE'])
  }, 60_000)

  it('refuses to commit a previewed batch that holds more rows than the limit, changing nothing and creating no asset', async () => {
    const batch = await newBatch()
    await stage(batch, dataRows(5_000, 'COM'))
    const p = await inDataContext(h.appDb, ctx(), async (trx) => previewBatch(trx, AUDIT, actor, wh, batch, await versionOf(batch)))
    await bypass(sql`INSERT INTO wam.import_rows (batch_id, warehouse_id, row_number, cells, outcome, issues)
                     VALUES (${batch}, ${wh}, 9999, '{"asset_code": "LIM-COM-EXTRA"}'::jsonb, 'invalid', '[]'::jsonb)`)
    const before = await stored(batch)
    await expect(inDataContext(h.appDb, ctx(), (trx) => commitBatch(trx, AUDIT, actor, wh, batch, p.batch.version))).rejects.toMatchObject({
      code: 'IMPORT_TOO_LARGE'
    })
    const res = await api('POST', `/api/warehouses/${String(wh)}/imports/${String(batch)}/commit`, { version: p.batch.version })
    expect([res.statusCode, res.json<{ error: { code: string } }>().error.code]).toEqual([422, 'IMPORT_TOO_LARGE'])
    expect(await stored(batch)).toEqual(before)
    const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM wam.assets WHERE asset_code LIKE 'LIM-COM-%'`.execute(h.ownerDb)
    expect(rows[0]?.n).toBe('0')
  }, 60_000)

  it('handles batches staged before O-17 safely: a recorded count above the limit or one that disagrees with the stored rows is refused', async () => {
    const legacyLarge = await newBatch()
    await stage(legacyLarge, dataRows(10, 'LEG'))
    await bypass(sql`UPDATE wam.import_batches SET row_count = 50000 WHERE id = ${legacyLarge}`)
    await expect(
      inDataContext(h.appDb, ctx(), async (trx) => previewBatch(trx, AUDIT, actor, wh, legacyLarge, await versionOf(legacyLarge)))
    ).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE', details: { rows: 50_000 } })

    // Before O-17, blank rows were staged with no cells and counted: the counts disagree, so it is refused.
    const legacyBlank = await newBatch()
    await stage(legacyBlank, dataRows(10, 'LEGB'))
    await bypass(sql`INSERT INTO wam.import_rows (batch_id, warehouse_id, row_number, cells, outcome, issues)
                     VALUES (${legacyBlank}, ${wh}, 9999, '{}'::jsonb, 'invalid', '[]'::jsonb)`)
    await bypass(sql`UPDATE wam.import_batches SET row_count = 11 WHERE id = ${legacyBlank}`)
    await expect(
      inDataContext(h.appDb, ctx(), async (trx) => previewBatch(trx, AUDIT, actor, wh, legacyBlank, await versionOf(legacyBlank)))
    ).rejects.toMatchObject({ code: 'IMPORT_STATE', details: { reason: 'staged rows do not match the batch' } })
    // Such a batch can still be cancelled.
    const cancelled = await api('POST', `/api/warehouses/${String(wh)}/imports/${String(legacyBlank)}/cancel`, { version: await versionOf(legacyBlank) })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
  })

  it('keeps each batch independent: a refused batch leaves an earlier committed batch committed', async () => {
    const first = await newBatch()
    await stage(first, dataRows(3, 'IND'))
    const p = await inDataContext(h.appDb, ctx(), async (trx) => previewBatch(trx, AUDIT, actor, wh, first, await versionOf(first)))
    await inDataContext(h.appDb, ctx(), (trx) => commitBatch(trx, AUDIT, actor, wh, first, p.batch.version))
    const second = await newBatch()
    await expect(stage(second, dataRows(5_001, 'IND2'))).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE' })
    expect((await stored(first)).state).toBe('committed')
    const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM wam.assets WHERE asset_code LIKE 'LIM-IND-%'`.execute(h.ownerDb)
    expect(rows[0]?.n).toBe('3')
    const detail = await inDataContext(h.appDb, ctx(), (trx) => getBatch(trx, wh, second, { limit: 1 }))
    expect(detail.batch.rowCount).toBeNull()
  })
})
