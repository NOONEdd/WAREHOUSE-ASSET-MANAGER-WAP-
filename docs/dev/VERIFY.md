# Verifying the desktop app (Phase 1A)

## Protected baseline

The last desktop-only commit is **`efbd65a`**, protected by the annotated tag
**`desktop-baseline-efbd65a`**. Phase 1 work happens on branches (`phase-1a/...`);
the tag must never be moved. To confirm the desktop application's code, assets and build config are unchanged:

```
git diff --stat desktop-baseline-efbd65a -- src resources electron.vite.config.js electron-builder.yml vitest.config.mjs index.html
```

An empty result means nothing the desktop app is built from has changed since the baseline.

## One command

```
npm ci --ignore-scripts
npm run verify
```

`verify` = `verify:env` (Node version vs `engines`, better-sqlite3 native binding loads) →
`npm test` (vitest, all desktop tests) → `npm run build` (electron-vite production build).
It stops at the first failing step and exits non-zero. It never opens or modifies any real
database (tests create temporary files; the env check uses an in-memory database) and never builds an installer.

### Why `--ignore-scripts`  (correction of an earlier version of this file)

An earlier version of this file said to run a plain `npm ci` on Windows "so the native binding is set up".
That was wrong. Verified in Phase 1A closure:

- `better-sqlite3@13.0.2` ships prebuilt N-API binaries (including `win32-x64`) inside the package.
- The lockfile marks it `hasInstallScript: true`, so a plain `npm ci` runs `node-gyp rebuild`, which compiles
  from source and needs Python, a C++ toolchain (Visual Studio Build Tools on Windows) and Node headers.
  Without them it fails at the configure step. This was reproduced on npm 10.9.9 and npm 11.21.1.
- `npm ci --ignore-scripts` skips that compile and uses the shipped prebuilt binary, which `verify:env` then loads.

`--ignore-scripts` also skips the other install scripts in the lockfile: `electron-winstaller`, `esbuild` (two
versions) and `fsevents` (macOS only). That is sufficient for `verify` (the tests and `electron-vite build` passed in
this mode on Linux). It has **not** been verified that an `--ignore-scripts` install can *launch* the desktop app
(Electron 43 has no install script in the lockfile, but its binary download path was not examined); launching the
app is outside Phase 1A and outside `verify`. If `verify:env` ever
reports that better-sqlite3 failed to load, reinstall with `npm ci --ignore-scripts` using the same Node version
you will run the tests with.

## Expected results (Linux, evidence from Phase 1A closure)

| Step | Expected | Observed (Node 22.23.4 / npm 10.9.9 and Node 24.22.1 / npm 11.21.1) |
|---|---|---|
| `npm ci --ignore-scripts` | exit 0 | exit 0 on both |
| `npm run verify:env` | `verify:env OK (...)` | OK on both |
| `npm test` | 37 files, 533 tests, all pass | 37 files, 533/533 passed on both |
| `npm run build` | exit 0, `out/` produced | exit 0 on both (no installer is built) |
| `npm run verify` (chained) | exit 0 | exit 0 on both |

Node: `engines.node` is `>=22.13.0` (the highest floor among the locked dependencies, which is `pdfjs-dist`).
`.nvmrc` currently says `22`. The decision about aligning it with the server's Node 24 is in
`docs/decisions/phase-1b-readiness-decision-sheet.md` (T-1); it has **not** been applied.

## Windows verification — NOT yet performed

Nothing in this repository has been run on Windows by the assistant. The results above come from a Linux
sandbox. To verify on the owner's Windows PC, in PowerShell, from the repository folder:

```
node --version
npm --version
npm ci --ignore-scripts
npm run verify:env
npm test
npm run build
npm run verify
git status --short
git diff --stat desktop-baseline-efbd65a -- src resources electron.vite.config.js electron-builder.yml vitest.config.mjs index.html
```

Record each command's exit status and the final test summary line. Acceptance: Node ≥ 22.13.0; every command
succeeds; the test summary says 533 passed; `git status --short` shows nothing unexpected; the `git diff --stat`
is empty. These steps create `node_modules/` and `out/` (both ignored by git); nothing else is written, no
installer is built, and no real database is touched.

Environment-specific uncertainty that Linux results cannot remove:

- **Path and line-ending handling.** Tests build temporary database paths; Windows path separators, short
  (8.3) names and CRLF checkouts (`core.autocrlf`) are untested.
- **Antivirus/file locking.** Windows may lock the temporary SQLite files that tests delete in teardown.
- **better-sqlite3 prebuilt binary on the owner's exact Node version/architecture** (win32-x64 is shipped for
  this release, but loading it on that machine is unverified; `verify:env` tests exactly that).
- **Long paths.** A deeply nested checkout folder can exceed legacy path limits.
- **Locale.** Persian-locale Windows behavior of date/number formatting in tests is untested.

If a Windows result differs from the table, treat it as new evidence to investigate, not as a reason to edit tests.

## Dependency integrity

`npm run verify:audit` (`npm audit --omit=dev`) is **not** part of `verify`: it needs the network and currently
reports known findings (e.g. `xlsx@0.18.5`, no fixed version on npm). It becomes a gate once decision D-15
(xlsx handling) is made for the desktop — its server-side part was decided on 2026-10-27; its desktop scope is still
open (decision register). Registry-signature verification of the lockfiles is a separate, reproducible
procedure: see [`DEPENDENCY_VERIFICATION.md`](DEPENDENCY_VERIFICATION.md).

## Server

`server/` is a separate package (Phase 1B-1 foundation; see `server/README.md`). Its checks are
`cd server && npm ci --ignore-scripts && npm run verify` (Node 24) and are not part of the root `verify`.
Its integration tests need PostgreSQL 16+ server programs and a non-root user (WSL2 on Windows).

## Test dispositions

See [`docs/testing/phase-1a-test-dispositions.md`](../testing/phase-1a-test-dispositions.md): what happened to
the 23 baseline failures, with the old→new mapping.
