import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import { createTestDb, cleanupTestDb } from '../testHelpers/testDb'

// Reliability + Audit Completeness phase (2.4) — exports are one of the
// clearest ways company data leaves the app as a file, and previously
// left no audit trail at all. These tests prove: a real, completed
// export records exactly one EXPORT entry with metadata only (never row
// data); cancelling the save/print dialog records nothing, since no
// file/print actually happened.

let ctx
let dialogResult
let printOutcome // { ok, failureReason }

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
  dialog: {
    showSaveDialog: async () => dialogResult
  },
  BrowserWindow: class {
    constructor() {}
    once() {}
    async loadFile() {}
    async loadURL() {}
    get webContents() {
      return {
        printToPDF: async () => Buffer.from('fake-pdf-bytes'),
        print: (_opts, callback) => callback(printOutcome.ok, printOutcome.failureReason),
        setWindowOpenHandler: () => {},
        on: () => {}
      }
    }
    destroy() {}
    static fromWebContents() {
      return null
    }
  }
}))

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, default: { ...actual.default, writeFileSync: () => {} } }
})

const { exportService } = await import('../../../src/main/services/exportService.js')

function seedUser() {
  const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
  const id = ctx.db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin', 'x', 'Admin', ?)")
    .run(roleId).lastInsertRowid
  return { id, username: 'admin' }
}

const payload = { title: 'گزارش دارایی‌ها', columns: [{ title: 'کد', key: 'code' }], rows: [{ code: 'A-1' }, { code: 'A-2' }] }

beforeEach(() => {
  ctx = createTestDb()
  dialogResult = { canceled: false, filePath: '/tmp/whatever.xlsx' }
  printOutcome = { ok: true, failureReason: null }
})

afterEach(() => {
  cleanupTestDb(ctx)
})

describe('exportService audit trail', () => {
  it('exportToExcel records exactly one EXPORT entry on a real save, with metadata only', async () => {
    const user = seedUser()
    const result = await exportService.exportToExcel(payload, null, user)
    expect(result.success).toBe(true)

    expect(ctx.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n).toBe(1)
    const entry = ctx.db.prepare('SELECT * FROM audit_log').get()
    expect(entry.action).toBe('EXPORT')
    expect(entry.entity_type).toBe('Export')
    expect(entry.entity_id).toBeNull()
    expect(entry.user_id).toBe(user.id)
    const changes = JSON.parse(entry.changes)
    expect(changes).toEqual({ format: 'excel', title: 'گزارش دارایی‌ها', rowCount: 2 })
    // Never the row data itself.
    expect(JSON.stringify(changes)).not.toContain('A-1')
  })

  it('exportToExcel records nothing when the save dialog is cancelled', async () => {
    dialogResult = { canceled: true, filePath: null }
    const user = seedUser()
    const result = await exportService.exportToExcel(payload, null, user)
    expect(result.success).toBe(false)
    expect(result.canceled).toBe(true)
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n).toBe(0)
  })

  it('exportToPdf records exactly one EXPORT entry on a real save', async () => {
    const user = seedUser()
    const result = await exportService.exportToPdf(payload, null, user)
    expect(result.success).toBe(true)

    const entry = ctx.db.prepare('SELECT * FROM audit_log').get()
    expect(entry.action).toBe('EXPORT')
    expect(JSON.parse(entry.changes)).toEqual({ format: 'pdf', title: 'گزارش دارایی‌ها', rowCount: 2 })
  })

  it('exportToPdf records nothing when the save dialog is cancelled', async () => {
    dialogResult = { canceled: true, filePath: null }
    const user = seedUser()
    await exportService.exportToPdf(payload, null, user)
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n).toBe(0)
  })

  it('printLabels records exactly one EXPORT entry when printing actually completes', async () => {
    const user = seedUser()
    const result = await exportService.printLabels(
      { assets: [{ assetCode: 'A-1', assetName: 'دستگاه' }, { assetCode: 'A-2', assetName: 'دستگاه' }] },
      null,
      user
    )
    expect(result.success).toBe(true)

    const entry = ctx.db.prepare('SELECT * FROM audit_log').get()
    expect(entry.action).toBe('EXPORT')
    expect(entry.entity_type).toBe('Export')
    expect(JSON.parse(entry.changes)).toEqual({ format: 'labels', assetCount: 2 })
  })

  it('printLabels records nothing when the print dialog is cancelled', async () => {
    printOutcome = { ok: false, failureReason: 'cancelled by user' }
    const user = seedUser()
    const result = await exportService.printLabels({ assets: [{ assetCode: 'A-1' }] }, null, user)
    expect(result.canceled).toBe(true)
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n).toBe(0)
  })
})
