import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let userDataDir

vi.mock('electron', () => ({
  app: {
    getPath: (name) => {
      if (name === 'userData') return userDataDir
      throw new Error('unexpected app.getPath: ' + name)
    }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true }),
    showSaveDialog: async () => ({ canceled: true })
  }
}))

const { autoBackupService } = await import('../../../src/main/services/autoBackupService.js')
const { backupService } = await import('../../../src/main/services/backupService.js')
const { settingsRepository } = await import('../../../src/main/repositories/settingsRepository.js')
const { closeDatabase, getDatabase } = await import('../../../src/main/database/connection.js')

let currentUser

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-autobackup-test-'))
  autoBackupService._resetCooldownForTests()

  const db = getDatabase()
  const roleId = db.prepare('SELECT id FROM roles LIMIT 1').get().id
  const userId = db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
    .run(roleId).lastInsertRowid
  currentUser = { id: userId, username: 'admin' }
})

afterEach(() => {
  vi.useRealTimers()
  closeDatabase()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

describe('autoBackupService.triggerAutoBackup', () => {
  it('creates an auto-tagged backup and returns null (no warning) on success', async () => {
    const warning = await autoBackupService.triggerAutoBackup(currentUser)
    expect(warning).toBeNull()

    const backups = backupService.listBackups()
    expect(backups).toHaveLength(1)
    expect(backups[0].auto).toBe(true)
    expect(backups[0].fileName.startsWith('auto_backup_')).toBe(true)
  })

  it('records the same BACKUP_CREATED audit action as a manual backup, tagged auto', async () => {
    await autoBackupService.triggerAutoBackup(currentUser)
    const entry = getDatabase().prepare("SELECT * FROM audit_log WHERE action = 'BACKUP_CREATED'").get()
    expect(JSON.parse(entry.changes).trigger).toBe('auto')
  })

  // "Prevent excessive duplicate backups where possible" — a second
  // trigger immediately after the first must not produce a second file.
  it('skips a second trigger within the cooldown window', async () => {
    await autoBackupService.triggerAutoBackup(currentUser)
    const warning = await autoBackupService.triggerAutoBackup(currentUser)
    expect(warning).toBeNull() // skipped silently, not treated as a failure
    expect(backupService.listBackups()).toHaveLength(1)
  })

  it('creates a new backup again once the cooldown window has passed', async () => {
    // Only Date is faked (not setTimeout/setImmediate) — better-sqlite3's
    // backup() relies on real timers internally to schedule its async
    // work, so faking those too would hang the backup call itself.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await autoBackupService.triggerAutoBackup(currentUser)
      vi.advanceTimersByTime(10_001)
      await autoBackupService.triggerAutoBackup(currentUser)
    } finally {
      vi.useRealTimers()
    }
    expect(backupService.listBackups()).toHaveLength(2)
  })

  // "If automatic backup fails, do NOT roll back a successful user
  // operation; show a clear warning." — simulated here by pointing the
  // active backup folder at a path that can never be created (a regular
  // file already occupies it), which makes performRawBackup's mkdirSync
  // throw synchronously.
  it('returns a Persian warning string instead of throwing when the backup fails', async () => {
    const blockedPath = path.join(userDataDir, 'not-a-folder')
    fs.writeFileSync(blockedPath, 'x')
    settingsRepository.set('backup.customDir', blockedPath)

    const warning = await autoBackupService.triggerAutoBackup(currentUser)
    expect(typeof warning).toBe('string')
    expect(warning.length).toBeGreaterThan(0)
  })

  it('a failed attempt still engages the cooldown (does not retry on every call)', async () => {
    const blockedPath = path.join(userDataDir, 'not-a-folder')
    fs.writeFileSync(blockedPath, 'x')
    settingsRepository.set('backup.customDir', blockedPath)

    const first = await autoBackupService.triggerAutoBackup(currentUser)
    const second = await autoBackupService.triggerAutoBackup(currentUser)
    expect(first).not.toBeNull()
    expect(second).toBeNull() // cooldown active, so no second attempt (and no second warning)
  })
})
