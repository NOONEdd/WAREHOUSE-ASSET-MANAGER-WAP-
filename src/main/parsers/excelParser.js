import * as XLSX from 'xlsx'
import { autoMapHeaders } from '../utils/importFieldAliases'

// SheetJS (xlsx package) rather than exceljs for READING: it transparently
// handles both .xlsx and .xls (legacy binary) through the same call, which
// exceljs cannot (xlsx-only). Export still uses exceljs (exportService.js)
// — that's a separate, already-working, unrelated feature, deliberately
// left untouched.

const MAX_HEADER_SCAN_ROWS = 15
const MIN_ALIAS_MATCHES_FOR_HEADER_ROW = 2

/**
 * Reads a single cell's displayed value, preserving exact text for string
 * cells (never re-stringifying a number) and real Date objects for
 * date-formatted numeric cells. For numeric cells, prefers the cell's own
 * formatted text (.w) over the raw value (.v) so a custom "0000"-style
 * format's leading zeros survive — the furthest this importer can go to
 * protect Asset Code / Serial Number digits; if the source cell was never
 * formatted to keep them, Excel itself already discarded them before this
 * file ever existed.
 *
 * Date cells are deliberately NOT read via SheetJS's own `cellDates`
 * conversion. That option's internal numdate() does a DST-offset lookup
 * (comparing "now" against 1899) that is wrong for some timezones —
 * confirmed empirically: a cell holding 2025-01-15 round-trips as
 * 2025-01-14 under Asia/Tehran. Reading raw (cellDates:false, cellNF:true)
 * and converting the serial number via XLSX.SSF.parse_date_code — which
 * does pure calendar arithmetic, no DST lookup — verified correct across
 * eight timezones including Tehran and deliberately awkward ones
 * (Lord Howe Island's 30-minute DST offset). The result is built as a
 * UTC-midnight Date; importDateParser.js reads it back with UTC getters
 * to match.
 */
function readCell(cell) {
  if (!cell) return ''
  if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
    const code = XLSX.SSF.parse_date_code(cell.v)
    if (!code) return ''
    return new Date(Date.UTC(code.y, code.m - 1, code.d))
  }
  if (cell.t === 's' || cell.t === 'str') return cell.v ?? ''
  if (cell.t === 'n' || cell.t === 'b') return cell.w !== undefined ? cell.w : String(cell.v)
  return cell.w ?? cell.v ?? ''
}

function sheetToGrid(worksheet) {
  const ref = worksheet['!ref']
  if (!ref) return []
  const range = XLSX.utils.decode_range(ref)
  const grid = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellRef = XLSX.utils.encode_cell({ r, c })
      row.push(readCell(worksheet[cellRef]))
    }
    grid.push(row)
  }
  return grid
}

function isRowEmpty(row) {
  return row.every((cell) => cell === '' || cell === null || cell === undefined)
}

/**
 * Scans the first several rows for the one that looks like a real header
 * row — i.e. at least two of its cells match a known field alias — rather
 * than always assuming row 1, since company exports often carry a title
 * or logo row above the actual columns.
 */
function findHeaderRowIndex(grid) {
  const scanLimit = Math.min(grid.length, MAX_HEADER_SCAN_ROWS)
  for (let i = 0; i < scanLimit; i++) {
    const row = grid[i]
    if (isRowEmpty(row)) continue
    const { mapping } = autoMapHeaders(row.map((c) => String(c)))
    if (Object.keys(mapping).length >= MIN_ALIAS_MATCHES_FOR_HEADER_ROW) {
      return i
    }
  }
  return -1
}

function listSheetNames(filePath) {
  const workbook = XLSX.readFile(filePath, { bookSheets: true })
  return workbook.SheetNames
}

/**
 * Parses one worksheet into { headers, rows, headerRowIndex }. `rows` is
 * an array of arrays aligned to `headers`, with fully empty rows already
 * dropped. Does not do field-mapping itself — that's importFieldAliases,
 * called separately so the wizard can let the user override the guess.
 */
function parseWorksheet(filePath, sheetName) {
  // cellDates:false + cellNF:true, not cellDates:true — see readCell()'s
  // comment. This keeps date cells as raw numeric + resolved format
  // string so they can be converted safely instead of through SheetJS's
  // own timezone-sensitive conversion.
  const workbook = XLSX.readFile(filePath, { cellDates: false, cellNF: true, cellText: false })
  const worksheet = workbook.Sheets[sheetName]
  if (!worksheet) throw new Error(`برگه «${sheetName}» در فایل یافت نشد`)

  const grid = sheetToGrid(worksheet)
  const headerRowIndex = findHeaderRowIndex(grid)
  if (headerRowIndex === -1) {
    throw new Error('ردیف سرستون در فایل شناسایی نشد. لطفاً فایل را بررسی کنید.')
  }

  const rawHeaders = grid[headerRowIndex].map((c) => String(c).trim())
  // Drop trailing empty header columns (common when a sheet has stray
  // formatting applied past the real data).
  let lastMeaningful = rawHeaders.length - 1
  while (lastMeaningful >= 0 && !rawHeaders[lastMeaningful]) lastMeaningful--
  const headers = rawHeaders.slice(0, lastMeaningful + 1)

  const dataRows = grid
    .slice(headerRowIndex + 1)
    .map((row) => row.slice(0, headers.length))
    .filter((row) => !isRowEmpty(row))

  return { headers, rows: dataRows, headerRowIndex }
}

export { listSheetNames, parseWorksheet }
