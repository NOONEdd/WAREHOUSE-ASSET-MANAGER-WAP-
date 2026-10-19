import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import currentSchema from '../../../src/main/database/schema.sql?raw'

// Simulates a real, already-existing production database created BEFORE
// this fix — i.e. today's schema.sql with the fix undone: asset_code and
// serial_number back to plain column UNIQUE constraints, and without the
// two partial indexes this fix adds. Built by editing the real, current
// schema.sql text (not a hand-written approximation), so this old schema
// can't silently drift from what today's schema.sql actually says as the
// app evolves.
const OLD_SCHEMA = currentSchema
  .replace('asset_code TEXT NOT NULL,', 'asset_code TEXT NOT NULL UNIQUE,')
  .replace('serial_number TEXT NOT NULL,', 'serial_number TEXT NOT NULL UNIQUE,')
  .replace(/CREATE UNIQUE INDEX idx_assets_code_active[^;]*;\s*/, '')
  .replace(/CREATE UNIQUE INDEX idx_assets_serial_active[^;]*;\s*/, '')

let userDataDir
let dbPath

vi.mock('electron', () => ({
  app: {
    getPath: (name) => {
      if (name === 'userData') return userDataDir
      throw new Error('unexpected app.getPath: ' + name)
    }
  }
}))

const { getDatabase, closeDatabase, getDbPath } = await import('../../../src/main/database/connection.js')

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-migration-test-'))
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

/**
 * Builds a pre-existing database on disk using OLD_SCHEMA (bypassing
 * connection.js entirely, matching how a real database from before this
 * fix would already look) and seeds it with exactly the data needed to
 * prove the migration both fixes the bug AND preserves everything it
 * shouldn't touch: an active asset, a soft-deleted asset whose code/
 * serial should become reusable, and the transaction/audit rows that
 * reference them by id.
 */
function buildPreExistingDatabase() {
  dbPath = getDbPath()
  const raw = new Database(dbPath)
  raw.pragma('foreign_keys = ON')
  raw.exec(OLD_SCHEMA)

  const roleId = raw.prepare('SELECT id FROM roles LIMIT 1').get().id
  const userId = raw
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
    .run(roleId).lastInsertRowid
  const itemTypeId = raw.prepare("INSERT INTO item_types (name) VALUES ('تجهیزات تست')").run().lastInsertRowid
  const statusId = raw.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id

  const activeId = raw
    .prepare(
      'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
    )
    .run('ACTIVE-1', 'دارایی فعال', itemTypeId, 'SN-ACTIVE', statusId).lastInsertRowid

  const deletedId = raw
    .prepare(
      `INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id, is_deleted, deleted_at, deleted_by)
       VALUES (?,?,?,?,?,1,datetime('now'),?)`
    )
    .run('WAS-DELETED', 'دارایی حذف‌شده', itemTypeId, 'SN-WAS-DELETED', statusId, userId).lastInsertRowid

  raw
    .prepare(
      'INSERT INTO asset_transactions (asset_id, new_status_id, performed_by_user_id) VALUES (?,?,?)'
    )
    .run(activeId, statusId, userId)
  raw
    .prepare(
      "INSERT INTO audit_log (user_id, username_snapshot, action, entity_type, entity_id) VALUES (?, 'admin', 'CREATE', 'Asset', ?)"
    )
    .run(userId, deletedId)

  raw.close()
  return { activeId, deletedId, userId, itemTypeId, statusId }
}

describe('migration 002 — scoping asset uniqueness to active assets on an existing database', () => {
  it('adds the partial unique indexes to a database that predates this fix', () => {
    buildPreExistingDatabase()
    const db = getDatabase()
    const indexNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='assets'")
      .all()
      .map((r) => r.name)
    expect(indexNames).toContain('idx_assets_code_active')
    expect(indexNames).toContain('idx_assets_serial_active')
  })

  it('preserves every existing asset exactly — same ids, same data, same is_deleted state', () => {
    const { activeId, deletedId } = buildPreExistingDatabase()
    const db = getDatabase()

    const active = db.prepare('SELECT * FROM assets WHERE id = ?').get(activeId)
    expect(active.asset_code).toBe('ACTIVE-1')
    expect(active.is_deleted).toBe(0)

    const deleted = db.prepare('SELECT * FROM assets WHERE id = ?').get(deletedId)
    expect(deleted.asset_code).toBe('WAS-DELETED')
    expect(deleted.is_deleted).toBe(1)
    expect(deleted.deleted_at).toBeTruthy()

    expect(db.prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(2)
  })

  it('preserves asset_transactions and audit_log references to those same asset ids', () => {
    const { activeId, deletedId } = buildPreExistingDatabase()
    const db = getDatabase()

    const txn = db.prepare('SELECT asset_id FROM asset_transactions').get()
    expect(txn.asset_id).toBe(activeId)

    const audit = db.prepare("SELECT entity_id FROM audit_log WHERE entity_type = 'Asset'").get()
    expect(audit.entity_id).toBe(deletedId)

    // The FK join itself still resolves — not just that the raw id
    // number matches, but that referential integrity survived the
    // table-rebuild (assets_new -> DROP -> RENAME) intact.
    const joined = db
      .prepare(
        `SELECT a.asset_code FROM asset_transactions t JOIN assets a ON a.id = t.asset_id`
      )
      .get()
    expect(joined.asset_code).toBe('ACTIVE-1')
  })

  // The actual bug, reproduced against a real pre-fix database and
  // proven fixed after the migration runs — not just "the index exists"
  // but "the operation that used to fail now succeeds."
  it('allows inserting a new asset that reuses a soft-deleted asset\'s code and serial number', () => {
    const { itemTypeId, statusId } = buildPreExistingDatabase()
    const db = getDatabase()

    expect(() => {
      db.prepare(
        'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
      ).run('WAS-DELETED', 'دارایی جدید با همان کد', itemTypeId, 'SN-WAS-DELETED', statusId)
    }).not.toThrow()

    const activeWithThatCode = db
      .prepare("SELECT COUNT(*) n FROM assets WHERE asset_code = 'WAS-DELETED' AND is_deleted = 0")
      .get().n
    expect(activeWithThatCode).toBe(1)
  })

  it('still rejects a new asset that duplicates an ACTIVE asset\'s code (preserved, not disabled)', () => {
    const { itemTypeId, statusId } = buildPreExistingDatabase()
    const db = getDatabase()

    expect(() => {
      db.prepare(
        'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
      ).run('ACTIVE-1', 'تلاش برای تکرار', itemTypeId, 'SN-DIFFERENT', statusId)
    }).toThrow(/UNIQUE/)
  })

  it('is idempotent — reopening the same (already-migrated) database does not error or duplicate data', () => {
    buildPreExistingDatabase()
    getDatabase() // first open, runs the migration
    closeDatabase()

    expect(() => getDatabase()).not.toThrow()
    const db = getDatabase()
    expect(db.prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(2)
    const indexCount = db
      .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_assets_code_active'")
      .get().n
    expect(indexCount).toBe(1)
  })
})
