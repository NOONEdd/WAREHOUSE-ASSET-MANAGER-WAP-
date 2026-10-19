import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDb, cleanupTestDb, seedMinimalLookups } from '../testHelpers/testDb'
import { hash } from '../../../src/main/utils/hashUtils'

/**
 * Security Hardening phase. Rather than starting a real Electron process,
 * this captures every ipcMain.handle(...) registration into a plain map
 * and calls the captured function directly — the same functions the real
 * ipcMain would invoke, just without needing a real IPC transport. This
 * is the most direct way to prove the actual guard behind each channel
 * without duplicating what the service-layer tests already cover.
 */

let ctx
let userDataDir
const handlers = {}

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => {
      handlers[channel] = fn
    }
  },
  app: {
    getPath: (name) => {
      if (name === 'userData') return userDataDir
      throw new Error('unexpected app.getPath: ' + name)
    },
    getAppPath: () => userDataDir
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true }),
    showSaveDialog: async () => ({ canceled: true })
  },
  BrowserWindow: {
    fromWebContents: () => null
  }
}))

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

const { authService } = await import('../../../src/main/services/authService.js')
const { registerAuthHandlers } = await import('../../../src/main/ipc/auth.ipc.js')
const { registerAssetHandlers } = await import('../../../src/main/ipc/assets.ipc.js')
const { registerLookupHandlers } = await import('../../../src/main/ipc/lookup.ipc.js')
const { registerAuditLogHandlers } = await import('../../../src/main/ipc/auditLog.ipc.js')
const { registerTransactionHandlers } = await import('../../../src/main/ipc/transactions.ipc.js')
const { registerBackupHandlers } = await import('../../../src/main/ipc/backup.ipc.js')
const { registerExportHandlers } = await import('../../../src/main/ipc/export.ipc.js')
const { registerImportHandlers } = await import('../../../src/main/ipc/import.ipc.js')
const { registerSavedFilterHandlers } = await import('../../../src/main/ipc/savedFilters.ipc.js')

registerAuthHandlers()
registerAssetHandlers()
registerLookupHandlers()
registerAuditLogHandlers()
registerTransactionHandlers()
registerBackupHandlers()
registerExportHandlers()
registerImportHandlers()
registerSavedFilterHandlers()

const AUTH_ERROR = 'ابتدا وارد حساب کاربری شوید'
const fakeEvent = { sender: {} }

async function invoke(channel, ...args) {
  try {
    const result = await handlers[channel](fakeEvent, ...args)
    return { threw: false, result }
  } catch (err) {
    return { threw: true, message: err.message }
  }
}

// True only when the specific outcome was an authentication rejection —
// covers both response shapes used across the app: a handler that lets
// requireUser() throw straight through (rejects the invoke() promise),
// and one that catches it into { success: false, error }.
function wasAuthRejected({ threw, message, result }) {
  if (threw) return message === AUTH_ERROR
  if (result && result.success === false) return result.error === AUTH_ERROR
  return false
}

function login() {
  const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
  ctx.db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin', ?, 'Admin', ?)")
    .run(hash('Password-1'), roleId)
  const result = authService.login('admin', 'Password-1')
  if (!result.success) throw new Error('test setup: login failed — ' + result.error)
}

beforeEach(() => {
  ctx = createTestDb()
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-ipc-auth-test-'))
})

afterEach(() => {
  // Must run BEFORE cleanupTestDb: logout() audits against currentSession
  // .id, which only exists in THIS test's ctx.db — clearing the session
  // here, while that db is still open, avoids a foreign-key mismatch
  // against the next test's fresh (and different) database.
  authService.logout()
  cleanupTestDb(ctx)
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

// Channel → args that reach past the auth check without crashing on
// something unrelated (a missing id/bad shape). The exact business
// outcome doesn't matter for these tests — only whether the auth check
// itself was what blocked the call.
const PROTECTED_CHANNELS = [
  ['assets:list', [{}]],
  ['assets:get', [1]],
  ['assets:dashboardStats', []],
  ['assets:countByWorkshop', []],
  ['lookups:getAll', []],
  ['lookups:create', ['itemTypes', 'تجهیزات تست جدید']],
  ['lookups:delete', ['itemTypes', 99999]],
  ['lookups:deleteBulk', ['itemTypes', []]],
  ['lookups:listStatuses', []],
  ['lookups:moveStatus', [99999, 'up']],
  ['auditLog:list', [{}]],
  ['transactions:listByAsset', [1]],
  ['transactions:listAll', [{}]],
  ['backup:list', []],
  ['backup:pickFile', []],
  ['backup:downloadCopy', ['nonexistent.db']],
  ['backup:getDirInfo', []],
  ['backup:pickDir', []],
  ['backup:resetDir', []],
  ['export:toExcel', [{ columns: [], rows: [], title: 'گزارش' }]],
  ['export:toPdf', [{ columns: [], rows: [], title: 'گزارش' }]],
  ['export:printLabels', [{ assets: [] }]],
  ['import:pickFile', []],
  ['import:inspectFile', ['/nonexistent/path.csv']],
  ['import:parseFile', ['/nonexistent/path.csv', {}]],
  ['import:buildPreview', [{ headers: [], rows: [], mapping: {} }]],
  // Already protected before this phase — regression check, not new
  // behavior. If any of these ever lost their guard, this phase's own
  // pattern (requireUser() at the top of every sensitive handler) is
  // what would catch it.
  ['assets:create', [{}]],
  ['assets:update', [1, {}]],
  ['assets:delete', [1]],
  ['assets:deleteBulk', [[]]],
  ['assets:changeStatus', [1, {}]],
  ['assets:changeStatusBulk', [[], {}]],
  ['lookups:createStatus', ['تعمیر']],
  ['lookups:renameStatus', [99999, 'x']],
  ['lookups:setStatusActive', [99999, false]],
  ['lookups:deleteStatus', [99999]],
  ['lookups:migrateAndDeleteStatus', [99999, 'در انبار']],
  ['backup:create', []],
  ['backup:restoreByFileName', ['nonexistent.db']],
  ['backup:restoreFromPath', ['/nonexistent/path.db']],
  ['import:commit', [{ headers: [], rows: [], mapping: {} }]],
  ['savedFilters:list', []],
  ['savedFilters:create', ['test', {}]],
  ['savedFilters:delete', ['some-id']],
  // First-Run Security phase
  [
    'auth:changePassword',
    [{ currentPassword: 'Password-1', newPassword: 'New-Password-2', confirmPassword: 'New-Password-2' }]
  ]
]

describe('Every sensitive IPC channel rejects an unauthenticated call', () => {
  for (const [channel, args] of PROTECTED_CHANNELS) {
    it(`${channel} rejects when nobody is logged in`, async () => {
      const outcome = await invoke(channel, ...args)
      expect(wasAuthRejected(outcome), `expected ${channel} to be rejected for auth, got: ${JSON.stringify(outcome)}`).toBe(
        true
      )
    })
  }
})

describe('The same channels are not blocked by authentication once logged in', () => {
  for (const [channel, args] of PROTECTED_CHANNELS) {
    it(`${channel} is not rejected for auth reasons once authenticated`, async () => {
      login()
      const outcome = await invoke(channel, ...args)
      expect(
        wasAuthRejected(outcome),
        `expected ${channel} NOT to be an auth rejection once logged in, got: ${JSON.stringify(outcome)}`
      ).toBe(false)
    })
  }
})

describe('Unauthenticated calls cause no database mutation', () => {
  it('lookups:create does not create a row when rejected for auth', async () => {
    await invoke('lookups:create', 'itemTypes', 'تجهیزات نباید ثبت شود')
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM item_types').get().n).toBe(0)
  })

  it('assets:create does not create a row when rejected for auth', async () => {
    const { itemTypeId } = seedMinimalLookups(ctx.db)
    const statusId = ctx.db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    await invoke('assets:create', {
      assetCode: 'SHOULD-NOT-EXIST',
      assetName: 'دستگاه تست',
      itemTypeId,
      serialNumber: 'SN-SHOULD-NOT-EXIST',
      statusId
    })
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(0)
  })

  it('lookups:moveStatus does not change sort_order when rejected for auth', async () => {
    const before = ctx.db.prepare('SELECT id, sort_order FROM asset_statuses ORDER BY id').all()
    await invoke('lookups:moveStatus', before[1].id, 'up')
    const after = ctx.db.prepare('SELECT id, sort_order FROM asset_statuses ORDER BY id').all()
    expect(after).toEqual(before)
  })
})

describe('auth:login / auth:logout / auth:currentUser remain accessible without authentication', () => {
  it('auth:currentUser can be called with nobody logged in — returns null, does not throw', async () => {
    const outcome = await invoke('auth:currentUser')
    expect(outcome.threw).toBe(false)
    expect(outcome.result).toBeNull()
  })

  it('auth:login can be called with nobody logged in — that is the entire point of it', async () => {
    const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
    ctx.db
      .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin', ?, 'Admin', ?)")
      .run(hash('Password-1'), roleId)

    const outcome = await invoke('auth:login', 'admin', 'Password-1')
    expect(outcome.threw).toBe(false)
    expect(outcome.result.success).toBe(true)
  })

  it('auth:logout can be called with nobody logged in — safe no-op, does not throw', async () => {
    const outcome = await invoke('auth:logout')
    expect(outcome.threw).toBe(false)
  })
})

describe('auth:needsFirstRunSetup / auth:completeFirstRunSetup remain accessible without authentication', () => {
  it('auth:needsFirstRunSetup can be called with nobody logged in — that is the only time it matters', async () => {
    const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
    ctx.db
      .prepare(
        "INSERT INTO users (username, password_hash, full_name, role_id, needs_password_setup) VALUES ('admin', ?, 'Admin', ?, 1)"
      )
      .run(hash('placeholder'), roleId)

    const outcome = await invoke('auth:needsFirstRunSetup')
    expect(outcome.threw).toBe(false)
    expect(outcome.result).toBe(true)
  })

  it('auth:completeFirstRunSetup can be called with nobody logged in — by definition nobody can be yet', async () => {
    const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
    ctx.db
      .prepare(
        "INSERT INTO users (username, password_hash, full_name, role_id, needs_password_setup) VALUES ('admin', ?, 'Admin', ?, 1)"
      )
      .run(hash('placeholder'), roleId)

    const outcome = await invoke('auth:completeFirstRunSetup', 'Chosen-Password-1', 'Chosen-Password-1')
    expect(outcome.threw).toBe(false)
    expect(outcome.result.success).toBe(true)
  })
})
