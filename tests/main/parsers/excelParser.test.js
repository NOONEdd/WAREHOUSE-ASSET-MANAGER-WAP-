import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as XLSX from 'xlsx'
import { listSheetNames, parseWorksheet } from '../../../src/main/parsers/excelParser.js'

let tmpDir

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = null
})

function writeWorkbook(sheets) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-excel-test-'))
  const filePath = path.join(tmpDir, 'test.xlsx')
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  XLSX.writeFile(wb, filePath)
  return filePath
}

describe('listSheetNames', () => {
  it('lists every sheet in the workbook, in order', () => {
    const filePath = writeWorkbook({
      اموال: [['کد اموال', 'نام دارایی']],
      برگه2: [['x']]
    })
    expect(listSheetNames(filePath)).toEqual(['اموال', 'برگه2'])
  })
})

describe('parseWorksheet', () => {
  it('reads headers and rows from row 1 when it is the real header row', () => {
    const filePath = writeWorkbook({
      Sheet1: [
        ['کد اموال', 'نام دارایی', 'شماره سریال'],
        ['A-001', 'لپ‌تاپ', 'SN-1'],
        ['A-002', 'مانیتور', 'SN-2']
      ]
    })
    const { headers, rows } = parseWorksheet(filePath, 'Sheet1')
    expect(headers).toEqual(['کد اموال', 'نام دارایی', 'شماره سریال'])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(['A-001', 'لپ‌تاپ', 'SN-1'])
  })

  it('finds the header row even when preceded by a title row', () => {
    const filePath = writeWorkbook({
      Sheet1: [
        ['فهرست دارایی‌های شرکت صنعت فرابر زرین'], // title row, not headers
        ['کد اموال', 'نام دارایی', 'شماره سریال'],
        ['A-001', 'لپ‌تاپ', 'SN-1']
      ]
    })
    const { headers, rows } = parseWorksheet(filePath, 'Sheet1')
    expect(headers).toEqual(['کد اموال', 'نام دارایی', 'شماره سریال'])
    expect(rows).toHaveLength(1)
  })

  it('drops fully empty rows', () => {
    const filePath = writeWorkbook({
      Sheet1: [
        ['کد اموال', 'نام دارایی', 'شماره سریال'],
        ['A-001', 'لپ‌تاپ', 'SN-1'],
        ['', '', ''],
        ['A-002', 'مانیتور', 'SN-2']
      ]
    })
    const { rows } = parseWorksheet(filePath, 'Sheet1')
    expect(rows).toHaveLength(2)
  })

  it('preserves a text-formatted asset code with leading zeros as an exact string', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-excel-test-'))
    const filePath = path.join(tmpDir, 'leading-zero.xlsx')
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([
      ['کد اموال', 'نام دارایی', 'شماره سریال'],
      ['0048', 'لپ‌تاپ', 'SN-1']
    ])
    // Force the asset-code cell to be stored as text (not a number) —
    // exactly what a company's export tool does when a column is
    // formatted as Text, which is the case this test protects.
    ws['A2'].t = 's'
    ws['A2'].v = '0048'
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    XLSX.writeFile(wb, filePath)

    const { rows } = parseWorksheet(filePath, 'Sheet1')
    expect(rows[0][0]).toBe('0048')
  })

  it('reads a real Excel date cell as a JS Date (Gregorian, unambiguous)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-excel-test-'))
    const filePath = path.join(tmpDir, 'date-cell.xlsx')
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([['کد اموال', 'تاریخ ورود'], ['A-001', new Date(2024, 7, 2)]])
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    XLSX.writeFile(wb, filePath)

    const { rows } = parseWorksheet(filePath, 'Sheet1')
    expect(rows[0][1]).toBeInstanceOf(Date)
    // Not just "is a Date" — the actual calendar date, read the same way
    // importDateParser.js reads it (UTC getters), must be exactly right.
    expect(rows[0][1].getUTCFullYear()).toBe(2024)
    expect(rows[0][1].getUTCMonth()).toBe(7) // 0-indexed: August
    expect(rows[0][1].getUTCDate()).toBe(2)
  })

  it('reads the correct calendar date regardless of the machine\'s timezone', () => {
    // Regression test for a real, confirmed bug: SheetJS's own cellDates
    // conversion (numdate()) does a DST-offset lookup that is wrong for
    // some timezones — a cell holding 2025-01-15 round-tripped as
    // 2025-01-14 under Asia/Tehran specifically, this app's actual
    // deployment timezone. parseWorksheet must not reproduce that bug.
    // Confirmed this test fails (produces the 14th) if readCell() is
    // reverted to `cellDates:true` + `cell.v instanceof Date`.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-excel-test-'))
    const filePath = path.join(tmpDir, 'tz-date-cell.xlsx')
    const wb = XLSX.utils.book_new()
    // Written as a plain date-formatted numeric cell — exactly how a real
    // Excel file stores a date, no JS Date object involved on the way in.
    const serial = (Date.UTC(2025, 0, 15) - Date.UTC(1899, 11, 30)) / 86400000
    const ws = { '!ref': 'A1:B2', A1: { t: 's', v: 'کد اموال' }, B1: { t: 's', v: 'تاریخ ورود' } }
    ws.A2 = { t: 's', v: 'A-001' }
    ws.B2 = { t: 'n', v: serial, z: 'yyyy-mm-dd' }
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    XLSX.writeFile(wb, filePath)

    const originalTz = process.env.TZ
    process.env.TZ = 'Asia/Tehran'
    try {
      const { rows } = parseWorksheet(filePath, 'Sheet1')
      expect(rows[0][1].getUTCFullYear()).toBe(2025)
      expect(rows[0][1].getUTCMonth()).toBe(0)
      expect(rows[0][1].getUTCDate()).toBe(15)
    } finally {
      process.env.TZ = originalTz
    }
  })

  it('throws a clear error when no header row can be found', () => {
    const filePath = writeWorkbook({ Sheet1: [['random'], ['stuff'], ['nothing header-like']] })
    expect(() => parseWorksheet(filePath, 'Sheet1')).toThrow(/سرستون/)
  })
})
