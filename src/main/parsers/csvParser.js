import fs from 'fs'
import Papa from 'papaparse'
import { autoMapHeaders } from '../utils/importFieldAliases'

const MAX_HEADER_SCAN_ROWS = 15
const MIN_ALIAS_MATCHES_FOR_HEADER_ROW = 2

function isRowEmpty(row) {
  return row.every((cell) => cell === '' || cell === null || cell === undefined)
}

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

/**
 * Parses a CSV file into { headers, rows }. Handles:
 *  - UTF-8 BOM (fs read as utf-8 already strips it via Papa's own BOM
 *    handling, confirmed below)
 *  - comma / semicolon / tab delimiters, auto-detected per-file by Papa
 *    (delimiter: '' triggers its sniffer)
 *  - quoted fields containing the delimiter or newlines (Papa's own CSV
 *    grammar handles this; nothing extra needed)
 *  - Persian text (file is read and decoded as utf-8 explicitly, not
 *    inferred from a BOM that may not be present)
 */
function parseCsvFile(filePath) {
  const buffer = fs.readFileSync(filePath)
  // Strip a UTF-8 BOM (EF BB BF) if present — Papa handles this too, but
  // being explicit here means the header-row scan below (which runs before
  // Papa ever sees the string) isn't thrown off by a BOM glued to the very
  // first header cell.
  let text = buffer.toString('utf-8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const parsed = Papa.parse(text, {
    delimiter: '', // '' = auto-detect comma / semicolon / tab
    skipEmptyLines: 'greedy',
    header: false
  })

  if (parsed.errors?.length) {
    // Papa reports several non-fatal notices that don't mean the file is
    // actually broken: 'Delimiter'/UndetectableDelimiter just means it
    // fell back to comma (fine for genuinely single-column data, and
    // harmless otherwise since our own header/delimiter content will
    // still contain the real delimiter and parse correctly), and
    // 'FieldMismatch' means a row has a different column count than the
    // rest, which our own empty-row/short-row handling already tolerates.
    // Only a 'Quotes' error (an unterminated quoted field) can actually
    // scramble field boundaries badly enough to be unsafe to import.
    const fatal = parsed.errors.filter((e) => e.type === 'Quotes')
    if (fatal.length) {
      throw new Error('فایل CSV قابل خواندن نیست. لطفاً ساختار فایل را بررسی کنید.')
    }
  }

  const grid = parsed.data.map((row) => row.map((cell) => (cell ?? '').toString().trim()))
  const headerRowIndex = findHeaderRowIndex(grid)
  if (headerRowIndex === -1) {
    throw new Error('ردیف سرستون در فایل شناسایی نشد. لطفاً فایل را بررسی کنید.')
  }

  const rawHeaders = grid[headerRowIndex]
  let lastMeaningful = rawHeaders.length - 1
  while (lastMeaningful >= 0 && !rawHeaders[lastMeaningful]) lastMeaningful--
  const headers = rawHeaders.slice(0, lastMeaningful + 1)

  const dataRows = grid
    .slice(headerRowIndex + 1)
    .map((row) => row.slice(0, headers.length))
    .filter((row) => !isRowEmpty(row))

  return { headers, rows: dataRows }
}

export { parseCsvFile }
