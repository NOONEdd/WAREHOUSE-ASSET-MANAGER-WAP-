import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, cleanupTestDb, seedMinimalLookups } from '../testHelpers/testDb'

let ctx

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

const { lookupService } = await import('../../../src/main/services/lookupService')
const { lookupRepository } = await import('../../../src/main/repositories/lookupRepository')
const { assetRepository } = await import('../../../src/main/repositories/assetRepository')

function seedAssetUsing(overrides = {}) {
  const { itemTypeId } = seedMinimalLookups(ctx.db)
  const statusId = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
  return assetRepository.create({
    assetCode: overrides.assetCode ?? 'A-1',
    assetName: 'دستگاه تست',
    itemTypeId: overrides.itemTypeId ?? itemTypeId,
    model: null,
    serialNumber: overrides.serialNumber ?? 'SN-1',
    countryId: overrides.countryId ?? null,
    workshopId: overrides.workshopId ?? null,
    warehouseEntryDate: null,
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

describe('lookupService — single delete', () => {
  it('deletes a value that no asset uses', () => {
    const item = lookupRepository.create('itemTypes', 'میز اداری')
    const result = lookupService.deleteLookup('itemTypes', item.id)
    expect(result).toEqual({ id: item.id, name: 'میز اداری' })
    expect(lookupRepository.findById('itemTypes', item.id)).toBeUndefined()
  })

  it('refuses to delete a value an active asset uses, and says how many', () => {
    seedAssetUsing() // uses the item type from seedMinimalLookups
    const items = lookupRepository.list('itemTypes')
    const used = items[0]

    expect(() => lookupService.deleteLookup('itemTypes', used.id)).toThrow(/1 دارایی/)
    // Must not have been deleted despite throwing.
    expect(lookupRepository.findById('itemTypes', used.id)).toBeDefined()
  })

  it('refuses to delete a value only a SOFT-DELETED asset uses — matches the database FK, which does not care about is_deleted', () => {
    const asset = seedAssetUsing()
    assetRepository.softDelete(asset.id, null)

    const items = lookupRepository.list('itemTypes')
    expect(() => lookupService.deleteLookup('itemTypes', items[0].id)).toThrow(/در حال استفاده|دارایی استفاده می‌شود/)
  })

  it('never leaves an orphaned asset record — the database itself would refuse the raw DELETE too', () => {
    seedAssetUsing()
    const items = lookupRepository.list('itemTypes')
    expect(() => lookupRepository.remove('itemTypes', items[0].id)).toThrow(/FOREIGN KEY/)
  })

  it('refuses to delete asset_statuses through this path — a fixed enum, not user base data', () => {
    const anyStatus = ctx.db.prepare('SELECT id FROM asset_statuses LIMIT 1').get()
    expect(() => lookupService.deleteLookup('statuses', anyStatus.id)).toThrow(/قابل حذف نیست/)
  })
})

describe('lookupService — bulk delete', () => {
  it('deletes every selected value when none are in use', () => {
    const a = lookupRepository.create('workshops', 'واحد الف')
    const b = lookupRepository.create('workshops', 'واحد ب')
    const result = lookupService.deleteLookupsBulk('workshops', [a.id, b.id])
    expect(result.count).toBe(2)
    expect(lookupRepository.list('workshops')).toHaveLength(0)
  })

  it('is all-or-nothing: if even one selected value is in use, NOTHING is deleted', () => {
    const safe = lookupRepository.create('countries', 'ایتالیا')
    const inUse = lookupRepository.create('countries', 'آلمان')
    seedAssetUsing({ countryId: inUse.id })

    expect(() => lookupService.deleteLookupsBulk('countries', [safe.id, inUse.id])).toThrow(/آلمان/)

    // The SAFE one must still exist too — a partial delete would be
    // exactly the confusing, undo-able-only-by-guessing outcome this is
    // meant to avoid.
    expect(lookupRepository.findById('countries', safe.id)).toBeDefined()
    expect(lookupRepository.findById('countries', inUse.id)).toBeDefined()
  })

  it('rejects an empty selection with a clear message rather than a silent no-op', () => {
    expect(() => lookupService.deleteLookupsBulk('workshops', [])).toThrow(/انتخاب نشده/)
  })

  it('refuses bulk delete of asset_statuses', () => {
    const ids = ctx.db.prepare('SELECT id FROM asset_statuses LIMIT 2').all().map((r) => r.id)
    expect(() => lookupService.deleteLookupsBulk('statuses', ids)).toThrow(/قابل حذف نیست/)
  })
})

describe('lookupRepository.countUsage', () => {
  it('counts soft-deleted assets too, matching what the FK constraint actually enforces', () => {
    // Phase 1A fix: seedAssetUsing() returns the new row id itself (a plain
    // number), so the previous `asset.id` was undefined and softDelete()
    // silently soft-deleted nothing — this test passed without ever
    // exercising a soft-deleted asset.
    const assetId = seedAssetUsing()
    const items = lookupRepository.list('itemTypes')
    expect(lookupRepository.countUsage('itemTypes', items[0].id)).toBe(1)

    assetRepository.softDelete(assetId, null)
    expect(ctx.db.prepare('SELECT is_deleted FROM assets WHERE id = ?').get(assetId).is_deleted).toBe(1)
    expect(lookupRepository.countUsage('itemTypes', items[0].id)).toBe(1)
  })

  it('returns 0 for a value nothing references', () => {
    const item = lookupRepository.create('itemTypes', 'یک نوع بی‌استفاده')
    expect(lookupRepository.countUsage('itemTypes', item.id)).toBe(0)
  })
})
