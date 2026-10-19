import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, cleanupTestDb } from '../testHelpers/testDb'

let ctx

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

const { assetService } = await import('../../../src/main/services/assetService')
const { assetRepository } = await import('../../../src/main/repositories/assetRepository')

let currentUser
let statusInWarehouse
let statusIssued

function seedAsset(overrides = {}) {
  const itemTypeId =
    ctx.db.prepare('SELECT id FROM item_types LIMIT 1').get()?.id ??
    ctx.db.prepare("INSERT INTO item_types (name) VALUES ('تجهیزات تست')").run().lastInsertRowid
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
    deliveredBy: overrides.deliveredBy ?? null,
    receivedBy: overrides.receivedBy ?? null,
    statusId: overrides.statusId ?? statusInWarehouse,
    notes: overrides.notes ?? null
  })
}

beforeEach(() => {
  ctx = createTestDb()
  const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
  const userId = ctx.db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
    .run(roleId).lastInsertRowid
  currentUser = { id: userId, username: 'admin' }
  statusInWarehouse = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
  statusIssued = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'صادر شده'").get().id
})

afterEach(() => {
  cleanupTestDb(ctx)
})

describe('assetService.changeAssetStatusBulk', () => {
  it('changes the status of every selected asset', () => {
    const ids = [seedAsset(), seedAsset(), seedAsset()]
    const result = assetService.changeAssetStatusBulk(ids, { newStatus: 'صادر شده' }, currentUser)
    expect(result.changedCount).toBe(3)
    expect(result.skippedCount).toBe(0)
    for (const id of ids) {
      expect(ctx.db.prepare('SELECT status_id FROM assets WHERE id = ?').get(id).status_id).toBe(statusIssued)
    }
  })

  it('skips (does not error on) an asset already at the target status, and reports it as skipped', () => {
    const alreadyThere = seedAsset({ statusId: statusIssued })
    const needsChange = seedAsset({ statusId: statusInWarehouse })

    const result = assetService.changeAssetStatusBulk(
      [alreadyThere, needsChange],
      { newStatus: 'صادر شده' },
      currentUser
    )

    expect(result.changedCount).toBe(1)
    expect(result.skippedCount).toBe(1)
    // No spurious audit/transaction entry for the one that never changed.
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM asset_transactions WHERE asset_id = ?').get(alreadyThere).n).toBe(0)
  })

  it('is all-or-nothing: a nonexistent id in the batch rolls back the whole thing, changing none', () => {
    const realId = seedAsset()
    const fakeId = realId + 9999

    expect(() =>
      assetService.changeAssetStatusBulk([realId, fakeId], { newStatus: 'صادر شده' }, currentUser)
    ).toThrow()

    expect(ctx.db.prepare('SELECT status_id FROM assets WHERE id = ?').get(realId).status_id).toBe(statusInWarehouse)
  })

  it('rejects an inactive status — backend validation, not just renderer trust', () => {
    ctx.db.prepare('UPDATE asset_statuses SET is_active = 0 WHERE id = ?').run(statusIssued)
    const id = seedAsset()
    expect(() => assetService.changeAssetStatusBulk([id], { newStatus: 'صادر شده' }, currentUser)).toThrow(
      /غیرفعال/
    )
    expect(ctx.db.prepare('SELECT status_id FROM assets WHERE id = ?').get(id).status_id).toBe(statusInWarehouse)
  })

  it('rejects a made-up status name', () => {
    const id = seedAsset()
    expect(() => assetService.changeAssetStatusBulk([id], { newStatus: 'وضعیت ساختگی' }, currentUser)).toThrow()
  })

  it('rejects an empty selection', () => {
    expect(() => assetService.changeAssetStatusBulk([], { newStatus: 'صادر شده' }, currentUser)).toThrow(
      /انتخاب نشده/
    )
  })

  it('records one transaction-history entry per CHANGED asset, with correct previous/new status', () => {
    const id = seedAsset()
    assetService.changeAssetStatusBulk([id], { newStatus: 'صادر شده' }, currentUser)
    const tx = ctx.db.prepare('SELECT * FROM asset_transactions WHERE asset_id = ?').get(id)
    expect(tx.previous_status_id).toBe(statusInWarehouse)
    expect(tx.new_status_id).toBe(statusIssued)
    expect(tx.performed_by_user_id).toBe(currentUser.id)
  })

  it('records one UPDATE audit entry per changed asset, same action as single-asset changeAssetStatus', () => {
    const ids = [seedAsset(), seedAsset()]
    assetService.changeAssetStatusBulk(ids, { newStatus: 'صادر شده' }, currentUser)
    const entries = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'UPDATE'").all()
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.entity_type === 'Asset')).toBe(true)
  })

  it('applies the same deliveredBy/receivedBy/notes to every changed asset', () => {
    const ids = [seedAsset(), seedAsset()]
    assetService.changeAssetStatusBulk(
      ids,
      { newStatus: 'صادر شده', deliveredBy: 'رضایی', receivedBy: 'محمدی', notes: 'انتقال گروهی' },
      currentUser
    )
    for (const id of ids) {
      const row = ctx.db.prepare('SELECT delivered_by, received_by FROM assets WHERE id = ?').get(id)
      expect(row.delivered_by).toBe('رضایی')
      expect(row.received_by).toBe('محمدی')
    }
  })

  it('preserves every other field unchanged — only status (and optionally delivered/received-by) moves', () => {
    const id = seedAsset({ assetCode: 'KEEP-ME', assetName: 'دستگاه ثابت' })
    assetService.changeAssetStatusBulk([id], { newStatus: 'صادر شده' }, currentUser)
    const row = ctx.db.prepare('SELECT asset_code, asset_name FROM assets WHERE id = ?').get(id)
    expect(row.asset_code).toBe('KEEP-ME')
    expect(row.asset_name).toBe('دستگاه ثابت')
  })

  it('does not affect the existing single-asset changeAssetStatus behavior', () => {
    const id = seedAsset()
    const updated = assetService.changeAssetStatus(id, { newStatus: 'صادر شده' }, currentUser)
    expect(updated.status).toBe('صادر شده')
  })
})
