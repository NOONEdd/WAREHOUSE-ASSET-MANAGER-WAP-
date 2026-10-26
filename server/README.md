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

`typescript@6.0.3` (released 2026-04-16; the newer 7.x native-compiler major is
deliberately not adopted yet), `vitest@4.1.10` (same as the desktop app),
`@types/node@24.19.2`.

## Commands (Node 24 required; see `.nvmrc`)

```
cd server
npm ci
npm run verify      # typecheck + tests
```
