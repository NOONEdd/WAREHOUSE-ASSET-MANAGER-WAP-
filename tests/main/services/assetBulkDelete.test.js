import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, cleanupTestDb } from '../testHelpers/testDb'

let ctx

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

const { assetService } = await import('../../../src/main/services/assetService')
const { assetRepository } = await import('../../../src/main/repositories/assetRepository')
const { auditService } = await import('../../../src/main/services/auditService')

let currentUser

function seedAsset(overrides = {}) {
  const itemTypeId =
    ctx.db.prepare('SELECT id FROM item_types LIMIT 1').get()?.id ??
    ctx.db.prepare("INSERT INTO item_types (name) VALUES ('تجهیزات تست')").run().lastInsertRowid
  const statusId = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
  return assetRepository.create({
    assetCode: overrides.assetCode ?? `A-${Math.random().toString(36).slice(2)}`,
    assetName: overrides.assetName ?? 'دستگاه تست',
    itemTypeId,
    model: null,
    serialNumber: overrides.serialNumber ?? `SN-${Math.random().toString(36).slice(2)}`,
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
  const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
  const userId = ctx.db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
    .run(roleId).lastInsertRowid
  currentUser = { id: userId, username: 'admin' }
})

afterEach(() => {
  cleanupTestDb(ctx)
})

describe('assetService.deleteAssetsBulk', () => {
  it('soft-deletes every selected asset', () => {
    const ids = [seedAsset(), seedAsset(), seedAsset()]
    const result = assetService.deleteAssetsBulk(ids, currentUser)
    expect(result.count).toBe(3)
    for (const id of ids) {
      const row = ctx.db.prepare('SELECT is_deleted FROM assets WHERE id = ?').get(id)
      expect(row.is_deleted).toBe(1)
    }
  })

  it('is a soft delete, not a hard delete — the row still physically exists', () => {
    const id = seedAsset()
    assetService.deleteAssetsBulk([id], currentUser)
    const row = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id)
    expect(row).toBeDefined()
    expect(row.deleted_at).not.toBeNull()
    expect(row.deleted_by).toBe(currentUser.id)
  })

  it('is all-or-nothing: a nonexistent id in the batch rolls back the whole thing, deleting none', () => {
    const realId = seedAsset()
    const fakeId = realId + 9999

    expect(() => assetService.deleteAssetsBulk([realId, fakeId], currentUser)).toThrow()

    const row = ctx.db.prepare('SELECT is_deleted FROM assets WHERE id = ?').get(realId)
    expect(row.is_deleted).toBe(0) // must NOT have been deleted
  })

  it('records one DELETE audit entry per asset, same shape as single delete', () => {
    const ids = [seedAsset({ assetCode: 'A-100' }), seedAsset({ assetCode: 'A-200' })]
    assetService.deleteAssetsBulk(ids, currentUser)

    const entries = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'DELETE'").all()
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.entity_id).sort()).toEqual([...ids].sort())
    expect(entries.every((e) => e.entity_type === 'Asset')).toBe(true)
  })

  it('preserves existing audit history for the deleted assets — soft delete never cascades', () => {
    const id = seedAsset()
    // creating the asset itself doesn't go through assetService.createAsset
    // here (seedAsset uses the repository directly), so record a CREATE
    // entry explicitly to have real prior history to check survives.
    auditService.recordAudit({ user: currentUser, action: 'CREATE', entityType: 'Asset', entityId: id, changes: {} })

    assetService.deleteAssetsBulk([id], currentUser)

    const history = ctx.db.prepare('SELECT action FROM audit_log WHERE entity_id = ? ORDER BY id').all(id)
    expect(history.map((h) => h.action)).toEqual(['CREATE', 'DELETE'])
  })

  it('excludes bulk-deleted assets from re-import duplicate checks, same as single delete (existing behavior via the same softDelete)', () => {
    const id = seedAsset({ assetCode: 'A-DUP', serialNumber: 'SN-DUP' })
    assetService.deleteAssetsBulk([id], currentUser)

    const codes = assetRepository.findAllCodesAndSerials()
    expect(codes.find((c) => c.asset_code === 'A-DUP')).toBeUndefined()
  })

  it('rejects an empty selection', () => {
    expect(() => assetService.deleteAssetsBulk([], currentUser)).toThrow(/انتخاب نشده/)
  })

  it('a bulk-deleted asset drops out of dashboard counts, same as single delete', () => {
    const id = seedAsset()
    let stats = assetService.getDashboardStats()
    expect(stats.total).toBe(1)

    assetService.deleteAssetsBulk([id], currentUser)
    stats = assetService.getDashboardStats()
    expect(stats.total).toBe(0)
  })
})
