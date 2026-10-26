// Phase 1A — environment gate used by `npm run verify`.
//
// Fails fast, with a plain-language message, when the machine cannot run the
// project's tests/build reliably. Checks only two things that have actually
// caused "works on my machine" differences here:
//   1. The Node.js version satisfies package.json "engines.node".
//   2. The better-sqlite3 native binding loads and can open a database
//      (an install done with --ignore-scripts, or for the wrong platform,
//      otherwise surfaces as dozens of confusing test failures).
// It touches no project database: the SQLite check uses an in-memory DB.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const failures = []

const range = pkg.engines?.node ?? ''
const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range)
if (!floor) {
  failures.push(`package.json engines.node must look like ">=22.13.0" (found "${range}")`)
} else {
  const need = floor.slice(1).map(Number)
  const have = process.versions.node.split('.').map(Number)
  const ok = have[0] !== need[0] ? have[0] > need[0] : have[1] !== need[1] ? have[1] > need[1] : have[2] >= need[2]
  if (!ok) failures.push(`Node.js ${process.versions.node} is too old; this project requires ${range}.`)
}

try {
  const Database = createRequire(join(root, 'package.json'))('better-sqlite3')
  const db = new Database(':memory:')
  db.prepare('SELECT 1').get()
  db.close()
} catch (err) {
  failures.push(
    `better-sqlite3 failed to load (${err.message.split('\n')[0]}). ` +
      'Reinstall with "npm ci --ignore-scripts": better-sqlite3 ships prebuilt binaries, whereas a plain "npm ci" ' +
      'runs "node-gyp rebuild", which needs Python, C++ build tools and Node headers. See docs/dev/VERIFY.md.'
  )
}

if (failures.length > 0) {
  console.error('verify:env FAILED')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`verify:env OK (Node ${process.versions.node}, engines ${range}, better-sqlite3 loads)`)
