import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseCsvFile } from '../../../src/main/parsers/csvParser.js'

let tmpDir

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = null
})

function writeCsv(content, { bom = false } = {}) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-csv-test-'))
  const filePath = path.join(tmpDir, 'test.csv')
  const buffer = bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf-8')])
    : Buffer.from(content, 'utf-8')
  fs.writeFileSync(filePath, buffer)
  return filePath
}

describe('parseCsvFile', () => {
  it('parses a standard comma-delimited UTF-8 file with Persian text', () => {
    const filePath = writeCsv('کد اموال,نام دارایی,شماره سریال\nA-001,لپ‌تاپ,SN-1\nA-002,مانیتور,SN-2')
    const { headers, rows } = parseCsvFile(filePath)
    expect(headers).toEqual(['کد اموال', 'نام دارایی', 'شماره سریال'])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(['A-001', 'لپ‌تاپ', 'SN-1'])
  })

  it('strips a UTF-8 BOM instead of leaving it glued to the first header', () => {
    const filePath = writeCsv('کد اموال,نام دارایی\nA-001,لپ‌تاپ', { bom: true })
    const { headers } = parseCsvFile(filePath)
    expect(headers[0]).toBe('کد اموال')
  })

  it('auto-detects a semicolon delimiter', () => {
    const filePath = writeCsv('کد اموال;نام دارایی;شماره سریال\nA-001;لپ‌تاپ;SN-1')
    const { headers, rows } = parseCsvFile(filePath)
    expect(headers).toEqual(['کد اموال', 'نام دارایی', 'شماره سریال'])
    expect(rows[0]).toEqual(['A-001', 'لپ‌تاپ', 'SN-1'])
  })

  it('auto-detects a tab delimiter', () => {
    const filePath = writeCsv('کد اموال\tنام دارایی\tشماره سریال\nA-001\tلپ‌تاپ\tSN-1')
    const { headers } = parseCsvFile(filePath)
    expect(headers).toEqual(['کد اموال', 'نام دارایی', 'شماره سریال'])
  })

  it('handles a quoted field containing the delimiter itself', () => {
    const filePath = writeCsv('کد اموال,نام دارایی\nA-001,"لپ‌تاپ, مدل ویژه"')
    const { rows } = parseCsvFile(filePath)
    expect(rows[0][1]).toBe('لپ‌تاپ, مدل ویژه')
  })

  it('preserves leading zeros in a plain-text CSV cell — nothing to lose in the first place', () => {
    const filePath = writeCsv('کد اموال,نام دارایی\n0048,لپ‌تاپ')
    const { rows } = parseCsvFile(filePath)
    expect(rows[0][0]).toBe('0048')
  })

  it('finds the header row even after a title row', () => {
    const filePath = writeCsv('فهرست دارایی‌ها\nکد اموال,نام دارایی,شماره سریال\nA-001,لپ‌تاپ,SN-1')
    const { headers, rows } = parseCsvFile(filePath)
    expect(headers).toEqual(['کد اموال', 'نام دارایی', 'شماره سریال'])
    expect(rows).toHaveLength(1)
  })

  it('drops fully empty lines', () => {
    const filePath = writeCsv('کد اموال,نام دارایی\nA-001,لپ‌تاپ\n\nA-002,مانیتور')
    const { rows } = parseCsvFile(filePath)
    expect(rows).toHaveLength(2)
  })

  it('throws a clear error when no header row can be found', () => {
    const filePath = writeCsv('random\nstuff\nnothing header-like')
    expect(() => parseCsvFile(filePath)).toThrow(/سرستون/)
  })
})
