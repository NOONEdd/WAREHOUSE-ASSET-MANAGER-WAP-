# server/ — WAM web server (Phase 1A skeleton)

This directory is **intentionally empty of application code**. Phase 1A only creates
an isolated place for the future Node 24 + TypeScript backend and proves its test
harness runs. Nothing here is used by, or can affect, the Electron desktop app:

- It has its own `package.json`, lockfile and `node_modules` (root `npm ci` does not touch it).
- The root `npm test` / `npm run verify` do not run these tests; `electron-vite build` and
  `electron-builder` never look in this folder.
- `src/` must never import from `../src/main`, `../src/renderer`, `electron` or
  `better-sqlite3` (enforced by `tests/harness.test.ts`).

## Not here yet (Phase 1B, needs separate authorization)

Fastify, PostgreSQL / `pg` / Kysely, migrations, auth, sessions, assets API, ETL.
Runtime dependencies were deliberately **not** added; versions will be verified against
the registry at the start of Phase 1B.

## Dev tooling pinned in Phase 1A (exact versions, verified on the npm registry)

- `typescript@6.0.3` — kept deliberately. TypeScript 7.0 (the native-compiler major) is not adopted: its stable
  programmatic API is not available until 7.1, and `typescript-eslint` (needed for the planned
  `no-floating-promises` rule) declares a peer range of `<6.1.0`. See
  `docs/decisions/phase-1b-readiness-decision-sheet.md` (T-3).
- `vitest@4.1.12` — bumped from 4.1.10 (the version the desktop app uses) because `npm audit` reported two
  moderate advisories against 4.1.10 in this package; 4.1.12 has none (`npm audit`: 0 vulnerabilities) and carries a
  provenance attestation. The root `vitest` pin is **unchanged** (needs owner approval; sheet item T-6).
- `@types/node@24.19.2` — matches the Node 24 line.

Install and run with `npm ci --ignore-scripts` (there are no install scripts to run; the flag only avoids surprises).

## Commands (Node 24 required; see `.nvmrc`)

```
cd server
npm ci --ignore-scripts
npm run verify      # typecheck + tests
```
