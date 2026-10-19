import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import currentSchema from '../../../src/main/database/schema.sql?raw'

// Simulates a real, genuinely old database from before the Phase 9 fix —
// six statuses, seeded in English, back when id 1..6 in that fixed order
// reliably meant در انبار/صادر شده/مرجوع شده/تعمیر/آسیب‌دیده/مفقود. Built
// by patching the actual current schema.sql's seed statement (not a
// hand-maintained duplicate schema), the same technique
// migration002.test.js uses for its own "old schema" fixture.
const OLD_ENGLISH_SIX_STATUS_SCHEMA = currentSchema.replace(
  /INSERT INTO asset_statuses[\s\S]*?;/,
  "INSERT INTO asset_statuses (name) VALUES ('In Stock'), ('Issued'), ('Returned'), ('Repair'), ('Damaged'), ('Lost');"
)

let userDataDir

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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-migration001-test-'))
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

describe('migration 001 still fixes a genuinely old English-named database', () => {
  it('repairs all six old English names to Persian, matched by id in the historical fixed order', async () => {
    const Database = (await import('better-sqlite3')).default
    const seedDb = new Database(getDbPath())
    seedDb.exec(OLD_ENGLISH_SIX_STATUS_SCHEMA)
    seedDb.close()

    const db = getDatabase()
    const names = db.prepare('SELECT name FROM asset_statuses ORDER BY id').all().map((r) => r.name)
    expect(names).toEqual(['در انبار', 'صادر شده', 'مرجوع شده', 'تعمیر', 'آسیب‌دیده', 'مفقود'])
  })
})

describe('migration 001 never corrupts a database created under the current 4-status schema', () => {
  // Regression test for a real bug found while building the Manual
  // Status Management phase: migration 001 used to match purely by id
  // (id 4 = "تعمیر"), which was safe while schema.sql always seeded
  // exactly six statuses in that fixed order. Once schema.sql was
  // changed to seed only FOUR statuses — id 4 now being "آسیب‌دیده" —
  // that same id-based statement fired on every single launch of a
  // brand-new database and either silently renamed "آسیب‌دیده" to
  // "تعمیر" (if no status was already named that), or crashed the whole
  // app on startup with a UNIQUE constraint violation (if an
  // administrator had separately created a custom status actually named
  // "تعمیر" — a realistic, even expected scenario, since it's the exact
  // example name this phase's own request uses). Fixed by matching on
  // "does this name still look English" (GLOB '*[A-Za-z]*') instead of
  // matching by id alone — see migrations/001's own comment for the
  // full explanation.
  it('leaves "آسیب‌دیده" (id 4 in the current schema) untouched after a second launch, with no custom "تعمیر" status present', () => {
    getDatabase() // first launch — creates the database fresh
    closeDatabase()

    const db = getDatabase() // second launch — this is what used to corrupt id 4
    const row = db.prepare('SELECT name FROM asset_statuses WHERE id = 4').get()
    expect(row.name).toBe('آسیب‌دیده')
  })

  it('does not crash — and does not touch anything — when an administrator has already created a custom status literally named "تعمیر"', async () => {
    const db0 = getDatabase()
    const roleId = db0.prepare('SELECT id FROM roles LIMIT 1').get().id
    const userId = db0
      .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
      .run(roleId).lastInsertRowid

    const { lookupService } = await import('../../../src/main/services/lookupService.js')
    lookupService.createStatus('تعمیر', { id: userId, username: 'admin' })
    closeDatabase()

    // The bug crashed here with "UNIQUE constraint failed:
    // asset_statuses.name" — reaching this line at all is the fix.
    const db = getDatabase()
    const names = db.prepare('SELECT name FROM asset_statuses ORDER BY id').all().map((r) => r.name)
    expect(names).toEqual(['در انبار', 'صادر شده', 'مرجوع شده', 'آسیب‌دیده', 'تعمیر'])
  })

  it('is idempotent across many repeated launches, not just two', () => {
    for (let i = 0; i < 5; i++) {
      getDatabase()
      closeDatabase()
    }
    const db = getDatabase()
    const names = db.prepare('SELECT name FROM asset_statuses ORDER BY id').all().map((r) => r.name)
    expect(names).toEqual(['در انبار', 'صادر شده', 'مرجوع شده', 'آسیب‌دیده'])
  })
})
