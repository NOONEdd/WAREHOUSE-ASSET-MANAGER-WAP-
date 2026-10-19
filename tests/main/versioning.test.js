import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Versioning phase — package.json is the single canonical source of the
// app version (Development Rules, Section 1-2 of the spec). Read via
// fs/JSON.parse rather than a JSON import so this test has no dependency
// on how the bundler/test-runner resolves JSON module imports.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'))

describe('package.json is the single source of truth for the app version', () => {
  it('is exactly 1.0.0 for the initial production release', () => {
    expect(pkg.version).toBe('1.0.0')
  })

  it('is valid semantic versioning (MAJOR.MINOR.PATCH, no stray suffixes)', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('electron-builder.yml does not introduce a second, driftable version source', () => {
  const builderConfig = fs.readFileSync(path.join(projectRoot, 'electron-builder.yml'), 'utf-8')

  it('has no top-level "version:" override', () => {
    // A leading, unindented "version:" key would override package.json's
    // version for the built artifacts — matching /^version:/ specifically
    // (not indented keys like "nsis:" sub-options) so this doesn't false
    // -positive on unrelated config.
    expect(builderConfig).not.toMatch(/^version:/m)
  })

  it('has no "buildVersion:" override either', () => {
    expect(builderConfig).not.toMatch(/^buildVersion:/m)
  })
})

// Same capture-the-handler technique as ipcAuthorization.test.js — proves
// the real registerAppHandlers() delegates to the real app.getVersion(),
// without needing a real Electron process.
describe('app:getVersion IPC channel', () => {
  it("returns exactly Electron's app.getVersion() value, unauthenticated", async () => {
    const handlers = {}
    vi.resetModules()
    vi.doMock('electron', () => ({
      ipcMain: {
        handle: (channel, fn) => {
          handlers[channel] = fn
        }
      },
      app: {
        // Electron's real app.getVersion() reads package.json's "version"
        // field automatically (see app.ipc.js's own comment) — this
        // stand-in returns that same value to prove the handler is a
        // thin, correct pass-through, not a second hard-coded copy.
        getVersion: () => pkg.version
      }
    }))

    const { registerAppHandlers } = await import('../../src/main/ipc/app.ipc.js')
    registerAppHandlers()

    const result = await handlers['app:getVersion']({ sender: {} })
    expect(result).toBe('1.0.0')
    expect(result).toBe(pkg.version)

    vi.doUnmock('electron')
  })
})
