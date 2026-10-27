# server/ — WAM web server

**Status: Phase 1B-2 (identity and access) in progress.** On top of the Phase 1B-1 foundation (configuration,
health endpoints, PostgreSQL, migrations, startup safety checks, test harness), the server now has users, sessions,
configurable permission profiles, warehouses, the owner CLI and an append-only audit trail. The binding rules are in
[`../docs/security/identity-and-access.md`](../docs/security/identity-and-access.md). There are still **no** asset,
import or reporting features; those are Phase 1B-3 onward.

Nothing here is used by, or can affect, the Electron desktop app:

- It has its own `package.json`, lockfile and `node_modules` (root `npm ci` does not touch it).
- The root `npm test` / `npm run verify` do not run these tests; `electron-vite build` and
  `electron-builder` never look in this folder.
- `src/` must never import from `../src/main`, `../src/renderer`, `electron` or
  `better-sqlite3` (enforced by `tests/harness.test.ts`).

## Requirements

- **Node.js 24** (see `.nvmrc`).
- **For the integration tests only:** PostgreSQL **16 or later** server programs (`initdb`, `pg_ctl`,
  `postgres`, `psql`) and a **normal, non-root user** (PostgreSQL refuses to run as root). No PostgreSQL
  *service* is needed: the tests start their own throwaway cluster. On Debian/Ubuntu or WSL2:
  `sudo apt install postgresql`; the packaged service can stay stopped. Programs are found under
  `/usr/lib/postgresql/<version>/bin`, on `PATH`, or in `WAM_TEST_PG_BINDIR`.
- Native Windows is not supported for the integration tests; use WSL2 (decision D-08).

## Commands

```
cd server
npm ci --ignore-scripts        # install exactly what package-lock.json pins
npm run verify                 # typecheck + lint + all tests + build; must end with exit code 0
```

| Command | What it does | Touches |
|---|---|---|
| `npm run typecheck` | strict TypeScript check | nothing |
| `npm run lint` | ESLint with type-aware rules (incl. `no-floating-promises`) | nothing |
| `npm run test:unit` | tests that need no database | nothing |
| `npm run test:integration` | tests against a **throwaway** PostgreSQL cluster | a temporary directory under the OS temp folder, deleted afterwards |
| `npm test` | both of the above | as above |
| `npm run build` | compiles `src/` to `dist/` | `dist/` (git-ignored) |
| `npm run db:migrate -- <command>` | migration CLI (after `build`) — see below | **the database in `WAM_MIGRATION_DATABASE_URL`** |
| `npm run owner -- <command>` | owner CLI (after `build`) — see below | **the database in `WAM_MIGRATION_DATABASE_URL`** |
| `npm start` | runs the server (after `build`) | the database in `WAM_DATABASE_URL` (read-only in 1B-1) |

## How the tests are kept away from real data

The integration tests never read a database address from the environment. They create a private cluster
in a fresh temporary directory that listens on **no TCP port** (only a Unix socket inside a directory only
your user can enter), give every role a random password, and stamp the cluster with a random per-run token
that every test connection must present. Any `PG*` or `WAM_*` variables in your shell are removed before
tests run. Details: `tests/support/ephemeralPostgres.ts`; the guarantees are themselves tested in
`tests/integration/testSafety.test.ts`.

## Configuration (environment variables)

The server does not read `.env` files. Values are validated together at startup; an invalid or missing
value stops the process with a list of every problem (never echoing the value).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `WAM_ENV` | yes | — | `development`, `test` or `production`. No default, so production can never silently run with development settings. |
| `WAM_DATABASE_URL` | yes (server) | — | `postgresql://wam_app:PASSWORD@HOST:PORT/wam`. Must be the **wam_app** role. |
| `WAM_MIGRATION_DATABASE_URL` | yes (migrations) | — | Same database, **wam_owner** role. Never give this to the server. |
| `WAM_PUBLIC_ORIGIN` | yes (server) | — | The address users open, e.g. `https://wam.example` (origin only, no path). State-changing requests must come from it. **Must be `https://` when `WAM_ENV=production`**; `http://` (development and tests only) switches the session cookie to its non-`Secure` development form. |
| `WAM_SESSION_IDLE_MINUTES` | no | `30` | Sign-out after this much inactivity (5–240). |
| `WAM_SESSION_ABSOLUTE_HOURS` | no | `12` | Sign-out after this long regardless of activity (1–24). |
| `WAM_HTTP_HOST` | no | `127.0.0.1` | Loopback: in production the server sits behind a reverse proxy on the same machine. |
| `WAM_HTTP_PORT` | no | `3000` | |
| `WAM_DB_POOL_MAX` | no | `10` | Connections per server process (1–100). |
| `WAM_DB_STATEMENT_TIMEOUT_MS` | no | `15000` | Per-statement limit for the server (100–600000). |
| `WAM_LOG_LEVEL` | no | `info` | `fatal` `error` `warn` `info` `debug` `trace` `silent`. Logs are JSON on stdout. |

For a Unix-socket connection, put the percent-encoded socket directory where the host goes:
`postgresql://wam_app:PASSWORD@%2Fvar%2Frun%2Fpostgresql:5432/wam`.

## Setting up a database (one time, as a PostgreSQL superuser)

```
psql -v ON_ERROR_STOP=1 -f server/sql/create-roles.sql          # once per PostgreSQL cluster
psql -c '\password wam_owner'                                    # type passwords interactively
psql -c '\password wam_app'
psql -v ON_ERROR_STOP=1 -v dbname=wam -f server/sql/create-database.sql
```

The two roles are fixed by name. `wam_owner` owns the schema and is used only for migrations; `wam_app` is
what the server uses and can never change the schema. The tests run these same two files.

## Migrations

```
npm run build
export WAM_ENV=development WAM_MIGRATION_DATABASE_URL='postgresql://wam_owner:…@…/wam'
npm run db:migrate -- status          # read-only: applied / pending
npm run db:migrate -- up              # dry run: shows what would be applied
npm run db:migrate -- up --apply      # applies all pending migrations in ONE transaction
npm run db:migrate -- down --apply    # reverts the latest migration; refused when WAM_ENV=production
```

- Migrations are listed explicitly in `src/db/migrations/index.ts`; never edit or rename an applied one.
- A failed run is rolled back completely; concurrent runs are serialized by a database lock (both tested).
- The CLI refuses to run as anything but `wam_owner` (a superuser would create objects with the wrong owner).
- **The server never migrates by itself.** It refuses to start if migrations are pending, or if the database
  was migrated by a newer version than the code.
- **Production recovery is a forward migration or a restore from backup, never `down`**, because reverting
  can destroy data written after the migration. Take and verify a backup before every production migration
  (the backup/restore procedure is a Phase 1D deliverable).

## Owner account (`npm run owner`)

The owner account is created and recovered **only** here, with the migration credentials (the web server's own
database role cannot write ownership at all). Every command is audited, including the operating-system user who ran it.

```
npm run build
export WAM_ENV=production WAM_MIGRATION_DATABASE_URL='postgresql://wam_owner:…@…/wam'
npm run owner -- status                                              # read-only
npm run owner -- bootstrap --username <name> --display-name "<name>"   # once; prints a one-time setup code
npm run owner -- recover --yes             # owner locked out: new setup code, owner signed out, throttling lifted
npm run owner -- transfer --to <username> --yes                     # ownership moves to another active user
npm run owner -- end-all-sessions --yes                             # incident response: everyone signs in again
```

A setup code is shown once, works once, and expires after 24 hours. Hand it over in person or by phone, never by
e-mail or chat. The owner then chooses a password on the sign-in page ("Set password with a setup code").

## What the server refuses at startup (`src/db/safety.ts`)

It will not listen if its database role: is a superuser; has `BYPASSRLS`, `CREATEROLE`, `CREATEDB` or
`REPLICATION`; owns or can create objects in schema `wam`; can create schemas in the database; can create
objects in `public`; or if PostgreSQL is older than 16, migrations are pending, or the database has
migrations this code does not know. Each case has a test.

## HTTP conventions (apply to every future endpoint)

- `GET /health/live` → `200 {"status":"ok"}`; `GET /health/ready` → `200` or `503 {"status":"unavailable"}`
  (database check). Neither reveals versions, hostnames or error text.
- Errors always look like `{"error":{"code":"NOT_FOUND","message":"Not found","requestId":"…"}}`. The message
  is generic; the details are logged server-side under the same `requestId`, which is also returned in the
  `X-Request-Id` header. A client-supplied `X-Request-Id` is ignored.
- Every response carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- Responses declare a JSON schema so only listed fields are ever serialized.

## Pinned versions (exact; verified on the npm registry, each at least 7 days old when adopted)

| Package | Version | Why this version |
|---|---|---|
| `fastify` | 5.12.7 | current v5 (2026-10-13) |
| `pg` | 8.23.1 | current (2026-09-30). Its tiny `pg-cloudflare` dependency is a socket shim used only on Cloudflare Workers; WAM does not use or depend on Cloudflare. |
| `kysely` | 0.29.7 | current (2026-10-17); zero dependencies. Pre-1.0: minor versions may break, hence the exact pin. Migration API is imported from `kysely/migration`. |
| `typescript` | 6.0.3 | kept: `typescript-eslint` supports only `<6.1.0` (decision sheet T-3) |
| `typescript-eslint` | 8.72.0 | 8.72.1 was one day old when checked |
| `eslint` / `@eslint/js` | 10.13.0 / 10.0.1 | current |
| `vitest` | 4.1.12 | 0 advisories (the root app's 4.1.10 has two) |
| `@types/node` / `@types/pg` | 24.19.2 / 8.23.1 | match Node 24 and pg 8.23 |

No package in `package-lock.json` runs an install script except `fsevents` (macOS-only, optional);
`npm ci --ignore-scripts` skips it anyway. `npm audit`: 0 vulnerabilities (2026-10-27).
