import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadAccess } from '../../src/access/access.js'
import { inDataContext, setDataContext } from '../../src/db/dataContext.js'
import { commitBatch, createBatch, MAX_IMPORT_BATCH_ROWS, previewBatch, runImportRetention, stageRows, type ParsedRow } from '../../src/imports/imports.js'
import { assignWarehouseProfile, createHarness, insertProfile, insertUser, insertWarehouse, type Harness } from '../support/appHarness.js'

// Cost of a staged import at the largest batch the server accepts — O-17's 5,000 non-blank data rows
// (E-18's 50,000 rows remain the per-file parse ceiling; a larger file is split into separate batches) —
// with invented rows: staging, preview and commit of 5,000 new assets, then of 5,000 updates of those
// assets, then the retention step clearing both batches. Measured, not claimed, and NOT the gate
// measurement: sandbox timings are no evidence for the target host (G-3). No target is fixed here; the
// owner fixes one before the measurement on the target host that the gate requires.

const ROWS = MAX_IMPORT_BATCH_ROWS

let h: Harness
let warehouseId: number
let userId: number

const timings: Record<string, number> = {}

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const t0 = performance.now()
  const result = await work()
  timings[label] = Math.round(performance.now() - t0)
  console.log(`${label}: ${String(timings[label])} ms`)
  return result
}

function rows(name: string): ParsedRow[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    sheetName: null,
    rowNumber: i + 2,
    cells: { asset_code: `PERF-${String(i).padStart(6, '0')}`, name, item_type: 'Synthetic laptop', status: 'in_stock', serial_number: `SN${String(i)}` }
  }))
}

/** One full import, each step in its own transaction as the routes run it. */
async function runImport(label: string, input: ParsedRow[]): Promise<Record<string, number>> {
  const actor = { userId, username: 'perf.importer', access: await loadAccess(h.appDb, userId, false) }
  const context = { warehouseIds: [warehouseId], actorUserId: userId, requestId: randomUUID() }
  const audit = { requestId: null, sourceIp: null }
  const batch = await timed(`${label}: stage`, () =>
    inDataContext(h.appDb, context, async (trx) => {
      const id = await createBatch(trx, audit, actor, warehouseId, { name: 'perf.csv', sha256: Buffer.alloc(32, 1), sizeBytes: 1, format: 'csv' })
      await stageRows(trx, warehouseId, id, input)
      return id
    })
  )
  const version = (await h.ownerDb.selectFrom('import_batches').select('version').where('id', '=', String(batch)).executeTakeFirstOrThrow()).version
  const previewed = await timed(`${label}: preview`, () =>
    h.appDb.transaction().execute(async (trx) => {
      await setDataContext(trx, context)
      return previewBatch(trx, audit, actor, warehouseId, batch, version)
    })
  )
  const committed = await timed(`${label}: commit`, () =>
    h.appDb.transaction().execute(async (trx) => {
      await setDataContext(trx, context)
      return commitBatch(trx, audit, actor, warehouseId, batch, previewed.batch.version)
    })
  )
  expect(committed.batch.state).toBe('committed')
  return { ...committed.counts, batch }
}

beforeAll(async () => {
  h = await createHarness()
  warehouseId = await insertWarehouse(h, 'SYN-PERF')
  userId = await insertUser(h, { username: 'perf.importer' })
  await assignWarehouseProfile(h, userId, warehouseId, await insertProfile(h, 'Perf import', 'warehouse', ['asset.view', 'asset.import']))
  await sql`INSERT INTO wam.item_types (name) VALUES ('Synthetic laptop')`.execute(h.ownerDb)
}, 300_000)

afterAll(async () => {
  await h.close()
})

describe(`staged import at ${String(ROWS)} rows`, () => {
  it('stages, previews and commits creates, then updates, then clears both by retention', async () => {
    const created = await runImport('create', rows('First name'))
    expect(created.create).toBe(ROWS)
    const updated = await runImport('update', rows('Second name'))
    expect(updated.update).toBe(ROWS)

    // Test-only time travel: age both batches past the 90-day period for committed batches.
    await h.superDb.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx)
      await sql`UPDATE wam.import_batches SET updated_at = now() - interval '91 days', closed_at = now() - interval '91 days'`.execute(trx)
    })
    const cleared = await timed('retention: clear both batches', () => runImportRetention(h.appDb))
    expect([cleared.clearedBatches, cleared.clearedRows]).toEqual([2, 2 * ROWS])

    const { rows: size } = await sql<{ assets: string; import_rows: string }>`
      SELECT pg_size_pretty(pg_total_relation_size('wam.assets')) AS assets,
             pg_size_pretty(pg_total_relation_size('wam.import_rows')) AS import_rows`.execute(h.ownerDb)
    console.log(JSON.stringify({ rows: ROWS, timingsMs: timings, sizes: size[0] }, null, 2))
  }, 1_800_000)
})
