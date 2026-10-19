import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as XLSX from 'xlsx'

// Phase 6 — Final QA. Unlike the rest of the suite (which mostly proves
// one mechanism at a time — one parser quirk, one classification rule),
// these tests each run a full real-world SESSION against the real
// pipeline end to end: parse -> preview -> commit -> query -> mutate ->
// re-import -> integrity check, at the scale (5,000+ assets) the app is
// actually built for. No mocking of importService/assetRepository/the
// database — only Electron's app.getPath is mocked, exactly like every
// other test in this suite, so a fresh on-disk SQLite database backs
// each test.

let userDataDir

vi.mock('electron', () => ({
  app: {
    getPath: (name) => {
      if (name === 'userData') return userDataDir
      throw new Error('unexpected app.getPath: ' + name)
    }
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))

const { importService } = await import('../../../src/main/services/importService.js')
const { assetRepository } = await import('../../../src/main/repositories/assetRepository.js')
const { closeDatabase, getDatabase } = await import('../../../src/main/database/connection.js')

let currentUser
let tmpDir

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-qa-test-'))
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-qa-files-'))
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
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- fixtures --

// The four fixed system statuses (strictLookup enum — see
// assetImportSchema.js) and a handful of open lookup values, reused
// across rows the way a real warehouse actually would be (a handful of
// workshops/countries/item types, not a different one per asset).
const STATUSES = ['در انبار', 'صادر شده', 'مرجوع شده', 'آسیب‌دیده']
const ITEM_TYPES = ['تجهیزات رایانه', 'تجهیزات جوشکاری', 'تجهیزات اداری', 'ابزار برقی', 'تجهیزات ایمنی']
const WORKSHOPS = ['واحد تولید', 'واحد کنترل کیفیت', 'انبار مرکزی', 'واحد نگهداری و تعمیرات', 'واحد مونتاژ']
const COUNTRIES = ['آلمان', 'چین', 'ژاپن', 'ایران', 'ایتالیا']
const NAMES = ['محمدرضا حسینی‌نژاد', 'علی‌اکبر رستمی', 'فاطمه احمدی‌راد', 'سید محمد طباطبایی', 'زهرا کریمی']

const FULL_HEADER = [
  'کد اموال',
  'نام دارایی',
  'نوع کالا',
  'مدل',
  'شماره سریال',
  'کشور سازنده',
  'واحد',
  'تاریخ ورود به انبار',
  'تحویل‌دهنده',
  'تحویل‌گیرنده',
  'وضعیت',
  'توضیحات'
]

function jalaliDateFor(i) {
  const month = String((i % 12) + 1).padStart(2, '0')
  const day = String((i % 27) + 1).padStart(2, '0')
  return `1402/${month}/${day}`
}

function buildRow(i, { prefix = 'BULK' } = {}) {
  return [
    `${prefix}-${i}`,
    `دارایی شماره ${i}`,
    ITEM_TYPES[i % ITEM_TYPES.length],
    `MDL-${i % 50}`,
    `SN-${prefix}-${i}`,
    COUNTRIES[i % COUNTRIES.length],
    WORKSHOPS[i % WORKSHOPS.length],
    jalaliDateFor(i),
    NAMES[i % NAMES.length],
    NAMES[(i + 1) % NAMES.length],
    STATUSES[i % STATUSES.length],
    i % 200 === 0 ? 'بازرسی سالانه انجام شد' : ''
  ]
}

function writeCsv(filename, count, opts) {
  const lines = [FULL_HEADER.join(',')]
  for (let i = 0; i < count; i++) lines.push(buildRow(i, opts).join(','))
  const filePath = path.join(tmpDir, filename)
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8')
  return filePath
}

function writeExcel(filename, count, opts) {
  const aoa = [FULL_HEADER]
  for (let i = 0; i < count; i++) aoa.push(buildRow(i, opts))
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  const filePath = path.join(tmpDir, filename)
  XLSX.writeFile(wb, filePath)
  return filePath
}

async function importFile(filePath, fileType, duplicatePolicy = 'skip', sheetName = 'Sheet1') {
  const parsed = await importService.parseFile(filePath, { fileType, sheetName })
  expect(parsed.success, parsed.error).toBe(true)
  const result = importService.commitImport(
    { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy },
    currentUser
  )
  return { parsed, result }
}

function checkDbIntegrity() {
  const db = getDatabase()
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all()
  expect(fkViolations, JSON.stringify(fkViolations)).toEqual([])
  const integrity = db.prepare('PRAGMA integrity_check').get()
  expect(integrity.integrity_check).toBe('ok')
}

// ------------------------------------------------------------------ tests --

describe('Phase 6 — CSV: 5,000-asset lifecycle (import, paginate, delete, reimport, integrity)', () => {
  it('handles the full real-world scenario correctly at scale', async () => {
    const TOTAL = 5000
    const filePath = writeCsv('bulk-5000.csv', TOTAL)

    // --- 1. Import 5,000 rows in one commit -------------------------------
    const t0 = Date.now()
    const { result } = await importFile(filePath, 'csv')
    const importMs = Date.now() - t0

    expect(result.success).toBe(true)
    expect(result.summary.total).toBe(TOTAL)
    expect(result.summary.imported).toBe(TOTAL)
    expect(result.summary.errors).toBe(0)
    // Generous ceiling, not a tight perf benchmark — this just guards
    // against a real regression (e.g. an accidental N+1 query) making a
    // 5,000-row import pathologically slow.
    expect(importMs).toBeLessThan(20000)

    const db = getDatabase()
    expect(db.prepare('SELECT COUNT(*) n FROM assets WHERE is_deleted = 0').get().n).toBe(TOTAL)
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'IMPORT'").get().n).toBe(TOTAL)
    expect(db.prepare('SELECT COUNT(*) n FROM asset_transactions').get().n).toBe(TOTAL)

    // Spot-check Persian data landed correctly, not just that counts match.
    const sample = db
      .prepare(
        `SELECT a.asset_code, a.asset_name, it.name AS item_type, c.name AS country,
                w.name AS workshop, st.name AS status, a.delivered_by, a.received_by,
                a.warehouse_entry_date
         FROM assets a
         JOIN item_types it ON it.id = a.item_type_id
         JOIN countries c ON c.id = a.country_id
         JOIN workshops w ON w.id = a.workshop_id
         JOIN asset_statuses st ON st.id = a.status_id
         WHERE a.asset_code = 'BULK-2500'`
      )
      .get()
    expect(sample).toMatchObject({
      asset_name: 'دارایی شماره 2500',
      item_type: ITEM_TYPES[2500 % ITEM_TYPES.length],
      country: COUNTRIES[2500 % COUNTRIES.length],
      workshop: WORKSHOPS[2500 % WORKSHOPS.length],
      status: STATUSES[2500 % STATUSES.length],
      delivered_by: NAMES[2500 % NAMES.length],
      received_by: NAMES[2501 % NAMES.length]
    })
    expect(sample.warehouse_entry_date).toBe('2023-08-08') // 1402/05/17 -> Gregorian, verifies real Jalali conversion at scale

    // Only 5 distinct item/workshop/country values should ever have been
    // created despite 5,000 rows referencing them — proves the lookup
    // index is genuinely reused, not re-queried/re-created per row.
    expect(db.prepare('SELECT COUNT(*) n FROM item_types').get().n).toBe(ITEM_TYPES.length)
    expect(db.prepare('SELECT COUNT(*) n FROM workshops').get().n).toBe(WORKSHOPS.length)
    expect(db.prepare('SELECT COUNT(*) n FROM countries').get().n).toBe(COUNTRIES.length)

    // --- 2. Pagination: walk every page twice, expect identical, --------
    //        gap-free, duplicate-free coverage of all 5,000 rows ---------
    const PAGE_SIZE = 50
    function fullWalk() {
      const ids = []
      for (let offset = 0; offset < TOTAL; offset += PAGE_SIZE) {
        const { rows, total } = assetRepository.list({ limit: PAGE_SIZE, offset })
        expect(total).toBe(TOTAL)
        expect(rows).toHaveLength(PAGE_SIZE)
        ids.push(...rows.map((r) => r.id))
      }
      return ids
    }
    const walk1 = fullWalk()
    const walk2 = fullWalk()
    expect(walk1).toEqual(walk2) // deterministic order across repeated queries
    expect(new Set(walk1).size).toBe(TOTAL) // every row exactly once, none skipped

    // One page past the end should come back empty, not error or wrap around.
    const overrun = assetRepository.list({ limit: PAGE_SIZE, offset: TOTAL })
    expect(overrun.rows).toEqual([])
    expect(overrun.total).toBe(TOTAL)

    // --- 3. Delete a chunk, then re-import the same file -----------------
    const CHUNK = 250
    const toDelete = db.prepare('SELECT id FROM assets ORDER BY id LIMIT ?').all(CHUNK)
    for (const { id } of toDelete) assetRepository.softDelete(id, currentUser.id)
    expect(db.prepare('SELECT COUNT(*) n FROM assets WHERE is_deleted = 0').get().n).toBe(TOTAL - CHUNK)

    const { result: reimportResult } = await importFile(filePath, 'csv', 'skip')
    expect(reimportResult.success).toBe(true)
    // The 250 soft-deleted rows are re-created (their code/serial freed up
    // by the partial unique index); the remaining 4,750 still-active rows
    // are correctly recognized as duplicates and skipped, not double-added.
    expect(reimportResult.summary.imported).toBe(CHUNK)
    expect(reimportResult.summary.skipped).toBe(TOTAL - CHUNK)
    expect(reimportResult.summary.duplicates).toBe(TOTAL - CHUNK)

    expect(db.prepare('SELECT COUNT(*) n FROM assets WHERE is_deleted = 0').get().n).toBe(TOTAL)
    // Physical row count includes the 250 original soft-deleted rows PLUS
    // their 250 freshly re-created replacements.
    expect(db.prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(TOTAL + CHUNK)
    // No duplicate active asset_code/serial_number anywhere.
    const dupeCodes = db
      .prepare('SELECT asset_code FROM assets WHERE is_deleted = 0 GROUP BY asset_code HAVING COUNT(*) > 1')
      .all()
    expect(dupeCodes).toEqual([])

    // --- 4. Database integrity after everything above --------------------
    checkDbIntegrity()
  })
})

describe('Phase 6 — Excel: 3,000-asset import matches the CSV path\u2019s guarantees', () => {
  it('imports correctly, survives delete + reimport, and passes integrity checks', async () => {
    const TOTAL = 3000
    const filePath = writeExcel('bulk-3000.xlsx', TOTAL, { prefix: 'XL' })

    const { result } = await importFile(filePath, 'xlsx')
    expect(result.success).toBe(true)
    expect(result.summary.imported).toBe(TOTAL)
    expect(result.summary.errors).toBe(0)

    const db = getDatabase()
    expect(db.prepare('SELECT COUNT(*) n FROM assets WHERE is_deleted = 0').get().n).toBe(TOTAL)

    const sample = db.prepare('SELECT asset_name FROM assets WHERE asset_code = ?').get('XL-1500')
    expect(sample.asset_name).toBe('دارایی شماره 1500')

    // Delete + reimport, same as the CSV scenario, at a smaller chunk.
    const toDelete = db.prepare('SELECT id FROM assets ORDER BY id LIMIT 100').all()
    for (const { id } of toDelete) assetRepository.softDelete(id, currentUser.id)
    const { result: reimportResult } = await importFile(filePath, 'xlsx', 'skip')
    expect(reimportResult.summary.imported).toBe(100)
    expect(reimportResult.summary.skipped).toBe(TOTAL - 100)
    expect(db.prepare('SELECT COUNT(*) n FROM assets WHERE is_deleted = 0').get().n).toBe(TOTAL)

    checkDbIntegrity()
  })
})

describe('Phase 6 — cross-format consistency: CSV and Excel commit identical field values for the same logical data', () => {
  it('produces byte-identical stored rows regardless of source format', async () => {
    const COUNT = 20 // small, deliberately covers all 4 statuses at least 5x each
    const csvPath = writeCsv('shared.csv', COUNT, { prefix: 'CF' })
    const xlsxPath = writeExcel('shared.xlsx', COUNT, { prefix: 'CF2' })

    await importFile(csvPath, 'csv')
    await importFile(xlsxPath, 'xlsx')

    const db = getDatabase()
    const cols = `a.asset_name, a.model, it.name AS item_type, c.name AS country, w.name AS workshop,
                  st.name AS status, a.delivered_by, a.received_by, a.warehouse_entry_date`
    const fromCsv = db
      .prepare(
        `SELECT ${cols} FROM assets a
         JOIN item_types it ON it.id=a.item_type_id JOIN countries c ON c.id=a.country_id
         JOIN workshops w ON w.id=a.workshop_id JOIN asset_statuses st ON st.id=a.status_id
         WHERE a.asset_code LIKE 'CF-%' ORDER BY a.asset_code`
      )
      .all()
    const fromXlsx = db
      .prepare(
        `SELECT ${cols} FROM assets a
         JOIN item_types it ON it.id=a.item_type_id JOIN countries c ON c.id=a.country_id
         JOIN workshops w ON w.id=a.workshop_id JOIN asset_statuses st ON st.id=a.status_id
         WHERE a.asset_code LIKE 'CF2-%' ORDER BY a.asset_code`
      )
      .all()

    expect(fromCsv).toHaveLength(COUNT)
    expect(fromXlsx).toHaveLength(COUNT)
    // Same generator, same index i -> every field except the code/serial
    // prefix itself must match exactly, proving CSV and Excel parsing +
    // classification + commit produce identical results for identical
    // logical input (including ZWNJ in NAMES, e.g. "حسینی‌نژاد").
    expect(fromCsv).toEqual(fromXlsx)
  })
})

describe('Phase 6 — PDF: multi-row Persian import (all four statuses, ZWNJ text) commits correctly', () => {
  // PDF imports are, in practice, printed/scanned reports rather than the
  // primary vehicle for 5,000-row bulk data entry (that's Excel/CSV,
  // already covered above at full scale) — pdfParser.test.js and
  // importCanonicalSchema.test.js already cover PDF-specific concerns
  // (multi-page, column reordering, digit normalization, ZWNJ-in-headers)
  // in detail. This test's job is just to confirm the same end-to-end
  // commit guarantees hold for PDF at a real multi-row scale, not one row.
  it('imports 18 rows spanning all four statuses and commits them correctly', async () => {
    const PDFDocument = (await import('pdfkit')).default
    const FONT_PATH = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      'parsers',
      'fixtures',
      'Vazirmatn-Regular.ttf'
    )
    const RTL = { features: ['rtla'] }
    const ROWS = 18
    const filePath = path.join(tmpDir, 'qa-pdf-multirow.pdf')

    const doc = new PDFDocument({ size: 'A4', margin: 30, layout: 'landscape' })
    doc.font(FONT_PATH).fontSize(9)
    const cols = [30, 110, 260, 380, 500, 610, 720]
    const header = ['کد اموال', 'نام دارایی', 'نوع اموال', 'شماره سریال', 'واحد', 'کشور سازنده', 'وضعیت']
    header.forEach((cell, c) => doc.text(cell, cols[c], 30, RTL))
    for (let i = 0; i < ROWS; i++) {
      const y = 50 + i * 18
      const row = [
        `PDFQA-${i}`,
        `دارایی پی‌دی‌اف ${i}`,
        ITEM_TYPES[i % ITEM_TYPES.length],
        `SN-PDFQA-${i}`,
        WORKSHOPS[i % WORKSHOPS.length],
        COUNTRIES[i % COUNTRIES.length],
        STATUSES[i % STATUSES.length]
      ]
      row.forEach((cell, c) => doc.text(cell, cols[c], y, RTL))
    }
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(filePath)
      doc.pipe(stream)
      stream.on('finish', resolve)
      stream.on('error', reject)
      doc.end()
    })

    const { result } = await importFile(filePath, 'pdf')
    expect(result.success).toBe(true)
    expect(result.summary.imported).toBe(ROWS)
    expect(result.summary.errors).toBe(0)

    const db = getDatabase()
    // Every one of the four fixed statuses actually landed as itself, not
    // rejected or coerced — the real risk for PDF specifically (ZWNJ
    // dropped from "آسیب‌دیده" during text extraction; see
    // pdfParser.test.js for the targeted regression).
    for (const status of STATUSES) {
      const n = db
        .prepare('SELECT COUNT(*) n FROM assets a JOIN asset_statuses st ON st.id=a.status_id WHERE st.name = ?')
        .get(status).n
      expect(n, `expected at least one row with status "${status}"`).toBeGreaterThan(0)
    }
    expect(db.prepare('SELECT COUNT(*) n FROM assets WHERE is_deleted = 0').get().n).toBe(ROWS)
    checkDbIntegrity()
  })
})
