import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, cleanupTestDb, seedMinimalLookups } from '../testHelpers/testDb'

let ctx

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

const { lookupService } = await import('../../../src/main/services/lookupService')
const { lookupRepository } = await import('../../../src/main/repositories/lookupRepository')
const { assetRepository } = await import('../../../src/main/repositories/assetRepository')

const SYSTEM_NAMES = ['در انبار', 'صادر شده', 'مرجوع شده', 'آسیب‌دیده']

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

describe('lookupService.listStatuses', () => {
  it('lists all four system statuses as protected and active, ordered by sort_order', () => {
    const list = lookupService.listStatuses()
    expect(list).toHaveLength(4)
    expect(list.every((s) => s.isSystem)).toBe(true)
    expect(list.every((s) => s.isActive)).toBe(true)
    expect(list.every((s) => s.usageCount === 0)).toBe(true)
    expect(list.map((s) => s.name)).toEqual(SYSTEM_NAMES) // sort_order 1-4, seeded in this exact order
  })

  it('marks an administrator-created status as not system', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    const list = lookupService.listStatuses()
    const found = list.find((s) => s.id === created.id)
    expect(found.isSystem).toBe(false)
    expect(found.isActive).toBe(true)
  })

  // Phase 1A — added so the retired statusCleanup.test.js scenario "reports how
  // many assets use a legacy status" keeps direct coverage: the existing tests
  // here only asserted usageCount for a SOFT-DELETED asset, never for plain
  // active ones.
  it('reports how many assets use a custom status (active assets are counted)', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    seedAsset({ statusId: created.id, itemTypeId, assetCode: 'A-1', serialNumber: 'SN-1' })
    seedAsset({ statusId: created.id, itemTypeId, assetCode: 'A-2', serialNumber: 'SN-2' })

    expect(lookupService.listStatuses().find((s) => s.id === created.id).usageCount).toBe(2)
  })

  it('counts a soft-deleted asset toward a custom status usage count too', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    const assetId = seedAsset({ statusId: created.id, itemTypeId })
    assetRepository.softDelete(assetId, null)

    expect(lookupService.listStatuses().find((s) => s.id === created.id).usageCount).toBe(1)
  })
})

describe('lookupService.createStatus', () => {
  it('creates a new active, non-system status appended after the existing ones', () => {
    const user = seedUser()
    const result = lookupService.createStatus('تعمیر', user)
    expect(result.isActive).toBe(true)
    expect(result.isSystem).toBe(false)
    expect(result.sortOrder).toBe(5) // after the four system statuses (sort_order 1-4)
  })

  it('records a STATUS_CREATED audit entry', () => {
    const user = seedUser()
    lookupService.createStatus('تعمیر', user)
    const entry = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'STATUS_CREATED'").get()
    expect(entry).toBeDefined()
    expect(JSON.parse(entry.changes)).toEqual({ name: 'تعمیر' })
  })

  it('trims whitespace and refuses an empty name', () => {
    const user = seedUser()
    const result = lookupService.createStatus('  قرنطینه  ', user)
    expect(result.name).toBe('قرنطینه')
    expect(() => lookupService.createStatus('   ', user)).toThrow(/خالی/)
  })

  it('refuses a duplicate name, including one of the four system names', () => {
    const user = seedUser()
    lookupService.createStatus('تعمیر', user)
    expect(() => lookupService.createStatus('تعمیر', user)).toThrow(/قبل وجود دارد/)
    expect(() => lookupService.createStatus('در انبار', user)).toThrow(/قبل وجود دارد/)
  })

  it('appends a second custom status after the first one, not colliding sort_order', () => {
    const user = seedUser()
    lookupService.createStatus('تعمیر', user)
    const second = lookupService.createStatus('اسقاط', user)
    expect(second.sortOrder).toBe(6)
  })
})

describe('lookupService.renameStatus', () => {
  it('renames a custom status and records a STATUS_RENAMED audit entry', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    const result = lookupService.renameStatus(created.id, 'در حال تعمیر', user)
    expect(result.name).toBe('در حال تعمیر')

    const entry = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'STATUS_RENAMED'").get()
    expect(JSON.parse(entry.changes)).toEqual({ from: 'تعمیر', to: 'در حال تعمیر' })
  })

  it('refuses to rename any of the four system statuses', () => {
    const user = seedUser()
    const system = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get()
    expect(() => lookupService.renameStatus(system.id, 'انبار جدید', user)).toThrow(/سیستمی/)
  })

  it('refuses an empty new name', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    expect(() => lookupService.renameStatus(created.id, '   ', user)).toThrow(/خالی/)
  })

  it('refuses a name clash with a different existing status', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    expect(() => lookupService.renameStatus(created.id, 'در انبار', user)).toThrow(/قبلاً/)
  })

  it('allows renaming to the exact same name it already has (no-op)', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    const result = lookupService.renameStatus(created.id, 'تعمیر', user)
    expect(result.name).toBe('تعمیر')
  })
})

describe('lookupService.setStatusActive', () => {
  it('deactivates a custom status and records a STATUS_DEACTIVATED audit entry', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    const result = lookupService.setStatusActive(created.id, false, user)
    expect(result.isActive).toBe(false)
    expect(
      ctx.db.prepare("SELECT action FROM audit_log WHERE entity_id = ? ORDER BY id DESC LIMIT 1").get(created.id)
        .action
    ).toBe('STATUS_DEACTIVATED')
  })

  it('reactivates it again, recording STATUS_ACTIVATED', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    lookupService.setStatusActive(created.id, false, user)
    const result = lookupService.setStatusActive(created.id, true, user)
    expect(result.isActive).toBe(true)
    const entries = ctx.db.prepare('SELECT action FROM audit_log WHERE entity_id = ? ORDER BY id').all(created.id)
    expect(entries.map((e) => e.action)).toEqual(['STATUS_CREATED', 'STATUS_DEACTIVATED', 'STATUS_ACTIVATED'])
  })

  it('refuses to deactivate (or "activate") any of the four system statuses', () => {
    const user = seedUser()
    const system = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get()
    expect(() => lookupService.setStatusActive(system.id, false, user)).toThrow(/سیستمی/)
    expect(() => lookupService.setStatusActive(system.id, true, user)).toThrow(/سیستمی/)
  })

  it('deactivating does not touch any asset or transaction data', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    const assetId = seedAsset({ statusId: created.id, itemTypeId })

    lookupService.setStatusActive(created.id, false, user)

    expect(ctx.db.prepare('SELECT status_id FROM assets WHERE id = ?').get(assetId).status_id).toBe(created.id)
    expect(lookupRepository.countUsage('statuses', created.id)).toBe(1)
  })
})

describe('lookupService.moveStatus (reordering)', () => {
  it('moves the second status up to first place', () => {
    const ordered = lookupService.listStatuses()
    const second = ordered[1]
    const result = lookupService.moveStatus(second.id, 'up')
    expect(result.moved).toBe(true)

    const after = lookupService.listStatuses()
    expect(after[0].id).toBe(second.id)
  })

  it('is a no-op (not an error) at the top edge', () => {
    const ordered = lookupService.listStatuses()
    const result = lookupService.moveStatus(ordered[0].id, 'up')
    expect(result.moved).toBe(false)
  })

  it('is a no-op (not an error) at the bottom edge', () => {
    const ordered = lookupService.listStatuses()
    const last = ordered[ordered.length - 1]
    const result = lookupService.moveStatus(last.id, 'down')
    expect(result.moved).toBe(false)
  })

  it('works for system statuses too — reordering is purely cosmetic', () => {
    const ordered = lookupService.listStatuses()
    const result = lookupService.moveStatus(ordered[0].id, 'down')
    expect(result.moved).toBe(true)
  })

  it('throws for a status id that no longer exists', () => {
    expect(() => lookupService.moveStatus(99999, 'up')).toThrow(/یافت نشد/)
  })
})

describe('lookupService.deleteStatus', () => {
  it('deletes a custom status nothing references', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    const result = lookupService.deleteStatus(created.id, user)
    expect(result).toEqual({ id: created.id, name: 'تعمیر' })
    expect(lookupRepository.findById('statuses', created.id)).toBeUndefined()
  })

  it('records a STATUS_DELETED audit entry with no reassignment target', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    lookupService.deleteStatus(created.id, user)
    const entry = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'STATUS_DELETED'").get()
    expect(JSON.parse(entry.changes)).toEqual({ name: 'تعمیر', reassignedTo: null, assetCount: 0 })
  })

  it('refuses to delete any of the four system statuses', () => {
    const user = seedUser()
    const system = ctx.db.prepare("SELECT id, name FROM asset_statuses WHERE name = 'در انبار'").get()
    expect(() => lookupService.deleteStatus(system.id, user)).toThrow(/سیستمی/)
    expect(lookupRepository.findById('statuses', system.id)).toBeDefined()
  })

  it('refuses to delete a custom status an active asset uses, suggesting deactivation instead', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    seedAsset({ statusId: created.id, itemTypeId })

    expect(() => lookupService.deleteStatus(created.id, user)).toThrow(/غیرفعال/)
    expect(lookupRepository.findById('statuses', created.id)).toBeDefined()
  })

  it('refuses to delete a custom status only a soft-deleted asset uses', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    const assetId = seedAsset({ statusId: created.id, itemTypeId })
    assetRepository.softDelete(assetId, null)

    expect(() => lookupService.deleteStatus(created.id, user)).toThrow(/دارایی/)
  })

  it('rejects an id that no longer exists', () => {
    const user = seedUser()
    expect(() => lookupService.deleteStatus(99999, user)).toThrow(/یافت نشد/)
  })
})

describe('lookupService.migrateAndDeleteStatus', () => {
  it('refuses to migrate any of the four system statuses', () => {
    const user = seedUser()
    const system = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get()
    expect(() => lookupService.migrateAndDeleteStatus(system.id, 'صادر شده', user)).toThrow(/سیستمی/)
  })

  it('refuses a target status name that does not exist', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    expect(() => lookupService.migrateAndDeleteStatus(created.id, 'Nonexistent', user)).toThrow(/فعال/)
  })

  it('refuses an inactive target', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    const other = lookupService.createStatus('اسقاط', user)
    lookupService.setStatusActive(other.id, false, user)

    expect(() => lookupService.migrateAndDeleteStatus(created.id, 'اسقاط', user)).toThrow(/فعال/)
  })

  it('refuses when the target is the same status being deleted', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    expect(() => lookupService.migrateAndDeleteStatus(created.id, 'تعمیر', user)).toThrow(/نمی‌تواند همان/)
  })

  it('moves every asset onto a custom target status, then deletes the source', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const source = lookupService.createStatus('تعمیر', user)
    const target = lookupService.createStatus('در حال تعمیر', user)
    const a1 = seedAsset({ statusId: source.id, itemTypeId, assetCode: 'A-1', serialNumber: 'SN-1' })
    const a2 = seedAsset({ statusId: source.id, itemTypeId, assetCode: 'A-2', serialNumber: 'SN-2' })

    const result = lookupService.migrateAndDeleteStatus(source.id, 'در حال تعمیر', user)
    expect(result).toEqual({ id: source.id, name: 'تعمیر', reassignedTo: 'در حال تعمیر', assetCount: 2 })
    expect(lookupRepository.findById('statuses', source.id)).toBeUndefined()
    expect(assetRepository.getById(a1).status_id).toBe(target.id)
    expect(assetRepository.getById(a2).status_id).toBe(target.id)
  })

  it('can migrate onto a system status target', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const source = lookupService.createStatus('تعمیر', user)
    const assetId = seedAsset({ statusId: source.id, itemTypeId })
    const target = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get()

    lookupService.migrateAndDeleteStatus(source.id, 'در انبار', user)
    expect(assetRepository.getById(assetId).status_id).toBe(target.id)
  })

  it('also reassigns soft-deleted assets, so the source row can actually be deleted', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const source = lookupService.createStatus('تعمیر', user)
    const assetId = seedAsset({ statusId: source.id, itemTypeId })
    assetRepository.softDelete(assetId, null)

    const result = lookupService.migrateAndDeleteStatus(source.id, 'در انبار', user)
    expect(result.assetCount).toBe(1)
    expect(lookupRepository.findById('statuses', source.id)).toBeUndefined()
  })

  it('writes a transaction-ledger entry per reassigned asset, naming the old status in notes', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const source = lookupService.createStatus('تعمیر', user)
    const assetId = seedAsset({ statusId: source.id, itemTypeId })

    lookupService.migrateAndDeleteStatus(source.id, 'در انبار', user)

    const tx = ctx.db.prepare('SELECT * FROM asset_transactions WHERE asset_id = ?').get(assetId)
    expect(tx).toBeDefined()
    expect(tx.previous_status_id).toBeNull()
    expect(tx.notes).toContain('تعمیر')
  })

  it('records exactly one audit entry for the whole migration, not one per asset', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const source = lookupService.createStatus('تعمیر', user)
    seedAsset({ statusId: source.id, itemTypeId, assetCode: 'A-1', serialNumber: 'SN-1' })
    seedAsset({ statusId: source.id, itemTypeId, assetCode: 'A-2', serialNumber: 'SN-2' })
    seedAsset({ statusId: source.id, itemTypeId, assetCode: 'A-3', serialNumber: 'SN-3' })

    lookupService.migrateAndDeleteStatus(source.id, 'در انبار', user)

    const entries = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'STATUS_DELETED'").all()
    expect(entries).toHaveLength(1)
    expect(JSON.parse(entries[0].changes)).toEqual({ name: 'تعمیر', reassignedTo: 'در انبار', assetCount: 3 })
  })

  it('works with zero assets too — a plain delete with no transaction rows', () => {
    const user = seedUser()
    const source = lookupService.createStatus('تعمیر', user)
    const result = lookupService.migrateAndDeleteStatus(source.id, 'در انبار', user)
    expect(result.assetCount).toBe(0)
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM asset_transactions').get().n).toBe(0)
  })

  it('refuses (and rolls back the reassignment) when historical transaction records still reference the status', () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const user = seedUser()
    const source = lookupService.createStatus('تعمیر', user)
    const target = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get()
    const assetId = seedAsset({ statusId: target.id, itemTypeId })

    // Simulates a historical transaction from back when this status was
    // actually assigned via ChangeStatusModal, before being superseded.
    ctx.db
      .prepare(
        `INSERT INTO asset_transactions (asset_id, previous_status_id, new_status_id, performed_by_user_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(assetId, target.id, source.id, user.id)

    expect(lookupService.listStatuses().find((s) => s.id === source.id).usageCount).toBe(0)
    expect(() => lookupService.migrateAndDeleteStatus(source.id, 'در انبار', user)).toThrow(/تاریخی/)
    expect(lookupRepository.findById('statuses', source.id)).toBeDefined()
  })
})

describe('the generic lookup create/delete path still refuses statuses entirely (unchanged)', () => {
  it('deleteLookup("statuses", ...) still throws even for a deletable custom status', () => {
    const user = seedUser()
    const created = lookupService.createStatus('تعمیر', user)
    expect(() => lookupService.deleteLookup('statuses', created.id)).toThrow(/قابل حذف نیست/)
  })

  it('createLookup("statuses", ...) redirects to the dedicated status screen instead of creating anything', () => {
    expect(() => lookupService.createLookup('statuses', 'Another Status')).toThrow(/وضعیت/)
    expect(lookupRepository.findByName('statuses', 'Another Status')).toBeUndefined()
  })
})
