import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import schema from '../../../src/main/database/schema.sql?raw'

/**
 * Creates a real, file-backed SQLite database with the actual app schema
 * applied — used instead of a hand-written mini-schema so these tests
 * exercise the real constraints, seed data, and column set.
 */
export function createTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-test-'))
  const dbPath = path.join(dir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.exec(schema)
  return { db, dbPath, dir }
}

export function cleanupTestDb({ db, dir }) {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

/** A minimal, valid item_type + role row — several tables need these as
 * foreign keys and schema.sql doesn't seed them (unlike asset_statuses). */
export function seedMinimalLookups(db) {
  const itemTypeId = db.prepare("INSERT INTO item_types (name) VALUES ('تجهیزات تست')").run()
    .lastInsertRowid
  const roleId = db.prepare('SELECT id FROM roles LIMIT 1').get().id
  return { itemTypeId, roleId }
}
