import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb, cleanupTestDb, seedMinimalLookups } from '../testHelpers/testDb.js'

// Regression coverage for a reported bug: "Damaged/Lost shows 0 when
// there is 1". Traced the full path — schema seed data, the dashboard
// SQL query, status resolution on create/update, soft-delete filtering,
// and the renderer's card-summing logic — and every step was already
// correct; empirically confirmed here rather than re-asserted from
// reading the code a second time. The one real defect found was
// presentation, not counting: مفقود's assigned color was identical to
// the chart/badge fallback color for an *unrecognized* status (fixed in
// theme.js) — a "Lost" asset was correctly counted everywhere but
// rendered visually indistinguishable from an error state. These tests
// pin down the counting side; theme.test.js pins down the color side.

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

describe('assetService.getDashboardStats', () => {
  let ctx
  let assetService
  let currentUser

  beforeEach(async () => {
    vi.resetModules()
    ctx = createTestDb()
    vi.doMock('../../../src/main/database/connection', () => ({ getDatabase: () => ctx.db }))
    ;({ assetService } = await import('../../../src/main/services/assetService.js'))
    const { roleId } = seedMinimalLookups(ctx.db)
    const userId = ctx.db
      .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
      .run(roleId).lastInsertRowid
    currentUser = { id: userId, username: 'admin' }

    // مفقود is no longer a seeded system status (Manual Status Management
    // phase — see lookupService.js's SYSTEM_STATUS_NAMES comment), but
    // every test below still needs it available exactly as before: an
    // administrator can always add it back as a custom status, and
    // that's exactly what these tests simulate rather than switching to
    // a different example status and losing the specific مفقود-color
    // regression this file exists to guard.
    const maxSortOrder = ctx.db.prepare('SELECT MAX(sort_order) m FROM asset_statuses').get().m
    ctx.db.prepare('INSERT INTO asset_statuses (name, is_active, sort_order) VALUES (?, 1, ?)').run('مفقود', maxSortOrder + 1)
  })

  afterEach(() => {
    cleanupTestDb(ctx)
  })

  it('returns all five statuses at zero on an empty database', () => {
    const stats = assetService.getDashboardStats()
    expect(stats.total).toBe(0)
    expect(stats.byStatus).toHaveLength(5)
    expect(stats.byStatus.every((s) => s.n === 0)).toBe(true)
  })

  it('counts a single مفقود (Lost) asset as 1, not 0 — the exact reported scenario', () => {
    assetService.createAsset(
      { assetCode: 'A-1', assetName: 'دستگاه گم‌شده', itemType: 'تجهیزات تست', serialNumber: 'SN-1', status: 'مفقود' },
      currentUser
    )

    const stats = assetService.getDashboardStats()
    expect(stats.total).toBe(1)
    const lost = stats.byStatus.find((s) => s.status === 'مفقود')
    expect(lost.n).toBe(1)
    // Every other status must stay at 0 — not just "لost is right"; a
    // bug that leaked the count into the wrong bucket would still pass
    // a check that only looked at the مفقود entry.
    for (const s of stats.byStatus) {
      if (s.status !== 'مفقود') expect(s.n).toBe(0)
    }
  })

  it('counts a single آسیب‌دیده (Damaged) asset as 1, not 0', () => {
    assetService.createAsset(
      { assetCode: 'A-1', assetName: 'دستگاه آسیب‌دیده', itemType: 'تجهیزات تست', serialNumber: 'SN-1', status: 'آسیب‌دیده' },
      currentUser
    )
    const stats = assetService.getDashboardStats()
    expect(stats.byStatus.find((s) => s.status === 'آسیب‌دیده').n).toBe(1)
  })

  it('counts one asset per status correctly across all five statuses at once', () => {
    const statuses = ['در انبار', 'صادر شده', 'مرجوع شده', 'آسیب‌دیده', 'مفقود']
    statuses.forEach((status, i) => {
      assetService.createAsset(
        { assetCode: `A-${i}`, assetName: `دارایی ${i}`, itemType: 'تجهیزات تست', serialNumber: `SN-${i}`, status },
        currentUser
      )
    })

    const stats = assetService.getDashboardStats()
    expect(stats.total).toBe(5)
    for (const s of stats.byStatus) {
      expect(s.n).toBe(1)
    }
  })

  it('moves the count to the new status after changeAssetStatus, not just adds to it', () => {
    assetService.createAsset(
      { assetCode: 'A-1', assetName: 'دارایی', itemType: 'تجهیزات تست', serialNumber: 'SN-1', status: 'در انبار' },
      currentUser
    )
    assetService.changeAssetStatus(1, { newStatus: 'مفقود', deliveredBy: null, receivedBy: null, notes: null }, currentUser)

    const stats = assetService.getDashboardStats()
    expect(stats.byStatus.find((s) => s.status === 'در انبار').n).toBe(0)
    expect(stats.byStatus.find((s) => s.status === 'مفقود').n).toBe(1)
    expect(stats.total).toBe(1) // status change must not change the total
  })

  it('excludes a soft-deleted asset from its status count and from the total', () => {
    assetService.createAsset(
      { assetCode: 'A-1', assetName: 'دارایی', itemType: 'تجهیزات تست', serialNumber: 'SN-1', status: 'مفقود' },
      currentUser
    )
    assetService.deleteAsset(1, currentUser)

    const stats = assetService.getDashboardStats()
    expect(stats.total).toBe(0)
    expect(stats.byStatus.find((s) => s.status === 'مفقود').n).toBe(0)
  })

  it('recovers the count when a re-imported asset reuses a soft-deleted code (existing re-import behavior)', () => {
    assetService.createAsset(
      { assetCode: 'A-1', assetName: 'دارایی قدیمی', itemType: 'تجهیزات تست', serialNumber: 'SN-1', status: 'مفقود' },
      currentUser
    )
    assetService.deleteAsset(1, currentUser)
    assetService.createAsset(
      { assetCode: 'A-1', assetName: 'دارایی جدید', itemType: 'تجهیزات تست', serialNumber: 'SN-1', status: 'مفقود' },
      currentUser
    )

    const stats = assetService.getDashboardStats()
    expect(stats.total).toBe(1)
    expect(stats.byStatus.find((s) => s.status === 'مفقود').n).toBe(1)
  })
})
