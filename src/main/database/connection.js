import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import schema from './schema.sql?raw'
import fixEnglishStatusNames from './migrations/001-fix-english-status-names.sql?raw'
import scopeUniqueConstraintsToActiveAssets from './migrations/002-scope-unique-constraints-to-active-assets.sql?raw'
import statusManagementColumns from './migrations/003-status-management-columns.sql?raw'
import baseDataLifecycle from './migrations/004-base-data-lifecycle.sql?raw'
import firstRunPasswordSetup from './migrations/005-first-run-password-setup.sql?raw'
import recentActivityIndexes from './migrations/006-recent-activity-indexes.sql?raw'

let db = null

function getDbPath() {
  return path.join(app.getPath('userData'), 'asset-warehouse.db')
}

/**
 * Opens (creating if necessary) the SQLite database in Electron's userData
 * directory — never inside the app's install folder, which may not be
 * writable and shouldn't hold mutable data. Applies the Phase 3 schema on
 * first run only; existing databases instead get any pending migrations
 * from database/migrations/ (see 001-fix-english-status-names.sql,
 * 002-scope-unique-constraints-to-active-assets.sql,
 * 003-status-management-columns.sql, and 004-base-data-lifecycle.sql).
 */
function getDatabase() {
  if (db) return db

  const dbPath = getDbPath()

  db = new Database(dbPath)

  // Required every time a connection is opened — SQLite does not persist
  // these as part of the file itself (Phase 3, "Connection Settings").
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')

  // Reliability phase — without this, a transient lock (a brief external
  // read by antivirus, or this same process's own backup/restore code
  // momentarily touching the file) makes better-sqlite3 throw
  // SQLITE_BUSY immediately instead of waiting. 5 seconds is long enough
  // to ride out any lock this single-writer desktop app would ever
  // realistically hit, without masking a genuinely stuck lock forever.
  // Applied to the one real connection this app ever opens — backupService
  // .js's validateBackupFile()/temp-file checks use their own short-lived
  // Database instances against different files entirely, not this one.
  db.pragma('busy_timeout = 5000')

  // Checked against the database itself, not just "does the file exist" —
  // a file can exist but be schema-less if a previous run was interrupted
  // between creating it and applying the schema. This makes first-run
  // detection self-healing regardless of how that happened.
  const hasSchema = db
    .prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='users'")
    .get().n

  if (!hasSchema) {
    db.exec(schema)
  } else {
    // Repairs databases created before the Phase 9 fix to schema.sql's
    // seed data (see migrations/001-fix-english-status-names.sql). A
    // fresh database never needs this, since schema.sql above already
    // seeds the correct names. Safe on every launch — each statement is
    // a no-op once already applied.
    db.exec(fixEnglishStatusNames)

    // Migration 002 rebuilds the assets table (SQLite has no ALTER
    // TABLE ... DROP CONSTRAINT), so unlike the plain UPDATEs above it
    // isn't naturally a no-op to rerun — guarded here to run only once,
    // by checking for the index it creates rather than tracking a
    // version number, so it's self-describing and can't drift out of
    // sync with what the migration actually does.
    const hasActiveUniqueIndexes = db
      .prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='index' AND name='idx_assets_code_active'")
      .get().n
    if (!hasActiveUniqueIndexes) {
      db.exec(scopeUniqueConstraintsToActiveAssets)
    }

    // Migration 003 adds columns (ADD COLUMN errors if run twice on a
    // column that already exists), so — like migration 002 above — this
    // is guarded by checking for the actual column rather than being
    // naturally safe to repeat like the plain UPDATEs in migration 001.
    const hasStatusManagementColumns = db
      .prepare("SELECT COUNT(*) as n FROM pragma_table_info('asset_statuses') WHERE name = 'is_active'")
      .get().n
    if (!hasStatusManagementColumns) {
      db.exec(statusManagementColumns)
    }

    // Migration 004 rebuilds item_types/workshops/countries (same
    // ALTER TABLE limitation as migration 002), so it's guarded the same
    // way — by checking for a column the rebuild adds, since a table
    // rebuild isn't naturally safe to repeat like migration 001's plain
    // UPDATEs.
    const hasBaseDataLifecycleColumns = db
      .prepare("SELECT COUNT(*) as n FROM pragma_table_info('item_types') WHERE name = 'is_active'")
      .get().n
    if (!hasBaseDataLifecycleColumns) {
      db.exec(baseDataLifecycle)
    }

    // Migration 005 adds a column (same ADD COLUMN-errors-if-rerun
    // constraint as migration 003), guarded the same way.
    const hasFirstRunSetupColumn = db
      .prepare("SELECT COUNT(*) as n FROM pragma_table_info('users') WHERE name = 'needs_password_setup'")
      .get().n
    if (!hasFirstRunSetupColumn) {
      db.exec(firstRunPasswordSetup)
    }

    // Migration 006 is CREATE INDEX IF NOT EXISTS — naturally a no-op
    // once already applied, same as migration 001's plain UPDATEs, so no
    // "has it run yet" guard is needed here.
    db.exec(recentActivityIndexes)
  }

  return db
}

function closeDatabase() {
  if (db) {
    db.close()
    db = null
  }
}

export { getDatabase, closeDatabase, getDbPath }
