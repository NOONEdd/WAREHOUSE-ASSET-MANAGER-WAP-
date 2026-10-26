import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? listSourceFiles(full) : /\.(ts|js|mjs)$/.test(name) ? [full] : []
  })
}

describe('server test harness (Phase 1A skeleton)', () => {
  it('runs TypeScript tests under the Node version this package requires', () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(24)
  })

  // The desktop app and the web server must stay independent until cutover:
  // the server may COPY reviewed pure modules, but must never import from the
  // desktop tree or from Electron / better-sqlite3 (SQLite is only ever used
  // by the one-off ETL extractor, which does not live in server/src).
  it('keeps server/src isolated from the desktop code and its native/Electron dependencies', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(join(serverRoot, 'src'))) {
      const text = readFileSync(file, 'utf8')
      if (/from\s+['"](?:\.\.\/)+(?:src\/main|src\/renderer|src\/preload)/.test(text)) offenders.push(`${file}: imports desktop source`)
      if (/(?:from|require\()\s*['"](?:electron|better-sqlite3)['"]/.test(text)) offenders.push(`${file}: imports electron/better-sqlite3`)
    }
    expect(offenders).toEqual([])
  })
})
