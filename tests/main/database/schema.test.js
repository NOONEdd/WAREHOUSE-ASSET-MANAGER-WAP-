import { describe, it, expect } from 'vitest'
import { createTestDb, cleanupTestDb } from '../testHelpers/testDb'

describe('schema.sql', () => {
  it('creates all expected core tables on a fresh database', () => {
    const ctx = createTestDb()
    const tables = ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name)

    for (const expected of [
      'assets',
      'asset_statuses',
      'asset_transactions',
      'audit_log',
      'countries',
      'item_types',
      'roles',
      'users',
      'workshops'
    ]) {
      expect(tables).toContain(expected)
    }
    cleanupTestDb(ctx)
  })

  // Regression test for the Phase 9 bug (fixed again in Phase 13 via
  // migrations/001-fix-english-status-names.sql after it resurfaced on
  // databases created before that fix): asset_statuses must be seeded in
  // Persian, matching what the UI expects everywhere it reads a status
  // name. If this ever seeds in English again, stat cards and status
  // lookups silently show zero counts rather than erroring. Reduced to
  // these four "system" statuses in the Manual Status Management phase —
  // تعمیر and مفقود were both dropped from the seeded/protected set (see
  // lookupService.js's SYSTEM_STATUS_NAMES comment); an administrator
  // can still add either one back through the UI if they want it.
  it('seeds exactly 4 system asset_statuses in Persian, not English', () => {
    const ctx = createTestDb()
    const rows = ctx.db.prepare('SELECT name, is_active, sort_order FROM asset_statuses ORDER BY id').all()

    expect(rows.map((r) => r.name)).toEqual(['در انبار', 'صادر شده', 'مرجوع شده', 'آسیب‌دیده'])
    expect(rows.every((r) => r.is_active === 1)).toBe(true)
    expect(rows.map((r) => r.sort_order)).toEqual([1, 2, 3, 4])
    cleanupTestDb(ctx)
  })

  it('rejects an asset with no status_id (NOT NULL constraint)', () => {
    const ctx = createTestDb()
    ctx.db.prepare("INSERT INTO item_types (name) VALUES ('X')").run()
    expect(() => {
      ctx.db
        .prepare(
          'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number) VALUES (?, ?, 1, ?)'
        )
        .run('A-1', 'Test', 'SN-1')
    }).toThrow(/NOT NULL/)
    cleanupTestDb(ctx)
  })

  it('allows an asset with no workshop_id (nullable — Phase 14 report logic depends on this)', () => {
    const ctx = createTestDb()
    ctx.db.prepare("INSERT INTO item_types (name) VALUES ('X')").run()
    const statusId = ctx.db.prepare('SELECT id FROM asset_statuses LIMIT 1').get().id
    expect(() => {
      ctx.db
        .prepare(
          'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?, ?, 1, ?, ?)'
        )
        .run('A-1', 'Test', 'SN-1', statusId)
    }).not.toThrow()
    cleanupTestDb(ctx)
  })

  // Regression tests for the duplicate-detection bug: asset_code and
  // serial_number used to be UNIQUE as plain column constraints,
  // enforced by SQLite across every row regardless of is_deleted — so a
  // soft-deleted asset permanently blocked reusing its own code/serial
  // number. Fixed by scoping uniqueness to active rows only, via a
  // partial index (WHERE is_deleted = 0) instead of a column constraint.
  describe('asset_code / serial_number uniqueness is scoped to active (non-deleted) assets', () => {
    function insertAsset(db, { assetCode, serialNumber, isDeleted = 0 }) {
      const itemTypeId = db.prepare('SELECT id FROM item_types LIMIT 1').get()?.id
        ?? db.prepare("INSERT INTO item_types (name) VALUES ('X')").run().lastInsertRowid
      const statusId = db.prepare('SELECT id FROM asset_statuses LIMIT 1').get().id
      return db
        .prepare(
          `INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id, is_deleted)
           VALUES (?, 'Test', ?, ?, ?, ?)`
        )
        .run(assetCode, itemTypeId, serialNumber, statusId, isDeleted).lastInsertRowid
    }

    it('rejects a second ACTIVE asset with a duplicate asset_code', () => {
      const ctx = createTestDb()
      insertAsset(ctx.db, { assetCode: 'DUP', serialNumber: 'SN-1' })
      expect(() => insertAsset(ctx.db, { assetCode: 'DUP', serialNumber: 'SN-2' })).toThrow(/UNIQUE/)
      cleanupTestDb(ctx)
    })

    it('rejects a second ACTIVE asset with a duplicate serial_number', () => {
      const ctx = createTestDb()
      insertAsset(ctx.db, { assetCode: 'A-1', serialNumber: 'DUP-SN' })
      expect(() => insertAsset(ctx.db, { assetCode: 'A-2', serialNumber: 'DUP-SN' })).toThrow(/UNIQUE/)
      cleanupTestDb(ctx)
    })

    it('allows a new ACTIVE asset to reuse the asset_code/serial_number of a SOFT-DELETED asset', () => {
      const ctx = createTestDb()
      insertAsset(ctx.db, { assetCode: 'REUSE', serialNumber: 'SN-REUSE', isDeleted: 1 })
      expect(() => insertAsset(ctx.db, { assetCode: 'REUSE', serialNumber: 'SN-REUSE' })).not.toThrow()

      const activeCount = ctx.db
        .prepare("SELECT COUNT(*) n FROM assets WHERE asset_code = 'REUSE' AND is_deleted = 0")
        .get().n
      expect(activeCount).toBe(1)
      cleanupTestDb(ctx)
    })

    it('still rejects two SOFT-DELETED rows sharing a code as a sanity check on the partial index — actually allows it, since only active rows are constrained', () => {
      // Documents the intentional scope of the fix: uniqueness is ONLY
      // enforced among active rows. Two deleted rows sharing a code is
      // harmless (neither is addressable or importable), so this is not
      // constrained, and is not something the app needs to prevent.
      const ctx = createTestDb()
      insertAsset(ctx.db, { assetCode: 'BOTH-DELETED', serialNumber: 'SN-1', isDeleted: 1 })
      expect(() =>
        insertAsset(ctx.db, { assetCode: 'BOTH-DELETED', serialNumber: 'SN-2', isDeleted: 1 })
      ).not.toThrow()
      cleanupTestDb(ctx)
    })
  })
})
