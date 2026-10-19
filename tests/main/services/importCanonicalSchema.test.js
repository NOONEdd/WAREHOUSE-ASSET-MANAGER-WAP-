import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Regression set for the import system's redesign around one canonical
// Asset schema (assetImportSchema.js). Per the task this was built for:
// build the fixtures BEFORE changing the parser, and don't proceed based
// on one PDF example only — these 5 are real Chromium-generated PDFs
// (same pipeline as the app's own reports; see tests/main/parsers/
// fixtures/ for how they were produced), each isolating one specific
// requirement rather than one big fixture testing everything at once:
//
//   import-schema-baseline.pdf               — all 13 fields, canonical
//                                                Persian headers, standard
//                                                order
//   import-schema-reordered-extra-columns.pdf — same 13 fields shuffled,
//                                                plus 2 columns with no
//                                                alias at all
//   import-schema-english-headers.pdf         — English headers, Persian
//                                                data, ltr page direction
//   import-schema-persian-digits.pdf          — Persian/Eastern-Arabic
//                                                digits in codes, serials,
//                                                and dates
//   import-schema-multipage.pdf               — 40 rows, spans 2 PDF
//                                                pages, second page has NO
//                                                repeated header row
//
// Every canonical field this schema defines (assetCode, assetName,
// assetType, model, serialNumber, country, workshop, warehouseEntryDate,
// warehouseExitDate, deliveredBy, receivedBy, status, description) is
// exercised by at least the baseline fixture; the other four each add one
// axis of real-world variation on top.

const FIXTURES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'parsers', 'fixtures')
const ALL_13_CANONICAL_KEYS = [
  'assetCode', 'assetName', 'assetType', 'model', 'serialNumber', 'country', 'workshop',
  'warehouseEntryDate', 'warehouseExitDate', 'deliveredBy', 'receivedBy', 'status', 'description'
].sort()

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
const { closeDatabase, getDatabase } = await import('../../../src/main/database/connection.js')
const { ASSET_IMPORT_SCHEMA, CANONICAL_FIELD_KEYS, REQUIRED_FIELD_KEYS } = await import(
  '../../../src/main/utils/assetImportSchema.js'
)

let currentUser

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-import-schema-test-'))
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

describe('assetImportSchema — the one canonical schema', () => {
  it('defines exactly the 13 specified fields, in order', () => {
    expect(CANONICAL_FIELD_KEYS).toEqual([
      'assetCode', 'assetName', 'assetType', 'model', 'serialNumber', 'country', 'workshop',
      'warehouseEntryDate', 'warehouseExitDate', 'deliveredBy', 'receivedBy', 'status', 'description'
    ])
  })

  it('marks exactly assetCode, assetName, assetType, serialNumber, and status as required', () => {
    expect(REQUIRED_FIELD_KEYS.sort()).toEqual(
      ['assetCode', 'assetName', 'assetType', 'serialNumber', 'status'].sort()
    )
  })

  it('gives every field a non-empty Persian label and at least one alias', () => {
    for (const f of ASSET_IMPORT_SCHEMA) {
      expect(f.label, `${f.key} has a label`).toBeTruthy()
      expect(f.aliases?.length, `${f.key} has aliases`).toBeGreaterThan(0)
    }
  })
})

describe('PDF regression set — reordered columns, extra columns, English headers, Persian digits, multi-page', () => {
  it('baseline: all 13 canonical fields auto-map from standard-order Persian headers', async () => {
    const parsed = await importService.parseFile(path.join(FIXTURES_DIR, 'import-schema-baseline.pdf'), { fileType: 'pdf' })
    expect(parsed.success).toBe(true)
    expect(parsed.unmapped).toEqual([])
    expect(parsed.missingRequiredFields).toEqual([])
    expect(Object.values(parsed.mapping).sort()).toEqual(ALL_13_CANONICAL_KEYS)
    expect(parsed.rows).toHaveLength(4)
    // fieldSchema travels with parseFile's response so the renderer never
    // hardcodes its own copy — confirm it's actually there and complete.
    expect(parsed.fieldSchema.map((f) => f.key).sort()).toEqual(ALL_13_CANONICAL_KEYS)
  })

  it('reordered + extra columns: mapping is unaffected by column order, and unrecognized columns are left unmapped rather than guessed at', async () => {
    const parsed = await importService.parseFile(
      path.join(FIXTURES_DIR, 'import-schema-reordered-extra-columns.pdf'),
      { fileType: 'pdf' }
    )
    expect(parsed.success).toBe(true)
    // The file has 15 columns: the 13 canonical ones (shuffled) plus
    // 'بارکد' (barcode) and 'شماره انبار' (warehouse slot number), neither
    // of which has any alias anywhere in the schema.
    expect(parsed.unmapped.sort()).toEqual(['بارکد', 'شماره انبار'].sort())
    expect(parsed.missingRequiredFields).toEqual([])
    expect(Object.values(parsed.mapping).sort()).toEqual(ALL_13_CANONICAL_KEYS)
    expect(parsed.rows).toHaveLength(3)

    // Spot-check the actual data landed on the right field despite the
    // shuffle — not just that 13 keys exist, but that e.g. assetCode
    // really is "AST-3001" and not something that merely looks mapped.
    const preview = importService.buildPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: parsed.mapping
    })
    expect(preview.results[0].fields.assetCode).toBe('AST-3001')
    expect(preview.results[0].fields.status).toBe('در انبار')
    expect(preview.results[0].fields.deliveredBy).toBe('حسینی')
    expect(preview.results[0].fields.receivedBy).toBe('کریمی')
  })

  it('English headers: all 13 fields map via their English aliases, Persian data values pass through unchanged', async () => {
    const parsed = await importService.parseFile(path.join(FIXTURES_DIR, 'import-schema-english-headers.pdf'), { fileType: 'pdf' })
    expect(parsed.success).toBe(true)
    expect(parsed.unmapped).toEqual([])
    expect(parsed.missingRequiredFields).toEqual([])
    expect(Object.values(parsed.mapping).sort()).toEqual(ALL_13_CANONICAL_KEYS)
    expect(parsed.mapping[parsed.headers.indexOf('Asset Code')]).toBe('assetCode')
    expect(parsed.mapping[parsed.headers.indexOf('Asset Type')]).toBe('assetType')
    expect(parsed.mapping[parsed.headers.indexOf('Delivered By')]).toBe('deliveredBy')
    expect(parsed.mapping[parsed.headers.indexOf('Received By')]).toBe('receivedBy')

    const preview = importService.buildPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: parsed.mapping
    })
    expect(preview.results[0].fields.assetName).toBe('یخچال آزمایشگاهی')
    expect(preview.results[0].fields.country).toBe('ژاپن')
  })

  it('Persian/Eastern-Arabic digits in the source file normalize to Western digits by preview time', async () => {
    const parsed = await importService.parseFile(path.join(FIXTURES_DIR, 'import-schema-persian-digits.pdf'), { fileType: 'pdf' })
    expect(parsed.success).toBe(true)
    expect(parsed.unmapped).toEqual([])
    expect(Object.values(parsed.mapping).sort()).toEqual(ALL_13_CANONICAL_KEYS)

    const preview = importService.buildPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: parsed.mapping
    })
    const first = preview.results[0].fields
    // Source file has "AST-۵۰۰۱", "SN-۹۹۱۲۳", "۱۴۰۱/۰۲/۱۰" — every digit
    // Persian. normalizeDigits (shapeRow, called from buildPreview) must
    // have converted every one of these to Western digits.
    expect(first.assetCode).toBe('AST-5001')
    expect(first.serialNumber).toBe('SN-99123')
    expect(first.warehouseEntryDate).toBe('1401/02/10')
    expect(/[۰-۹]/.test(first.assetCode + first.serialNumber + first.warehouseEntryDate)).toBe(false)
    // And the normalized date actually parses — proves this isn't just a
    // character-substitution that happens to look right.
    expect(preview.results[0].resolved.entryDateIso).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('multi-page: all 40 rows come through exactly once, including the second page which has no repeated header row', async () => {
    const parsed = await importService.parseFile(path.join(FIXTURES_DIR, 'import-schema-multipage.pdf'), { fileType: 'pdf' })
    expect(parsed.success).toBe(true)
    expect(parsed.unmapped).toEqual([])
    expect(parsed.missingRequiredFields).toEqual([])
    expect(parsed.rows).toHaveLength(40)

    const preview = importService.buildPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: parsed.mapping
    })
    expect(preview.results).toHaveLength(40)
    // AST-6002, 6008, ... use "تعمیر" and AST-6004, 6010, ... use "مفقود"
    // in this real fixture — both were official statuses at the time
    // this PDF was generated, both since dropped from the system-status
    // set in the Manual Status Management phase (see lookupService.js's
    // SYSTEM_STATUS_NAMES comment). strictLookup now correctly rejects
    // exactly those 14 rows; every other row is unaffected.
    const errorIndices = preview.results.reduce((acc, r, i) => (r.severity === 'error' ? [...acc, i] : acc), [])
    expect(errorIndices).toEqual([1, 3, 7, 9, 13, 15, 19, 21, 25, 27, 31, 33, 37, 39])
    expect(
      preview.results
        .filter((r) => r.severity === 'error')
        .every((r) => r.messages.join(' ').includes('تعمیر') || r.messages.join(' ').includes('مفقود'))
    ).toBe(true)

    const codes = preview.results.map((r) => r.fields.assetCode)
    const expectedCodes = Array.from({ length: 40 }, (_, i) => `AST-${6001 + i}`)
    // Order AND completeness — page 2 (rows 28-40, no repeated header)
    // must continue the sequence with nothing dropped, duplicated, or
    // reordered across the page boundary.
    expect(codes).toEqual(expectedCodes)
  })

  it('end-to-end: the baseline fixture commits all 13 fields correctly into the database', async () => {
    const parsed = await importService.parseFile(path.join(FIXTURES_DIR, 'import-schema-baseline.pdf'), { fileType: 'pdf' })
    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'skip' },
      currentUser
    )
    expect(result.success).toBe(true)
    // AST-3004 uses "تعمیر" in this real fixture — one of the six official
    // statuses at the time this PDF was generated, dropped from the
    // canonical set in the Status Cleanup / clean-database phase. Only
    // the other 3 rows (still-valid statuses) actually commit.
    expect(result.summary.imported).toBe(3)
    expect(result.summary.errors).toBe(1)
    expect(
      getDatabase().prepare("SELECT * FROM assets WHERE asset_code = 'AST-3004'").get()
    ).toBeUndefined()

    const stored = getDatabase()
      .prepare(
        `SELECT a.asset_code, a.asset_name, it.name AS asset_type, a.model, a.serial_number,
                c.name AS country, w.name AS workshop,
                a.warehouse_entry_date, a.warehouse_exit_date,
                a.delivered_by, a.received_by, st.name AS status, a.notes AS description
         FROM assets a
         JOIN item_types it ON it.id = a.item_type_id
         LEFT JOIN countries c ON c.id = a.country_id
         LEFT JOIN workshops w ON w.id = a.workshop_id
         JOIN asset_statuses st ON st.id = a.status_id
         WHERE a.asset_code = 'AST-3001'`
      )
      .get()

    expect(stored).toMatchObject({
      asset_code: 'AST-3001',
      asset_name: 'دستگاه جوش اینورتر',
      asset_type: 'تجهیزات جوشکاری',
      model: 'IW-250',
      serial_number: 'SN-11023',
      country: 'آلمان',
      workshop: 'واحد تولید',
      delivered_by: 'حسینی',
      received_by: 'کریمی',
      status: 'در انبار',
      description: 'بازرسی سالانه انجام شد'
    })
    expect(stored.warehouse_entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(stored.warehouse_exit_date).toBe(null)
  })
})
