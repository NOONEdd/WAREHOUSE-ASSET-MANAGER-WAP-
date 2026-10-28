// Evaluation only: a deliberately misbehaving child, started through the same
// isolate.mjs path as the parser, to prove that each confinement layer stops it
// without help from the child's own code. Never part of the design.
import { Worker } from 'node:worker_threads'

const mode = process.argv[2]

function done(result) {
  process.stdout.write(`${JSON.stringify({ result: { ok: true, ...result, rssKiB: Math.round(process.memoryUsage().rss / 1024) } })}\n`)
}

// Discard stdin; the isolate always sends input.
process.stdin.resume()

switch (mode) {
  case 'heap': {
    const keep = []
    for (;;) keep.push({ a: Math.random(), b: `x${String(keep.length)}`, c: [keep.length] })
  }
  case 'buffers': {
    const keep = []
    for (;;) keep.push(Buffer.alloc(16 * 1024 * 1024, 1)) // filled, so the pages are resident
  }
  case 'spin': {
    for (;;);
  }
  case 'busy': {
    // Legitimate work of a known duration, for the wall-clock boundary.
    const ms = Number(process.argv[4])
    const until = Date.now() + ms
    while (Date.now() < until);
    done({ busyMs: ms })
    process.exit(0)
  }
  case 'escape': {
    const fs = await import('node:fs')
    const cp = await import('node:child_process')
    const net = await import('node:net')
    const attempt = (fn) => {
      try {
        fn()
        return 'allowed'
      } catch (err) {
        return String(err.code ?? err.name)
      }
    }
    const write = attempt(() => fs.writeFileSync('/tmp/wam-eval-escape-test', 'x'))
    const read = attempt(() => fs.readFileSync('/etc/hostname'))
    const spawn = attempt(() => cp.execFileSync('/bin/true'))
    const worker = attempt(() => new Worker('process.exit(0)', { eval: true }).terminate())
    const network = await new Promise((resolve) => {
      const port = Number(process.argv[4])
      const socket = net.connect(port, '127.0.0.1')
      socket.setTimeout(3000, () => resolve('timeout'))
      socket.on('connect', () => resolve('allowed'))
      socket.on('error', (err) => resolve(String(err.code)))
    })
    done({ write, read, spawn, worker, network, envKeys: Object.keys(process.env).sort() })
    process.exit(0)
  }
  case 'worker-buffers':
  case 'worker-heap': {
    // A worker thread with the tightest heap limit Node offers. Buffers live
    // outside that limit; plain objects do not.
    const source = mode === 'worker-buffers'
      ? 'const k = []; for (let i = 0; i < 64; i += 1) k.push(Buffer.alloc(16 * 1024 * 1024, 1)); require("worker_threads").parentPort.postMessage(k.length * 16)'
      : 'const k = []; for (;;) k.push({ a: Math.random(), b: [k.length] })'
    const worker = new Worker(source, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } })
    const outcome = await new Promise((resolve) => {
      worker.on('message', (mib) => resolve({ workerFinished: true, allocatedMiB: mib }))
      worker.on('error', (err) => resolve({ workerFinished: false, error: String(err.code ?? err.name) }))
    })
    await worker.terminate()
    done({ worker: outcome, mainThreadAlive: true })
    process.exit(0)
  }
  default:
    throw new Error('unknown mode')
}
