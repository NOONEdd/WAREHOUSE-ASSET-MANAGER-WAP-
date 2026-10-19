import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, cleanupTestDb, seedMinimalLookups } from '../testHelpers/testDb'

let ctx

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

const { lookupService } = await import('../../../src/main/services/lookupService')
const { lookupRepository } = await import('../../../src/main/repositories/lookupRepository')
const { assetRepository } = await import('../../../src/main/repositories/assetRepository')
const { assetService } = await import('../../../src/main/services/assetService')

const KINDS = ['itemTypes', 'workshops', 'countries']

function seedUser(username = 'admin') {
  const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
  const id = ctx.db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES (?, 'x', 'Admin', ?)")
    .run(username, roleId).lastInsertRowid
  return { id, username }
}

function seedAsset({ kind, lookupId, itemTypeId, assetCode = 'A-1', serialNumber = 'SN-1' }) {
  const statusId = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
  return assetRepository.create({
    assetCode,
    assetName: 'دستگاه تست',
    itemTypeId: kind === 'itemTypes' ? lookupId : itemTypeId,
    model: null,
    serialNumber,
    countryId: kind === 'countries' ? lookupId : null,
    workshopId: kind === 'workshops' ? lookupId : null,
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

describe('lookupService.deleteLookup — the three-way lifecycle, identical across Item Types / Workshops / Countries', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('Case: no references at all → hard delete', () => {
        const created = lookupRepository.create(kind, 'مقدار تست')
        const result = lookupService.deleteLookup(kind, created.id)
        expect(result).toEqual({ id: created.id, name: 'مقدار تست', action: 'deleted' })
        expect(lookupRepository.findById(kind, created.id)).toBeUndefined()
      })

      it('Case A: an ACTIVE asset references it → blocked, not deleted or deactivated', () => {
        const { itemTypeId } = seedMinimalLookups(ctx.db)
        const created = lookupRepository.create(kind, 'مقدار تست')
        seedAsset({ kind, lookupId: created.id, itemTypeId })

        expect(() => lookupService.deleteLookup(kind, created.id)).toThrow(/1 دارایی فعال/)
        const row = lookupRepository.findById(kind, created.id)
        expect(row).toBeDefined()
        expect(row.is_active).toBe(1)
      })

      it('Case B: ONLY a soft-deleted asset references it → deactivated, not blocked, not hard-deleted', () => {
        const { itemTypeId } = seedMinimalLookups(ctx.db)
        const created = lookupRepository.create(kind, 'مقدار تست')
        const assetId = seedAsset({ kind, lookupId: created.id, itemTypeId })
        assetRepository.softDelete(assetId, null)

        const result = lookupService.deleteLookup(kind, created.id)
        expect(result).toEqual({ id: created.id, name: 'مقدار تست', action: 'deactivated', historicalUsage: 1 })

        const row = lookupRepository.findById(kind, created.id)
        expect(row).toBeDefined() // NOT hard-deleted
        expect(row.is_active).toBe(0)
      })

      it('Case C: one active + one soft-deleted asset reference it → still blocked (the active one)', () => {
        const { itemTypeId } = seedMinimalLookups(ctx.db)
        const created = lookupRepository.create(kind, 'مقدار تست')
        seedAsset({ kind, lookupId: created.id, itemTypeId, assetCode: 'A-1', serialNumber: 'SN-1' })
        const deletedAssetId = seedAsset({ kind, lookupId: created.id, itemTypeId, assetCode: 'A-2', serialNumber: 'SN-2' })
        assetRepository.softDelete(deletedAssetId, null)

        expect(() => lookupService.deleteLookup(kind, created.id)).toThrow(/1 دارایی فعال/)
        expect(lookupRepository.findById(kind, created.id).is_active).toBe(1)
      })

      it('Case D: several assets, ALL soft-deleted → deactivated', () => {
        const { itemTypeId } = seedMinimalLookups(ctx.db)
        const created = lookupRepository.create(kind, 'مقدار تست')
        const a1 = seedAsset({ kind, lookupId: created.id, itemTypeId, assetCode: 'A-1', serialNumber: 'SN-1' })
        const a2 = seedAsset({ kind, lookupId: created.id, itemTypeId, assetCode: 'A-2', serialNumber: 'SN-2' })
        assetRepository.softDelete(a1, null)
        assetRepository.softDelete(a2, null)

        const result = lookupService.deleteLookup(kind, created.id)
        expect(result.action).toBe('deactivated')
        expect(lookupRepository.findById(kind, created.id).is_active).toBe(0)
      })

      it('a genuine raw-SQL hard DELETE would actually fail on Case B — confirms deactivation is not merely a UX choice', () => {
        const { itemTypeId } = seedMinimalLookups(ctx.db)
        const created = lookupRepository.create(kind, 'مقدار تست')
        const assetId = seedAsset({ kind, lookupId: created.id, itemTypeId })
        assetRepository.softDelete(assetId, null)

        const table = { itemTypes: 'item_types', workshops: 'workshops', countries: 'countries' }[kind]
        expect(() => ctx.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(created.id)).toThrow(
          /FOREIGN KEY constraint failed/
        )
      })
    })
  }

  it('rejects an id that no longer exists', () => {
    expect(() => lookupService.deleteLookup('itemTypes', 99999)).toThrow(/یافت نشد/)
  })

  it('still refuses "statuses" entirely — unchanged, Status Management is not part of this phase', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    expect(() => lookupService.deleteLookup('statuses', created.id)).toThrow(/قابل حذف نیست/)
  })
})

describe('lookupService.deleteLookupsBulk — mixed outcomes in one operation (Section 8 / 14 acceptance criteria)', () => {
  it('A (unused) is hard-deleted, B (historical-only) is deactivated, C (active) is protected — all in the same call', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const a = lookupRepository.create('workshops', 'A - بدون استفاده')
    const b = lookupRepository.create('workshops', 'B - فقط سابقه تاریخی')
    const c = lookupRepository.create('workshops', 'C - دارایی فعال')

    const bAssetId = seedAsset({ kind: 'workshops', lookupId: b.id, itemTypeId, assetCode: 'A-1', serialNumber: 'SN-1' })
    assetRepository.softDelete(bAssetId, null)
    seedAsset({ kind: 'workshops', lookupId: c.id, itemTypeId, assetCode: 'A-2', serialNumber: 'SN-2' })

    const result = lookupService.deleteLookupsBulk('workshops', [a.id, b.id, c.id])

    expect(result.deletedCount).toBe(1)
    expect(result.deactivatedCount).toBe(1)
    expect(result.blocked).toEqual([{ id: c.id, name: 'C - دارایی فعال', activeUsage: 1 }])

    expect(lookupRepository.findById('workshops', a.id)).toBeUndefined()
    expect(lookupRepository.findById('workshops', b.id).is_active).toBe(0)
    expect(lookupRepository.findById('workshops', c.id).is_active).toBe(1)
  })

  it('one blocked record does not prevent a different, safe record in the same selection from being processed', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const safe = lookupRepository.create('itemTypes', 'ایمن')
    const blocked = lookupRepository.create('itemTypes', 'مسدود')
    seedAsset({ kind: 'itemTypes', lookupId: blocked.id, itemTypeId: blocked.id, assetCode: 'A-1', serialNumber: 'SN-1' })

    const result = lookupService.deleteLookupsBulk('itemTypes', [safe.id, blocked.id])
    expect(result.deletedCount).toBe(1)
    expect(lookupRepository.findById('itemTypes', safe.id)).toBeUndefined()
    expect(result.blocked.map((b) => b.id)).toEqual([blocked.id])
  })

  it('is transactional: every delete/deactivate in the plan either all apply or none do', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const a = lookupRepository.create('countries', 'کشور یک')
    const b = lookupRepository.create('countries', 'کشور دو')
    const bAssetId = seedAsset({ kind: 'countries', lookupId: b.id, itemTypeId, assetCode: 'A-1', serialNumber: 'SN-1' })
    assetRepository.softDelete(bAssetId, null)

    lookupService.deleteLookupsBulk('countries', [a.id, b.id])
    expect(lookupRepository.findById('countries', a.id)).toBeUndefined()
    expect(lookupRepository.findById('countries', b.id).is_active).toBe(0)
  })

  it('rejects an empty selection', () => {
    expect(() => lookupService.deleteLookupsBulk('itemTypes', [])).toThrow(/انتخاب نشده/)
  })

  it('rejects a selection containing an id that no longer exists', () => {
    const real = lookupRepository.create('itemTypes', 'واقعی')
    expect(() => lookupService.deleteLookupsBulk('itemTypes', [real.id, 99999])).toThrow(/یافت نشد|وجود ندارد/)
  })

  it('still refuses "statuses" entirely — unchanged', () => {
    expect(() => lookupService.deleteLookupsBulk('statuses', [1])).toThrow(/قابل حذف نیست/)
  })
})

describe('lookupService.setLookupActive — reactivate / manual deactivate', () => {
  it('reactivates a value that was deactivated by deleteLookup', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const created = lookupRepository.create('workshops', 'واحد بازیابی‌شده')
    const assetId = seedAsset({ kind: 'workshops', lookupId: created.id, itemTypeId })
    assetRepository.softDelete(assetId, null)
    lookupService.deleteLookup('workshops', created.id)
    expect(lookupRepository.findById('workshops', created.id).is_active).toBe(0)

    const result = lookupService.setLookupActive('workshops', created.id, true)
    expect(result).toEqual({ id: created.id, name: 'واحد بازیابی‌شده', isActive: true })
    expect(lookupRepository.findById('workshops', created.id).is_active).toBe(1)
  })

  it('a reactivated value becomes selectable for a new asset again', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const created = lookupRepository.create('workshops', 'واحد بازیابی‌شده')
    const assetId = seedAsset({ kind: 'workshops', lookupId: created.id, itemTypeId })
    assetRepository.softDelete(assetId, null)
    lookupService.deleteLookup('workshops', created.id)

    expect(lookupRepository.findActiveByName('workshops', 'واحد بازیابی‌شده')).toBeUndefined()
    lookupService.setLookupActive('workshops', created.id, true)
    expect(lookupRepository.findActiveByName('workshops', 'واحد بازیابی‌شده')).toBeDefined()
  })

  it('can also manually deactivate a currently-unused active value, without going through delete', () => {
    const created = lookupRepository.create('countries', 'کشور بدون استفاده')
    const result = lookupService.setLookupActive('countries', created.id, false)
    expect(result.isActive).toBe(false)
    expect(lookupRepository.findById('countries', created.id).is_active).toBe(0)
  })

  it('still refuses "statuses" — that kind keeps using its own dedicated setStatusActive', () => {
    expect(() => lookupService.setLookupActive('statuses', 1, true)).toThrow(/قابل حذف نیست/)
  })
})

describe('lookupService.createLookup — reusing a retired name (Section 7)', () => {
  it('allows creating a new ACTIVE value with the same name as an existing INACTIVE one', () => {
    const original = lookupRepository.create('itemTypes', 'لپ‌تاپ Dell')
    lookupService.setLookupActive('itemTypes', original.id, false)

    const recreated = lookupService.createLookup('itemTypes', 'لپ‌تاپ Dell')
    expect(recreated.id).not.toBe(original.id) // a genuinely distinct row, not a silent reactivation
    expect(lookupRepository.findById('itemTypes', recreated.id).is_active).toBe(1)
    expect(lookupRepository.findById('itemTypes', original.id).is_active).toBe(0) // untouched
  })

  it('still refuses two ACTIVE values with the same name', () => {
    lookupService.createLookup('itemTypes', 'لپ‌تاپ Dell')
    expect(() => lookupService.createLookup('itemTypes', 'لپ‌تاپ Dell')).toThrow(/قبل وجود دارد/)
  })

  it('delete-then-recreate the exact scenario from the report: works once nothing active references it', () => {
    const { itemTypeId: otherItemType } = seedMinimalLookups(ctx.db)
    const laptop = lookupService.createLookup('itemTypes', 'Laptop')
    const assetId = seedAsset({ kind: 'itemTypes', lookupId: laptop.id, itemTypeId: laptop.id })
    assetRepository.softDelete(assetId, null)

    const deleteResult = lookupService.deleteLookup('itemTypes', laptop.id)
    expect(deleteResult.action).toBe('deactivated') // history exists, so retired rather than removed

    const recreated = lookupService.createLookup('itemTypes', 'Laptop')
    expect(recreated.id).not.toBe(laptop.id)
    expect(lookupRepository.findActiveByName('itemTypes', 'Laptop').id).toBe(recreated.id)
    void otherItemType
  })
})

describe('Active-only enforcement is backend, not just UI (Section 4) — via assetService', () => {
  it('rejects creating a new asset with an inactive item type', () => {
    const created = lookupRepository.create('itemTypes', 'نوع غیرفعال')
    lookupService.setLookupActive('itemTypes', created.id, false)
    const user = seedUser()
    const statusId = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id

    expect(() =>
      assetService.createAsset(
        { assetCode: 'A-1', assetName: 'دستگاه', itemType: 'نوع غیرفعال', serialNumber: 'SN-1', status: 'در انبار' },
        user
      )
    ).toThrow(/غیرفعال/)
    void statusId
  })

  it('rejects changing an EXISTING asset onto an inactive item type', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const inactive = lookupRepository.create('itemTypes', 'نوع غیرفعال')
    lookupService.setLookupActive('itemTypes', inactive.id, false)
    const user = seedUser()
    const assetId = seedAsset({ kind: 'itemTypes', lookupId: itemTypeId, itemTypeId })

    expect(() =>
      assetService.updateAsset(
        assetId,
        {
          assetCode: 'A-1',
          assetName: 'دستگاه',
          itemType: 'نوع غیرفعال',
          serialNumber: 'SN-1',
          status: 'در انبار'
        },
        user
      )
    ).toThrow(/غیرفعال/)
  })

  it('editing OTHER fields on an asset that already has an inactive item type does not fail (Section 5)', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const assetId = seedAsset({ kind: 'itemTypes', lookupId: itemTypeId, itemTypeId })
    lookupService.setLookupActive('itemTypes', itemTypeId, false) // deactivated AFTER the asset already uses it

    const existing = assetRepository.getById(assetId)
    const updated = assetService.updateAsset(
      assetId,
      {
        assetCode: existing.asset_code,
        assetName: existing.asset_name,
        itemType: 'تجهیزات تست', // unchanged — same name the asset already has
        serialNumber: existing.serial_number,
        status: 'در انبار',
        notes: 'یادداشت جدید'
      },
      user
    )
    expect(updated.itemType).toBe('تجهیزات تست') // preserved, not rejected
    expect(assetRepository.getById(assetId).item_type_id).toBe(itemTypeId) // exact same historical row
  })

  it('an ACTIVE asset whose item type later becomes inactive still displays it correctly everywhere the asset is read', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const assetId = seedAsset({ kind: 'itemTypes', lookupId: itemTypeId, itemTypeId })
    lookupService.setLookupActive('itemTypes', itemTypeId, false)

    expect(assetRepository.getById(assetId).item_type).toBe('تجهیزات تست')
    expect(assetRepository.list({}).rows.find((r) => r.id === assetId).item_type).toBe('تجهیزات تست')
  })

  it('a SOFT-DELETED asset keeps its exact historical item_type_id even after that item type is deactivated (data-level — no UI currently exposes a soft-deleted asset\'s details)', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const assetId = seedAsset({ kind: 'itemTypes', lookupId: itemTypeId, itemTypeId })
    assetRepository.softDelete(assetId, null)
    lookupService.deleteLookup('itemTypes', itemTypeId) // deactivates, since the only reference is now historical

    const raw = ctx.db.prepare('SELECT item_type_id, is_deleted FROM assets WHERE id = ?').get(assetId)
    expect(raw.is_deleted).toBe(1)
    expect(raw.item_type_id).toBe(itemTypeId) // untouched — not nulled, not reassigned
  })
})

describe('Foreign-key integrity survives the migration/rebuild (004-base-data-lifecycle.sql)', () => {
  it('assets.item_type_id / workshop_id / country_id still correctly reference the rebuilt tables', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const workshop = lookupRepository.create('workshops', 'واحد یک')
    const country = lookupRepository.create('countries', 'کشور یک')
    const assetId = assetRepository.create({
      assetCode: 'A-1',
      assetName: 'دستگاه',
      itemTypeId,
      model: null,
      serialNumber: 'SN-1',
      countryId: country.id,
      workshopId: workshop.id,
      warehouseEntryDate: null,
      warehouseExitDate: null,
      deliveredBy: null,
      receivedBy: null,
      statusId: ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id,
      notes: null
    })

    const row = assetRepository.getById(assetId)
    expect(row.item_type).toBe('تجهیزات تست')
    expect(row.workshop).toBe('واحد یک')
    expect(row.country).toBe('کشور یک')
  })

  it('passes PRAGMA foreign_key_check after create/deactivate/reactivate/delete activity', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const a = lookupRepository.create('workshops', 'A')
    const b = lookupRepository.create('workshops', 'B')
    seedAsset({ kind: 'workshops', lookupId: a.id, itemTypeId })
    const bAssetId = seedAsset({ kind: 'workshops', lookupId: b.id, itemTypeId, assetCode: 'A-2', serialNumber: 'SN-2' })
    assetRepository.softDelete(bAssetId, null)
    lookupService.deleteLookup('workshops', b.id)
    lookupService.setLookupActive('workshops', b.id, true)

    expect(ctx.db.pragma('foreign_key_check')).toEqual([])
    expect(ctx.db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})

// Reliability + Audit Completeness phase — the generic item type/
// workshop/country CRUD path (createLookup/deleteLookup/
// deleteLookupsBulk/setLookupActive) previously recorded no audit trail
// at all; asset_statuses' own dedicated functions already did (see
// statusManagement.test.js), and this brings the other three base-data
// kinds up to the same standard, one entityType per kind.
const KIND_TO_ENTITY_TYPE = { itemTypes: 'ItemType', workshops: 'Workshop', countries: 'Country' }

describe('Reliability + Audit Completeness — generic lookup CRUD is now audited', () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it('createLookup records a CREATE entry attributed to the acting user', () => {
        const user = seedUser()
        const created = lookupService.createLookup(kind, 'مقدار تست', user)
        const entry = ctx.db.prepare('SELECT * FROM audit_log WHERE action = ?').get('CREATE')
        expect(entry).toBeDefined()
        expect(entry.entity_type).toBe(KIND_TO_ENTITY_TYPE[kind])
        expect(entry.entity_id).toBe(created.id)
        expect(entry.user_id).toBe(user.id)
        expect(entry.username_snapshot).toBe(user.username)
      })

      it('deleteLookup records a DELETE entry for the hard-delete case', () => {
        const user = seedUser()
        const created = lookupRepository.create(kind, 'مقدار تست')
        lookupService.deleteLookup(kind, created.id, user)
        const entry = ctx.db.prepare('SELECT * FROM audit_log WHERE action = ?').get('DELETE')
        expect(entry).toBeDefined()
        expect(entry.entity_type).toBe(KIND_TO_ENTITY_TYPE[kind])
        expect(entry.entity_id).toBe(created.id)
      })

      it('deleteLookup records a DEACTIVATED entry (not DELETE) for the historical-reference case', () => {
        const { itemTypeId } = seedMinimalLookups(ctx.db)
        const user = seedUser()
        const created = lookupRepository.create(kind, 'مقدار تست')
        const assetId = seedAsset({ kind, lookupId: created.id, itemTypeId })
        assetRepository.softDelete(assetId, user.id)

        lookupService.deleteLookup(kind, created.id, user)

        expect(ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'DELETE'").get().n).toBe(0)
        const entry = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'DEACTIVATED'").get()
        expect(entry).toBeDefined()
        expect(entry.entity_type).toBe(KIND_TO_ENTITY_TYPE[kind])
        expect(entry.entity_id).toBe(created.id)
      })

      it('setLookupActive records REACTIVATED / DEACTIVATED depending on direction', () => {
        const user = seedUser()
        const created = lookupRepository.create(kind, 'مقدار تست')

        lookupService.setLookupActive(kind, created.id, false, user)
        expect(
          ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'DEACTIVATED'").get().n
        ).toBe(1)

        lookupService.setLookupActive(kind, created.id, true, user)
        const reactivated = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'REACTIVATED'").get()
        expect(reactivated).toBeDefined()
        expect(reactivated.entity_type).toBe(KIND_TO_ENTITY_TYPE[kind])
        expect(reactivated.entity_id).toBe(created.id)
      })

      it('deleteLookupsBulk records one entry per changed row and none for a blocked one', () => {
        const { itemTypeId } = seedMinimalLookups(ctx.db)
        const user = seedUser()
        const toDelete = lookupRepository.create(kind, 'حذف می‌شود')
        const toDeactivate = lookupRepository.create(kind, 'غیرفعال می‌شود')
        const blocked = lookupRepository.create(kind, 'مسدود')

        const historicalAssetId = seedAsset({
          kind,
          lookupId: toDeactivate.id,
          itemTypeId,
          assetCode: 'HIST-1',
          serialNumber: 'SN-HIST-1'
        })
        assetRepository.softDelete(historicalAssetId, user.id)
        seedAsset({ kind, lookupId: blocked.id, itemTypeId, assetCode: 'ACTIVE-1', serialNumber: 'SN-ACTIVE-1' })

        lookupService.deleteLookupsBulk(kind, [toDelete.id, toDeactivate.id, blocked.id], user)

        expect(ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_id = ?").get(toDelete.id).n).toBe(1)
        expect(
          ctx.db.prepare("SELECT action FROM audit_log WHERE entity_id = ?").get(toDelete.id).action
        ).toBe('DELETE')
        expect(
          ctx.db.prepare("SELECT action FROM audit_log WHERE entity_id = ?").get(toDeactivate.id).action
        ).toBe('DEACTIVATED')
        // The blocked row never changed, so it gets no audit entry at all.
        expect(ctx.db.prepare('SELECT COUNT(*) n FROM audit_log WHERE entity_id = ?').get(blocked.id).n).toBe(0)
        expect(ctx.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n).toBe(2)
      })
    })
  }

  it('does not throw and records username_snapshot as "system" if no user is passed (defensive — every real caller does pass one)', () => {
    const created = lookupRepository.create('itemTypes', 'بدون کاربر')
    expect(() => lookupService.deleteLookup('itemTypes', created.id)).not.toThrow()
    const entry = ctx.db.prepare('SELECT * FROM audit_log').get()
    expect(entry.username_snapshot).toBe('system')
    expect(entry.user_id).toBeNull()
  })
})
