import { writeZip } from './zip-write.mjs'

// Builds synthetic .xlsx workbooks part by part (SpreadsheetML), so that sizes,
// counts, part order and hostile content can be controlled exactly. Only
// invented data is ever written.

export function columnName(n) {
  let s = ''
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s
  return s
}

export function xmlText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const EPOCH = Date.UTC(1899, 11, 30)

function cellXml(ref, value, strings) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return `<c r="${ref}"><v>${String(value)}</v></c>`
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`
  if (value instanceof Date) return `<c r="${ref}" s="1"><v>${String((value.getTime() - EPOCH) / 86_400_000)}</v></c>`
  if (typeof value === 'object' && 'f' in value) return `<c r="${ref}"><f>${xmlText(value.f)}</f><v>${String(value.v)}</v></c>`
  if (typeof value === 'object' && 'raw' in value) return value.raw
  if (strings === undefined) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(String(value))}</t></is></c>`
  let index = strings.map.get(value)
  if (index === undefined) {
    index = strings.list.length
    strings.map.set(value, index)
    strings.list.push(value)
  }
  strings.count += 1
  return `<c r="${ref}" t="s"><v>${String(index)}</v></c>`
}

export function sheetXml(sheet, strings) {
  const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">']
  if (sheet.before !== undefined) parts.push(sheet.before)
  parts.push('<sheetData>')
  let r = 0
  for (const row of sheet.rows) {
    r += 1
    const cells = []
    row.forEach((value, i) => cells.push(cellXml(`${columnName(i + 1)}${String(r)}`, value, strings)))
    parts.push(`<row r="${String(r)}">${cells.join('')}</row>`)
  }
  parts.push('</sheetData>')
  if (sheet.after !== undefined) parts.push(sheet.after)
  parts.push('</worksheet>')
  return parts.join('')
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>'

/**
 * @param {{sheets: Array<{name: string, rows: Iterable<unknown[]>, before?: string, after?: string, xml?: string}>,
 *   sharedStrings?: boolean, order?: 'excel'|'sstFirst', extra?: Array<{name: string, data: string|Buffer}>,
 *   level?: number, zip?: object, edit?: (entries: object[]) => void}} spec
 */
export function buildXlsx(spec) {
  const strings = spec.sharedStrings === false ? undefined : { map: new Map(), list: [], count: 0 }
  const sheets = spec.sheets.map((s, i) => ({ name: `xl/worksheets/sheet${String(i + 1)}.xml`, data: s.xml ?? sheetXml(s, strings) }))
  const n = spec.sheets.length
  const types = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>']
  if (strings !== undefined) types.push('<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>')
  for (let i = 1; i <= n; i += 1) types.push(`<Override PartName="/xl/worksheets/sheet${String(i)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
  types.push('</Types>')
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  const book = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${spec.sheets.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${String(i + 1)}" r:id="rId${String(i + 1)}"/>`).join('')}</sheets></workbook>`
  const bookRels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
  for (let i = 1; i <= n; i += 1) bookRels.push(`<Relationship Id="rId${String(i)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(i)}.xml"/>`)
  bookRels.push(`<Relationship Id="rId${String(n + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`)
  if (strings !== undefined) bookRels.push(`<Relationship Id="rId${String(n + 2)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`)
  bookRels.push('</Relationships>')

  const head = [
    { name: '[Content_Types].xml', data: types.join('') },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: book },
    { name: 'xl/_rels/workbook.xml.rels', data: bookRels.join('') }
  ]
  const tail = [{ name: 'xl/styles.xml', data: STYLES }]
  if (strings !== undefined) {
    tail.push({
      name: 'xl/sharedStrings.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${String(strings.count)}" uniqueCount="${String(strings.list.length)}">${strings.list.map((s) => `<si><t xml:space="preserve">${xmlText(s)}</t></si>`).join('')}</sst>`
    })
  }
  const entries = spec.order === 'sstFirst' ? [...head, ...tail, ...sheets] : [...head, ...sheets, ...tail]
  entries.push(...(spec.extra ?? []))
  for (const e of entries) e.level ??= spec.level ?? 6
  spec.edit?.(entries)
  return writeZip(entries, spec.zip)
}

/** Deterministic pseudo-random numbers (mulberry32), so every run builds identical files. */
export function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
