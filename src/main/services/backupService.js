import { app, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { toJalaali } from 'jalaali-js'
import { getDatabase, closeDatabase, getDbPath } from '../database/connection'
import { auditService } from './auditService'
import { settingsRepository } from '../repositories/settingsRepository'

/**
 * Phase 15 — Backup & Restore. Extended in the Automatic Backup phase to
 * support a person-chosen backup folder and to tag which backups were
 * system-triggered vs a manual "پشتیبان‌گیری اکنون" click (see
 * autoBackupService.js for the actual auto-trigger logic — this file only
 * knows how to take a backup and where to put it).
 *
 * The database runs in WAL mode (connection.js). A plain fs.copyFileSync
 * of the main .db file is NOT a safe backup: recently written data can
 * sit in the -wal sidecar file for a while before SQLite checkpoints it
 * into the main file, so a naive copy can silently capture a near-empty
 * database. Confirmed this directly — a copy taken this way was missing
 * every row that hadn't been checkpointed yet. Database.prototype.backup()
 * (used throughout this file) is SQLite's own online-backup API and
 * handles this correctly regardless of WAL state.
 */

// Persisted in the existing generic `settings` key/value table — no schema
// change needed. An empty/missing value means "use the default folder".
const BACKUP_DIR_SETTING_KEY = 'backup.customDir'

function getDefaultBackupsDir() {
  const dir = path.join(app.getPath('userData'), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// The folder backups are actually written to right now: the person's
// chosen folder if they set one (Settings → پشتیبان‌گیری), otherwise the
// app's own userData/backups. mkdirSync is allowed to throw here (e.g. a
// USB drive that held the chosen folder was unplugged) — callers let that
// propagate as a real backup failure rather than silently falling back to
// the default folder, since a silent fallback would be a folder switch
// the person never asked for.
function getActiveBackupsDir() {
  const custom = settingsRepository.get(BACKUP_DIR_SETTING_KEY)
  if (custom) {
    fs.mkdirSync(custom, { recursive: true })
    return custom
  }
  return getDefaultBackupsDir()
}

// For the Settings UI to display "پشتیبان‌ها اکنون در «...» ذخیره می‌شوند"
// without needing to know the settings-key/default-fallback details itself.
function getBackupDirInfo() {
  const custom = settingsRepository.get(BACKUP_DIR_SETTING_KEY)
  return { path: custom || getDefaultBackupsDir(), isCustom: Boolean(custom) }
}

/**
 * Lets the person pick any writable folder as the backup destination.
 * Validated (created if missing, checked for write access) BEFORE being
 * persisted — an unwritable choice must never silently become "the
 * folder backups now quietly fail to reach". Only the setting changes;
 * nothing already on disk in the previous folder is moved, renamed, or
 * deleted, so existing backups are never lost or overwritten by a folder
 * switch — they simply stop appearing in listBackups() (which only ever
 * reads the currently-active folder) until the person switches back.
 */
async function pickBackupDir(parentWindow) {
  const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
    title: 'انتخاب پوشه ذخیره پشتیبان‌ها',
    properties: ['openDirectory', 'createDirectory']
  })
  if (canceled || !filePaths?.[0]) return { success: false, canceled: true }

  const chosen = filePaths[0]
  try {
    fs.mkdirSync(chosen, { recursive: true })
    fs.accessSync(chosen, fs.constants.W_OK)
  } catch (err) {
    return { success: false, error: 'پوشه انتخاب‌شده قابل نوشتن نیست: ' + err.message }
  }

  settingsRepository.set(BACKUP_DIR_SETTING_KEY, chosen)
  return { success: true, path: chosen }
}

// Reverts to the default userData/backups folder. Same "setting only,
// nothing on disk touched" guarantee as pickBackupDir.
function resetBackupDir() {
  settingsRepository.set(BACKUP_DIR_SETTING_KEY, '')
  return { success: true, path: getDefaultBackupsDir() }
}

const pad2 = (n) => String(n).padStart(2, '0')

// `auto` gets its own filename prefix (not just a field in the list
// response) so the two kinds are unambiguous even to someone opening the
// folder directly in a file explorer, not just inside the app.
function backupFileName({ auto = false } = {}) {
  const now = new Date()
  const { jy, jm, jd } = toJalaali(now)
  const prefix = auto ? 'auto_backup' : 'backup'
  return `${prefix}_${jy}-${pad2(jm)}-${pad2(jd)}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}.db`
}

// backupFileName() only has 1-second resolution, so two backups taken in
// the same second would otherwise collide. That's not just theoretical:
// restoreFromFile takes a safety-net backup moments before restoring, and
// if that lands in the same second as the backup being restored FROM,
// naively reusing backupFileName() would silently overwrite — and
// corrupt — the very file mid-restore. Verified this actually happens,
// then fixed it here rather than trusting timestamp uniqueness. Same
// protection now also covers the auto-backup path, where a burst of
// quick operations makes same-second collisions the common case, not the
// edge case.
function uniqueBackupPath({ auto = false } = {}) {
  const dir = getActiveBackupsDir()
  const baseName = backupFileName({ auto })
  let candidate = path.join(dir, baseName)
  let suffix = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, baseName.replace(/\.db$/, `-${suffix}.db`))
    suffix++
  }
  return candidate
}

async function performRawBackup({ auto = false } = {}) {
  const destPath = uniqueBackupPath({ auto })
  await getDatabase().backup(destPath)
  return destPath
}

// `auto: true` is passed by autoBackupService.js after a database-changing
// operation has already committed, and by restoreFromFile's own pre-
// restore safety net below — both are system-triggered, not a direct
// "پشتیبان‌گیری اکنون" click. Recorded in the audit trail either way (same
// BACKUP_CREATED action) so the audit log stays a complete record of every
// backup regardless of what triggered it; `trigger` in `changes`
// distinguishes them for anyone reading the log.
async function createBackup(currentUser, { auto = false } = {}) {
  const destPath = await performRawBackup({ auto })
  auditService.recordAudit({
    user: currentUser,
    action: 'BACKUP_CREATED',
    entityType: 'Database',
    entityId: null,
    changes: { fileName: path.basename(destPath), trigger: auto ? 'auto' : 'manual' }
  })
  return { success: true, fileName: path.basename(destPath), auto }
}

// Only ever reads the CURRENTLY ACTIVE folder (see getActiveBackupsDir) —
// a deliberate single-source-of-truth choice: if backups from two
// different folders were merged into one list, restoreByFileName's
// filename lookup could become ambiguous the moment two folders happened
// to contain a same-named file. Nothing from a previous folder is lost on
// disk by this — it just won't show up here until that folder is active
// again (see pickBackupDir's comment).
function listBackups() {
  const dir = getActiveBackupsDir()
  return fs
    .readdirSync(dir)
    .filter((f) => (f.startsWith('backup_') || f.startsWith('auto_backup_')) && f.endsWith('.db'))
    .map((f) => {
      const full = path.join(dir, f)
      const stat = fs.statSync(full)
      return {
        fileName: f,
        path: full,
        createdAt: stat.mtime.toISOString(),
        size: stat.size,
        auto: f.startsWith('auto_backup_')
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// SQLite files always start with this exact 16-byte header — a cheap
// sanity check before attempting a full open.
function looksLikeSqliteFile(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(16)
    fs.readSync(fd, buf, 0, 16, 0)
    return buf.toString('utf8') === 'SQLite format 3\u0000'
  } finally {
    fs.closeSync(fd)
  }
}

// Deeper check: does this look like THIS app's database specifically, not
// just any SQLite file — guards against restoring an unrelated .db file
// picked by mistake from "restore from file".
function validateBackupFile(filePath) {
  if (!fs.existsSync(filePath)) return { valid: false, reason: 'فایل یافت نشد' }
  if (!looksLikeSqliteFile(filePath)) {
    return { valid: false, reason: 'فایل انتخاب‌شده یک پایگاه‌داده SQLite معتبر نیست' }
  }
  let testDb
  try {
    testDb = new Database(filePath, { readonly: true })
    const hasAssetsTable = testDb
      .prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='assets'")
      .get().n
    if (!hasAssetsTable) {
      return { valid: false, reason: 'این فایل ساختار پایگاه‌داده این برنامه را ندارد' }
    }
    return { valid: true }
  } catch (err) {
    return { valid: false, reason: 'فایل قابل خواندن نیست: ' + err.message }
  } finally {
    testDb?.close()
  }
}

async function pickBackupFile(parentWindow) {
  const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
    title: 'انتخاب فایل پشتیبان برای بازیابی',
    properties: ['openFile'],
    filters: [{ name: 'SQLite Database', extensions: ['db'] }]
  })
  if (canceled || !filePaths?.[0]) return { success: false, canceled: true }
  return { success: true, path: filePaths[0], fileName: path.basename(filePaths[0]) }
}

/**
 * The actual restore. Order matters and each step assumes the previous one
 * succeeded:
 *   1. Validate the source file BEFORE touching anything live.
 *   2. Take a safety-net backup of what's currently live, in case the
 *      wrong file gets restored — this runs (and can fail loudly) while
 *      the live db is still open and untouched.
 *   3. Copy the chosen backup into a TEMP file next to the live one —
 *      NOT over the live path yet. The live database stays open and
 *      fully functional through this entire step; if the copy fails
 *      partway (disk full, permissions), nothing about the live database
 *      was ever touched.
 *   4. Validate the TEMP copy with the exact same check already applied
 *      to the source in step 1 — catches a corrupted copy (rare, but a
 *      real filesystem failure mode) before it can ever reach the live
 *      path.
 *   5. Only now close the live connection — required before replacing
 *      its file (an open handle can block or corrupt the replacement,
 *      especially on Windows) — and only for the brief moment the actual
 *      swap in step 6 takes, not for the copy/validate steps above.
 *   6. Atomically replace the live file with the validated temp file via
 *      fs.renameSync. This is the step that makes the whole operation
 *      safe: Node's fs.rename uses the OS's own single-operation
 *      file-replace primitive on every platform (POSIX rename(2); on
 *      Windows, libuv's implementation calls MoveFileExW with
 *      MOVEFILE_REPLACE_EXISTING) — the destination is either the OLD
 *      content or the NEW content at every instant, never neither and
 *      never a half-written file, regardless of platform. This replaces
 *      the previous close-then-delete-then-copy sequence, which had a
 *      real window where the live path could be missing entirely if the
 *      app or OS crashed mid-copy — confirmed exactly this gap during
 *      the audit that asked for this fix. If the rename itself throws
 *      (e.g. the destination is locked by another process), the OS
 *      guarantees the destination was never touched, so the ORIGINAL
 *      live file is still intact and simply gets reopened — restore
 *      cleanly failed, nothing was lost, and the safety-net backup from
 *      step 2 is untouched regardless of which branch this takes.
 *   7. Only after a successful swap are the old file's -wal/-shm sidecars
 *      removed — they belong to content that's now gone, and are safe to
 *      drop; done AFTER rather than alongside the swap so that if the
 *      rename in step 6 fails, the original database's WAL state is
 *      still fully intact, not just its main file.
 *   8. Reopen and record the audit entry into the newly-restored
 *      database, not the old one. Recording it beforehand (into the
 *      about-to-be-replaced live db) was the first version of this
 *      function — testing caught that the restore then immediately wipes
 *      out that very entry along with everything else in the old live
 *      db, so the restored database ended up with no record it was ever
 *      restored. This also means a backup taken before a schema
 *      migration correctly gets that migration reapplied via the normal
 *      getDatabase() path, same as any other database this app opens.
 *   9. Reload the window rather than relaunching the whole app process.
 *      app.relaunch() was the original design and the file-swap logic
 *      above is correct under it too — but relaunch turned out unreliable
 *      specifically under `electron-vite dev`, which launches Electron
 *      with arguments a bare app.relaunch() doesn't reconstruct, so the
 *      new process silently never appeared even though every step before
 *      it had already completed correctly. Reloading the window instead
 *      discards all renderer state (React, cached IPC data, everything)
 *      the same way a restart would, without depending on OS-level
 *      process respawning — works identically in dev and packaged builds.
 */
async function restoreFromFile(sourcePath, currentUser, targetWindow) {
  const validation = validateBackupFile(sourcePath)
  if (!validation.valid) return { success: false, error: validation.reason }

  const safetyPath = await performRawBackup({ auto: true })

  const liveDbPath = getDbPath()
  const tempPath = liveDbPath + '.restoring.tmp'
  // Debris from a previous restore attempt that never reached the rename
  // step (e.g. the app was closed mid-validation) — cleared before this
  // attempt starts so it can't be mistaken for anything.
  fs.rmSync(tempPath, { force: true })

  try {
    fs.copyFileSync(sourcePath, tempPath)
  } catch (err) {
    fs.rmSync(tempPath, { force: true })
    return { success: false, error: 'کپی فایل پشتیبان با خطا مواجه شد: ' + err.message }
  }

  const tempValidation = validateBackupFile(tempPath)
  if (!tempValidation.valid) {
    fs.rmSync(tempPath, { force: true })
    return { success: false, error: 'فایل کپی‌شده معتبر نیست: ' + tempValidation.reason }
  }

  closeDatabase()

  try {
    fs.renameSync(tempPath, liveDbPath)
  } catch (err) {
    // The OS guarantees liveDbPath was not touched by a failed rename —
    // the original database is exactly as it was before this call, and
    // is reopened here so the app keeps working normally.
    getDatabase()
    fs.rmSync(tempPath, { force: true })
    return {
      success: false,
      error:
        'جایگزینی پایگاه‌داده با خطا مواجه شد و انجام نشد: ' +
        err.message +
        ' — پایگاه‌داده فعلی دست‌نخورده باقی ماند. نسخه پشتیبان امنیتی نیز در دسترس است: ' +
        path.basename(safetyPath)
    }
  }

  // Only reachable after a successful swap — see step 7 in the comment
  // above for why this waits until here.
  ;['-wal', '-shm'].forEach((ext) => fs.rmSync(liveDbPath + ext, { force: true }))

  try {
    getDatabase()
  } catch (err) {
    // Extremely unlikely (the file was already validated before the
    // rename), but if it happens there is no safe further automated
    // action to take — more filesystem surgery at this point would add
    // risk, not reduce it. The safety-net backup from step 2 is untouched
    // and named here for manual recovery.
    return {
      success: false,
      error:
        'بازیابی پس از جایگزینی با خطا مواجه شد: ' +
        err.message +
        ' — برای بازیابی دستی، نسخه پشتیبان امنیتی موجود است: ' +
        path.basename(safetyPath)
    }
  }

  auditService.recordAudit({
    user: currentUser,
    action: 'BACKUP_RESTORED',
    entityType: 'Database',
    entityId: null,
    changes: { restoredFrom: path.basename(sourcePath), safetyBackup: path.basename(safetyPath) }
  })

  targetWindow?.reload()

  return { success: true }
}

async function downloadBackupCopy(sourcePath, parentWindow) {
  const { canceled, filePath } = await dialog.showSaveDialog(parentWindow, {
    title: 'ذخیره فایل پشتیبان',
    defaultPath: path.basename(sourcePath),
    filters: [{ name: 'SQLite Database', extensions: ['db'] }]
  })
  if (canceled || !filePath) return { success: false, canceled: true }
  fs.copyFileSync(sourcePath, filePath)
  return { success: true, path: filePath }
}

export const backupService = {
  createBackup,
  listBackups,
  pickBackupFile,
  restoreFromFile,
  downloadBackupCopy,
  getBackupDirInfo,
  pickBackupDir,
  resetBackupDir
}
