// O-13: does the explicit move from unzipper ^0.10.11 (ExcelJS's declared range)
// to 0.12.5 change anything ExcelJS returns? Runs ExcelJS's streaming reader —
// the only code path that uses unzipper — on the same synthetic files with two
// installs and compares every cell. Usage:
//   node compare-unzipper.mjs <node_modules of an install WITHOUT the unzipper override>
// The second install is made in a throwaway folder outside the repository, e.g.
//   {"dependencies":{"exceljs":"4.4.0","csv-parse":"7.0.3"},"overrides":{"exceljs":{"uuid":"11.1.1"}}}
//   npm ci --ignore-scripts
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

async function one(modulesRoot) {
  const require = createRequire(join(modulesRoot, 'x.js'))
  const ExcelJS = require('exceljs')
  const { corpus } = await import('./lib/corpus.mjs')
  const { buildXlsx } = await import('./lib/xlsx-build.mjs')
  const cases = corpus(here)
  const files = {}
  for (const id of ['N1', 'N2', 'N4', 'N5', 'N6', 'L1', 'L2']) files[id] = cases.find((c) => c.id === id).build()
  files['N1-sharedStringsFirst'] = buildXlsx({ order: 'sstFirst', sheets: [{ name: 'S', rows: [['00123', 'Монитор', 3, new Date(Date.UTC(2024, 2, 15)), true]] }] })
  const val = (c) => (c.type === ExcelJS.ValueType.Formula ? { f: c.formula, r: c.result } : c.value)
  const out = {}
  for (const [id, buf] of Object.entries(files)) {
    const cells = []
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buf]), { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit', entries: 'ignore', hyperlinks: 'ignore' })
    let sheet = 0
    for await (const ws of reader) {
      sheet += 1
      for await (const row of ws) row.eachCell({ includeEmpty: false }, (c, col) => cells.push([sheet, row.number, col, val(c)]))
    }
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const loaded = new Map()
    wb.worksheets.forEach((ws, i) => ws.eachRow({ includeEmpty: false }, (row, n) => row.eachCell({ includeEmpty: false }, (c, col) => {
      if (c.type !== ExcelJS.ValueType.Merge) loaded.set(`${String(i + 1)}!${String(n)}:${String(col)}`, JSON.stringify(val(c)))
    })))
    const text = JSON.stringify(cells)
    out[id] = {
      streamCells: cells.length,
      differFromLoad: cells.filter((x) => loaded.get(`${String(x[0])}!${String(x[1])}:${String(x[2])}`) !== JSON.stringify(x[3])).length,
      unresolvedSharedStrings: cells.filter((x) => x[3] !== null && typeof x[3] === 'object' && 'sharedString' in x[3]).length,
      damagedText: (text.match(/�/g) ?? []).length,
      digest: createHash('sha256').update(text).digest('hex')
    }
  }
  return { unzipper: require('unzipper/package.json').version, exceljs: require('exceljs/package.json').version, out }
}

if (process.argv[2] === '--one') {
  process.stdout.write(`${JSON.stringify(await one(process.argv[3]))}\n`)
} else {
  const other = process.argv[2]
  if (other === undefined) throw new Error('usage: node compare-unzipper.mjs <other node_modules>')
  mkdirSync(join(here, 'out'), { recursive: true })
  const run = (root) => {
    // The streaming reader writes worksheets to temporary files; give each run its own folder.
    const tmp = mkdtempSync(join(here, 'out', 'compare-'))
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--one', root], { env: { TMPDIR: tmp }, encoding: 'utf8', maxBuffer: 1 << 24 })
    if (r.status !== 0) throw new Error(r.stderr)
    return JSON.parse(r.stdout)
  }
  const a = run(join(here, 'node_modules'))
  const b = run(other)
  let same = true
  console.log(`ExcelJS ${a.exceljs}: unzipper ${a.unzipper} (this folder) vs ${b.unzipper} (${other})`)
  for (const id of Object.keys(a.out)) {
    const x = a.out[id]
    const y = b.out[id]
    const identical = x.digest === y.digest
    same &&= identical
    console.log(`${id.padEnd(22)} identical output: ${String(identical).padEnd(5)}  cells ${String(x.streamCells).padStart(7)}  differ from load(): ${String(x.differFromLoad).padStart(4)}  unresolved shared strings: ${String(x.unresolvedSharedStrings).padStart(3)}  damaged text (U+FFFD): ${String(x.damagedText).padStart(3)}`)
  }
  console.log(same ? 'RESULT: the override changes nothing the streaming reader returns' : 'RESULT: OUTPUT DIFFERS between the two unzipper versions')
  process.exitCode = same ? 0 : 1
}
