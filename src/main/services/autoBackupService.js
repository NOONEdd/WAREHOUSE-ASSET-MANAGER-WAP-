import { backupService } from './backupService'

/**
 * Automatic Backup phase — fires a backup after a database-changing
 * operation (asset add/edit/delete/import/status change, and the status-
 * cleanup migration in lookupService.js) has ALREADY committed.
 *
 * Placement matters: every caller of triggerAutoBackup() below calls it
 * AFTER its own db.transaction() has returned successfully — never from
 * inside one. better-sqlite3 transactions are synchronous, so by the time
 * an IPC handler reaches this call there is nothing left to roll back;
 * a failure here can only ever become a warning, never undo the operation
 * that already succeeded.
 */

// Prevents excessive duplicate backups when several operations happen in
// quick succession (e.g. deleting several assets one at a time, or a
// person clicking "save" repeatedly) — without this, every single
// database write would take its own full SQLite backup. Deliberately a
// simple time-based cooldown rather than a queue/debounce with a trailing
// call: the live .db file is always the real, authoritative copy of the
// data — automatic backups are a safety net on top of that, not the only
// place the data lives — so it's an acceptable trade-off to occasionally
// skip backing up the very last write in a fast burst, in exchange for
// never hammering the disk on every keystroke-adjacent action. Manual
// backups (Settings → "پشتیبان‌گیری اکنون") and the pre-restore safety-net
// backup are NOT subject to this cooldown — see backupService.js — only
// this automatic-after-mutation path is.
const MIN_INTERVAL_MS = 10_000

let lastAttemptAt = 0

/**
 * Returns a Persian warning string if the backup could not be taken (or
 * was skipped by the cooldown — not a real problem, so no warning), or
 * null when a backup was successfully created. Callers fold a non-null
 * result into their IPC response as `backupWarning`, alongside the
 * already-successful result of the real operation — never as an error
 * that would make the renderer think the actual save/delete/import
 * failed.
 */
async function triggerAutoBackup(currentUser) {
  const now = Date.now()
  if (now - lastAttemptAt < MIN_INTERVAL_MS) {
    return null
  }
  lastAttemptAt = now

  try {
    await backupService.createBackup(currentUser, { auto: true })
    return null
  } catch (err) {
    return `پشتیبان‌گیری خودکار انجام نشد: ${err.message}`
  }
}

// Test-only escape hatch — vitest fake timers still share this module's
// closure across tests unless the cooldown clock is reset explicitly.
function _resetCooldownForTests() {
  lastAttemptAt = 0
}

export const autoBackupService = { triggerAutoBackup, _resetCooldownForTests }
