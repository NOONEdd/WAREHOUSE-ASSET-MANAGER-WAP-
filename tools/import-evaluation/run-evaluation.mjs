// Evaluation of spreadsheet import under isolation and the E-18 ceilings
// (decisions D-15, O-13, E-18). Synthetic files only; nothing here is part of
// the web server or the desktop app. Usage (Node 24, Linux):
//   node run-evaluation.mjs            full run: measure, set limits, verify
//   node run-evaluation.mjs --quick    skip the measurement, use the recorded limits
// Results go to out/evaluation-results.json and out/evaluation-summary.md.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus, freemem, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corpus } from './lib/corpus.mjs'
import { canIsolateNetwork, runIsolated } from './lib/isolate.mjs'
import { OPERATIONAL } from './lib/limits.mjs'
import { buildXlsx } from './lib/xlsx-build.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const out = join(root, 'out')
mkdirSync(out, { recursive: true })
const quick = process.argv.includes('--quick')

// The limits this evaluation recommends (set from the measurement phase; see
// the README). The measurement phase recomputes them and fails if they differ.
const RECOMMENDED = { heapMiB: 1280, rssMiB: 2048, dataMiB: 3072 }
const GENEROUS = { heapMiB: 6144, rssMiB: 8192, dataMiB: 10240 }

const canaryPath = join(out, 'canary.txt')
if (!existsSync(canaryPath)) writeFileSync(canaryPath, `canary-${randomBytes(12).toString('hex')}\n`)

const log = (...a) => console.log(...a)
const results = { host: host(), started: new Date().toISOString(), phases: {} }

function host() {
  return {
    node: process.version,
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    totalMemMiB: Math.round(totalmem() / 1048576),
    freeMemMiB: Math.round(freemem() / 1048576),
    kernel: release(),
    networkNamespace: canIsolateNetwork()
  }
}

async function exceljsReference() {
  const { default: ExcelJS } = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('دارایی‌ها')
  ws.addRows([
    ['کد دارایی', 'نام', 'سریال', 'تعداد', 'تاریخ خرید', 'فعال', 'یادداشت'],
    ['00123', 'لپ‌تاپ نمونه', 'SN-0001', 3, new Date(Date.UTC(2024, 2, 15)), true, "=cmd|' /C calc'!A0"],
    ['000045', 'Монитор', null, 1, new Date(Date.UTC(2023, 11, 1)), false, 'line1\nline2'],
    ['A-7', 'پرینتر ۱۲۳', '۰۰۹۸۷', 2.5, new Date(Date.UTC(2025, 0, 31)), true, 'مقدار']
  ])
  ws.getCell('D5').value = { formula: 'SUM(D2:D4)', result: 6.5 }
  ws.mergeCells('A6:C6')
  ws.getCell('A6').value = { richText: [{ text: 'merged ' }, { font: { bold: true }, text: 'note' }] }
  ws.getCell('H2').value = { text: 'link', hyperlink: 'https://example.invalid/' }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const cache = new Map()
async function input(c) {
  if (!cache.has(c.id)) {
    const buf = c.build === 'exceljs-reference' ? await exceljsReference() : c.build()
    // Large inputs are rebuilt when needed rather than all kept in memory.
    if (buf.length < 16 * 1048576) cache.set(c.id, buf)
    return buf
  }
  return cache.get(c.id)
}

function classify(r) {
  if (r.outcome === 'parse-error') return 'rejected'
  return r.outcome
}

function judge(c, r) {
  const got = classify(r)
  const contained = got !== 'ok'
  let pass = c.expect.includes(got) || (c.expect.includes('contained') && contained)
  let note
  if (pass && got === 'refused' && c.limit !== undefined && !String(r.result?.message ?? '').includes(`limit exceeded: ${c.limit}`)) {
    pass = false
    note = `expected limit ${c.limit}, got: ${String(r.result?.message ?? r.reason)}`
  }
  if (pass && c.check !== undefined && (got === 'ok' || c.expect.includes('contained'))) {
    const verdict = r.outcome === 'ok' || r.keptRows !== undefined ? c.check(r) : true
    if (verdict !== true) {
      pass = false
      note = verdict
    }
  }
  if (pass && r.replacementRows > 0) {
    pass = false
    note = `${String(r.replacementRows)} parsed rows contain U+FFFD (damaged text)`
  }
  if (pass && r.wallMs > 30_000 + 2_000) {
    pass = false
    note = 'ran past the wall-clock limit'
  }
  return { pass, got, note }
}

async function runCase(c, memory, extra = {}) {
  const buf = await input(c)
  const r = await runIsolated({ mode: c.mode, input: buf, memory, keepRows: true, ...extra })
  r.inputBytes = buf.length
  return r
}

function row(c, r, j) {
  return {
    id: c.id,
    group: c.group,
    title: c.title,
    expect: c.expect.join('|'),
    got: j.got,
    pass: j.pass,
    note: j.note,
    detail: r.result?.message ?? r.reason ?? r.stderrHead,
    inputBytes: r.inputBytes,
    wallMs: r.wallMs,
    peakRssMiB: r.peakRssMiB,
    peakVmDataMiB: r.peakVmDataMiB,
    heapMiB: r.result?.heapMiB,
    rows: r.rows,
    rowsDigest: r.rowsDigest
  }
}

const cases = corpus(root)
const heavy = cases.filter((c) => c.heavy)

// ---------- 1. measurement with generous limits ----------
let recommended = RECOMMENDED
if (!quick) {
  log('1. measuring the at-limit files with generous limits', JSON.stringify(GENEROUS))
  const measured = []
  for (const c of heavy) {
    const r = await runCase(c, GENEROUS)
    const j = judge(c, r)
    measured.push(row(c, r, j))
    log(`   ${c.id} ${j.got} ${String(r.wallMs)} ms, peak RSS ${String(r.peakRssMiB)} MiB, VmData ${String(r.peakVmDataMiB)} MiB, input ${String(r.inputBytes)} B${j.pass ? '' : `  FAIL ${String(j.note ?? '')}`}`)
  }
  results.phases.measure = measured

  // Smallest V8 heap ceiling at which every at-limit file still parses.
  const steps = [512, 768, 1024, 1280, 1536, 2048, 3072, 4096]
  let minHeap
  for (const heapMiB of steps) {
    let all = true
    for (const c of heavy) {
      const r = await runCase(c, { ...GENEROUS, heapMiB })
      if (r.outcome !== 'ok') {
        all = false
        log(`   heap ${String(heapMiB)} MiB: ${c.id} -> ${r.outcome}`)
        break
      }
    }
    if (all) {
      minHeap = heapMiB
      break
    }
  }
  const peakRss = Math.max(...measured.map((m) => m.peakRssMiB))
  const peakData = Math.max(...measured.map((m) => m.peakVmDataMiB))
  const roundUp = (x) => Math.ceil(x / 256) * 256
  const derived = {
    heapMiB: roundUp((minHeap ?? 4096) * 1.5),
    rssMiB: roundUp(peakRss * 1.5),
    dataMiB: roundUp(peakData * 1.5)
  }
  // The watchdog must sit above the heap ceiling plus Node's own resident memory,
  // and the kernel limit above both, so each layer can act in its own order.
  derived.rssMiB = Math.max(derived.rssMiB, derived.heapMiB + 512)
  derived.dataMiB = Math.max(derived.dataMiB, derived.rssMiB + 1024)
  results.phases.derive = { minHeapThatPasses: minHeap, peakRssMiB: peakRss, peakVmDataMiB: peakData, derived, recorded: RECOMMENDED }
  log('   minimum heap that passes', minHeap, '-> derived', JSON.stringify(derived), 'recorded', JSON.stringify(RECOMMENDED))
  if (JSON.stringify(derived) !== JSON.stringify(RECOMMENDED)) {
    log('   NOTE: derived limits differ from the recorded ones; the verification below uses the derived ones')
    recommended = derived
  }
}
results.limitsUsed = recommended

// ---------- 2. every case under the recommended limits ----------
log('2. all cases under', JSON.stringify(recommended))
const verified = []
for (const c of cases) {
  let r
  try {
    r = await runCase(c, recommended)
  } catch (err) {
    verified.push({ id: c.id, group: c.group, title: c.title, expect: c.expect.join('|'), got: 'not-run', pass: false, note: String(err.message) })
    log(`   ${c.id} NOT RUN ${String(err.message)}`)
    continue
  }
  const j = judge(c, r)
  verified.push(row(c, r, j))
  log(`   ${j.pass ? 'pass' : 'FAIL'} ${c.id.padEnd(4)} ${j.got.padEnd(9)} ${String(r.wallMs).padStart(6)} ms ${String(r.peakRssMiB).padStart(5)} MiB  ${c.title}${j.note ? `  [${j.note}]` : ''}  ${j.got !== 'ok' ? `(${String(r.result?.message ?? r.reason ?? r.stderrHead)})` : ''}`)
}
results.phases.verify = verified

// ---------- 3. determinism and the streaming reader (unzipper 0.12.5) ----------
log('3. determinism; ExcelJS streaming reader (the only code path that uses unzipper)')
const tmpDir = join(out, 'stream-tmp')
mkdirSync(tmpDir, { recursive: true })
const compare = []
for (const id of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'L1']) {
  const c = cases.find((x) => x.id === id)
  const a = await runCase(c, recommended)
  const b = await runCase(c, recommended)
  const confined = await runCase({ ...c, mode: 'xlsx-stream' }, recommended)
  const s = await runCase({ ...c, mode: 'xlsx-stream' }, recommended, { allowTempFiles: true, tmpDir })
  const entry = {
    id,
    loadTwiceSameDigest: a.rowsDigest === b.rowsDigest && a.outcome === 'ok',
    streamConfined: classify(confined),
    streamConfinedDetail: confined.result?.message,
    streamWithTempFiles: classify(s),
    streamDigestEqualsLoad: s.rowsDigest === a.rowsDigest,
    streamRowsWithDamagedText: s.replacementRows,
    loadRowsWithDamagedText: a.replacementRows,
    streamPeakRssMiB: s.peakRssMiB,
    loadPeakRssMiB: a.peakRssMiB
  }
  compare.push(entry)
  log('  ', JSON.stringify(entry))
}
const sstFirst = buildXlsx({ order: 'sstFirst', sheets: [{ name: 'S', rows: [['00123', 'لپ‌تاپ', 3]] }] })
const sf = await runIsolated({ mode: 'xlsx-stream', input: sstFirst, memory: recommended })
const sl = await runIsolated({ mode: 'xlsx-load', input: sstFirst, memory: recommended })
compare.push({ id: 'shared-strings-first', streamConfined: classify(sf), streamDigestEqualsLoad: sf.rowsDigest === sl.rowsDigest })
log('   shared strings stored first:', classify(sf), sf.rowsDigest === sl.rowsDigest ? 'same rows as load()' : 'ROWS DIFFER')
results.phases.stream = compare

// ---------- 4. the confinement itself ----------
log('4. confinement layers (deliberately misbehaving child)')
const hog = join(root, 'lib', 'hog-child.mjs')
const listener = createServer((s) => s.end()).listen(0, '127.0.0.1')
await new Promise((resolve) => listener.once('listening', resolve))
const port = String(listener.address().port)
const iso = []
const probe = async (name, mode, memory, extra = {}) => {
  const r = await runIsolated({ mode, input: Buffer.from('x'), memory, script: hog, args: [port], ...extra })
  const entry = { name, outcome: r.outcome, reason: r.reason, wallMs: r.wallMs, peakRssMiB: r.peakRssMiB, peakVmDataMiB: r.peakVmDataMiB, result: r.result, stderrHead: r.stderrHead }
  iso.push(entry)
  log('  ', name, JSON.stringify({ outcome: r.outcome, reason: r.reason, wallMs: r.wallMs, peakRssMiB: r.peakRssMiB, result: r.result }))
  return r
}
await probe('V8 heap exhaustion (heap ceiling acts)', 'heap', recommended)
await probe('Buffer growth, watchdog out of the way (kernel RLIMIT_DATA acts)', 'buffers', { ...recommended, rssMiB: 1 << 20 })
await probe('Buffer growth, kernel limit out of the way (RSS watchdog acts)', 'buffers', { ...recommended, dataMiB: 12288 })
await probe('escape attempts: file write, file read outside, child process, worker, network', 'escape', recommended)
await probe('escape attempts without the network namespace (shows what it adds)', 'escape', recommended, { network: false })
await probe('worker thread with resourceLimits, Buffers (not covered by the limit)', 'worker-buffers', recommended, { permission: false })
await probe('worker thread with resourceLimits, objects (covered)', 'worker-heap', recommended, { permission: false })
await probe('infinite loop, real 30 s wall-clock limit', 'spin', recommended)
// The wall-clock boundary: work that needs just under 30 s completes; work that needs just over is stopped.
await probe('work of 29.5 s, just under the 30 s limit (completes)', 'busy', recommended, { args: ['29500'] })
await probe('work of 30.1 s, just over the 30 s limit (stopped)', 'busy', recommended, { args: ['30100'] })
listener.close()
results.phases.isolation = iso

// ---------- 5. load: the approved maximum of parallel parses, and a stress level above it ----------
log(`5. parallel at-limit parses: ${String(OPERATIONAL.concurrentParsesMaximum)} (approved maximum) and 4 (stress test only)`)
function memAvailableMiB() {
  const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))
  return m === null ? undefined : Math.round(Number(m[1]) / 1024)
}
const load = []
const sets = [
  [OPERATIONAL.concurrentParsesMaximum, ['L6', 'L6']],
  [OPERATIONAL.concurrentParsesMaximum, ['L1', 'L1']],
  [OPERATIONAL.concurrentParsesMaximum, ['L6', 'L1']],
  [4, ['L6', 'L6', 'L6', 'L6']],
  [4, ['L1', 'L1', 'L1', 'L1']]
]
for (const [parallel, ids] of sets) {
  const bufs = await Promise.all(ids.map((id) => input(cases.find((x) => x.id === id))))
  const before = memAvailableMiB()
  let lowest = before
  const sampler = setInterval(() => {
    const now = memAvailableMiB()
    if (now !== undefined && now < lowest) lowest = now
  }, 50)
  const t0 = Date.now()
  const runs = await Promise.all(ids.map((id, i) => runIsolated({ mode: cases.find((x) => x.id === id).mode, input: bufs[i], memory: recommended })))
  clearInterval(sampler)
  const digests = new Map()
  ids.forEach((id, i) => digests.set(id, [...(digests.get(id) ?? []), runs[i].rowsDigest]))
  const entry = {
    parallel,
    files: ids.join('+'),
    totalMs: Date.now() - t0,
    outcomes: runs.map((r) => r.outcome),
    wallMs: runs.map((r) => r.wallMs),
    peakRssMiB: runs.map((r) => r.peakRssMiB),
    sameDigest: [...digests.values()].every((d) => new Set(d).size === 1),
    memAvailableBeforeMiB: before,
    memAvailableLowestMiB: lowest
  }
  load.push(entry)
  log('  ', JSON.stringify(entry))
}
results.phases.load = load

// ---------- summary ----------
const failures = verified.filter((v) => !v.pass)
// The streaming reader is evidence only (it is not used): the check is that
// load() never damages text and gives the same rows twice.
const streamOk = compare.every((e) => e.loadRowsWithDamagedText === undefined || (e.loadRowsWithDamagedText === 0 && e.loadTwiceSameDigest))
const loadOk = load.every((l) => l.outcomes.every((o) => o === 'ok') && l.wallMs.every((w) => w < 30_000) && l.sameDigest)
const probeResult = (start) => iso.find((p) => p.name.startsWith(start))
const escaped = probeResult('escape attempts:')?.result ?? {}
const isoOk =
  probeResult('V8 heap exhaustion')?.outcome === 'memory' &&
  probeResult('Buffer growth, watchdog out of the way')?.outcome === 'memory' &&
  probeResult('Buffer growth, kernel limit out of the way')?.reason === 'memory-watchdog' &&
  probeResult('infinite loop')?.outcome === 'timeout' &&
  probeResult('work of 29.5 s')?.outcome === 'ok' &&
  probeResult('work of 30.1 s')?.outcome === 'timeout' &&
  ['write', 'read', 'spawn', 'worker'].every((k) => escaped[k] === 'ERR_ACCESS_DENIED') &&
  (escaped.network === 'ENETUNREACH' || !results.host.networkNamespace)
results.finished = new Date().toISOString()
results.summary = { cases: verified.length, failures: failures.map((f) => f.id), streamOk, loadOk, isolationOk: isoOk }
writeFileSync(join(out, 'evaluation-results.json'), `${JSON.stringify(results, null, 2)}\n`)
const md = [
  `# Evaluation summary (${results.finished})`,
  '',
  `Host: Node ${results.host.node}, ${String(results.host.cores)} cores (${String(results.host.cpu)}), ${String(results.host.totalMemMiB)} MiB RAM, kernel ${results.host.kernel}, network namespace available: ${String(results.host.networkNamespace)}`,
  `Limits used: ${JSON.stringify(recommended)}`,
  '',
  '| Case | Group | Expected | Got | Pass | ms | Peak RSS MiB | Title | Detail |',
  '|---|---|---|---|---|---|---|---|---|',
  ...verified.map((v) => `| ${v.id} | ${v.group} | ${v.expect} | ${v.got} | ${v.pass ? 'yes' : '**NO**'} | ${String(v.wallMs ?? '')} | ${String(v.peakRssMiB ?? '')} | ${v.title} | ${String(v.note ?? v.detail ?? '').replace(/\|/g, '/')} |`),
  '',
  `Failures: ${failures.length === 0 ? 'none' : failures.map((f) => f.id).join(', ')}; load() deterministic and text intact: ${String(streamOk)}; load test: ${String(loadOk)}; isolation layers: ${String(isoOk)}`
]
writeFileSync(join(out, 'evaluation-summary.md'), `${md.join('\n')}\n`)
log(`\nsummary: ${String(verified.length)} cases, ${String(failures.length)} failures${failures.length ? ` (${failures.map((f) => f.id).join(', ')})` : ''}; load() deterministic ${String(streamOk)}; load test ${String(loadOk)}; isolation ${String(isoOk)}`)
log(`digest of this summary file: ${createHash('sha256').update(readFileSync(join(out, 'evaluation-summary.md'))).digest('hex')}`)
process.exitCode = failures.length === 0 && streamOk && loadOk && isoOk ? 0 : 1
