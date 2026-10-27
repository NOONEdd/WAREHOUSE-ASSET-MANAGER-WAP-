import { crc32, inflateRawSync } from 'node:zlib'
import { DERIVED, InvalidFileError, LimitError } from './limits.mjs'

// Checks an .xlsx (a ZIP archive) BEFORE any spreadsheet library sees it
// (ASVS 5.0.0 V5.2.2, V5.2.3, V5.3.3, V1.5.1; D-15 review §4.3–4.5):
//   1. structure from the central directory only: entry count, declared sizes,
//      names (no traversal, absolute paths, backslashes, duplicates), no
//      symlinks, no encryption, no ZIP64, only stored/deflate, no macros, and no
//      part name that ExcelJS's unanchored name patterns would pick up from an
//      unexpected place;
//   2. every entry is inflated with a hard output cap equal to its declared
//      size, then its length and CRC-32 are verified — a ZIP bomb that lies
//      about its size fails here, never inside the parser;
//   3. no XML part may contain a DTD or an entity declaration (XXE, entity
//      expansion); shared strings and cell formats are counted;
//   4. every worksheet is scanned for rows, cells and every coordinate the
//      parser would act on: cell and row references must lie inside the E-18
//      extent, column-format ranges inside Excel's grid, and the merged and
//      data-validation ranges ExcelJS expands cell by cell must fit a budget.
// The scanner fails closed: an attribute it cannot read exactly is refused,
// not skipped.

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const UNIX = 3

// Unanchored, exactly as ExcelJS 4.4.0 matches them (lib/xlsx/xlsx.js and
// lib/stream/xlsx/workbook-reader.js), paired with the only place each part may be.
const EXCELJS_PARTS = [
  [/xl\/worksheets\/sheet\d+[.]xml/, /^xl\/worksheets\/sheet\d+\.xml$/],
  [/xl\/worksheets\/_rels\/sheet\d+[.]xml.rels/, /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/],
  [/xl\/theme\/[a-zA-Z0-9]+[.]xml/, /^xl\/theme\/[a-zA-Z0-9]+\.xml$/],
  [/xl\/media\//, /^xl\/media\/[^/]+$/],
  [/xl\/drawings\/[a-zA-Z0-9]+[.]xml/, /^xl\/drawings\/[a-zA-Z0-9]+\.xml$/],
  [/xl\/comments\d+[.]xml/, /^xl\/comments\d+\.xml$/],
  [/xl\/tables\/table\d+[.]xml/, /^xl\/tables\/table\d+\.xml$/],
  [/xl\/drawings\/_rels\/[a-zA-Z0-9]+[.]xml[.]rels/, /^xl\/drawings\/_rels\/[a-zA-Z0-9]+\.xml\.rels$/],
  [/xl\/drawings\/vmlDrawing\d+[.]vml/, /^xl\/drawings\/vmlDrawing\d+\.vml$/]
]
const WORKSHEET = /^xl\/worksheets\/sheet\d+\.xml$/

// One tag of interest with its attributes. '<' cannot occur inside an XML
// attribute value, so the scan of one tag never runs past the next '<' and the
// whole scan stays linear even on hostile input.
const TAG = /<(?:[A-Za-z_][\w.-]*:)?(row|c|col|mergeCell|dataValidation)(?=[\s/>])((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>/g
const ATTR = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const CELL_REF = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/
const RANGE_REF = /^([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?$/
const INT = /^[1-9][0-9]{0,7}$/
const DTD = /<!(?:DOCTYPE|ENTITY)/i
const SHARED_STRING = /<(?:[A-Za-z_][\w.-]*:)?si(?=[\s/>])/g
const CELL_FORMAT = /<(?:[A-Za-z_][\w.-]*:)?xf(?=[\s/>])/g

function count(re, text) {
  re.lastIndex = 0
  let n = 0
  while (re.exec(text) !== null) n += 1
  return n
}

function findEnd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_END) return i
  }
  throw new InvalidFileError('not a ZIP archive (no end-of-central-directory record)')
}

function columnIndex(letters) {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

function checkName(name) {
  if (name === '' || name.length > 255) throw new InvalidFileError('empty or overlong entry name')
  if (/[\u0000-\u001f\\:]/.test(name)) throw new InvalidFileError('entry name with control characters, backslash or colon')
  if (name.startsWith('/')) throw new InvalidFileError('absolute entry path')
  if (name.split('/').some((part) => part === '..')) throw new InvalidFileError('entry path with ".."')
  for (const [loose, exact] of EXCELJS_PARTS) {
    if (loose.test(name) && !exact.test(name)) throw new InvalidFileError('part name outside its standard location')
  }
}

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

// XML attribute value as the XML parser will see it (character references and
// the five predefined entities; any other '&' is refused).
function decodeAttr(raw) {
  if (/&(?!(?:#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);)/.test(raw)) throw new InvalidFileError('unknown entity in an attribute')
  return raw
    .replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (_, ref) => {
      if (ref[0] !== '#') return NAMED[ref]
      const code = ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10)
      if (code > 0x10ffff) throw new InvalidFileError('invalid character reference')
      return String.fromCodePoint(code)
    })
    .replace(/[\t\n\r]/g, ' ')
}

function attributes(text) {
  const map = new Map()
  ATTR.lastIndex = 0
  for (let m = ATTR.exec(text); m !== null; m = ATTR.exec(text)) {
    if (map.has(m[1])) throw new InvalidFileError('duplicate attribute')
    map.set(m[1], decodeAttr(m[2] ?? m[3]))
  }
  return map
}

function rangeArea(ref, where) {
  const m = RANGE_REF.exec(ref)
  if (m === null) throw new InvalidFileError(`unreadable range reference in ${where}`)
  const c1 = columnIndex(m[1])
  const r1 = Number(m[2])
  const c2 = m[3] === undefined ? c1 : columnIndex(m[3])
  const r2 = m[4] === undefined ? r1 : Number(m[4])
  if (Math.max(c1, c2) > DERIVED.gridColumns || Math.max(r1, r2) > DERIVED.gridRows) {
    throw new InvalidFileError(`range outside the Excel grid in ${where}`)
  }
  return (Math.abs(c2 - c1) + 1) * (Math.abs(r2 - r1) + 1)
}

/** Scans one worksheet's XML; adds to `totals` and throws on any breach. */
function scanWorksheet(xml, name, limits, totals) {
  let row = 0
  let column = 0
  TAG.lastIndex = 0
  for (let m = TAG.exec(xml); m !== null; m = TAG.exec(xml)) {
    const attrs = attributes(m[2])
    switch (m[1]) {
      case 'row': {
        const r = attrs.get('r')
        if (r !== undefined && !INT.test(r)) throw new InvalidFileError(`unreadable row number in ${name}`)
        row = r === undefined ? row + 1 : Number(r)
        column = 0
        if (row > limits.rows) throw new LimitError('rows', `${name}: row number ${String(row)}`)
        const spans = attrs.get('spans')
        if (spans !== undefined) {
          for (const part of spans.split(/[ :]/)) {
            if (!INT.test(part) || Number(part) > DERIVED.gridColumns) throw new InvalidFileError(`unreadable row span in ${name}`)
          }
        }
        totals.rows += 1
        if (totals.rows > limits.rows) throw new LimitError('rows', totals.rows)
        break
      }
      case 'c': {
        const r = attrs.get('r')
        if (r === undefined) {
          column += 1
        } else {
          const ref = CELL_REF.exec(r)
          if (ref === null) throw new InvalidFileError(`unreadable cell reference in ${name}`)
          column = columnIndex(ref[1])
          if (Number(ref[2]) > limits.rows) throw new LimitError('rows', `${name}: cell ${r}`)
        }
        if (column > limits.columnsPerSheet) throw new LimitError('columnsPerSheet', `${name}: column ${String(column)}`)
        totals.cells += 1
        if (totals.cells > limits.cells) throw new LimitError('cells', totals.cells)
        break
      }
      case 'col': {
        const min = attrs.get('min')
        const max = attrs.get('max')
        if (min === undefined || max === undefined || !INT.test(min) || !INT.test(max)) throw new InvalidFileError(`unreadable column range in ${name}`)
        if (Number(min) > Number(max) || Number(max) > DERIVED.gridColumns) throw new InvalidFileError(`column range outside the Excel grid in ${name}`)
        break
      }
      case 'mergeCell':
      case 'dataValidation': {
        const ref = attrs.get(m[1] === 'mergeCell' ? 'ref' : 'sqref')
        if (ref === undefined) throw new InvalidFileError(`${m[1]} without a range in ${name}`)
        for (const part of ref.trim().split(/ +/)) totals.expanded += rangeArea(part, name)
        if (totals.expanded > DERIVED.expandedPositions) throw new LimitError('expandedPositions', `merged and validated ranges cover ${String(totals.expanded)} positions`)
        break
      }
    }
  }
}

/**
 * Validates the archive and returns its counts; throws InvalidFileError or
 * LimitError. Never writes files and never uses entry names as paths.
 */
export function inspectXlsx(buf, limits) {
  if (buf.length > limits.compressedBytes) throw new LimitError('compressedBytes', buf.length)
  if (buf.length < 30 || buf.readUInt32LE(0) !== SIG_LOCAL) throw new InvalidFileError('not a ZIP archive (magic bytes)')
  const end = findEnd(buf)
  if (end >= 20 && buf.readUInt32LE(end - 20) === SIG_ZIP64_LOCATOR) throw new InvalidFileError('ZIP64 archives are not accepted')
  const disk = buf.readUInt16LE(end + 4)
  const cdDisk = buf.readUInt16LE(end + 6)
  const entriesHere = buf.readUInt16LE(end + 8)
  const entries = buf.readUInt16LE(end + 10)
  const cdSize = buf.readUInt32LE(end + 12)
  const cdOffset = buf.readUInt32LE(end + 16)
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new InvalidFileError('ZIP64 archives are not accepted')
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries) throw new InvalidFileError('multi-disk archives are not accepted')
  if (entries > limits.zipEntries) throw new LimitError('zipEntries', entries)
  if (cdOffset + cdSize > end) throw new InvalidFileError('central directory outside the file')

  const list = []
  const names = new Set()
  let declaredTotal = 0
  let p = cdOffset
  for (let i = 0; i < entries; i += 1) {
    if (p + 46 > end || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new InvalidFileError('corrupt central directory')
    const madeBy = buf.readUInt16LE(p + 4)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const externalAttr = buf.readUInt32LE(p + 38)
    const localOffset = buf.readUInt32LE(p + 42)
    if (p + 46 + nameLen > end) throw new InvalidFileError('corrupt central directory')
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 0x1) throw new InvalidFileError('encrypted entries are not accepted')
    if (method !== 0 && method !== 8) throw new InvalidFileError(`unsupported compression method ${String(method)}`)
    if (madeBy >> 8 === UNIX && ((externalAttr >>> 16) & 0o170000) === 0o120000) throw new InvalidFileError('symbolic links are not accepted')
    if (csize === 0xffffffff || usize === 0xffffffff) throw new InvalidFileError('ZIP64 entries are not accepted')
    checkName(name)
    if (names.has(name)) throw new InvalidFileError('duplicate entry name')
    names.add(name)
    if (/vbaProject/i.test(name)) throw new InvalidFileError('macro-enabled workbooks are not accepted')
    declaredTotal += usize
    if (declaredTotal > limits.decompressedBytes) throw new LimitError('decompressedBytes', `declared ${String(declaredTotal)} bytes`)
    list.push({ name, method, crc, csize, usize, localOffset })
  }
  for (const required of ['[Content_Types].xml', 'xl/workbook.xml']) {
    if (!names.has(required)) throw new InvalidFileError(`missing ${required}`)
  }
  const worksheets = list.filter((e) => WORKSHEET.test(e.name)).length
  if (worksheets > limits.worksheets) throw new LimitError('worksheets', worksheets)

  // Inflate every entry with a hard cap; verify the declared size and the CRC.
  const totals = { rows: 0, cells: 0, expanded: 0 }
  let actualTotal = 0
  for (const e of list) {
    if (e.localOffset + 30 > buf.length || buf.readUInt32LE(e.localOffset) !== SIG_LOCAL) throw new InvalidFileError('corrupt local header')
    const start = e.localOffset + 30 + buf.readUInt16LE(e.localOffset + 26) + buf.readUInt16LE(e.localOffset + 28)
    if (start + e.csize > buf.length) throw new InvalidFileError('entry data outside the file')
    const raw = buf.subarray(start, start + e.csize)
    let data
    if (e.method === 0) {
      if (e.csize !== e.usize) throw new InvalidFileError('stored entry with inconsistent sizes')
      data = raw
    } else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize) })
      } catch (err) {
        if (err instanceof RangeError || err?.code === 'ERR_BUFFER_TOO_LARGE') throw new InvalidFileError('entry inflates beyond its declared size')
        throw new InvalidFileError('corrupt compressed data')
      }
    }
    if (data.length !== e.usize) throw new InvalidFileError('entry size differs from its declared size')
    if (crc32(data) >>> 0 !== e.crc >>> 0) throw new InvalidFileError('CRC mismatch')
    actualTotal += data.length
    if (actualTotal > limits.decompressedBytes) throw new LimitError('decompressedBytes', `actual ${String(actualTotal)} bytes`)
    if (e.name.startsWith('xl/media/')) continue

    const text = data.toString('latin1') // the scans only need ASCII
    if (DTD.test(text)) throw new InvalidFileError('XML with a DTD or an entity declaration')
    if (WORKSHEET.test(e.name)) scanWorksheet(text, e.name, limits, totals)
    if (e.name === 'xl/sharedStrings.xml' && count(SHARED_STRING, text) > DERIVED.sharedStrings) throw new LimitError('sharedStrings', 'more shared strings than cells allowed')
    if (e.name === 'xl/styles.xml' && count(CELL_FORMAT, text) > DERIVED.cellFormats) throw new LimitError('cellFormats', 'more cell formats than Excel allows')
  }
  return {
    counts: { entries: list.length, worksheets, rows: totals.rows, cells: totals.cells, expandedPositions: totals.expanded, decompressedBytes: actualTotal },
    parts: list.map((e) => ({ name: e.name, usize: e.usize, crc: e.crc >>> 0 }))
  }
}
