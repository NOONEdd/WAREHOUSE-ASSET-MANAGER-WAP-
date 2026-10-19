import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as XLSX from 'xlsx'

let userDataDir

vi.mock('electron', () => ({
  app: {
    getPath: (name) => {
      if (name === 'userData') return userDataDir
      throw new Error('unexpected app.getPath: ' + name)
    }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  }
}))

const { importService } = await import('../../../src/main/services/importService.js')
const { closeDatabase, getDatabase } = await import('../../../src/main/database/connection.js')
const { assetRepository } = await import('../../../src/main/repositories/assetRepository.js')
const { lookupService } = await import('../../../src/main/services/lookupService.js')

let currentUser
let csvDir

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-import-test-'))
  csvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-import-csv-'))

  // audit_log / asset_transactions both have FKs on users — recordAudit
  // and transactionRepository.insert fail without a real row.
  const db = getDatabase()
  const roleId = db.prepare('SELECT id FROM roles LIMIT 1').get().id
  const userId = db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
    .run(roleId).lastInsertRowid
  currentUser = { id: userId, username: 'admin' }

  db.prepare("INSERT INTO item_types (name) VALUES ('تجهیزات رایانه')").run()
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(userDataDir, { recursive: true, force: true })
  fs.rmSync(csvDir, { recursive: true, force: true })
})

function writeCsv(content) {
  const filePath = path.join(csvDir, `test-${Math.random().toString(36).slice(2)}.csv`)
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

const HEADER_ROW = 'کد اموال,نام دارایی,نوع کالا,شماره سریال,وضعیت,واحد,کشور سازنده,تاریخ ورود'

async function parseAndPreview(csvBody) {
  const filePath = writeCsv(`${HEADER_ROW}\n${csvBody}`)
  const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
  expect(parsed.success).toBe(true)
  const preview = importService.buildPreview({
    headers: parsed.headers,
    rows: parsed.rows,
    mapping: parsed.mapping
  })
  return { parsed, preview }
}

describe('importService.parseFile', () => {
  it('auto-maps every column via importFieldAliases and reports no missing required fields', async () => {
    const filePath = writeCsv(`${HEADER_ROW}\nA-001,لپ‌تاپ,تجهیزات رایانه,SN-1,در انبار,,,`)
    const result = await importService.parseFile(filePath, { fileType: 'csv' })
    expect(result.success).toBe(true)
    expect(result.mapping[result.headers.indexOf('کد اموال')]).toBe('assetCode')
    expect(result.mapping[result.headers.indexOf('شماره سریال')]).toBe('serialNumber')
    expect(result.missingRequiredFields).toEqual([])
    expect(result.totalRows).toBe(1)
  })

  it('reports missing required fields when a required column has no matching header', async () => {
    const filePath = writeCsv('نام دارایی,شماره سریال\nلپ‌تاپ,SN-1')
    const result = await importService.parseFile(filePath, { fileType: 'csv' })
    expect(result.success).toBe(true)
    expect(result.missingRequiredFields).toEqual(expect.arrayContaining(['assetCode', 'assetType', 'status']))
  })

  // Regression test for a real bug: mapping used to be keyed by header
  // TEXT, so two columns sharing the exact same header (a real, common
  // case — e.g. several columns all literally titled "Date") collided on
  // that shared string key. Manually mapping the second one to a field
  // silently destroyed whichever field the first one was already mapped
  // to, with no warning. Column index is always unique even when header
  // text isn't, so this must no longer happen.
  it('lets two columns with identical header text be mapped to two different fields without either one clobbering the other', async () => {
    const filePath = writeCsv(
      'کد اموال,نام دارایی,نوع کالا,شماره سریال,وضعیت,Date,Date\nA-001,لپ‌تاپ,تجهیزات رایانه,SN-1,در انبار,1401/01/01,1402/06/15'
    )
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
    expect(parsed.success).toBe(true)

    // Neither "Date" column auto-maps (bare "Date" has no alias), so the
    // person maps them by hand — exactly what ColumnMappingStep.jsx's
    // handleColumnChange does: write straight into mapping by index.
    const dateIndices = parsed.headers.reduce((acc, h, i) => (h === 'Date' ? [...acc, i] : acc), [])
    expect(dateIndices).toHaveLength(2)
    const manualMapping = {
      ...parsed.mapping,
      [dateIndices[0]]: 'warehouseEntryDate',
      [dateIndices[1]]: 'warehouseExitDate'
    }

    const preview = importService.buildPreview({ headers: parsed.headers, rows: parsed.rows, mapping: manualMapping })
    expect(preview.results[0].fields.warehouseEntryDate).toBe('1401/01/01')
    expect(preview.results[0].fields.warehouseExitDate).toBe('1402/06/15')
  })
})

describe('importService.buildPreview — classification', () => {
  it('classifies a fully valid row as valid', async () => {
    const { preview } = await parseAndPreview('A-001,لپ‌تاپ,تجهیزات رایانه,SN-1,در انبار,,,')
    expect(preview.summary).toEqual({ total: 1, valid: 1, warning: 0, duplicate: 0, error: 0 })
    expect(preview.results[0].severity).toBe('valid')
  })

  it('classifies a row with a missing required field as an error, without blocking other rows', async () => {
    const { preview } = await parseAndPreview(
      'A-001,,تجهیزات رایانه,SN-1,در انبار,,,\nA-002,مانیتور,تجهیزات رایانه,SN-2,در انبار,,,'
    )
    expect(preview.summary.error).toBe(1)
    expect(preview.summary.valid).toBe(1)
    expect(preview.results[0].severity).toBe('error')
    expect(preview.results[1].severity).toBe('valid')
  })

  it('classifies the second occurrence of a duplicate code WITHIN the file as an error', async () => {
    const { preview } = await parseAndPreview(
      'A-001,لپ‌تاپ,تجهیزات رایانه,SN-1,در انبار,,,\nA-001,مانیتور,تجهیزات رایانه,SN-2,در انبار,,,'
    )
    expect(preview.results[0].severity).toBe('valid')
    expect(preview.results[1].severity).toBe('error')
    expect(preview.results[1].messages[0]).toMatch(/ردیف 1/)
  })

  // Regression tests for Phase 4 (validate data types): unlike
  // assetType/country/workshop — genuinely open reference data an import
  // is meant to grow — status still rejects an unrecognized value as an
  // error rather than silently turning it into a new "status" row (see
  // assetImportSchema.js's `status` field comment) — even though, since
  // the Manual Status Management phase, an administrator genuinely CAN
  // add a new status through Settings → داده‌های پایه → وضعیت. The two
  // are not in tension: creating a status is a deliberate action on that
  // screen, never a side effect of an import file having a typo.
  it('rejects a status value that does not match any known status', async () => {
    const { preview } = await parseAndPreview('A-001,لپ‌تاپ,تجهیزات رایانه,SN-1,وضعیت نامعتبر,,,')
    expect(preview.results[0].severity).toBe('error')
    expect(preview.results[0].messages[0]).toMatch(/وضعیت نامعتبر/)
    expect(preview.results[0].messages[0]).toMatch(/در انبار/) // lists the valid options
    expect(getDatabase().prepare("SELECT * FROM asset_statuses WHERE name = 'وضعیت نامعتبر'").get()).toBeUndefined()
  })

  it('still accepts every one of the four system status values', async () => {
    const statuses = ['در انبار', 'صادر شده', 'مرجوع شده', 'آسیب‌دیده']
    for (const [i, status] of statuses.entries()) {
      const { preview } = await parseAndPreview(`A-${i},لپ‌تاپ,تجهیزات رایانه,SN-${i},${status},,,`)
      expect(preview.results[0].severity, `status "${status}" should classify as valid`).toBe('valid')
    }
  })

  it('accepts an administrator-created custom status once it exists, and rejects it again once deactivated', async () => {
    const user = { id: currentUser.id, username: currentUser.username }
    lookupService.createStatus('تعمیر', user)

    const accepted = await parseAndPreview('A-100,لپ‌تاپ,تجهیزات رایانه,SN-100,تعمیر,,,')
    expect(accepted.preview.results[0].severity).toBe('valid')

    const created = getDatabase().prepare("SELECT id FROM asset_statuses WHERE name = 'تعمیر'").get()
    lookupService.setStatusActive(created.id, false, user)

    const rejected = await parseAndPreview('A-101,لپ‌تاپ,تجهیزات رایانه,SN-101,تعمیر,,,')
    expect(rejected.preview.results[0].severity).toBe('error')
  })

  it('an unrecognized status still blocks commit, even with duplicatePolicy that would otherwise let the row through', async () => {
    const filePath = writeCsv(`${HEADER_ROW}\nA-001,لپ‌تاپ,تجهیزات رایانه,SN-1,وضعیت نامعتبر,,,`)
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'skip' },
      currentUser
    )
    expect(result.success).toBe(true)
    expect(result.summary.imported).toBe(0)
    expect(result.summary.errors).toBe(1)
    expect(getDatabase().prepare("SELECT COUNT(*) n FROM assets").get().n).toBe(0)
  })

  it('classifies a row matching an existing DB asset code as a duplicate', async () => {
    const db = getDatabase()
    const itemTypeId = db.prepare('SELECT id FROM item_types LIMIT 1').get().id
    const statusId = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    db.prepare(
      'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
    ).run('EXISTING-1', 'دارایی موجود', itemTypeId, 'SN-EXIST', statusId)

    const { preview } = await parseAndPreview('EXISTING-1,لپ‌تاپ,تجهیزات رایانه,SN-NEW,در انبار,,,')
    expect(preview.results[0].severity).toBe('duplicate')
    expect(preview.summary.duplicate).toBe(1)
  })

  it('matches a duplicate even when the file uses Persian digits and the DB uses Western digits', async () => {
    const db = getDatabase()
    const itemTypeId = db.prepare('SELECT id FROM item_types LIMIT 1').get().id
    const statusId = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    db.prepare(
      'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
    ).run('123', 'دارایی موجود', itemTypeId, 'SN-EXIST', statusId)

    const { preview } = await parseAndPreview('۱۲۳,لپ‌تاپ,تجهیزات رایانه,SN-NEW,در انبار,,,')
    expect(preview.results[0].severity).toBe('duplicate')
  })

  // Regression test for the duplicate-detection bug: a soft-deleted asset
  // stayed in the assets table (is_deleted = 1) but its code/serial
  // number kept blocking re-import forever, since the duplicate check
  // (assetRepository.findAllCodesAndSerials) didn't filter deleted rows
  // out. Required scenario #3 from the bug report: importing a file that
  // matches a real, currently-active asset must still be flagged.
  it('classifies a row matching an existing, ACTIVE asset as a duplicate (existing behavior, preserved)', async () => {
    const db = getDatabase()
    const itemTypeId = db.prepare('SELECT id FROM item_types LIMIT 1').get().id
    const statusId = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    db.prepare(
      'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
    ).run('ACTIVE-1', 'دارایی فعال', itemTypeId, 'SN-ACTIVE', statusId)

    const { preview } = await parseAndPreview('ACTIVE-1,لپ‌تاپ,تجهیزات رایانه,SN-NEW,در انبار,,,')
    expect(preview.results[0].severity).toBe('duplicate')
  })

  // Required scenario #1 from the bug report, at the classification level:
  // a soft-deleted asset must not be treated as still occupying its code
  // or serial number.
  it('does NOT classify a row matching a soft-deleted asset\'s code/serial as a duplicate', async () => {
    const db = getDatabase()
    const itemTypeId = db.prepare('SELECT id FROM item_types LIMIT 1').get().id
    const statusId = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    const deletedId = db
      .prepare(
        'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
      )
      .run('WAS-DELETED', 'دارایی حذف‌شده', itemTypeId, 'SN-WAS-DELETED', statusId).lastInsertRowid
    assetRepository.softDelete(deletedId, currentUser.id)

    const { preview } = await parseAndPreview('WAS-DELETED,لپ‌تاپ,تجهیزات رایانه,SN-WAS-DELETED,در انبار,,,')
    expect(preview.results[0].severity).toBe('valid')
    expect(preview.results[0].duplicateOf).toBe(null)
  })

  // Regression tests for a real bug (Phase 4 — never corrupt or partially
  // commit data): resolveLookupValue used to write a genuinely-new
  // assetType/country/workshop value to the database immediately during
  // classification — including during a plain PREVIEW, before the person
  // ever clicked "confirm import." Looking at a preview and then backing
  // out (or the whole import later getting canceled) left that new
  // lookup row behind permanently, with nothing in the app ever actually
  // using it. Preview must now only ever show what WOULD happen;
  // committing is the only thing that actually writes it.
  it('auto-creates an unrecognized workshop name only at commit time, never during preview', async () => {
    const { parsed, preview } = await parseAndPreview('A-001,لپ‌تاپ,تجهیزات رایانه,SN-1,در انبار,برق,,')
    expect(preview.results[0].severity).toBe('warning')
    expect(preview.results[0].messages[0]).toMatch(/برق/)

    // The preview warned about it, but nothing was written yet.
    expect(getDatabase().prepare("SELECT * FROM workshops WHERE name = 'برق'").get()).toBeUndefined()

    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'skip' },
      currentUser
    )
    expect(result.success).toBe(true)
    expect(getDatabase().prepare("SELECT * FROM workshops WHERE name = 'برق'").get()).toBeTruthy()
  })

  it('reuses an auto-created lookup value across multiple rows in the same file instead of creating it twice', async () => {
    const { parsed, preview } = await parseAndPreview(
      'A-001,لپ‌تاپ,تجهیزات رایانه,SN-1,در انبار,برق,,\nA-002,مانیتور,تجهیزات رایانه,SN-2,در انبار,برق,,'
    )
    // Only the row that first encounters "برق" triggers (and is warned
    // about) the creation; by the time the second row is processed in the
    // same pass, it already exists in this call's in-memory index — that
    // row is plain 'valid'.
    expect(preview.results[0].severity).toBe('warning')
    expect(preview.results[1].severity).toBe('valid')

    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'skip' },
      currentUser
    )
    expect(result.success).toBe(true)
    // The meaningful assertion: only ONE workshop row ever gets created,
    // not one per row that referenced it.
    const workshops = getDatabase().prepare("SELECT * FROM workshops WHERE name = 'برق'").all()
    expect(workshops).toHaveLength(1)
  })

  // Regression test, the OTHER half of "never corrupt or partially
  // commit data": a canceled import (duplicatePolicy: 'cancel') must
  // roll back ANY new lookup values classification created while
  // resolving the file's rows — not just skip inserting the assets.
  it('a canceled import (duplicatePolicy "cancel") leaves no new lookup rows behind either', async () => {
    const db = getDatabase()
    const itemTypeId = db.prepare('SELECT id FROM item_types LIMIT 1').get().id
    const statusId = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    db.prepare(
      'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
    ).run('EXISTING-1', 'نام قدیمی', itemTypeId, 'SN-EXIST', statusId)

    const filePath = writeCsv(
      `${HEADER_ROW}\nEXISTING-1,نام جدید,تجهیزات رایانه,SN-NEW,در انبار,یک واحد کاملاً جدید,,`
    )
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'cancel' },
      currentUser
    )

    expect(result.success).toBe(false)
    expect(result.canceled).toBe(true)
    expect(db.prepare("SELECT * FROM workshops WHERE name = 'یک واحد کاملاً جدید'").get()).toBeUndefined()
  })

  it('flags an unparseable date as a warning rather than an error', async () => {
    const { preview } = await parseAndPreview('A-001,لپ‌تاپ,تجهیزات رایانه,SN-1,در انبار,,,not-a-date')
    expect(preview.results[0].severity).toBe('warning')
    expect(preview.results[0].resolved.entryDateIso).toBe(null)
  })

  it('converts a Jalali entry date to the stored Gregorian ISO form', async () => {
    const { preview } = await parseAndPreview('A-001,لپ‌تاپ,تجهیزات رایانه,SN-1,در انبار,,,1403/05/12')
    expect(preview.results[0].resolved.entryDateIso).toBe('2024-08-02')
    expect(preview.results[0].severity).toBe('valid')
  })

  it('a row can be both a duplicate AND carry a warning without losing the duplicate badge', async () => {
    const db = getDatabase()
    const itemTypeId = db.prepare('SELECT id FROM item_types LIMIT 1').get().id
    const statusId = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    db.prepare(
      'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
    ).run('EXISTING-1', 'دارایی موجود', itemTypeId, 'SN-EXIST', statusId)

    // Duplicate code AND a brand-new workshop name AND a bad date — severity must stay 'duplicate', the highest-ranked check.
    const { preview } = await parseAndPreview('EXISTING-1,لپ‌تاپ,تجهیزات رایانه,SN-NEW,در انبار,واحد-جدید,,garbage')
    expect(preview.results[0].severity).toBe('duplicate')
  })
})

describe('importService.commitImport', () => {
  it('imports valid rows inside one transaction, with transaction ledger + audit entries', async () => {
    const filePath = writeCsv(
      `${HEADER_ROW}\nA-001,لپ‌تاپ,تجهیزات رایانه,SN-1,در انبار,,,\nA-002,مانیتور,تجهیزات رایانه,SN-2,در انبار,,,`
    )
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'skip' },
      currentUser
    )

    expect(result.success).toBe(true)
    expect(result.summary).toEqual({
      total: 2,
      imported: 2,
      updated: 0,
      skipped: 0,
      duplicates: 0,
      warnings: 0,
      errors: 0
    })

    const db = getDatabase()
    expect(db.prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(2)
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'IMPORT'").get().n).toBe(2)
    expect(db.prepare('SELECT COUNT(*) n FROM asset_transactions').get().n).toBe(2)
  })

  it('excludes error rows but still imports the valid rows in the same batch', async () => {
    const filePath = writeCsv(
      `${HEADER_ROW}\nA-001,,تجهیزات رایانه,SN-1,در انبار,,,\nA-002,مانیتور,تجهیزات رایانه,SN-2,در انبار,,,`
    )
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'skip' },
      currentUser
    )
    expect(result.summary.imported).toBe(1)
    expect(result.summary.errors).toBe(1)
    expect(result.errorDetails).toHaveLength(1)
    expect(getDatabase().prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(1)
  })

  it('duplicatePolicy "skip" leaves the existing asset untouched', async () => {
    const db = getDatabase()
    const itemTypeId = db.prepare('SELECT id FROM item_types LIMIT 1').get().id
    const statusId = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    db.prepare(
      'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
    ).run('EXISTING-1', 'نام قدیمی', itemTypeId, 'SN-EXIST', statusId)

    const filePath = writeCsv(`${HEADER_ROW}\nEXISTING-1,نام جدید از فایل,تجهیزات رایانه,SN-NEW,در انبار,,,`)
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'skip' },
      currentUser
    )

    expect(result.success).toBe(true)
    expect(result.summary.skipped).toBe(1)
    expect(result.summary.imported).toBe(0)
    const stillThere = db.prepare("SELECT asset_name FROM assets WHERE asset_code = 'EXISTING-1'").get()
    expect(stillThere.asset_name).toBe('نام قدیمی')
  })

  it('duplicatePolicy "update" overwrites the existing asset with the file\'s data', async () => {
    const db = getDatabase()
    const itemTypeId = db.prepare('SELECT id FROM item_types LIMIT 1').get().id
    const statusId = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    db.prepare(
      'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
    ).run('EXISTING-1', 'نام قدیمی', itemTypeId, 'SN-EXIST', statusId)

    const filePath = writeCsv(`${HEADER_ROW}\nEXISTING-1,نام جدید از فایل,تجهیزات رایانه,SN-EXIST,در انبار,,,`)
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'update' },
      currentUser
    )

    expect(result.success).toBe(true)
    expect(result.summary.updated).toBe(1)
    const updated = db.prepare("SELECT asset_name FROM assets WHERE asset_code = 'EXISTING-1'").get()
    expect(updated.asset_name).toBe('نام جدید از فایل')
  })

  it('duplicatePolicy "cancel" aborts the whole import and writes nothing when duplicates exist', async () => {
    const db = getDatabase()
    const itemTypeId = db.prepare('SELECT id FROM item_types LIMIT 1').get().id
    const statusId = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    db.prepare(
      'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
    ).run('EXISTING-1', 'نام قدیمی', itemTypeId, 'SN-EXIST', statusId)

    const filePath = writeCsv(
      `${HEADER_ROW}\nEXISTING-1,نام جدید,تجهیزات رایانه,SN-NEW,در انبار,,,\nA-002,مانیتور,تجهیزات رایانه,SN-2,در انبار,,,`
    )
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'cancel' },
      currentUser
    )

    expect(result.success).toBe(false)
    expect(result.canceled).toBe(true)
    // Not even the non-duplicate A-002 row should have been imported.
    expect(db.prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(1)
  })

  // Regression test for the duplicate-detection bug, required scenario
  // #2 from the bug report: importing a file, deleting the resulting
  // asset, then importing the exact same file again must succeed the
  // second time, not be rejected as a duplicate of a row that's gone.
  // Goes through the real commit -> softDelete -> commit path, the same
  // one the app itself uses, rather than just checking classification.
  it('importing the same file again after the resulting asset was deleted succeeds instead of being treated as a duplicate', async () => {
    const db = getDatabase()
    const filePath = writeCsv(`${HEADER_ROW}\nA-001,لپ‌تاپ,تجهیزات رایانه,SN-1,در انبار,,,`)

    const firstParse = await importService.parseFile(filePath, { fileType: 'csv' })
    const firstResult = importService.commitImport(
      { headers: firstParse.headers, rows: firstParse.rows, mapping: firstParse.mapping, duplicatePolicy: 'skip' },
      currentUser
    )
    expect(firstResult.success).toBe(true)
    expect(firstResult.summary.imported).toBe(1)

    const created = db.prepare("SELECT id FROM assets WHERE asset_code = 'A-001'").get()
    assetRepository.softDelete(created.id, currentUser.id)

    // Re-parse and re-import the SAME file, exactly as a person would by
    // running the import wizard again.
    const secondParse = await importService.parseFile(filePath, { fileType: 'csv' })
    const secondResult = importService.commitImport(
      {
        headers: secondParse.headers,
        rows: secondParse.rows,
        mapping: secondParse.mapping,
        duplicatePolicy: 'skip'
      },
      currentUser
    )

    expect(secondResult.success).toBe(true)
    expect(secondResult.summary.imported).toBe(1)
    expect(secondResult.summary.duplicates).toBe(0)

    // Exactly one ACTIVE asset with this code — the original soft-deleted
    // row plus the freshly re-imported one, not a collision between them.
    const active = db.prepare("SELECT COUNT(*) n FROM assets WHERE asset_code = 'A-001' AND is_deleted = 0").get().n
    expect(active).toBe(1)
    const total = db.prepare("SELECT COUNT(*) n FROM assets WHERE asset_code = 'A-001'").get().n
    expect(total).toBe(2)
  })

  it('handles a 500-row batch correctly (bulk insert + bulk duplicate check at scale)', async () => {
    const rows = []
    for (let i = 0; i < 500; i++) {
      rows.push(`BULK-${i},دارایی ${i},تجهیزات رایانه,SN-BULK-${i},در انبار,,,`)
    }
    const filePath = writeCsv(`${HEADER_ROW}\n${rows.join('\n')}`)
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
    expect(parsed.totalRows).toBe(500)

    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'skip' },
      currentUser
    )
    expect(result.summary.imported).toBe(500)
    const db = getDatabase()
    expect(db.prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(500)
    // Phase 5 — Performance: transaction-ledger + audit entries are now
    // written via transactionRepository.bulkInsert / auditService
    // .recordAuditBulk (one prepared statement reused across every row)
    // instead of one insert per row. Same regression coverage as the
    // 2-row "transaction ledger + audit entries" test above, at a scale
    // that would have made the old per-row prepare() calls the dominant
    // cost of a real import.
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'IMPORT'").get().n).toBe(500)
    expect(db.prepare('SELECT COUNT(*) n FROM asset_transactions').get().n).toBe(500)
  })

  // Regression test for the Phase 5 batching change: bulkInsert must
  // still record each row's OWN previous/new status and delivered/received
  // fields correctly, not (for example) accidentally reuse the last row's
  // values across the reused prepared statement.
  it('a mixed batch of new inserts and duplicate updates writes distinct, correct audit + transaction rows for each', async () => {
    const db = getDatabase()
    const itemTypeId = db.prepare('SELECT id FROM item_types LIMIT 1').get().id
    const statusId = db.prepare("SELECT id FROM asset_statuses WHERE name = 'در انبار'").get().id
    db.prepare(
      'INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, status_id) VALUES (?,?,?,?,?)'
    ).run('EXISTING-1', 'نام قدیمی', itemTypeId, 'SN-EXIST', statusId)

    const filePath = writeCsv(
      `${HEADER_ROW}\nEXISTING-1,نام جدید,تجهیزات رایانه,SN-EXIST,آسیب‌دیده,,,\nNEW-1,لپ‌تاپ,تجهیزات رایانه,SN-NEW-1,در انبار,,,`
    )
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'update' },
      currentUser
    )

    expect(result.success).toBe(true)
    expect(result.summary.imported).toBe(1)
    expect(result.summary.updated).toBe(1)

    const importAudit = db
      .prepare("SELECT entity_id, changes FROM audit_log WHERE action = 'IMPORT' ORDER BY id")
      .all()
      .map((r) => ({ ...r, changes: JSON.parse(r.changes) }))
    expect(importAudit).toHaveLength(1)
    expect(importAudit[0].changes.assetCode).toBe('NEW-1')

    const updateAudit = db
      .prepare("SELECT entity_id, changes FROM audit_log WHERE action = 'IMPORT_UPDATE'")
      .all()
      .map((r) => ({ ...r, changes: JSON.parse(r.changes) }))
    expect(updateAudit).toHaveLength(1)
    expect(updateAudit[0].changes.assetCode).toBe('EXISTING-1')

    // Only the newly-inserted row gets a transaction-ledger entry here —
    // duplicatePolicy "update" overwrites the asset's own columns but
    // does not itself call transactionRepository (matching pre-existing,
    // unchanged behavior — see toUpdate handling in commitImport).
    const newAssetId = db.prepare("SELECT id FROM assets WHERE asset_code = 'NEW-1'").get().id
    const txns = db.prepare('SELECT asset_id, new_status_id FROM asset_transactions').all()
    expect(txns).toHaveLength(1)
    expect(txns[0].asset_id).toBe(newAssetId)
    expect(txns[0].new_status_id).toBe(statusId)
  })
})

describe('importService — Preview reflects only the parsed file (regression guard)', () => {
  function writeRealXlsx(headerRow, dataRow) {
    const filePath = path.join(csvDir, `xlsx-${Math.random().toString(36).slice(2)}.xlsx`)
    const ws = XLSX.utils.aoa_to_sheet([headerRow, dataRow])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    XLSX.writeFile(wb, filePath)
    return filePath
  }

  const XLSX_HEADERS = ['کد اموال', 'نام دارایی', 'نوع کالا', 'شماره سریال', 'وضعیت']

  it('preview rows exactly match a real .xlsx file\'s contents, with no leftover/mock data', async () => {
    const filePath = writeRealXlsx(XLSX_HEADERS, ['15648', 'دارایی من', 'تجهیزات رایانه', 'ssf', 'در انبار'])
    const parsed = await importService.parseFile(filePath, { fileType: 'xlsx', sheetName: 'Sheet1' })
    expect(parsed.success).toBe(true)

    const preview = importService.buildPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: parsed.mapping
    })

    expect(preview.results).toHaveLength(1)
    expect(preview.results[0].fields.assetCode).toBe('15648')
    expect(preview.results[0].fields.serialNumber).toBe('ssf')
  })

  it('preview changes when a different .xlsx file is imported (no stale/cached preview)', async () => {
    const first = writeRealXlsx(XLSX_HEADERS, ['15648', 'دارایی من', 'تجهیزات رایانه', 'ssf', 'در انبار'])
    const parsed1 = await importService.parseFile(first, { fileType: 'xlsx', sheetName: 'Sheet1' })
    const preview1 = importService.buildPreview({
      headers: parsed1.headers,
      rows: parsed1.rows,
      mapping: parsed1.mapping
    })
    expect(preview1.results[0].fields.assetCode).toBe('15648')

    const second = writeRealXlsx(XLSX_HEADERS, ['99001', 'دارایی دوم', 'تجهیزات رایانه', 'XYZ-999', 'در انبار'])
    const parsed2 = await importService.parseFile(second, { fileType: 'xlsx', sheetName: 'Sheet1' })
    const preview2 = importService.buildPreview({
      headers: parsed2.headers,
      rows: parsed2.rows,
      mapping: parsed2.mapping
    })
    expect(preview2.results[0].fields.assetCode).toBe('99001')
    expect(preview2.results[0].fields.serialNumber).toBe('XYZ-999')
  })
})

describe('importService — default values for required fields with no source column', () => {
  // Deliberately missing "نام دارایی" (assetName) and "نوع کالا" (assetType)
  // columns entirely — the real-world scenario reported: a legacy file
  // that never tracked those two fields.
  const HEADERS_NO_NAME_NO_TYPE = 'کد اموال,شماره سریال,وضعیت'

  it('without any default configured, a row missing an unmapped required field is still an error', async () => {
    const filePath = writeCsv(`${HEADERS_NO_NAME_NO_TYPE}\n15648,ssf,در انبار`)
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })
    expect(parsed.missingRequiredFields).toEqual(expect.arrayContaining(['assetName', 'assetType']))

    const preview = importService.buildPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: parsed.mapping
    })
    expect(preview.results[0].severity).toBe('error')
  })

  it('a constant default fills a required field with no column, on every row', async () => {
    const filePath = writeCsv(
      `${HEADERS_NO_NAME_NO_TYPE}\n15648,ssf,در انبار\n15649,ssf2,در انبار`
    )
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })

    const preview = importService.buildPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: parsed.mapping,
      defaults: {
        assetType: { type: 'constant', value: 'متفرقه' },
        assetName: { type: 'constant', value: 'دارایی وارداتی' }
      }
    })

    expect(preview.results[0].fields.assetType).toBe('متفرقه')
    expect(preview.results[1].fields.assetType).toBe('متفرقه')
    expect(preview.results[0].fields.assetName).toBe('دارایی وارداتی')
    expect(preview.results[0].severity).not.toBe('error')
  })

  it('a "mirror" default copies another mapped field\'s value on the SAME row (not a fixed constant)', async () => {
    const filePath = writeCsv(
      `${HEADERS_NO_NAME_NO_TYPE}\n15648,ssf,در انبار\n99001,XYZ-999,در انبار`
    )
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })

    const preview = importService.buildPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: parsed.mapping,
      defaults: {
        assetName: { type: 'mirror', sourceField: 'assetCode' },
        assetType: { type: 'constant', value: 'متفرقه' }
      }
    })

    // Each row gets ITS OWN asset code mirrored — not one shared value.
    expect(preview.results[0].fields.assetName).toBe('15648')
    expect(preview.results[1].fields.assetName).toBe('99001')
  })

  it('a default never overrides a real value that IS present in the file', async () => {
    const filePath = writeCsv(`${HEADER_ROW}\nA-001,لپ‌تاپ واقعی,تجهیزات رایانه,SN-1,در انبار,,,`)
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })

    const preview = importService.buildPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: parsed.mapping,
      defaults: { assetName: { type: 'constant', value: 'باید نادیده گرفته شود' } }
    })

    expect(preview.results[0].fields.assetName).toBe('لپ‌تاپ واقعی')
  })

  it('commitImport also applies defaults, so committed rows are not blocked by the missing column', async () => {
    const filePath = writeCsv(`${HEADERS_NO_NAME_NO_TYPE}\n15648,ssf,در انبار`)
    const parsed = await importService.parseFile(filePath, { fileType: 'csv' })

    const result = importService.commitImport(
      {
        headers: parsed.headers,
        rows: parsed.rows,
        mapping: parsed.mapping,
        duplicatePolicy: 'skip',
        defaults: {
          assetType: { type: 'constant', value: 'متفرقه' },
          assetName: { type: 'mirror', sourceField: 'assetCode' }
        }
      },
      currentUser
    )

    expect(result.success).toBe(true)
    expect(result.summary.imported).toBe(1)
    const row = getDatabase().prepare('SELECT asset_name FROM assets WHERE asset_code = ?').get('15648')
    expect(row.asset_name).toBe('15648')
  })
})

describe('importService.parseFile — PDF end-to-end (parser + classification + commit)', () => {
  // pdfkit is only for fixture generation here — see pdfParser.test.js
  // for the detailed rationale and the specific Persian-shaping quirks
  // it has that the fixtures below deliberately avoid.
  const FONT_PATH = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    'parsers',
    'fixtures',
    'Vazirmatn-Regular.ttf'
  )
  const RTL = { features: ['rtla'] }

  async function writePdfTable() {
    const PDFDocument = (await import('pdfkit')).default
    const filePath = path.join(csvDir, `test-${Math.random().toString(36).slice(2)}.pdf`)
    const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' })
    doc.font(FONT_PATH).fontSize(10)
    const cols = [40, 160, 300, 430, 560]
    const header = ['کد اموال', 'نام دارایی', 'نوع اموال', 'شماره سریال', 'وضعیت']
    header.forEach((cell, c) => doc.text(cell, cols[c], 40, RTL))
    const row = ['15648', 'دستگاه یک', 'رایانه', 'ssf', 'در انبار']
    row.forEach((cell, c) => doc.text(cell, cols[c], 60, RTL))
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(filePath)
      doc.pipe(stream)
      stream.on('finish', resolve)
      stream.on('error', reject)
      doc.end()
    })
    return filePath
  }

  it('parses a real PDF table, previews it, and commits it — same pipeline as Excel/CSV', async () => {
    const filePath = await writePdfTable()
    const parsed = await importService.parseFile(filePath, { fileType: 'pdf' })
    expect(parsed.success).toBe(true)
    expect(parsed.mapping[parsed.headers.indexOf('کد اموال')]).toBe('assetCode')

    const preview = importService.buildPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: parsed.mapping
    })
    expect(preview.results).toHaveLength(1)
    expect(preview.results[0].fields.assetCode).toBe('15648')
    expect(preview.results[0].fields.serialNumber).toBe('ssf')
    expect(preview.results[0].severity).not.toBe('error')

    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'skip' },
      currentUser
    )
    expect(result.success).toBe(true)
    expect(result.summary.imported).toBe(1)
    expect(getDatabase().prepare('SELECT COUNT(*) n FROM assets').get().n).toBe(1)
  })

  it('a real 11-column export with wrapped cells: all 11 fields auto-map, preview, and commit correctly (user-reported regression)', async () => {
    // Same fixture as pdfParser.test.js's wrapped-cell describe block —
    // see the comment there for the full story. This test proves the
    // fix end-to-end, all the way into the database, not just at the
    // parser boundary: every field the person reported as "not being
    // recognized" (country, workshop/section, entry date, exit date)
    // plus the two ZWNJ-mangled headers (deliverer/receiver) land
    // correctly on the committed row.
    const fixturePath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      'parsers',
      'fixtures',
      'real-export-fa-wrapped.pdf'
    )

    const parsed = await importService.parseFile(fixturePath, { fileType: 'pdf' })
    expect(parsed.success).toBe(true)
    expect(parsed.unmapped).toEqual([])
    expect(Object.keys(parsed.mapping)).toHaveLength(11)
    expect(Object.values(parsed.mapping).sort()).toEqual(
      [
        'assetCode',
        'assetName',
        'assetType',
        'serialNumber',
        'country',
        'workshop',
        'warehouseEntryDate',
        'warehouseExitDate',
        'deliveredBy',
        'receivedBy',
        'status'
      ].sort()
    )

    const preview = importService.buildPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: parsed.mapping
    })
    expect(preview.results).toHaveLength(3)
    // Row 3 (AST-10236) carries "تعمیر" as its status — a real value from
    // this fixture's original export, back when it was still one of the
    // six official statuses. Dropped from the canonical set in the
    // Status Cleanup / clean-database phase, so strictLookup now
    // correctly rejects it here rather than silently importing a status
    // nothing else in the app recognizes anymore (see
    // assetImportSchema.js's `status` field comment). Rows 1-2 are
    // "warning", not "valid" — this fixture's country/workshop/item type
    // values don't exist yet, so each gets auto-created with an
    // informational warning, same as any other first-time import.
    expect(preview.results[0].severity).toBe('warning')
    expect(preview.results[1].severity).toBe('warning')
    expect(preview.results[2].severity).toBe('error')
    expect(preview.results[2].messages.join(' ')).toMatch(/تعمیر/)
    expect(preview.results[2].messages.join(' ')).toMatch(/در انبار/) // lists the valid options

    const result = importService.commitImport(
      { headers: parsed.headers, rows: parsed.rows, mapping: parsed.mapping, duplicatePolicy: 'skip' },
      currentUser
    )
    expect(result.success).toBe(true)
    expect(result.summary.imported).toBe(2)
    expect(result.summary.errors).toBe(1)

    const stored = getDatabase()
      .prepare(
        `SELECT a.asset_code, a.asset_name, it.name AS item_type, a.serial_number,
                c.name AS country, w.name AS workshop,
                a.warehouse_entry_date, a.warehouse_exit_date,
                a.delivered_by, a.received_by, st.name AS status
         FROM assets a
         JOIN item_types it ON it.id = a.item_type_id
         LEFT JOIN countries c ON c.id = a.country_id
         LEFT JOIN workshops w ON w.id = a.workshop_id
         JOIN asset_statuses st ON st.id = a.status_id
         ORDER BY a.asset_code`
      )
      .all()

    // Only the 2 rows with a still-valid status actually commit —
    // AST-10236 (status "تعمیر") is correctly excluded, per the preview
    // assertions above.
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({
      asset_code: 'AST-10234',
      asset_name: 'دستگاه جوشکاری آرگون صنعتی مدل XR-500', // reunited across its 2 wrapped lines
      item_type: 'تجهیزات جوشکاری',
      serial_number: 'SN-2024-88451', // reunited across its 2 wrapped lines, no inserted space
      country: 'آلمان',
      workshop: 'واحد تولید و مونتاژ خط یک', // reunited across its 2 wrapped lines
      delivered_by: 'محمدرضا حسینی نژاد',
      received_by: 'علی اکبر رستمی',
      status: 'در انبار'
    })
    expect(stored[0].warehouse_entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(stored[0].warehouse_exit_date).toBe(null)

    expect(stored[1]).toMatchObject({
      asset_code: 'AST-10235',
      country: 'چین',
      workshop: 'واحد کنترل کیفیت و آزمایشگاه',
      delivered_by: 'سید محمد طباطبایی',
      received_by: 'فاطمه احمدی راد',
      status: 'صادر شده'
    })
    expect(stored[1].warehouse_exit_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('inspectFile flags an image-only PDF as needing OCR, before the wizard even tries to parse it', async () => {
    const PDFDocument = (await import('pdfkit')).default
    const filePath = path.join(csvDir, `scanned-${Math.random().toString(36).slice(2)}.pdf`)
    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    doc.rect(40, 40, 200, 100).stroke() // no text operators at all
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(filePath)
      doc.pipe(stream)
      stream.on('finish', resolve)
      stream.on('error', reject)
      doc.end()
    })

    const result = await importService.inspectFile(filePath)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/اسکن‌شده|OCR/)
  })
})
