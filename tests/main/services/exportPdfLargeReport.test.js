// Regression coverage for a real production bug found via manual testing
// with a 10,000-asset benchmark database: buildPdfBuffer() used to send
// the entire generated HTML to Chromium as a base64 data: URL via
// win.loadURL(). Small reports worked; a 10,000-row report's data: URL
// came out ~6.8 million characters, which Chromium's navigation URL
// length ceiling rejects outright with ERR_INVALID_URL (-300) — not a
// slowness problem, a hard cliff. The fix writes the HTML to a uniquely-
// named temp file and uses loadFile() instead, which has no such limit.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDb, cleanupTestDb } from '../testHelpers/testDb'

let ctx
let loadFileCalls = []
let loadURLCalls = []
let destroyed = false
let closedCallback = null
let navigationHandlers = { openHandler: null, willNavigate: null }

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
  dialog: {
    showSaveDialog: async () => ({ canceled: true }) // don't need a real save for this
  },
  BrowserWindow: class {
    constructor() {}
    once(event, cb) {
      if (event === 'closed') closedCallback = cb
    }
    async loadFile(filePath) {
      loadFileCalls.push(filePath)
    }
    async loadURL(url) {
      loadURLCalls.push(url)
    }
    get webContents() {
      return {
        printToPDF: async () => Buffer.from('fake-pdf-bytes'),
        setWindowOpenHandler: (fn) => {
          navigationHandlers.openHandler = fn
        },
        on: (event, fn) => {
          if (event === 'will-navigate') navigationHandlers.willNavigate = fn
        }
      }
    }
    destroy() {
      destroyed = true
    }
    static fromWebContents() {
      return null
    }
  }
}))

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

const { exportService } = await import('../../../src/main/services/exportService.js')

function seedUser() {
  const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
  const id = ctx.db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
    .run(roleId).lastInsertRowid
  return { id, username: 'admin' }
}

// A genuinely large row count — big enough that the OLD data: URL
// approach would have been multiple megabytes, comfortably past
// Chromium's real-world ceiling (the actual production failure was
// ~6.8 million characters at 10,000 rows).
function bigPayload(rowCount = 10000) {
  return {
    title: 'گزارش بزرگ',
    columns: [
      { title: 'کد', key: 'code' },
      { title: 'نام', key: 'name' },
      { title: 'یادداشت', key: 'notes' }
    ],
    rows: Array.from({ length: rowCount }, (_, i) => ({
      code: `AST-${String(i).padStart(6, '0')}`,
      name: `دارایی شماره ${i}`,
      notes: 'یک یادداشت نسبتاً طولانی برای شبیه‌سازی داده واقعی در ردیف ' + i
    }))
  }
}

beforeEach(() => {
  ctx = createTestDb()
  loadFileCalls = []
  loadURLCalls = []
  destroyed = false
  closedCallback = null
  navigationHandlers = { openHandler: null, willNavigate: null }
})

afterEach(() => {
  cleanupTestDb(ctx)
})

describe('exportService.exportToPdf — large report (production bug fix)', () => {
  it('a 10,000-row report no longer throws — the old code path is gone entirely', async () => {
    const user = seedUser()
    // Would have thrown ERR_INVALID_URL before the fix (in real Electron;
    // here the mock would have received a many-megabyte string).
    await expect(exportService.exportToPdf(bigPayload(10000), null, user)).resolves.toEqual(
      expect.objectContaining({ canceled: true })
    )
  })

  it('uses loadFile with a real temp-directory path — never loadURL/data: for the PDF HTML', async () => {
    const user = seedUser()
    await exportService.exportToPdf(bigPayload(10000), null, user)

    expect(loadURLCalls).toHaveLength(0)
    expect(loadFileCalls).toHaveLength(1)
    expect(loadFileCalls[0]).not.toMatch(/^data:/)
    expect(path.isAbsolute(loadFileCalls[0])).toBe(true)
    // Under the OS temp directory, not the app's install/resources dir.
    expect(loadFileCalls[0].startsWith(os.tmpdir())).toBe(true)
  })

  it('the temp file actually exists at loadFile-time and contains the real generated HTML', async () => {
    const user = seedUser()
    let contentAtLoadTime = null
    // Re-mock loadFile for this one test to peek at the file while it's
    // still guaranteed to exist (see the cleanup-race comment on the
    // other export test file for why this has to happen synchronously
    // inside the call, not after exportToPdf resolves).
    const { BrowserWindow } = await import('electron')
    const originalLoadFile = BrowserWindow.prototype.loadFile
    BrowserWindow.prototype.loadFile = async function (filePath) {
      contentAtLoadTime = fs.readFileSync(filePath, 'utf-8')
      return originalLoadFile.call(this, filePath)
    }
    try {
      await exportService.exportToPdf(bigPayload(50), null, user)
    } finally {
      BrowserWindow.prototype.loadFile = originalLoadFile
    }

    expect(contentAtLoadTime).toBeTruthy()
    expect(contentAtLoadTime).toContain('دارایی شماره 0')
    expect(contentAtLoadTime).toContain('گزارش بزرگ')
  })

  it('gives each export a unique temp filename — no collision risk for concurrent exports', async () => {
    const user = seedUser()
    await exportService.exportToPdf(bigPayload(10), null, user)
    const first = loadFileCalls[0]
    await exportService.exportToPdf(bigPayload(10), null, user)
    const second = loadFileCalls[1]
    expect(first).not.toBe(second)
  })

  it('cleans up the temp file after a successful export', async () => {
    const user = seedUser()
    await exportService.exportToPdf(bigPayload(100), null, user)
    const tempPath = loadFileCalls[0]
    // The real cleanup is fire-and-forget fs.unlink; give the event loop
    // a tick to let it actually complete before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fs.existsSync(tempPath)).toBe(false)
  })

  it('still cleans up the temp file when printToPDF itself fails', async () => {
    const user = seedUser()
    const { BrowserWindow } = await import('electron')
    const originalDescriptor = Object.getOwnPropertyDescriptor(BrowserWindow.prototype, 'webContents')
    Object.defineProperty(BrowserWindow.prototype, 'webContents', {
      configurable: true,
      get() {
        return {
          printToPDF: async () => {
            throw new Error('simulated printToPDF failure')
          },
          setWindowOpenHandler: () => {},
          on: () => {}
        }
      }
    })
    try {
      await expect(exportService.exportToPdf(bigPayload(100), null, user)).rejects.toThrow(
        'simulated printToPDF failure'
      )
    } finally {
      Object.defineProperty(BrowserWindow.prototype, 'webContents', originalDescriptor)
    }

    const tempPath = loadFileCalls[0]
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fs.existsSync(tempPath)).toBe(false)
    expect(destroyed).toBe(true) // window is still destroyed even on failure
  })

  it('registers deny-by-default navigation guards on the export window, same as the main window', async () => {
    const user = seedUser()
    await exportService.exportToPdf(bigPayload(10), null, user)

    expect(navigationHandlers.openHandler).toBeTruthy()
    expect(navigationHandlers.openHandler()).toEqual({ action: 'deny' })

    expect(navigationHandlers.willNavigate).toBeTruthy()
    const fakeEvent = { preventDefault: vi.fn() }
    navigationHandlers.willNavigate(fakeEvent, 'https://example.com')
    expect(fakeEvent.preventDefault).toHaveBeenCalled()
  })

  it('a small report still works exactly as before — no regression for the common case', async () => {
    const user = seedUser()
    const result = await exportService.exportToPdf(
      { title: 'گزارش کوچک', columns: [{ title: 'کد', key: 'code' }], rows: [{ code: 'A-1' }] },
      null,
      user
    )
    expect(result.canceled).toBe(true) // save dialog mocked to cancel — the PDF buffer step itself succeeded without throwing
    expect(loadFileCalls).toHaveLength(1)
  })
})
