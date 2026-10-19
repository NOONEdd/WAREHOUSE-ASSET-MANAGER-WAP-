import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Database Reset phase. These tests simulate exactly what main/index.js's
 * real startup sequence does on a brand-new install — getDatabase()
 * (creates the schema fresh, since there's nothing to migrate yet) then
 * authService.bootstrapAdminIfNeeded() (creates the one admin account) —
 * and nothing else. That combination is "a fresh/reset database" in this
 * app's own terms: there is no separate reset button or seed script:
 * deleting the on-disk .db file and relaunching goes through this exact
 * path, so proving it here proves what a real reset produces.
 */

let userDataDir

vi.mock('electron', () => ({
  app: {
    getPath: (name) => {
      if (name === 'userData') return userDataDir
      throw new Error('unexpected app.getPath: ' + name)
    }
  }
}))

const { getDatabase, closeDatabase } = await import('../../../src/main/database/connection.js')
const { authService } = await import('../../../src/main/services/authService.js')
const { lookupService } = await import('../../../src/main/services/lookupService.js')

function bootFreshApp() {
  const db = getDatabase()
  const bootstrap = authService.bootstrapAdminIfNeeded()
  return { db, bootstrap }
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-fresh-db-test-'))
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

describe('Fresh/reset database contains only required initial/system data', () => {
  it('seeds exactly the four system statuses — نه مفقود، نه تعمیر — matching what the rest of the app depends on', () => {
    const { db } = bootFreshApp()
    const names = db.prepare('SELECT name FROM asset_statuses ORDER BY id').all().map((r) => r.name)
    expect(names).toEqual(['در انبار', 'صادر شده', 'مرجوع شده', 'آسیب‌دیده'])
  })

  it('contains zero legacy/English status values, and does not auto-add مفقود either', () => {
    const { db } = bootFreshApp()
    const names = db.prepare('SELECT name FROM asset_statuses').all().map((r) => r.name)
    const KNOWN_LEGACY_OR_DROPPED_NAMES = [
      'Returned',
      'Checked Out',
      'In Stock',
      'In Use',
      'Issued',
      'Damaged',
      'Lost',
      'Repair',
      'Maintenance',
      'تعمیر',
      'مفقود'
    ]
    for (const legacy of KNOWN_LEGACY_OR_DROPPED_NAMES) {
      expect(names).not.toContain(legacy)
    }
    // Independent structural check on top of the exact-list check above:
    // nothing English got in at all, under any spelling.
    expect(names.every((n) => !/[A-Za-z]/.test(n))).toBe(true)
  })

  it('has zero assets', () => {
    const { db } = bootFreshApp()
    expect(db.prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(0)
  })

  it('has no test/sample lookup data — item types, workshops, and countries all start empty', () => {
    const { db } = bootFreshApp()
    expect(db.prepare('SELECT COUNT(*) n FROM item_types').get().n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM workshops').get().n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM countries').get().n).toBe(0)
  })

  it('has zero transaction history', () => {
    const { db } = bootFreshApp()
    expect(db.prepare('SELECT COUNT(*) n FROM asset_transactions').get().n).toBe(0)
  })

  it('creates exactly one user — the bootstrapped admin — with exactly one matching audit entry', () => {
    const { db, bootstrap } = bootFreshApp()
    expect(bootstrap.username).toBe('admin')
    expect(bootstrap.needsPasswordSetup).toBe(true)
    expect(bootstrap.password).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) n FROM users').get().n).toBe(1)
    expect(db.prepare('SELECT needs_password_setup FROM users').get().needs_password_setup).toBe(1)
    expect(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n).toBe(1)
    expect(db.prepare('SELECT action, entity_type FROM audit_log').get()).toEqual({
      action: 'CREATE',
      entity_type: 'User'
    })
  })

  it('the generic base-data create path still refuses statuses — createStatus is the real, dedicated path', () => {
    bootFreshApp()
    expect(() => lookupService.createLookup('statuses', 'Repair')).toThrow(/وضعیت/)
  })

  // Manual Status Management phase (Part 1 of this same request): unlike
  // the closed enum this used to be, an administrator CAN add a new
  // status without any source change — this is the actual point of that
  // phase, verified here at the database layer since there's no
  // component-testing harness in this project to click through the
  // Settings screen itself. See statusManagement.test.js for the full
  // create/rename/activate/reorder/delete test suite.
  it('an administrator CAN create a new status through the dedicated createStatus path — no source change needed', () => {
    bootFreshApp()
    const fakeAdmin = { id: 1, username: 'admin' }
    const result = lookupService.createStatus('تعمیر', fakeAdmin)
    expect(result.name).toBe('تعمیر')
    expect(result.isSystem).toBe(false)
    expect(result.isActive).toBe(true)
    expect(lookupService.listStatuses().map((s) => s.name)).toContain('تعمیر')
  })

  it('cannot delete, rename, or deactivate any of the four system statuses', () => {
    const { db } = bootFreshApp()
    const official = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get()
    const fakeAdmin = { id: 1, username: 'admin' }
    expect(() => lookupService.deleteStatus(official.id, fakeAdmin)).toThrow(/سیستمی/)
    expect(() => lookupService.migrateAndDeleteStatus(official.id, 'صادر شده', fakeAdmin)).toThrow(/سیستمی/)
    expect(() => lookupService.renameStatus(official.id, 'نام جدید', fakeAdmin)).toThrow(/سیستمی/)
    expect(() => lookupService.setStatusActive(official.id, false, fakeAdmin)).toThrow(/سیستمی/)
    // Confirms none of the throws above partially applied anything.
    expect(db.prepare('SELECT COUNT(*) n FROM asset_statuses').get().n).toBe(4)
  })

  it('passes PRAGMA foreign_key_check with zero violations', () => {
    const { db } = bootFreshApp()
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('passes PRAGMA integrity_check', () => {
    const { db } = bootFreshApp()
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })

  it('is deterministic — creating a second fresh database from scratch produces the identical clean state', () => {
    const first = bootFreshApp()
    const firstNames = first.db.prepare('SELECT name FROM asset_statuses ORDER BY id').all().map((r) => r.name)
    closeDatabase()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-fresh-db-test-2-'))

    const second = bootFreshApp()
    const secondNames = second.db.prepare('SELECT name FROM asset_statuses ORDER BY id').all().map((r) => r.name)
    expect(secondNames).toEqual(firstNames)
    expect(second.db.prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(0)
    expect(second.db.prepare('SELECT COUNT(*) n FROM users').get().n).toBe(1)
  })
})

describe('Manually-created base data survives a restart (Test 2 / Test 3 from the Manual Status Management request)', () => {
  it('a country, workshop, item type, and custom status created before "closing" the app are all still there after "reopening" it', () => {
    bootFreshApp()
    const fakeAdmin = { id: 1, username: 'admin' }

    const db1 = getDatabase()
    db1.prepare("INSERT INTO countries (name) VALUES ('آلمان')").run()
    db1.prepare("INSERT INTO workshops (name) VALUES ('واحد تولید')").run()
    db1.prepare("INSERT INTO item_types (name) VALUES ('تجهیزات جوشکاری')").run()
    lookupService.createStatus('تعمیر', fakeAdmin)

    // "Close and reopen" — closeDatabase() drops the in-memory handle;
    // getDatabase() afterward re-opens the SAME on-disk file (same
    // userDataDir throughout this test, nothing recreated) rather than
    // going through schema.sql's seed path again.
    closeDatabase()
    const db2 = getDatabase()

    expect(db2.prepare('SELECT COUNT(*) n FROM countries').get().n).toBe(1)
    expect(db2.prepare('SELECT COUNT(*) n FROM workshops').get().n).toBe(1)
    expect(db2.prepare('SELECT COUNT(*) n FROM item_types').get().n).toBe(1)
    expect(lookupService.listStatuses().map((s) => s.name)).toContain('تعمیر')
    // And the four system statuses plus one custom = five total, not a
    // fresh reseed on top of what was already there.
    expect(db2.prepare('SELECT COUNT(*) n FROM asset_statuses').get().n).toBe(5)
  })
})
