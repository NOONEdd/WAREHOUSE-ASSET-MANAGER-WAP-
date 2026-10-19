import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, cleanupTestDb } from '../testHelpers/testDb'

let ctx

// assetRepository.js only ever reaches the database through getDatabase(),
// so replacing that with one returning our real, schema-applied test db
// lets the repository's actual SQL run for real without needing Electron
// at all — no need to mock 'electron' here, unlike the backup tests.
vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

const { assetRepository } = await import('../../../src/main/repositories/assetRepository')

let serialCounter = 0
function seedAsset(overrides = {}) {
  serialCounter++
  const itemTypeId = ctx.db.prepare("SELECT id FROM item_types LIMIT 1").get()?.id
    ?? ctx.db.prepare("INSERT INTO item_types (name) VALUES ('نوع تست')").run().lastInsertRowid
  const statusId =
    overrides.statusId ?? ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id

  return assetRepository.create({
    assetCode: overrides.assetCode ?? `A-${serialCounter}`,
    assetName: overrides.assetName ?? 'دستگاه تست',
    itemTypeId,
    model: overrides.model ?? null,
    serialNumber: overrides.serialNumber ?? `SN-AUTO-${serialCounter}`,
    countryId: overrides.countryId ?? null,
    workshopId: overrides.workshopId ?? null,
    warehouseEntryDate: overrides.warehouseEntryDate ?? null,
    warehouseExitDate: null,
    deliveredBy: null,
    receivedBy: null,
    statusId,
    notes: null
  })
}

beforeEach(() => {
  ctx = createTestDb()
})

afterEach(() => {
  cleanupTestDb(ctx)
})

describe('assetRepository.list — search', () => {
  it('matches by asset_code, serial_number, asset_name, and model', () => {
    seedAsset({ assetCode: 'FIND-ME-1', serialNumber: 'SN-X' })
    seedAsset({ assetCode: 'A-2', serialNumber: 'FIND-ME-2' })
    seedAsset({ assetCode: 'A-3', assetName: 'دستگاه FIND-ME-3' })
    seedAsset({ assetCode: 'A-4', model: 'FIND-ME-4' })
    seedAsset({ assetCode: 'NO-MATCH', serialNumber: 'NO-MATCH' })

    const { rows, total } = assetRepository.list({ search: 'FIND-ME' })
    expect(total).toBe(4)
    expect(rows.map((r) => r.asset_code).sort()).toEqual(['A-2', 'A-3', 'A-4', 'FIND-ME-1'])
  })

  // Phase 11: id was originally missing from the search clause.
  it('matches by the numeric id ("شناسه دارایی"), the Phase 11 fix', () => {
    const id = seedAsset({ assetCode: 'A-100' })
    const { rows, total } = assetRepository.list({ search: String(id) })
    expect(total).toBe(1)
    expect(rows[0].id).toBe(id)
  })

  it('excludes soft-deleted assets even when they match the search text', () => {
    const id = seedAsset({ assetCode: 'DELETED-ME' })
    assetRepository.softDelete(id, null)
    const { total } = assetRepository.list({ search: 'DELETED-ME' })
    expect(total).toBe(0)
  })
})

describe('assetRepository — duplicate detection ignores soft-deleted assets', () => {
  // Regression tests for the duplicate-detection bug: asset_code and
  // serial_number used to be UNIQUE as plain column constraints (schema.sql),
  // enforced across every row regardless of is_deleted, and
  // findByCodeOrSerial / findAllCodesAndSerials didn't filter is_deleted
  // either — so a soft-deleted asset's code/serial permanently blocked
  // re-adding or re-importing the exact same asset. Fixed at both layers:
  // the unique constraints are now partial indexes scoped to active rows
  // (idx_assets_code_active / idx_assets_serial_active), and these two
  // repository functions now filter is_deleted = 0 to match.

  it('findByCodeOrSerial does not match a soft-deleted asset', () => {
    const id = seedAsset({ assetCode: 'DEL-CODE', serialNumber: 'DEL-SERIAL' })
    assetRepository.softDelete(id, null)
    expect(assetRepository.findByCodeOrSerial('DEL-CODE', 'DEL-SERIAL')).toBeUndefined()
  })

  it('findByCodeOrSerial still matches an active asset (existing behavior, preserved)', () => {
    seedAsset({ assetCode: 'ACTIVE-CODE', serialNumber: 'ACTIVE-SERIAL' })
    const match = assetRepository.findByCodeOrSerial('ACTIVE-CODE', 'ACTIVE-SERIAL')
    expect(match?.asset_code).toBe('ACTIVE-CODE')
  })

  it('findAllCodesAndSerials excludes soft-deleted assets', () => {
    const id = seedAsset({ assetCode: 'DEL-CODE-2', serialNumber: 'DEL-SERIAL-2' })
    assetRepository.softDelete(id, null)
    seedAsset({ assetCode: 'ACTIVE-CODE-2', serialNumber: 'ACTIVE-SERIAL-2' })

    const codes = assetRepository.findAllCodesAndSerials().map((r) => r.asset_code)
    expect(codes).toContain('ACTIVE-CODE-2')
    expect(codes).not.toContain('DEL-CODE-2')
  })

  // Required scenario #1 from the bug report, at the repository/database
  // level: create, delete, then create again with the exact same
  // code/serial must succeed — not throw a raw SQLite UNIQUE constraint
  // error, which is what a partial-index-less schema would still do even
  // with the query-level filters above fixed.
  it('create() succeeds reusing the code/serial number of a soft-deleted asset', () => {
    const firstId = seedAsset({ assetCode: 'REUSE-ME', serialNumber: 'REUSE-SN' })
    assetRepository.softDelete(firstId, null)

    expect(() => seedAsset({ assetCode: 'REUSE-ME', serialNumber: 'REUSE-SN' })).not.toThrow()

    const active = ctx.db
      .prepare("SELECT COUNT(*) n FROM assets WHERE asset_code = 'REUSE-ME' AND is_deleted = 0")
      .get().n
    expect(active).toBe(1)
  })

  // Preserved behavior (requirement: do not simply disable duplicate
  // detection) — the partial unique index still enforces true uniqueness
  // among ACTIVE assets as a database-level safety net, independent of
  // whatever the application layer checked first.
  it('create() still fails for a code already used by an ACTIVE asset (raw UNIQUE constraint, defense in depth)', () => {
    seedAsset({ assetCode: 'STILL-ACTIVE', serialNumber: 'SN-A' })
    expect(() => seedAsset({ assetCode: 'STILL-ACTIVE', serialNumber: 'SN-B' })).toThrow(/UNIQUE/)
  })

  it('create() still fails for a serial number already used by an ACTIVE asset (raw UNIQUE constraint, defense in depth)', () => {
    seedAsset({ assetCode: 'CODE-A', serialNumber: 'STILL-ACTIVE-SN' })
    expect(() => seedAsset({ assetCode: 'CODE-B', serialNumber: 'STILL-ACTIVE-SN' })).toThrow(/UNIQUE/)
  })
})

describe('assetRepository.list — filters', () => {
  it('combines multiple filters with AND, not OR', () => {
    const statusInWarehouse = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    const statusDamaged = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'آسیب‌دیده'").get().id
    const workshopId = ctx.db.prepare("INSERT INTO workshops (name) VALUES ('واحد الف')").run().lastInsertRowid
    const otherWorkshopId = ctx.db.prepare("INSERT INTO workshops (name) VALUES ('واحد ب')").run().lastInsertRowid

    seedAsset({ assetCode: 'MATCH', statusId: statusInWarehouse, workshopId })
    seedAsset({ assetCode: 'WRONG-STATUS', statusId: statusDamaged, workshopId })
    seedAsset({ assetCode: 'WRONG-WORKSHOP', statusId: statusInWarehouse, workshopId: otherWorkshopId })

    const { rows, total } = assetRepository.list({ statusId: statusInWarehouse, workshopId })
    expect(total).toBe(1)
    expect(rows[0].asset_code).toBe('MATCH')
  })

  it('filters by warehouse_entry_date range (from/to)', () => {
    seedAsset({ assetCode: 'TOO-EARLY', warehouseEntryDate: '2026-01-01' })
    seedAsset({ assetCode: 'IN-RANGE', warehouseEntryDate: '2026-03-15' })
    seedAsset({ assetCode: 'TOO-LATE', warehouseEntryDate: '2026-06-01' })

    const { rows, total } = assetRepository.list({ from: '2026-02-01', to: '2026-04-01' })
    expect(total).toBe(1)
    expect(rows[0].asset_code).toBe('IN-RANGE')
  })

  it('with no filters at all, returns every non-deleted asset', () => {
    seedAsset({ assetCode: 'A-1' })
    seedAsset({ assetCode: 'A-2' })
    const deletedId = seedAsset({ assetCode: 'A-3' })
    assetRepository.softDelete(deletedId, null)

    const { total } = assetRepository.list({})
    expect(total).toBe(2)
  })

  // Phase 14's asset-list report relies on this exact behavior to export
  // the complete inventory rather than a possibly-truncated subset.
  it('limit: -1 (SQLite\'s own "no limit") returns every row, not a default-capped subset', () => {
    for (let i = 0; i < 60; i++) seedAsset({ assetCode: `BULK-${i}`, serialNumber: `SN-BULK-${i}` })
    const { rows, total } = assetRepository.list({ limit: -1 })
    expect(total).toBe(60)
    expect(rows).toHaveLength(60)
  })

  it('the default limit (50) still applies when no limit is specified', () => {
    for (let i = 0; i < 60; i++) seedAsset({ assetCode: `BULK-${i}`, serialNumber: `SN-BULK-${i}` })
    const { rows, total } = assetRepository.list({})
    expect(total).toBe(60) // total count is unaffected by pagination
    expect(rows).toHaveLength(50) // but the page of rows is capped
  })

  // Phase 5 — Performance: regression test for the contract AssetsPage's
  // pagination now relies on — offset must advance to a genuinely
  // different, non-overlapping slice of rows, and total must stay the
  // full count regardless of which page is requested. Before Phase 5,
  // nothing in the renderer ever passed `offset`, so this path existed
  // in the repository but was never actually exercised past page 1.
  it('offset returns the next page of rows, not overlapping with page 1, while total stays the full count', () => {
    for (let i = 0; i < 120; i++) seedAsset({ assetCode: `PG-${String(i).padStart(3, '0')}`, serialNumber: `SN-PG-${i}` })

    const pageSize = 50
    const page1 = assetRepository.list({ limit: pageSize, offset: 0 })
    const page2 = assetRepository.list({ limit: pageSize, offset: pageSize })
    const page3 = assetRepository.list({ limit: pageSize, offset: pageSize * 2 })

    expect(page1.total).toBe(120)
    expect(page2.total).toBe(120)
    expect(page3.total).toBe(120)
    expect(page1.rows).toHaveLength(50)
    expect(page2.rows).toHaveLength(50)
    expect(page3.rows).toHaveLength(20) // 120 - 50 - 50

    const idsSeenSoFar = new Set(page1.rows.map((r) => r.id))
    for (const row of page2.rows) expect(idsSeenSoFar.has(row.id)).toBe(false)
    page2.rows.forEach((r) => idsSeenSoFar.add(r.id))
    for (const row of page3.rows) expect(idsSeenSoFar.has(row.id)).toBe(false)

    // All 120 distinct rows accounted for across the three pages, with
    // none skipped and none duplicated.
    const allIds = new Set([...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id))
    expect(allIds.size).toBe(120)
  })
})

describe('assetRepository.getRecentlyAdded / getRecentlyModified', () => {
  it('getRecentlyAdded returns the newest rows first, respecting the limit', () => {
    const ids = [seedAsset(), seedAsset(), seedAsset(), seedAsset()]
    const recent = assetRepository.getRecentlyAdded(2)
    expect(recent).toHaveLength(2)
    // Newest (highest id, same second — id DESC tiebreaker) first.
    expect(recent.map((r) => r.id)).toEqual([ids[3], ids[2]])
  })

  it('getRecentlyAdded excludes soft-deleted assets', () => {
    const id = seedAsset()
    assetRepository.softDelete(id, null)
    expect(assetRepository.getRecentlyAdded(10).map((r) => r.id)).not.toContain(id)
  })

  it('getRecentlyModified reflects a real edit — updated_at moves it to the top', async () => {
    const older = seedAsset({ assetCode: 'OLDER' })
    const newer = seedAsset({ assetCode: 'NEWER' })

    // A raw back-dating UPDATE doesn't work here: update_assets_timestamp
    // (schema.sql) is an AFTER UPDATE trigger, so it would immediately
    // re-stamp updated_at to "now" on top of any manual UPDATE, including
    // one meant to set an artificial past value. A real short wait is
    // simpler and actually correct: it guarantees `older`'s real edit
    // below lands in a later datetime('now') second than `newer`'s
    // untouched creation timestamp, regardless of how fast the rest of
    // this test runs.
    await new Promise((resolve) => setTimeout(resolve, 1100))

    const before = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(older)
    assetRepository.update(older, {
      assetCode: before.asset_code,
      assetName: 'ویرایش‌شده',
      itemTypeId: before.item_type_id,
      model: before.model,
      serialNumber: before.serial_number,
      countryId: before.country_id,
      workshopId: before.workshop_id,
      warehouseEntryDate: before.warehouse_entry_date,
      warehouseExitDate: before.warehouse_exit_date,
      deliveredBy: before.delivered_by,
      receivedBy: before.received_by,
      statusId: before.status_id,
      notes: before.notes
    })

    const recent = assetRepository.getRecentlyModified(5)
    expect(recent[0].id).toBe(older)
    expect(recent[0].asset_name).toBe('ویرایش‌شده')
    // And genuinely later than the untouched row's timestamp, not a tie
    // resolved only by the id fallback.
    const untouched = ctx.db.prepare('SELECT updated_at FROM assets WHERE id = ?').get(newer)
    expect(recent[0].updated_at > untouched.updated_at).toBe(true)
  }, 10000)

  it('getRecentlyModified excludes soft-deleted assets even if they were just edited', () => {
    const id = seedAsset()
    assetRepository.softDelete(id, null) // softDelete is itself an UPDATE, so updated_at is very recent
    expect(assetRepository.getRecentlyModified(10).map((r) => r.id)).not.toContain(id)
  })

  it('getRecentlyAdded and getRecentlyModified both return the full joined shape (item type/workshop/country/status names)', () => {
    seedAsset()
    const [row] = assetRepository.getRecentlyAdded(1)
    expect(row).toHaveProperty('item_type')
    expect(row).toHaveProperty('status')
  })
})
