// The isolated parser process (evaluation of D-15 / O-13 / E-18). It reads one
// file from stdin, refuses it or parses it, and writes NDJSON to stdout: one
// {"row": …} line per non-blank row, then one {"result": …} line. It is started
// only by isolate.mjs, with an empty environment, kernel resource limits, Node's
// permission model (no file writes, no child processes) and, where available, no
// network. It never writes files and never logs cell values to stderr.
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { getHeapStatistics } from 'node:v8'
import { DERIVED, InvalidFileError, LIMITS, LimitError } from './limits.mjs'
import { inspectXlsx } from './zip-inspect.mjs'

const require = createRequire(import.meta.url)
const mode = process.argv[2]
const limits = { ...LIMITS, ...JSON.parse(process.argv[3] ?? '{}') }

async function readInput() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > limits.compressedBytes) throw new LimitError('compressedBytes', `more than ${String(limits.compressedBytes)} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function emit(line) {
  if (!process.stdout.write(`${JSON.stringify(line)}\n`)) {
    await new Promise((resolve) => process.stdout.once('drain', resolve))
  }
}

const FORMULA_LIKE = /^[=+\-@\t\r]/

/** Plain, typed value of one cell, or undefined for a blank one. Formulas are never evaluated. */
function normalize(value, stats) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return text(value, stats)
  if (typeof value === 'number') return { t: 'n', v: value }
  if (typeof value === 'boolean') return { t: 'b', v: value }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? { t: 'e', v: '#DATE' } : { t: 'd', v: value.toISOString() }
  if (typeof value === 'object') {
    if ('formula' in value) {
      stats.formulas += 1
      const cached = normalize(value.result, stats)
      return { t: 'f', v: cached === undefined ? null : cached.v }
    }
    if (Array.isArray(value.richText)) return text(value.richText.map((r) => String(r.text ?? '')).join(''), stats)
    if ('hyperlink' in value) return text(String(value.text ?? ''), stats)
    if ('error' in value) return { t: 'e', v: String(value.error) }
  }
  stats.unknownTypes += 1
  return { t: 'e', v: '#UNSUPPORTED' }
}

function text(s, stats) {
  if (s.length > DERIVED.cellTextChars) stats.overlongCells += 1
  if (FORMULA_LIKE.test(s)) stats.formulaLikeText += 1
  return { t: 's', v: s }
}

function newStats() {
  return { sheets: 0, rows: 0, cells: 0, maxColumn: 0, formulas: 0, formulaLikeText: 0, overlongCells: 0, unknownTypes: 0, mergedCellsSkipped: 0 }
}

// Authoritative recount of what the parser actually built.
function recount(stats) {
  if (stats.rows > limits.rows) throw new LimitError('rows', `parsed ${String(stats.rows)}`)
  if (stats.cells > limits.cells) throw new LimitError('cells', `parsed ${String(stats.cells)}`)
  if (stats.maxColumn > limits.columnsPerSheet) throw new LimitError('columnsPerSheet', `parsed ${String(stats.maxColumn)}`)
  if (stats.sheets > limits.worksheets) throw new LimitError('worksheets', `parsed ${String(stats.sheets)}`)
}

// One parsed row as [column, value] pairs. Formula cells are read through
// cell.result: ExcelJS 4.4.0's cell.value drops a cached result that is 0 or
// FALSE (FormulaValue._copyModel tests truthiness). Merged ranges contribute
// their value once, at the top-left cell; ExcelJS repeats it in every cell.
function excelPairs(row, stats, ValueType) {
  const pairs = []
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    if (cell.type === ValueType.Merge) {
      stats.mergedCellsSkipped += 1
      return
    }
    pairs.push([col, cell.type === ValueType.Formula ? { formula: cell.formula ?? '', result: cell.result } : cell.value])
  })
  return pairs
}

async function emitRow(sheet, number, pairs, stats) {
  const cells = []
  for (const [col, value] of pairs) {
    const cell = normalize(value, stats)
    if (cell === undefined) continue
    stats.cells += 1
    if (col > stats.maxColumn) stats.maxColumn = col
    cells.push([col, cell.t, cell.v])
  }
  if (cells.length === 0) return
  stats.rows += 1
  if (stats.rows % 1000 === 0) recount(stats)
  await emit({ row: [sheet, number, cells] })
}

// JSZip (what ExcelJS's load() unzips with) must see exactly the archive the
// inspector checked: same parts, same sizes, same checksums. Any difference
// between the two ZIP readers is refused.
async function sameView(buf, parts) {
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(buf, { checkCRC32: true })
  const seen = Object.values(zip.files)
  if (seen.length !== parts.length) throw new InvalidFileError('ZIP readers disagree on the entries')
  const expected = new Map(parts.map((p) => [p.name, p]))
  for (const file of seen) {
    const part = expected.get(file.name)
    if (part === undefined) throw new InvalidFileError('ZIP readers disagree on the entries')
    // Explicit folder entries (written by archiver, among others) carry no data.
    if (file.dir) {
      if (!part.name.endsWith('/') || part.usize !== 0) throw new InvalidFileError('ZIP readers disagree on the entries')
      continue
    }
    const data = file._data // JSZip 3 CompressedObject
    if (data === undefined || data.uncompressedSize !== part.usize || data.crc32 >>> 0 !== part.crc) {
      throw new InvalidFileError('ZIP readers disagree on the entries')
    }
  }
}

async function parseLoad(buf) {
  const { counts: check, parts } = inspectXlsx(buf, limits)
  await sameView(buf, parts)
  const ExcelJS = require('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buf)
  const stats = newStats()
  for (const ws of workbook.worksheets) {
    stats.sheets += 1
    const rows = []
    ws.eachRow({ includeEmpty: false }, (row, number) => rows.push([number, excelPairs(row, stats, ExcelJS.ValueType)]))
    for (const [number, pairs] of rows) await emitRow(stats.sheets, number, pairs, stats)
  }
  recount(stats)
  // Valid SpreadsheetML may prefix element names (<x:c>); ExcelJS ignores such
  // elements, so a file whose cells it cannot see is refused, not imported empty.
  if (check.cells > 0 && stats.cells === 0) throw new InvalidFileError('the parser read no cells although the file contains some')
  return { check, stats }
}

// Evaluation only: ExcelJS without any of the checks above, to show what the
// isolation limits alone contain. Never part of the design.
async function parseLoadUnchecked(buf) {
  const ExcelJS = require('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buf)
  const stats = newStats()
  for (const ws of workbook.worksheets) {
    stats.sheets += 1
    const rows = []
    ws.eachRow({ includeEmpty: false }, (row, number) => rows.push([number, excelPairs(row, stats, ExcelJS.ValueType)]))
    for (const [number, pairs] of rows) await emitRow(stats.sheets, number, pairs, stats)
  }
  return { check: { unchecked: true }, stats }
}

async function parseStream(buf) {
  const { counts: check } = inspectXlsx(buf, limits)
  const ExcelJS = require('exceljs')
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buf]), {
    entries: 'ignore', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'cache', worksheets: 'emit'
  })
  const stats = newStats()
  for await (const ws of reader) {
    stats.sheets += 1
    for await (const row of ws) await emitRow(stats.sheets, row.number, excelPairs(row, stats, ExcelJS.ValueType), stats)
  }
  recount(stats)
  return { check, stats }
}

async function parseCsv(buf) {
  if (buf.includes(0)) throw new InvalidFileError('NUL byte in a text file')
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf)
  } catch {
    throw new InvalidFileError('not valid UTF-8')
  }
  const { parse } = require('csv-parse')
  const parser = parse({
    bom: true, cast: false, relax_quotes: false, relax_column_count: false, skip_empty_lines: true,
    max_record_size: DERIVED.cellTextChars * limits.columnsPerSheet
  })
  const stats = newStats()
  stats.sheets = 1
  const done = (async () => {
    let number = 0
    for await (const record of parser) {
      number += 1
      if (record.length > limits.columnsPerSheet) throw new LimitError('columnsPerSheet', `row ${String(number)}: ${String(record.length)}`)
      if (number > limits.rows) throw new LimitError('rows', number)
      await emitRow(1, number, record.map((v, i) => [i + 1, v === '' ? undefined : v]), stats)
    }
  })()
  parser.end(source)
  try {
    await done
  } catch (err) {
    if (err instanceof LimitError || err instanceof InvalidFileError) throw err
    throw new InvalidFileError(`CSV ${String(err.code ?? 'parse error')}`)
  }
  recount(stats)
  return { check: { bytes: buf.length }, stats }
}

const MODES = { 'xlsx-load': parseLoad, 'xlsx-stream': parseStream, csv: parseCsv, 'xlsx-load-unchecked': parseLoadUnchecked }

try {
  if (!(mode in MODES)) throw new Error(`unknown mode ${String(mode)}`)
  const buf = await readInput()
  const { check, stats } = await MODES[mode](buf)
  const heap = getHeapStatistics()
  await emit({ result: { ok: true, check, stats, rssKiB: Math.round(process.memoryUsage().rss / 1024), heapMiB: Math.round(heap.total_heap_size / 1048576), externalMiB: Math.round(heap.external_memory / 1048576) } })
} catch (err) {
  const known = err instanceof LimitError || err instanceof InvalidFileError
  // The kernel's data limit or the heap ceiling, caught before V8 gives up.
  const memory = err?.code === 'ERR_MEMORY_ALLOCATION_FAILED' || (err instanceof RangeError && /allocation failed|Invalid array length|Invalid string length/i.test(String(err.message)))
  await emit({
    result: {
      ok: false,
      code: known ? err.code : memory ? 'MEMORY' : 'PARSE',
      // Parser messages can quote file content; only our own messages are passed on.
      message: known ? err.message : `parser rejected the file (${String(err?.name ?? 'Error')}${typeof err?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code) ? ` ${err.code}` : ''})`,
      rssKiB: Math.round(process.memoryUsage().rss / 1024)
    }
  })
  process.exitCode = 0
}
