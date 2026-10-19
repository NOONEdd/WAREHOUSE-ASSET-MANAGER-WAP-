// Regression coverage added alongside the "remove the in-app company
// banner" phase. That change only touched AppShell.jsx (the renderer
// layout) — exportService.js reads resources/branding/sfz-banner.png
// directly off disk for PDF/Excel letterheads, entirely independent of
// the renderer component that got removed. These tests prove that
// independence empirically rather than by re-reading the source a
// second time: real export functions are run end-to-end and the actual
// output bytes are checked against the real file on disk, not just
// "the function didn't throw".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createTestDb, cleanupTestDb } from '../testHelpers/testDb'

let savedPath = null
let capturedHtml = null
let ctx

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
  dialog: {
    showSaveDialog: async () => {
      savedPath = path.join(os.tmpdir(), 'verify-export-test.xlsx')
      return { canceled: false, filePath: savedPath }
    }
  },
  BrowserWindow: class {
    constructor() {}
    once() {}
    async loadFile(filePath) {
      // Read now — the real code deletes this temp file asynchronously
      // (fire-and-forget fs.unlink) as soon as buildPdfBuffer's finally
      // block runs, so reading it any later than "immediately, inside
      // this call" would be a race against that cleanup.
      capturedHtml = fs.readFileSync(filePath, 'utf-8')
    }
    get webContents() {
      return {
        printToPDF: async () => Buffer.from('fake-pdf-bytes'),
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

// Reliability + Audit Completeness phase — exportToExcel/exportToPdf now
// call auditService.recordAudit, which needs a real getDatabase(). Mocked
// here the same way every other service test does it, rather than
// letting the unmocked real connection.js quietly open (and never clean
// up) a stray database file in the OS temp dir on every run of this
// otherwise-unrelated banner regression test.
vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

beforeEach(() => {
  ctx = createTestDb()
})

afterEach(() => {
  cleanupTestDb(ctx)
})

function seedUser() {
  const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
  const id = ctx.db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin', 'x', 'Admin', ?)")
    .run(roleId).lastInsertRowid
  return { id, username: 'admin' }
}

describe('export letterhead sanity check (post banner-removal)', () => {
  it('generates a real Excel file with the SFZ banner actually embedded as an image', async () => {
    const { exportService } = await import('../../../src/main/services/exportService.js')
    const user = seedUser()

    const result = await exportService.exportToExcel(
      {
        title: 'تست بنر',
        columns: [{ title: 'کد', key: 'code' }],
        rows: [{ code: 'A-1' }]
      },
      null,
      user
    )

    expect(result.success).toBe(true)
    expect(fs.existsSync(savedPath)).toBe(true)

    // Read the generated xlsx back and confirm it actually contains an
    // embedded image (the banner) — not just that the code path ran.
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(savedPath)
    const sheet = wb.worksheets[0]
    const images = sheet.getImages()
    expect(images.length).toBeGreaterThan(0)

    // Cross-check the embedded image bytes match the real source file on
    // disk (same asset the login page and the app icon both derive from).
    const bannerOnDisk = fs.readFileSync(path.join(process.cwd(), 'resources', 'branding', 'sfz-banner.png'))
    const mediaId = images[0].imageId
    const media = wb.model.media.find((m) => m.index === mediaId)
    expect(Buffer.compare(media.buffer, bannerOnDisk)).toBe(0)

    // Reliability + Audit Completeness phase — a successful export is
    // now recorded, with metadata only (no row data).
    const entry = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'EXPORT'").get()
    expect(entry).toBeDefined()
    expect(entry.entity_type).toBe('Export')
    expect(JSON.parse(entry.changes)).toEqual({ format: 'excel', title: 'تست بنر', rowCount: 1 })

    fs.unlinkSync(savedPath)
  })

  it('embeds the real banner bytes in the HTML that gets printed to PDF', async () => {
    const { exportService } = await import('../../../src/main/services/exportService.js')
    const user = seedUser()

    // Route the save dialog to a throwaway path for this call too.
    savedPath = path.join(os.tmpdir(), 'verify-export-test.pdf')

    await exportService.exportToPdf(
      {
        title: 'تست بنر PDF',
        columns: [{ title: 'کد', key: 'code' }],
        rows: [{ code: 'A-1' }]
      },
      null,
      user
    )

    expect(capturedHtml).toBeTruthy()

    const bannerOnDisk = fs.readFileSync(path.join(process.cwd(), 'resources', 'branding', 'sfz-banner.png'))
    const expectedBase64 = bannerOnDisk.toString('base64')

    expect(capturedHtml).toContain(expectedBase64)
    expect(capturedHtml.toLowerCase()).toContain('<img')

    const entry = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'EXPORT'").get()
    expect(entry).toBeDefined()
    expect(JSON.parse(entry.changes)).toEqual({ format: 'pdf', title: 'تست بنر PDF', rowCount: 1 })
  })
})
