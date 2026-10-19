import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import currentSchema from '../../../src/main/database/schema.sql?raw'
import { hash } from '../../../src/main/utils/hashUtils'

// Simulates a real, already-existing production database created BEFORE
// this phase shipped: today's schema.sql with the needs_password_setup
// column (and its comment) removed from the users table — i.e. exactly
// what an install that's been running since before First-Run Security
// actually has on disk right now.
const OLD_SCHEMA = currentSchema.replace(
  /\s*-- First-Run Security phase[\s\S]*?needs_password_setup INTEGER NOT NULL DEFAULT 0,\n/,
  '\n'
)

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
const { authService } = await import('../../../src/main/services/authService.js')

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-migration005-test-'))
})

afterEach(() => {
  authService.logout()
  closeDatabase()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

/**
 * Builds a pre-existing database with a real, already-working
 * Administrator account — the exact shape a currently-deployed install
 * has: a genuine password the operator already knows and uses, set up
 * some other way before this phase existed. No needs_password_setup
 * column exists at all yet, since this table predates it.
 */
function buildPreExistingDatabaseWithWorkingAdmin() {
  dbPath = getDbPath()
  const raw = new Database(dbPath)
  raw.pragma('foreign_keys = ON')
  raw.exec(OLD_SCHEMA)

  const roleId = raw.prepare('SELECT id FROM roles LIMIT 1').get().id
  raw
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin', ?, 'Admin', ?)")
    .run(hash('Already-Working-Password-1'), roleId)

  raw.close()
}

describe('migration 005 — adding needs_password_setup to an existing database', () => {
  it('adds the column to a database that predates this phase', () => {
    buildPreExistingDatabaseWithWorkingAdmin()
    const db = getDatabase()
    const hasColumn = db
      .prepare("SELECT COUNT(*) n FROM pragma_table_info('users') WHERE name = 'needs_password_setup'")
      .get().n
    expect(hasColumn).toBe(1)
  })

  it('defaults the existing admin row to 0 — an already-working install is never forced into first-run setup', () => {
    buildPreExistingDatabaseWithWorkingAdmin()
    getDatabase()
    expect(authService.needsFirstRunSetup()).toBe(false)
  })

  it('preserves the existing admin account and its real password exactly — same row, same working credential', () => {
    buildPreExistingDatabaseWithWorkingAdmin()
    getDatabase()

    const login = authService.login('admin', 'Already-Working-Password-1')
    expect(login.success).toBe(true)
    expect(login.user.username).toBe('admin')
  })

  it('is idempotent — reopening the same (already-migrated) database does not error or duplicate data', () => {
    buildPreExistingDatabaseWithWorkingAdmin()
    getDatabase() // first open, runs the migration
    closeDatabase()

    expect(() => getDatabase()).not.toThrow()
    const db = getDatabase()
    expect(db.prepare('SELECT COUNT(*) n FROM users').get().n).toBe(1)
    const columnCount = db
      .prepare("SELECT COUNT(*) n FROM pragma_table_info('users') WHERE name = 'needs_password_setup'")
      .get().n
    expect(columnCount).toBe(1)
  })
})
