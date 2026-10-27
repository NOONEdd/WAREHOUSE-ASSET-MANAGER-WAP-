import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIMITS } from './limits.mjs'
import { buildXlsx, columnName, random, sheetXml, xmlText } from './xlsx-build.mjs'
import { writeZip } from './zip-write.mjs'

// The synthetic corpus (decisions D-15, O-13, E-18). Every file is invented and
// rebuilt identically on each run. `expect` lists the acceptable outcomes:
//   ok       parsed; `check` may assert on the parsed values
//   refused  stopped by the pre-check or a ceiling (code LIMIT or INVALID)
//   rejected stopped by the parser itself (a parse error)
//   contained any end except "ok with unchecked data": refused, rejected, or
//            stopped by a memory or time limit — and the supervisor survives
// `heavy` marks the at-limit files used to measure memory and time.

const MiB = 1024 * 1024
const WORDS = ['کالا', 'انبار', 'دستگاه', 'قطعه', 'تهران', 'Laptop', 'Monitor', 'Printer', 'Cable', 'Scanner', 'شماره', 'سریال', 'Router', 'Switch', 'Desk', 'Chair']

function rowsOf(n, cols, cell) {
  return {
    *[Symbol.iterator]() {
      for (let r = 1; r <= n; r += 1) {
        const row = []
        for (let c = 1; c <= cols; c += 1) row.push(cell(r, c))
        yield row
      }
    }
  }
}

function tiny(extra = {}) {
  return buildXlsx({ sheets: [{ name: 'S', rows: [['a', 1], ['b', 2]], ...extra }] })
}

function withSheetXml(xml, spec = {}) {
  return buildXlsx({ sheets: [{ name: 'S', xml }], ...spec })
}

const SHEET_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'

function editEntry(buf, name, fn) {
  return buildFrom(buf, (entries) => {
    const e = entries.find((x) => x.name === name)
    fn(e)
  })
}

// Rebuild helper: parses our own writer's output back into entries (only used on
// archives this corpus built, never on untrusted input).
function buildFrom(spec, edit) {
  const s = typeof spec === 'function' ? spec() : spec
  return buildXlsx({ ...s, edit })
}

function exactSize(target, buildWithPad) {
  // Pads with a stored random media part so the archive is exactly `target` bytes.
  const probe = buildWithPad(0).length
  return buildWithPad(target - probe)
}

const sheetsWithText = (n, rows, cols, text) =>
  Array.from({ length: n }, (_, s) => ({ name: `S${String(s + 1)}`, rows: rowsOf(rows, cols, (r, c) => text(s, r, c)) }))

export function corpus(root) {
  const producers = join(root, 'out', 'producers')
  const canaryPath = join(root, 'out', 'canary.txt')
  const canary = existsSync(canaryPath) ? readFileSync(canaryPath, 'utf8').trim() : 'missing-canary'
  const cases = []
  const add = (c) => cases.push(c)

  // ---------- normal workbooks ----------
  const reference = [
    ['کد دارایی', 'نام', 'سریال', 'تعداد', 'تاریخ خرید', 'فعال', 'یادداشت'],
    ['00123', 'لپ‌تاپ نمونه', 'SN-0001', 3, new Date(Date.UTC(2024, 2, 15)), true, "=cmd|' /C calc'!A0"],
    ['000045', 'Монитор', null, 1, new Date(Date.UTC(2023, 11, 1)), false, 'line1\nline2'],
    ['A-7', 'پرینتر ۱۲۳', '۰۰۹۸۷', 2.5, new Date(Date.UTC(2025, 0, 31)), true, 'مقدار']
  ]
  const referenceCheck = (r) => {
    const byRef = new Map()
    for (const [, number, cells] of r.keptRows) for (const [col, t, v] of cells) byRef.set(`${columnName(col)}${String(number)}`, [t, v])
    const want = { A2: ['s', '00123'], A3: ['s', '000045'], B2: ['s', 'لپ‌تاپ نمونه'], B3: ['s', 'Монитор'], C4: ['s', '۰۰۹۸۷'], D4: ['n', 2.5], F2: ['b', true], F3: ['b', false], G2: ['s', "=cmd|' /C calc'!A0"], G3: ['s', 'line1\nline2'] }
    // LibreOffice stores TRUE and FALSE as the formulas TRUE() and FALSE(); the
    // cached value must still come through (it does only via cell.result).
    const same = (ref, t, v) => { const got = JSON.stringify(byRef.get(ref)); return got === JSON.stringify([t, v]) || (t === 'b' && got === JSON.stringify(['f', v])) }
    const bad = Object.entries(want).filter(([ref, [t, v]]) => !same(ref, t, v))
    if (byRef.has('B6') || byRef.has('C6')) bad.push(['merged A6:C6 must be read once, at A6'])
    if (byRef.has('C3')) bad.push(['C3 must stay blank'])
    const date = byRef.get('E2')
    if (date === undefined || date[0] !== 'd' || !String(date[1]).startsWith('2024-03-15')) bad.push(['E2 date', date])
    return bad.length === 0 ? true : `unexpected values: ${JSON.stringify(bad)}`
  }
  add({ id: 'N1', group: 'normal', title: 'reference table (shared strings, Excel part order)', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'دارایی‌ها', rows: reference }] }), expect: ['ok'], check: referenceCheck })
  add({ id: 'N2', group: 'normal', title: 'reference table (inline strings)', mode: 'xlsx-load', build: () => buildXlsx({ sharedStrings: false, sheets: [{ name: 'S', rows: reference }] }), expect: ['ok'], check: referenceCheck })
  add({ id: 'N3', group: 'normal', title: 'written by ExcelJS 4.4.0 itself (merged cells, hyperlink, rich text)', mode: 'xlsx-load', build: 'exceljs-reference', expect: ['ok'], check: referenceCheck })
  for (const [id, file, title] of [['N4', 'reference-openpyxl.xlsx', 'written by openpyxl 3.1.5'], ['N5', 'reference-xlsxwriter.xlsx', 'written by XlsxWriter 3.2.9'], ['N6', 'reference-libreoffice.xlsx', 'written by LibreOffice Calc (Excel 2007-365 filter)']]) {
    add({ id, group: 'normal', title, mode: 'xlsx-load', build: () => readFileSync(join(producers, file)), expect: ['ok'], check: referenceCheck })
  }
  add({ id: 'N7', group: 'normal', title: 'CSV: UTF-8 with BOM, CRLF, quoted comma and newline, Persian, leading zeros', mode: 'csv', build: () => Buffer.from('﻿کد,نام,یادداشت\r\n00123,"لپ‌تاپ, نمونه","line1\nline2"\r\n000045,Монитор,\r\n', 'utf8'), expect: ['ok'], check: (r) => (JSON.stringify(r.keptRows[1][2][0]) === '[1,"s","00123"]' && r.keptRows[2][2].length === 2 ? true : 'values differ') })
  add({ id: 'N8', group: 'normal', title: 'namespace-prefixed SpreadsheetML (valid XML, but ExcelJS does not read prefixed elements): must not import as empty', mode: 'xlsx-load', build: () => withSheetXml('<?xml version="1.0" encoding="UTF-8"?>\n<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>a</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>'), expect: ['refused', 'rejected'] })

  // ---------- at the E-18 ceilings (must be accepted) ----------
  const rnd = random(18)
  const word = () => WORDS[Math.floor(rnd() * WORDS.length)]
  add({ id: 'L1', group: 'at-limit', heavy: true, title: '50,000 rows x 20 columns = 1,000,000 cells, one sheet, unique shared strings', mode: 'xlsx-load', build: () => buildXlsx({ sheets: sheetsWithText(1, 50_000, 20, (s, r, c) => (c % 4 === 0 ? r * c : `${word()}-${String(r)}-${String(c)}`)) }), expect: ['ok'], check: (r) => (r.result.stats.rows === 50_000 && r.result.stats.cells === 1_000_000 ? true : 'counts differ') })
  add({ id: 'L2', group: 'at-limit', heavy: true, title: '20 worksheets x 2,500 rows x 20 columns = 1,000,000 cells', mode: 'xlsx-load', build: () => buildXlsx({ sheets: sheetsWithText(20, 2_500, 20, (s, r, c) => `${word()}-${String(s)}-${String(r)}-${String(c)}`) }), expect: ['ok'], check: (r) => (r.result.stats.sheets === 20 && r.result.stats.cells === 1_000_000 ? true : 'counts differ') })
  add({ id: 'L3', group: 'at-limit', heavy: true, title: '10,000 rows x 100 columns = 1,000,000 cells', mode: 'xlsx-load', build: () => buildXlsx({ sheets: sheetsWithText(1, 10_000, 100, (s, r, c) => (c % 2 === 0 ? r + c / 1000 : `${word()}${String(r)}`)) }), expect: ['ok'], check: (r) => (r.result.stats.maxColumn === 100 && r.result.stats.cells === 1_000_000 ? true : 'counts differ') })
  add({ id: 'L4', group: 'at-limit', heavy: true, title: 'CSV 50,000 rows x 20 columns = 1,000,000 cells, just under 10 MiB', mode: 'csv', build: () => { const g = random(4); const a = 'abcdefghijklmnopqrstuvwxyz0123456789'; return Buffer.from(Array.from({ length: 50_000 }, () => Array.from({ length: 20 }, () => Array.from({ length: 9 }, () => a[Math.floor(g() * 36)]).join('')).join(',')).join('\n'), 'utf8') }, expect: ['ok'], check: (r) => (r.result.stats.rows === 50_000 && r.result.stats.cells === 1_000_000 && r.inputBytes > 9 * MiB ? true : 'counts or size differ') })
  add({ id: 'L5', group: 'at-limit', title: 'exactly 1,000 ZIP entries', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: Array.from({ length: 1000 - 7 }, (_, i) => ({ name: `customXml/item${String(i + 1)}.xml`, data: '<a/>' })) }), expect: ['ok'], check: (r) => (r.result.check.entries === 1000 ? true : `entries ${String(r.result.check.entries)}`) })
  add({ id: 'L6', group: 'at-limit', heavy: true, title: '1,000,000 cells of longer text, 99.3 MiB decompressed (5.7 MiB compressed)', mode: 'xlsx-load', build: () => { const g = random(6); const w = () => WORDS[Math.floor(g() * 4)]; return buildXlsx({ level: 9, sheets: [{ name: 'S', rows: rowsOf(50_000, 20, (r, c) => `${w()} ${'x'.repeat(12)} ${String(r * 20 + c)}`) }] }) }, expect: ['ok'], check: (r) => (r.result.check.decompressedBytes > 98 * MiB && r.result.check.decompressedBytes <= LIMITS.decompressedBytes ? true : `${String(r.result.check.decompressedBytes)} bytes decompressed; corpus needs tuning`) })
  add({ id: 'L7', group: 'at-limit', heavy: true, title: '1,000,000 random (incompressible) shared strings, 9.4 MiB compressed', mode: 'xlsx-load', build: () => { const g = random(7); const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; return buildXlsx({ level: 9, sheets: [{ name: 'S', rows: rowsOf(50_000, 20, () => Array.from({ length: 7 }, () => b64[Math.floor(g() * 64)]).join('')) }] }) }, expect: ['ok'], check: (r) => (r.inputBytes > 9 * MiB && r.inputBytes <= LIMITS.compressedBytes ? true : `${String(r.inputBytes)} bytes; corpus needs tuning`) })
  add({ id: 'L8', group: 'at-limit', title: 'exactly 10 MiB (10,485,760 bytes) compressed', mode: 'xlsx-load', build: () => exactSize(LIMITS.compressedBytes, (pad) => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: pad > 0 ? [{ name: 'xl/media/image1.png', data: randomFill(Math.max(1, pad - 'xl/media/image1.png'.length * 2 - 76)), method: 0 }] : [] })), expect: ['ok'], check: (r) => (r.inputBytes === LIMITS.compressedBytes ? true : `size ${String(r.inputBytes)}`) })
  add({ id: 'L9', group: 'at-limit', title: 'CSV with exactly 100 columns', mode: 'csv', build: () => Buffer.from(Array.from({ length: 3 }, (_, r) => Array.from({ length: 100 }, (_, c) => `r${String(r)}c${String(c + 1)}`).join(',')).join('\n'), 'utf8'), expect: ['ok'], check: (r) => (r.result.stats.maxColumn === 100 ? true : `max column ${String(r.result.stats.maxColumn)}`) })
  add({ id: 'L10', group: 'at-limit', title: 'CSV of exactly 10 MiB (10,485,760 bytes)', mode: 'csv', build: () => {
    const lines = Array.from({ length: 40_000 }, (_, r) => Array.from({ length: 20 }, (_, c) => `v${String(r).padStart(6, '0')}-${String(c).padStart(4, '0')}`).join(','))
    let rest = LIMITS.compressedBytes - Buffer.byteLength(lines.join('\n'), 'utf8')
    for (let k = lines.length - 1; rest > 0; k -= 1) { const add = Math.min(rest, 30_000); lines[k] += 'x'.repeat(add); rest -= add }
    return Buffer.from(lines.join('\n'), 'utf8')
  }, expect: ['ok'], check: (r) => (r.inputBytes === LIMITS.compressedBytes && r.result.stats.rows === 40_000 ? true : `size ${String(r.inputBytes)}`) })
  add({ id: 'L11', group: 'at-limit', title: 'decompressed total exactly 100 MiB (104,857,600 bytes)', mode: 'xlsx-load', build: () => { const base = buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }] }); return buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'customXml/item1.xml', data: Buffer.alloc(LIMITS.decompressedBytes - decompressedTotal(base), 0x20), level: 9 }] }) }, expect: ['ok'], check: (r) => (r.result.check.decompressedBytes === LIMITS.decompressedBytes ? true : `decompressed ${String(r.result.check.decompressedBytes)}`) })

  // ---------- one step over each ceiling (must be refused) ----------
  add({ id: 'O1', group: 'over-limit', title: '21 worksheets', mode: 'xlsx-load', build: () => buildXlsx({ sheets: sheetsWithText(21, 1, 1, () => 'x') }), expect: ['refused'], limit: 'worksheets' })
  add({ id: 'O2', group: 'over-limit', title: '50,001 rows (across two sheets)', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'A', rows: rowsOf(25_000, 1, () => 1) }, { name: 'B', rows: rowsOf(25_001, 1, () => 1) }] }), expect: ['refused'], limit: 'rows' })
  add({ id: 'O3', group: 'over-limit', title: 'a cell in column 101 (CW)', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [Array.from({ length: 101 }, (_, i) => (i === 100 ? 'x' : null))] }] }), expect: ['refused'], limit: 'columnsPerSheet' })
  add({ id: 'O4', group: 'over-limit', title: '1,000,001 cells (40,000 x 25 + 1)', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: { *[Symbol.iterator]() { for (let r = 1; r <= 40_000; r += 1) yield r === 1 ? Array.from({ length: 26 }, () => 1) : Array.from({ length: 25 }, () => 1) } } }] }), expect: ['refused'], limit: 'cells' })
  add({ id: 'O5', group: 'over-limit', title: '1,001 ZIP entries', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: Array.from({ length: 1001 - 7 }, (_, i) => ({ name: `customXml/item${String(i + 1)}.xml`, data: '<a/>' })) }), expect: ['refused'], limit: 'zipEntries' })
  add({ id: 'O6', group: 'over-limit', title: '100 MiB + 1 byte decompressed (truthful sizes)', mode: 'xlsx-load', build: () => { const base = buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }] }); const baseTotal = decompressedTotal(base); return buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'customXml/item1.xml', data: Buffer.alloc(LIMITS.decompressedBytes + 1 - baseTotal, 0x20), level: 9 }] }) }, expect: ['refused'], limit: 'decompressedBytes' })
  add({ id: 'O7', group: 'over-limit', title: '10 MiB + 1 byte compressed', mode: 'xlsx-load', build: () => exactSize(LIMITS.compressedBytes + 1, (pad) => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: pad > 0 ? [{ name: 'xl/media/image1.png', data: randomFill(Math.max(1, pad - 'xl/media/image1.png'.length * 2 - 76)), method: 0 }] : [] })), expect: ['refused'], limit: 'compressedBytes' })
  add({ id: 'O8', group: 'over-limit', title: 'CSV 50,001 rows', mode: 'csv', build: () => Buffer.from('a\n'.repeat(50_001), 'utf8'), expect: ['refused'], limit: 'rows' })
  add({ id: 'O9', group: 'over-limit', title: 'CSV 101 columns', mode: 'csv', build: () => Buffer.from(`${Array.from({ length: 101 }, () => 'a').join(',')}\n`, 'utf8'), expect: ['refused'], limit: 'columnsPerSheet' })
  add({ id: 'O10', group: 'over-limit', title: 'CSV 10 MiB + 1 byte', mode: 'csv', build: () => Buffer.alloc(LIMITS.compressedBytes + 1, 0x61), expect: ['refused'], limit: 'compressedBytes' })

  // ---------- hostile archives ----------
  const good = () => tiny()
  add({ id: 'H1', group: 'hostile-zip', title: 'truncated archive (first half)', mode: 'xlsx-load', build: () => { const b = good(); return b.subarray(0, Math.floor(b.length / 2)) }, expect: ['refused'] })
  add({ id: 'H2', group: 'hostile-zip', title: 'random bytes', mode: 'xlsx-load', build: () => randomFill(64 * 1024), expect: ['refused'] })
  add({ id: 'H3', group: 'hostile-zip', title: 'empty file', mode: 'xlsx-load', build: () => Buffer.alloc(0), expect: ['refused'] })
  add({ id: 'H4', group: 'hostile-zip', title: 'ZIP bomb with truthful sizes (one 200 MiB part, about 200 KiB compressed)', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'customXml/item1.xml', data: Buffer.alloc(200 * MiB, 0x20), level: 9 }] }), expect: ['refused'], limit: 'decompressedBytes' })
  add({ id: 'H4u', group: 'hostile-zip', title: 'H4 with a 1 GiB part, without the pre-check (ExcelJS/JSZip alone, under isolation)', mode: 'xlsx-load-unchecked', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'xl/theme/theme1.xml', data: Buffer.alloc(1024 * MiB, 0x20), level: 9 }] }), expect: ['contained'] })
  add({ id: 'H5', group: 'hostile-zip', title: 'ZIP bomb that lies about its size (declares 1 KiB, inflates to 200 MiB)', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'customXml/item1.xml', data: Buffer.alloc(200 * MiB, 0x20), level: 9, usize: 1024 }] }), expect: ['refused'] })
  add({ id: 'H5u', group: 'hostile-zip', title: 'H5 without the pre-check (ExcelJS/JSZip alone, under isolation)', mode: 'xlsx-load-unchecked', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'xl/theme/theme1.xml', data: Buffer.alloc(200 * MiB, 0x20), level: 9, usize: 1024 }] }), expect: ['contained'] })
  add({ id: 'H6', group: 'hostile-zip', title: 'CRC-32 mismatch', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], edit: (es) => { es[2].crc = 12345 } }), expect: ['refused'] })
  add({ id: 'H7', group: 'hostile-zip', title: 'entry name with ".." (path traversal)', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'xl/../../evil.xml', data: '<a/>' }] }), expect: ['refused'] })
  add({ id: 'H8', group: 'hostile-zip', title: 'absolute entry name', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: '/etc/evil.xml', data: '<a/>' }] }), expect: ['refused'] })
  add({ id: 'H9', group: 'hostile-zip', title: 'backslash in entry name', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'xl\\..\\evil.xml', data: '<a/>' }] }), expect: ['refused'] })
  add({ id: 'H10', group: 'hostile-zip', title: 'symbolic-link entry', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'xl/media/link', data: '/etc/passwd', method: 0, madeBy: 0x031e, externalAttr: (0o120777 << 16) >>> 0 }] }), expect: ['refused'] })
  add({ id: 'H11', group: 'hostile-zip', title: 'encrypted entry flag', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], edit: (es) => { es[4].flags = 1 } }), expect: ['refused'] })
  add({ id: 'H12', group: 'hostile-zip', title: 'ZIP64 locator', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], zip: { zip64Locator: true } }), expect: ['refused'] })
  add({ id: 'H13', group: 'hostile-zip', title: 'macro project (vbaProject.bin)', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'xl/vbaProject.bin', data: randomFill(512) }] }), expect: ['refused'] })
  add({ id: 'H14', group: 'hostile-zip', title: 'duplicate entry names (two different sheet1.xml)', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'xl/worksheets/sheet1.xml', data: `${SHEET_HEAD}<sheetData><row r="1"><c r="A1"><v>666</v></c></row></sheetData></worksheet>` }] }), expect: ['refused'] })
  add({ id: 'H15', group: 'hostile-zip', title: 'missing xl/workbook.xml', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], edit: (es) => { es.splice(2, 1) } }), expect: ['refused'] })
  add({ id: 'H16', group: 'hostile-zip', title: 'worksheet outside its standard place (matched by ExcelJS\'s unanchored pattern)', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'hidden/xl/worksheets/sheet2.xml', data: `${SHEET_HEAD}<sheetData><row r="1"><c r="XFD1"><v>1</v></c></row></sheetData></worksheet>` }] }), expect: ['refused'] })
  add({ id: 'H17', group: 'hostile-zip', title: 'unknown compression method (bzip2 = 12)', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], edit: (es) => { es[1].methodOverride = 12 } }), expect: ['refused'], buildNote: 'method override applied by the writer' })

  // ---------- hostile XML ----------
  add({ id: 'X1', group: 'hostile-xml', title: 'malformed XML (unclosed elements) in a worksheet', mode: 'xlsx-load', build: () => withSheetXml(`${SHEET_HEAD}<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><row r="2"><c r="A2"><v>1</v></sheetData></worksheet>`), expect: ['rejected', 'refused'] })
  add({ id: 'X2', group: 'hostile-xml', title: 'not XML at all in a worksheet', mode: 'xlsx-load', build: () => withSheetXml('this is not xml <<<>>> &&&'), expect: ['rejected', 'refused'] })
  const xxe = `<?xml version="1.0"?>\n<!DOCTYPE worksheet [<!ENTITY x SYSTEM "file://${canaryPath}">]>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&x;</t></is></c></row></sheetData></worksheet>`
  add({ id: 'X3', group: 'hostile-xml', title: 'XXE: external entity pointing at a canary file', mode: 'xlsx-load', build: () => withSheetXml(xxe), expect: ['refused'] })
  add({ id: 'X3u', group: 'hostile-xml', title: 'X3 without the pre-check: the canary must not appear in any output', mode: 'xlsx-load-unchecked', build: () => withSheetXml(xxe), expect: ['contained', 'ok'], check: (r) => (JSON.stringify(r.keptRows ?? []).includes(canary) ? 'CANARY LEAKED' : true) })
  const laughs = `<?xml version="1.0"?>\n<!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa">${Array.from({ length: 9 }, (_, i) => `<!ENTITY ${String.fromCharCode(98 + i)} "${`&${String.fromCharCode(97 + i)};`.repeat(10)}">`).join('')}]>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&j;</t></is></c></row></sheetData></worksheet>`
  add({ id: 'X4', group: 'hostile-xml', title: 'entity expansion ("billion laughs")', mode: 'xlsx-load', build: () => withSheetXml(laughs), expect: ['refused'] })
  add({ id: 'X4u', group: 'hostile-xml', title: 'X4 without the pre-check', mode: 'xlsx-load-unchecked', build: () => withSheetXml(laughs), expect: ['contained', 'ok'], check: (r) => ((r.result?.stats?.cells ?? 0) === 0 || JSON.stringify(r.keptRows ?? []).length < 100_000 ? true : 'entities were expanded') })
  add({ id: 'X5', group: 'hostile-xml', title: '200,000 nested elements inside a cell', mode: 'xlsx-load', build: () => withSheetXml(`${SHEET_HEAD}<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t>${'<x>'.repeat(200_000)}${'</x>'.repeat(200_000)}</is></c></row></sheetData></worksheet>`), expect: ['ok', 'rejected', 'refused'] })
  add({ id: 'X6', group: 'hostile-xml', heavy: true, title: 'one 90 MiB cell (Excel allows 32,767 characters)', mode: 'xlsx-load', build: () => buildXlsx({ level: 9, sheets: [{ name: 'S', rows: [['h'], ['x'.repeat(90 * MiB)]] }] }), expect: ['ok', 'refused'], check: (r) => (r.outcome !== 'ok' || r.result.stats.overlongCells === 1 ? true : 'overlong cell not flagged') })
  add({ id: 'X7', group: 'hostile-xml', title: 'merged range over the whole grid (A1:XFD1048576)', mode: 'xlsx-load', build: () => tiny({ after: '<mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells>' }), expect: ['refused'], limit: 'expandedPositions' })
  add({ id: 'X7u', group: 'hostile-xml', title: 'X7 without the pre-check', mode: 'xlsx-load-unchecked', build: () => tiny({ after: '<mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells>' }), expect: ['contained'] })
  add({ id: 'X8', group: 'hostile-xml', title: 'data validation over the whole grid', mode: 'xlsx-load', build: () => tiny({ after: '<dataValidations count="1"><dataValidation type="list" sqref="A1:XFD1048576"><formula1>"a,b"</formula1></dataValidation></dataValidations>' }), expect: ['refused'], limit: 'expandedPositions' })
  add({ id: 'X8u', group: 'hostile-xml', title: 'X8 without the pre-check', mode: 'xlsx-load-unchecked', build: () => tiny({ after: '<dataValidations count="1"><dataValidation type="list" sqref="A1:XFD1048576"><formula1>"a,b"</formula1></dataValidation></dataValidations>' }), expect: ['contained'] })
  add({ id: 'X9', group: 'hostile-xml', title: 'column format range up to column 2,000,000,000', mode: 'xlsx-load', build: () => tiny({ before: '<cols><col min="1" max="2000000000" width="9"/></cols>' }), expect: ['refused'] })
  add({ id: 'X9u', group: 'hostile-xml', title: 'X9 without the pre-check', mode: 'xlsx-load-unchecked', build: () => tiny({ before: '<cols><col min="1" max="2000000000" width="9"/></cols>' }), expect: ['contained'] })
  add({ id: 'X10', group: 'hostile-xml', title: 'whole-sheet column format (A:XFD) as Excel writes it: accepted', mode: 'xlsx-load', build: () => tiny({ before: '<cols><col min="1" max="16384" width="9"/></cols>' }), expect: ['ok'] })
  add({ id: 'X11', group: 'hostile-xml', title: 'cell reference hidden in character references (r="&#90;&#90;&#90;1")', mode: 'xlsx-load', build: () => withSheetXml(`${SHEET_HEAD}<sheetData><row r="1"><c r="&#90;&#90;&#90;1"><v>1</v></c></row></sheetData></worksheet>`), expect: ['refused'], limit: 'columnsPerSheet' })
  add({ id: 'X12', group: 'hostile-xml', title: '">" inside an attribute before the reference (scanner desync attempt)', mode: 'xlsx-load', build: () => withSheetXml(`${SHEET_HEAD}<sheetData><row r="1"><c foo=">" r="ZZ1"><v>1</v></c></row></sheetData></worksheet>`), expect: ['refused'], limit: 'columnsPerSheet' })
  add({ id: 'X13', group: 'hostile-xml', title: 'duplicate attribute (r="A1" r="ZZ1")', mode: 'xlsx-load', build: () => withSheetXml(`${SHEET_HEAD}<sheetData><row r="1"><c r="A1" r="ZZ1"><v>1</v></c></row></sheetData></worksheet>`), expect: ['refused'] })
  add({ id: 'X14', group: 'hostile-xml', title: 'row number 1,048,577 (beyond the grid and the extent)', mode: 'xlsx-load', build: () => withSheetXml(`${SHEET_HEAD}<sheetData><row r="1048577"><c r="A1048577"><v>1</v></c></row></sheetData></worksheet>`), expect: ['refused'], limit: 'rows' })
  add({ id: 'X15', group: 'hostile-xml', title: '101 cells in a row without references', mode: 'xlsx-load', build: () => withSheetXml(`${SHEET_HEAD}<sheetData><row>${'<c><v>1</v></c>'.repeat(101)}</row></sheetData></worksheet>`), expect: ['refused'], limit: 'columnsPerSheet' })
  add({ id: 'X16', group: 'hostile-xml', title: '1,000,001 shared strings', mode: 'xlsx-load', build: () => buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }], edit: (es) => { const e = es.find((x) => x.name === 'xl/sharedStrings.xml'); e.data = `<?xml version="1.0"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${'<si><t>a</t></si>'.repeat(1_000_001)}</sst>` } }), expect: ['refused'], limit: 'sharedStrings' })
  add({ id: 'X17', group: 'hostile-xml', title: 'shared-string index out of range', mode: 'xlsx-load', build: () => withSheetXml(`${SHEET_HEAD}<sheetData><row r="1"><c r="A1" t="s"><v>99999999</v></c></row></sheetData></worksheet>`), expect: ['ok', 'rejected', 'refused'], check: (r) => (r.outcome !== 'ok' || r.rows === 0 || JSON.stringify(r.keptRows).length < 1000 ? true : 'unexpected content') })
  add({ id: 'X18', group: 'hostile-xml', title: '1,500,000 comments in a comments part (growth linear in the file size)', mode: 'xlsx-load', build: () => buildXlsx({ level: 9, sheets: [{ name: 'S', rows: [['a']] }], extra: [{ name: 'xl/comments1.xml', data: `<?xml version="1.0"?>\n<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>x</author></authors><commentList>${'<comment ref="A1" authorId="0"><text><t>a</t></text></comment>'.repeat(1_500_000)}</commentList></comments>` }] }), expect: ['ok', 'rejected', 'refused', 'contained'] })

  // Every other element that carries a range, set to the whole grid: ExcelJS must not expand any of them.
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const GRID = 'A1:XFD1048576'
  const ranged = (before, cells, after) => `<?xml version="1.0" encoding="UTF-8"?>\n<worksheet ${NS}>${before}<sheetData><row r="1">${cells}</row></sheetData>${after}</worksheet>`
  const one = '<c r="A1"><v>1</v></c>'
  const sheetRels = (rel) => ({ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>` })
  const wholeGrid = [
    ['X19', 'sheet dimension', ranged(`<dimension ref="${GRID}"/>`, one, ''), []],
    ['X20', 'selection in the sheet view', ranged(`<sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="${GRID}"/></sheetView></sheetViews>`, one, ''), []],
    ['X21', 'shared formula', ranged('', `<c r="A1"><f t="shared" ref="${GRID}" si="0">1+1</f><v>2</v></c>`, ''), []],
    ['X22', 'array formula', ranged('', `<c r="A1"><f t="array" ref="${GRID}">1+1</f><v>2</v></c>`, ''), []],
    ['X23', 'hyperlink', ranged('', one, `<hyperlinks><hyperlink ref="${GRID}" r:id="rId9"/></hyperlinks>`), [sheetRels('<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/" TargetMode="External"/>')]],
    ['X24', 'conditional formatting', ranged('', one, `<conditionalFormatting sqref="${GRID}"><cfRule type="expression" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting>`), []],
    ['X25', 'auto filter', ranged('', one, `<autoFilter ref="${GRID}"/>`), []],
    ['X26', 'page break at the last row', ranged('', one, '<rowBreaks count="1" manualBreakCount="1"><brk id="1048575" max="16383" man="1"/></rowBreaks>'), []],
    ['X27', 'table', ranged('', '<c r="A1" t="inlineStr"><is><t>a</t></is></c>', '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>'), [sheetRels('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>'), { name: 'xl/tables/table1.xml', data: `<?xml version="1.0" encoding="UTF-8"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T1" displayName="T1" ref="${GRID}"><autoFilter ref="${GRID}"/><tableColumns count="1"><tableColumn id="1" name="a"/></tableColumns></table>` }]]
  ]
  for (const [id, what, xml, extra] of wholeGrid) {
    add({ id, group: 'hostile-xml', title: `${what} over the whole grid, without the pre-check: not expanded`, mode: 'xlsx-load-unchecked', build: () => buildXlsx({ sheets: [{ name: 'S', xml }], extra }), expect: ['ok'], check: (r) => (r.wallMs < 5_000 && r.peakRssMiB < 300 ? true : `${String(r.wallMs)} ms, ${String(r.peakRssMiB)} MiB: expanded?`) })
  }

  // ---------- hostile CSV ----------
  add({ id: 'C1', group: 'hostile-csv', title: 'invalid UTF-8', mode: 'csv', build: () => Buffer.from([0x61, 0x2c, 0xc3, 0x28, 0x0a]), expect: ['refused'] })
  add({ id: 'C2', group: 'hostile-csv', title: 'NUL byte', mode: 'csv', build: () => Buffer.from('a,b\0c\n', 'utf8'), expect: ['refused'] })
  add({ id: 'C3', group: 'hostile-csv', title: 'UTF-16 text (Excel "Unicode text")', mode: 'csv', build: () => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\r\n', 'utf16le')]), expect: ['refused'] })
  add({ id: 'C4', group: 'hostile-csv', title: 'unclosed quote', mode: 'csv', build: () => Buffer.from('a,"b\nc,d\n', 'utf8'), expect: ['refused'] })
  add({ id: 'C5', group: 'hostile-csv', title: 'rows with different column counts', mode: 'csv', build: () => Buffer.from('a,b,c\nd,e\n', 'utf8'), expect: ['refused'] })
  add({ id: 'C6', group: 'hostile-csv', title: 'formula-like cells (=, +, -, @) are kept as text and counted', mode: 'csv', build: () => Buffer.from('a,b\n"=HYPERLINK(""http://x"")",+1\n-2,@SUM(A1)\n', 'utf8'), expect: ['ok'], check: (r) => (r.result.stats.formulaLikeText === 4 && r.result.stats.formulas === 0 ? true : `formula-like ${String(r.result.stats.formulaLikeText)}`) })
  add({ id: 'C7', group: 'hostile-csv', title: 'one 9 MiB field', mode: 'csv', build: () => Buffer.from(`a\n"${'x'.repeat(9 * MiB)}"\n`, 'utf8'), expect: ['refused'] })

  return cases
}

function randomFill(n) {
  return randomBytes(n)
}

function decompressedTotal(buf) {
  // Sum of declared sizes in the central directory of an archive this corpus built.
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  let total = 0
  for (let i = 0; i < count; i += 1) {
    total += buf.readUInt32LE(p + 24)
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return total
}

export const helpers = { sheetXml, xmlText, writeZip, editEntry }
