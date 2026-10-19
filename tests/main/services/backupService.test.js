import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

let userDataDir
let dialogQueue
let mockWindow

vi.mock('electron', () => ({
  app: {
    getPath: (name) => {
      if (name === 'userData') return userDataDir
      throw new Error('unexpected app.getPath: ' + name)
    }
  },
  dialog: {
    showOpenDialog: async () => dialogQueue.openFile,
    showSaveDialog: async () => dialogQueue.saveFile
  }
}))

// backupService only reaches the database through connection.js's own
// getDatabase/closeDatabase — a real app.getPath (from the mock above) is
// all connection.js itself needs, so it runs unmodified and for real.
const { backupService } = await import('../../../src/main/services/backupService.js')
const { closeDatabase, getDatabase } = await import('../../../src/main/database/connection.js')

let currentUser

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-backup-test-'))
  dialogQueue = { openFile: null, saveFile: null }
  mockWindow = { reloadCount: 0, reload() { this.reloadCount++ } }

  // audit_log has a FK on users — recordAudit fails without a real row.
  const db = getDatabase()
  const roleId = db.prepare('SELECT id FROM roles LIMIT 1').get().id
  const userId = db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
    .run(roleId).lastInsertRowid
  currentUser = { id: userId, username: 'admin' }
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

function seedLiveAssets(count, codePrefix) {
  const db = getDatabase()
  const itemTypeId =
    db.prepare('SELECT id FROM item_types LIMIT 1').get()?.id ??
    db.prepare("INSERT INTO item_types (name) VALUES ('X')").run().lastInsertRowid
  const statusId = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
  const insert = db.prepare(
    'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?, ?, ?, ?, ?)'
  )
  for (let i = 0; i < count; i++) {
    insert.run(`${codePrefix}-${i}`, `${codePrefix} ${i}`, itemTypeId, `SN-${codePrefix}-${i}`, statusId)
  }
  return db
}

// Every listed backup's file always exists at exactly the path listBackups()
// reports — used instead of reconstructing paths from internals.
function pathFor(fileName) {
  return backupService.listBackups().find((b) => b.fileName === fileName).path
}

describe('backupService.createBackup', () => {
  it('produces a file that actually contains all live rows (WAL-safety)', async () => {
    seedLiveAssets(40, 'LIVE')
    expect(getDatabase().prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(40)

    const result = await backupService.createBackup(currentUser)
    expect(result.success).toBe(true)

    const check = new Database(pathFor(result.fileName), { readonly: true })
    expect(check.prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(40)
    check.close()
  })

  it('records exactly one BACKUP_CREATED audit entry', async () => {
    seedLiveAssets(1, 'X')
    await backupService.createBackup(currentUser)
    const entries = getDatabase().prepare("SELECT * FROM audit_log WHERE action = 'BACKUP_CREATED'").all()
    expect(entries).toHaveLength(1)
  })
})

describe('backupService.listBackups', () => {
  it('lists backups newest first', async () => {
    seedLiveAssets(1, 'X')
    const first = await backupService.createBackup(currentUser)
    const second = await backupService.createBackup(currentUser)
    const list = backupService.listBackups()
    expect(list[0].fileName).toBe(second.fileName)
    expect(list.some((b) => b.fileName === first.fileName)).toBe(true)
  })

  // Regression test for a real bug found during manual testing: two
  // backups taken in the same second used to silently collide and
  // overwrite each other, since backupFileName() only has 1-second
  // resolution. uniqueBackupPath() must guarantee no collision regardless
  // of timing.
  it('never collides — many rapid backups all produce distinct files', async () => {
    seedLiveAssets(1, 'X')
    const results = []
    for (let i = 0; i < 5; i++) {
      results.push(await backupService.createBackup(currentUser))
    }
    const fileNames = new Set(results.map((r) => r.fileName))
    expect(fileNames.size).toBe(5) // no two collided
    expect(backupService.listBackups()).toHaveLength(5)
  })
})

describe('backupService — configurable backup folder', () => {
  it('defaults to userData/backups when no custom folder has been chosen', () => {
    const info = backupService.getBackupDirInfo()
    expect(info.isCustom).toBe(false)
    expect(info.path).toBe(path.join(userDataDir, 'backups'))
  })

  it('pickBackupDir persists a valid, writable chosen folder', async () => {
    const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-custom-backups-'))
    dialogQueue.openFile = { canceled: false, filePaths: [chosen] }

    const result = await backupService.pickBackupDir(mockWindow)
    expect(result.success).toBe(true)
    expect(result.path).toBe(chosen)

    const info = backupService.getBackupDirInfo()
    expect(info.isCustom).toBe(true)
    expect(info.path).toBe(chosen)
  })

  it('a canceled folder picker leaves the active folder unchanged', async () => {
    dialogQueue.openFile = { canceled: true, filePaths: [] }
    const result = await backupService.pickBackupDir(mockWindow)
    expect(result.success).toBe(false)
    expect(result.canceled).toBe(true)
    expect(backupService.getBackupDirInfo().isCustom).toBe(false)
  })

  it('subsequent backups are written into the newly-chosen folder', async () => {
    seedLiveAssets(2, 'X')
    const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-custom-backups-'))
    dialogQueue.openFile = { canceled: false, filePaths: [chosen] }
    await backupService.pickBackupDir(mockWindow)

    const result = await backupService.createBackup(currentUser)
    expect(fs.existsSync(path.join(chosen, result.fileName))).toBe(true)
  })

  // "Do not lose or overwrite existing backups unexpectedly." — a backup
  // taken BEFORE switching folders must still exist on disk afterwards,
  // even though it no longer appears in listBackups() (which only reads
  // the currently-active folder).
  it('switching folders never deletes backups left behind in the previous one', async () => {
    seedLiveAssets(1, 'X')
    const before = await backupService.createBackup(currentUser)
    const oldPath = pathFor(before.fileName)

    const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-custom-backups-'))
    dialogQueue.openFile = { canceled: false, filePaths: [chosen] }
    await backupService.pickBackupDir(mockWindow)

    expect(fs.existsSync(oldPath)).toBe(true)
    expect(backupService.listBackups().some((b) => b.fileName === before.fileName)).toBe(false)
  })

  it('resetBackupDir reverts to the default folder without touching any files', async () => {
    seedLiveAssets(1, 'X')
    const before = await backupService.createBackup(currentUser)

    const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-custom-backups-'))
    dialogQueue.openFile = { canceled: false, filePaths: [chosen] }
    await backupService.pickBackupDir(mockWindow)

    const reset = backupService.resetBackupDir()
    expect(reset.success).toBe(true)
    expect(backupService.getBackupDirInfo().isCustom).toBe(false)
    expect(backupService.listBackups().some((b) => b.fileName === before.fileName)).toBe(true)
  })

  it('rejects a chosen folder that cannot be written to', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-readonly-'))
    const blocked = path.join(parent, 'not-a-folder')
    fs.writeFileSync(blocked, 'x') // a file sits where a folder is expected
    dialogQueue.openFile = { canceled: false, filePaths: [blocked] }

    const result = await backupService.pickBackupDir(mockWindow)
    expect(result.success).toBe(false)
    expect(backupService.getBackupDirInfo().isCustom).toBe(false)
  })
})

describe('backupService — auto vs manual backups', () => {
  it('tags a manual backup as not-auto by default', async () => {
    seedLiveAssets(1, 'X')
    const result = await backupService.createBackup(currentUser)
    expect(result.auto).toBe(false)
    expect(result.fileName.startsWith('backup_')).toBe(true)
    expect(backupService.listBackups()[0].auto).toBe(false)
  })

  it('tags an auto backup distinctly, with its own filename prefix', async () => {
    seedLiveAssets(1, 'X')
    const result = await backupService.createBackup(currentUser, { auto: true })
    expect(result.auto).toBe(true)
    expect(result.fileName.startsWith('auto_backup_')).toBe(true)
    expect(backupService.listBackups()[0].auto).toBe(true)
  })

  it('auto and manual backups never collide even taken in the same instant', async () => {
    seedLiveAssets(1, 'X')
    const manual = await backupService.createBackup(currentUser)
    const auto = await backupService.createBackup(currentUser, { auto: true })
    expect(manual.fileName).not.toBe(auto.fileName)
    expect(backupService.listBackups()).toHaveLength(2)
  })
})


describe('backupService.restoreFromFile — validation', () => {
  it('rejects a non-SQLite file and leaves the live database untouched', async () => {
    seedLiveAssets(9, 'UNTOUCHED')
    const badPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awm-x-')), 'garbage.txt')
    fs.writeFileSync(badPath, 'not a database')

    const result = await backupService.restoreFromFile(badPath, currentUser, mockWindow)
    expect(result.success).toBe(false)
    expect(mockWindow.reloadCount).toBe(0)
    expect(getDatabase().prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(9)
  })

  it('rejects a valid SQLite file that lacks an assets table', async () => {
    seedLiveAssets(3, 'UNTOUCHED')
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awm-x-')), 'wrong.db')
    const wrongDb = new Database(p)
    wrongDb.exec('CREATE TABLE unrelated (id INTEGER)')
    wrongDb.close()

    const result = await backupService.restoreFromFile(p, currentUser, mockWindow)
    expect(result.success).toBe(false)
    expect(mockWindow.reloadCount).toBe(0)
  })

  it('rejects a path that does not exist', async () => {
    const result = await backupService.restoreFromFile('/no/such/file.db', currentUser, mockWindow)
    expect(result.success).toBe(false)
    expect(mockWindow.reloadCount).toBe(0)
  })
})

describe('backupService.restoreFromFile', () => {
  it("replaces live data with the backup's data, and relaunches the app", async () => {
    seedLiveAssets(5, 'OLDBACKUP') // will become the backup we restore FROM
    const targetBackup = await backupService.createBackup(currentUser)
    const targetPath = pathFor(targetBackup.fileName)

    // Live data changes AFTER that backup was taken — restore should undo this.
    getDatabase().exec('DELETE FROM assets')
    seedLiveAssets(99, 'CURRENT-LIVE')
    expect(getDatabase().prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(99)

    const result = await backupService.restoreFromFile(targetPath, currentUser, mockWindow)
    expect(result.success).toBe(true)
    expect(mockWindow.reloadCount).toBe(1)

    // Simulates the relaunched process opening fresh.
    const reopened = getDatabase()
    const rows = reopened.prepare('SELECT asset_code FROM assets ORDER BY asset_code').all()
    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.asset_code.startsWith('OLDBACKUP'))).toBe(true)
  })

  it('creates a safety-net backup of the pre-restore state before overwriting it', async () => {
    seedLiveAssets(3, 'TARGET')
    const target = await backupService.createBackup(currentUser)
    const targetPath = pathFor(target.fileName)

    getDatabase().exec('DELETE FROM assets')
    seedLiveAssets(17, 'ABOUT-TO-BE-OVERWRITTEN')

    await backupService.restoreFromFile(targetPath, currentUser, mockWindow)

    const backups = backupService.listBackups()
    const has17RowSnapshot = backups.some((b) => {
      const db = new Database(b.path, { readonly: true })
      const n = db.prepare('SELECT COUNT(*) n FROM assets').get().n
      db.close()
      return n === 17
    })
    expect(has17RowSnapshot).toBe(true)
  })

  it('tags the pre-restore safety-net backup as auto, not manual', async () => {
    seedLiveAssets(3, 'TARGET')
    const target = await backupService.createBackup(currentUser)
    const targetPath = pathFor(target.fileName)

    getDatabase().exec('DELETE FROM assets')
    seedLiveAssets(17, 'ABOUT-TO-BE-OVERWRITTEN')

    await backupService.restoreFromFile(targetPath, currentUser, mockWindow)

    const backups = backupService.listBackups()
    const safetyNet = backups.find((b) => {
      const db = new Database(b.path, { readonly: true })
      const n = db.prepare('SELECT COUNT(*) n FROM assets').get().n
      db.close()
      return n === 17
    })
    expect(safetyNet.auto).toBe(true)
  })

  // Regression test for a real bug: the BACKUP_RESTORED audit entry was
  // originally written into the OLD live database before it got replaced
  // — meaning the restore silently erased the very record of itself. It
  // must survive into the newly-restored database instead.
  it('the BACKUP_RESTORED audit entry survives the restore (written to the NEW db, not the old one)', async () => {
    seedLiveAssets(2, 'TARGET')
    const target = await backupService.createBackup(currentUser)
    const targetPath = pathFor(target.fileName)

    getDatabase().exec('DELETE FROM assets')
    seedLiveAssets(2, 'REPLACED')

    await backupService.restoreFromFile(targetPath, currentUser, mockWindow)

    const reopened = getDatabase()
    const entries = reopened.prepare("SELECT * FROM audit_log WHERE action = 'BACKUP_RESTORED'").all()
    expect(entries).toHaveLength(1)
    expect(JSON.parse(entries[0].changes).restoredFrom).toBe(target.fileName)
  })
})
