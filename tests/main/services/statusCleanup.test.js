import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, cleanupTestDb, seedMinimalLookups } from '../testHelpers/testDb'

let ctx

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

const { lookupService } = await import('../../../src/main/services/lookupService')
const { lookupRepository } = await import('../../../src/main/repositories/lookupRepository')
const { assetRepository } = await import('../../../src/main/repositories/assetRepository')

const CANONICAL_NAMES = ['در انبار', 'صادر شده', 'مرجوع شده', 'آسیب‌دیده', 'مفقود']

function seedUser(username = 'admin') {
  const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
  const id = ctx.db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES (?, 'x', 'Admin', ?)")
    .run(username, roleId).lastInsertRowid
  return { id, username }
}

function seedAsset({ statusId, assetCode = 'A-1', serialNumber = 'SN-1', itemTypeId }) {
  return assetRepository.create({
    assetCode,
    assetName: 'دستگاه تست',
    itemTypeId,
    model: null,
    serialNumber,
    countryId: null,
    workshopId: null,
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

describe('lookupService.listStatusesForCleanup', () => {
  it('lists all five canonical statuses as protected, with zero usage on a fresh database', () => {
    const list = lookupService.listStatusesForCleanup()
    expect(list).toHaveLength(5)
    expect(list.every((s) => s.isCanonical)).toBe(true)
    expect(list.every((s) => s.usageCount === 0)).toBe(true)
    expect(list.map((s) => s.name).sort()).toEqual([...CANONICAL_NAMES].sort())
  })

  it('marks a legacy value as not canonical and reports how many assets use it', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const legacy = lookupRepository.create('statuses', 'In Stock')
    seedAsset({ statusId: legacy.id, itemTypeId })

    const list = lookupService.listStatusesForCleanup()
    const found = list.find((s) => s.id === legacy.id)
    expect(found.isCanonical).toBe(false)
    expect(found.usageCount).toBe(1)
  })

  it('counts a soft-deleted asset toward a legacy status usage count too', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const legacy = lookupRepository.create('statuses', 'Issued')
    const assetId = seedAsset({ statusId: legacy.id, itemTypeId })
    assetRepository.softDelete(assetId, null)

    const list = lookupService.listStatusesForCleanup()
    expect(list.find((s) => s.id === legacy.id).usageCount).toBe(1)
  })
})

describe('lookupService.deleteLegacyStatus', () => {
  it('deletes a legacy status nothing references', () => {
    const legacy = lookupRepository.create('statuses', 'Old English Status')
    const user = seedUser()

    const result = lookupService.deleteLegacyStatus(legacy.id, user)
    expect(result).toEqual({ id: legacy.id, name: 'Old English Status' })
    expect(lookupRepository.findById('statuses', legacy.id)).toBeUndefined()
  })

  it('records a STATUS_DELETED audit entry with no reassignment target', () => {
    const legacy = lookupRepository.create('statuses', 'Old English Status')
    const user = seedUser()
    lookupService.deleteLegacyStatus(legacy.id, user)

    const entry = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'STATUS_DELETED'").get()
    expect(entry).toBeDefined()
    const changes = JSON.parse(entry.changes)
    expect(changes).toEqual({ name: 'Old English Status', reassignedTo: null, assetCount: 0 })
  })

  it('refuses to delete one of the five canonical statuses', () => {
    const canonical = ctx.db.prepare("SELECT id, name FROM asset_statuses WHERE name = 'در انبار'").get()
    const user = seedUser()
    expect(() => lookupService.deleteLegacyStatus(canonical.id, user)).toThrow(/رسمی/)
    expect(lookupRepository.findById('statuses', canonical.id)).toBeDefined()
  })

  it('refuses to delete a legacy status an active asset uses, and says how many', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const legacy = lookupRepository.create('statuses', 'In Stock')
    seedAsset({ statusId: legacy.id, itemTypeId })
    const user = seedUser()

    expect(() => lookupService.deleteLegacyStatus(legacy.id, user)).toThrow(/1 دارایی/)
    expect(lookupRepository.findById('statuses', legacy.id)).toBeDefined()
  })

  it('refuses to delete a legacy status only a soft-deleted asset uses', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const legacy = lookupRepository.create('statuses', 'In Stock')
    const assetId = seedAsset({ statusId: legacy.id, itemTypeId })
    assetRepository.softDelete(assetId, null)
    const user = seedUser()

    expect(() => lookupService.deleteLegacyStatus(legacy.id, user)).toThrow(/دارایی/)
    expect(lookupRepository.findById('statuses', legacy.id)).toBeDefined()
  })

  it('rejects an id that no longer exists', () => {
    const user = seedUser()
    expect(() => lookupService.deleteLegacyStatus(99999, user)).toThrow(/یافت نشد/)
  })
})

describe('lookupService.migrateAndDeleteLegacyStatus', () => {
  it('refuses to migrate one of the five canonical statuses', () => {
    const canonical = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get()
    const user = seedUser()
    expect(() => lookupService.migrateAndDeleteLegacyStatus(canonical.id, 'صادر شده', user)).toThrow(/رسمی/)
  })

  it('refuses a target that is not one of the five canonical statuses', () => {
    const legacyA = lookupRepository.create('statuses', 'Old A')
    const legacyB = lookupRepository.create('statuses', 'Old B')
    const user = seedUser()
    expect(() => lookupService.migrateAndDeleteLegacyStatus(legacyA.id, legacyB.name, user)).toThrow(/رسمی/)
    expect(lookupRepository.findById('statuses', legacyA.id)).toBeDefined() // nothing deleted
  })

  it('refuses a target status name that does not exist at all', () => {
    const legacy = lookupRepository.create('statuses', 'Old A')
    const user = seedUser()
    expect(() => lookupService.migrateAndDeleteLegacyStatus(legacy.id, 'Nonexistent', user)).toThrow(/رسمی/)
  })

  it('moves every asset off the legacy status onto the chosen canonical one, then deletes it', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const legacy = lookupRepository.create('statuses', 'In Stock')
    const target = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get()
    const a1Id = seedAsset({ statusId: legacy.id, itemTypeId, assetCode: 'A-1', serialNumber: 'SN-1' })
    const a2Id = seedAsset({ statusId: legacy.id, itemTypeId, assetCode: 'A-2', serialNumber: 'SN-2' })
    const user = seedUser()

    const result = lookupService.migrateAndDeleteLegacyStatus(legacy.id, 'در انبار', user)
    expect(result).toEqual({ id: legacy.id, name: 'In Stock', reassignedTo: 'در انبار', assetCount: 2 })

    expect(lookupRepository.findById('statuses', legacy.id)).toBeUndefined()
    expect(assetRepository.getById(a1Id).status_id).toBe(target.id)
    expect(assetRepository.getById(a2Id).status_id).toBe(target.id)
  })

  // The FK on assets.status_id doesn't care about is_deleted — a
  // soft-deleted asset left pointing at the legacy status would still
  // block the DELETE at the database level, so the migration must move
  // ALL referencing rows, not just the visible ones.
  it('also reassigns soft-deleted assets, so the legacy row can actually be deleted', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const legacy = lookupRepository.create('statuses', 'In Stock')
    const assetId = seedAsset({ statusId: legacy.id, itemTypeId })
    assetRepository.softDelete(assetId, null)
    const user = seedUser()

    const result = lookupService.migrateAndDeleteLegacyStatus(legacy.id, 'در انبار', user)
    expect(result.assetCount).toBe(1)
    expect(lookupRepository.findById('statuses', legacy.id)).toBeUndefined()

    const target = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get()
    expect(ctx.db.prepare('SELECT status_id FROM assets WHERE id = ?').get(assetId).status_id).toBe(target.id)
  })

  // previousStatusId is deliberately null (see the function's own
  // comment) rather than the legacy status's id — the legacy name is
  // preserved in `notes` instead, precisely so this insert doesn't create
  // a permanent foreign key that would block the legacy row's own
  // deletion a few lines later in the same transaction.
  it('writes one asset_transactions row per reassigned asset, naming the old status in notes', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const legacy = lookupRepository.create('statuses', 'In Stock')
    const assetId = seedAsset({ statusId: legacy.id, itemTypeId })
    const user = seedUser()

    lookupService.migrateAndDeleteLegacyStatus(legacy.id, 'در انبار', user)

    const tx = ctx.db.prepare('SELECT * FROM asset_transactions WHERE asset_id = ?').get(assetId)
    expect(tx).toBeDefined()
    expect(tx.previous_status_id).toBeNull()
    expect(tx.notes).toContain('In Stock')
    const target = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get()
    expect(tx.new_status_id).toBe(target.id)
    expect(tx.performed_by_user_id).toBe(user.id)
  })

  it('records exactly one audit entry for the whole migration, not one per asset', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const legacy = lookupRepository.create('statuses', 'In Stock')
    seedAsset({ statusId: legacy.id, itemTypeId, assetCode: 'A-1', serialNumber: 'SN-1' })
    seedAsset({ statusId: legacy.id, itemTypeId, assetCode: 'A-2', serialNumber: 'SN-2' })
    seedAsset({ statusId: legacy.id, itemTypeId, assetCode: 'A-3', serialNumber: 'SN-3' })
    const user = seedUser()

    lookupService.migrateAndDeleteLegacyStatus(legacy.id, 'در انبار', user)

    const entries = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'STATUS_DELETED'").all()
    expect(entries).toHaveLength(1)
    const changes = JSON.parse(entries[0].changes)
    expect(changes).toEqual({ name: 'In Stock', reassignedTo: 'در انبار', assetCount: 3 })
  })

  it('works with zero assets on the legacy status too — a plain delete with no transaction rows', () => {
    const legacy = lookupRepository.create('statuses', 'Never Used')
    const user = seedUser()

    const result = lookupService.migrateAndDeleteLegacyStatus(legacy.id, 'در انبار', user)
    expect(result.assetCount).toBe(0)
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM asset_transactions').get().n).toBe(0)
  })

  // The real-world reason this whole reassignment mechanism can't always
  // succeed even after moving every current asset off the status: if it
  // was ever used in a PAST status change, an immutable asset_transactions
  // row from back then still references it, and that predates anything
  // this function can do about it.
  it('refuses (and rolls back the reassignment) when historical transaction records still reference the legacy status', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const legacy = lookupRepository.create('statuses', 'In Stock')
    const target = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get()
    const assetId = seedAsset({ statusId: target.id, itemTypeId })
    const user = seedUser()

    // Simulates a historical transaction from back when this status was
    // actually assigned to an asset via ChangeStatusModal, before being
    // superseded — current usage is 0, but the old transaction persists.
    ctx.db
      .prepare(
        `INSERT INTO asset_transactions (asset_id, previous_status_id, new_status_id, performed_by_user_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(assetId, target.id, legacy.id, user.id)

    expect(lookupService.listStatusesForCleanup().find((s) => s.id === legacy.id).usageCount).toBe(0)
    expect(() => lookupService.migrateAndDeleteLegacyStatus(legacy.id, 'در انبار', user)).toThrow(/تاریخی/)

    // Rolled back cleanly — the status row must still exist afterwards.
    expect(lookupRepository.findById('statuses', legacy.id)).toBeDefined()
  })
})

describe('the generic lookup-delete path still refuses statuses entirely (unchanged)', () => {
  it('deleteLookup("statuses", ...) still throws, even for a legacy value the new path can delete', () => {
    const legacy = lookupRepository.create('statuses', 'Untouched By Generic Path')
    expect(() => lookupService.deleteLookup('statuses', legacy.id)).toThrow(/قابل حذف نیست/)
  })

  it('createLookup("statuses", ...) refuses to add a new status through the base-data "افزودن" path', () => {
    expect(() => lookupService.createLookup('statuses', 'Another English Status')).toThrow(/ثابت/)
  })
})
