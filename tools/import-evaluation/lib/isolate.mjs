import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { LIMITS } from './limits.mjs'

// Runs one parse in a separate, confined process (decision E-18: "isolated
// processing with an actual resource limit"). Layers, each enforced outside the
// parser's own code:
//   1. kernel: prlimit sets RLIMIT_DATA (every private writable mapping, so
//      Buffers and V8 heap alike), RLIMIT_CORE=0, RLIMIT_FSIZE=0, RLIMIT_NOFILE;
//   2. V8: --max-old-space-size, so heap growth fails before the kernel limit;
//   3. this supervisor: a resident-memory (VmRSS) watchdog, a wall-clock kill,
//      and a cap on the bytes the child may send back;
//   4. Node's permission model: reads only the evaluation folder; no file
//      writes, no child processes, no worker threads, no native add-ons;
//   5. optional: a new network namespace (unshare -r -n), so no network at all.
// The child gets an empty environment, so no secret reaches it.

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const MiB = 1024 * 1024

let networkIsolation
/** Whether an unprivileged network namespace can be created on this host. */
export function canIsolateNetwork() {
  if (networkIsolation === undefined) {
    const r = spawnSync('unshare', ['-r', '-n', '--', 'true'], { env: {}, timeout: 5000 })
    networkIsolation = r.status === 0
  }
  return networkIsolation
}

function readStatus(pid) {
  try {
    const text = readFileSync(`/proc/${String(pid)}/status`, 'utf8')
    const kib = (key) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? 0)
    return { rss: kib('VmRSS'), hwm: kib('VmHWM'), data: kib('VmData') }
  } catch {
    return undefined
  }
}

/**
 * @param {{mode: string, input: Buffer, limits?: object, memory: {dataMiB: number, heapMiB: number, rssMiB: number},
 *   script?: string, network?: boolean, permission?: boolean, args?: string[], allowTempFiles?: boolean, tmpDir?: string, keepRows?: boolean}} job
 */
export function runIsolated(job) {
  const limits = { ...LIMITS, ...(job.limits ?? {}) }
  const script = job.script ?? join(here, 'parse-child.mjs')
  const node = [
    process.execPath,
    `--max-old-space-size=${String(job.memory.heapMiB)}`,
    '--v8-pool-size=1',
    ...(job.permission === false || job.allowTempFiles === true ? [] : ['--permission', `--allow-fs-read=${root}`]),
    script,
    job.mode,
    JSON.stringify(job.limits ?? {}),
    ...(job.args ?? [])
  ]
  // allowTempFiles exists only to test ExcelJS's streaming reader, which writes
  // worksheets to temporary files; the confined design never sets it.
  const prlimit = [
    'prlimit',
    `--data=${String(job.memory.dataMiB * MiB)}`,
    '--core=0',
    ...(job.allowTempFiles === true ? [] : ['--fsize=0']),
    '--nofile=64',
    '--',
    ...node
  ]
  const argv = job.network === false || !canIsolateNetwork() ? prlimit : ['unshare', '-r', '-n', '--', ...prlimit]
  const started = process.hrtime.bigint()
  const env = job.allowTempFiles === true ? { UV_THREADPOOL_SIZE: '1', TMPDIR: job.tmpDir } : { UV_THREADPOOL_SIZE: '1' }
  const child = spawn(argv[0], argv.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] })

  return new Promise((resolve) => {
    let reason
    let peakRss = 0
    let peakData = 0
    let outBytes = 0
    let pending = ''
    const decoder = new StringDecoder('utf8')
    let result
    const rows = createHash('sha256')
    let rowCount = 0
    let replacementRows = 0
    const kept = []
    let stderr = ''
    const outCap = limits.decompressedBytes * 3

    const kill = (why) => {
      if (reason === undefined) reason = why
      child.kill('SIGKILL')
    }
    const sample = () => {
      const s = readStatus(child.pid)
      if (s === undefined) return
      // VmHWM is the high-water mark of this process image only. (getrusage's
      // maxRSS is not used: Linux carries it across exec from the forked
      // supervisor, so it would include the supervisor's own memory.)
      if (s.hwm > peakRss) peakRss = s.hwm
      if (s.data > peakData) peakData = s.data
      if (s.rss > job.memory.rssMiB * 1024) kill('memory-watchdog')
    }
    const watchdog = setInterval(sample, 20)
    const timer = setTimeout(() => kill('timeout'), limits.wallClockMs)

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes > outCap) return kill('output-cap')
      // Only the new text is searched for line ends, so one very long line
      // (a 90 MiB cell) costs linear time, not quadratic.
      const text = decoder.write(chunk)
      let from = 0
      for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', from)) {
        const line = pending + text.slice(from, nl)
        pending = ''
        from = nl + 1
        if (line.startsWith('{"row":')) {
          rows.update(line)
          rows.update('\n')
          rowCount += 1
          // U+FFFD in the output means text was damaged on the way (the corpus never contains it).
          if (line.includes('\ufffd')) replacementRows += 1
          if (job.keepRows === true && kept.length < 200 && line.length < 1_000_000) kept.push(JSON.parse(line).row)
        } else if (line.startsWith('{"result":')) {
          try {
            result = JSON.parse(line).result
          } catch {
            kill('protocol')
          }
        } else {
          kill('protocol')
        }
      }
      pending += text.slice(from)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16384) stderr += chunk.toString('utf8').slice(0, 16384 - stderr.length)
    })
    child.stdin.on('error', () => {}) // the child may exit before reading everything
    child.stdin.end(job.input)

    child.on('close', (code, signal) => {
      clearInterval(watchdog)
      clearTimeout(timer)
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6
      let outcome
      if (reason === 'timeout') outcome = 'timeout'
      else if (reason === 'memory-watchdog') outcome = 'memory'
      else if (reason !== undefined) outcome = 'refused'
      else if (code === 0 && result?.ok === true) outcome = 'ok'
      else if (code === 0 && result?.ok === false) outcome = result.code === 'PARSE' ? 'parse-error' : result.code === 'MEMORY' ? 'memory' : 'refused'
      else if (/out of memory|heap limit|Allocation failed|Failed to reserve|Failed to allocate memory|ERR_MEMORY_ALLOCATION_FAILED/i.test(stderr)) outcome = 'memory'
      else outcome = 'crash'
      resolve({
        outcome,
        reason: reason ?? (outcome === 'memory' ? 'kernel-or-heap-limit' : undefined),
        code,
        signal,
        wallMs: Math.round(wallMs),
        peakRssMiB: Math.round(Math.max(peakRss, result?.rssKiB ?? 0) / 1024),
        peakVmDataMiB: Math.round(peakData / 1024),
        rows: rowCount,
        rowsDigest: rows.digest('hex'),
        replacementRows,
        keptRows: job.keepRows === true ? kept : undefined,
        outputMiB: Math.round((outBytes / MiB) * 10) / 10,
        result,
        stderrHead: outcome === 'ok' ? undefined : stderr.split('\n').filter((l) => /Error|memory|denied|ERR_/i.test(l)).slice(0, 3).join(' | ')
      })
    })
  })
}
