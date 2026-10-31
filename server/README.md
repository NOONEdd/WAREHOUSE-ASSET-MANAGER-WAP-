# server/ — WAM web server

**Status: Phase 1B-2 (identity and access) complete on the server side, including multi-factor authentication
(slice 1B-2c).** On top of the Phase 1B-1 foundation (configuration, health endpoints, PostgreSQL, migrations,
startup safety checks, test harness), the server has users, sessions, multi-factor authentication (authenticator
apps and recovery codes), configurable permission profiles, warehouses, the owner CLI and an append-only audit
trail. The binding rules are in
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
| `npm run test:perf` | performance measurement (see below) | as above |
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
| `WAM_MFA_ENCRYPTION_KEY` | yes (server) | — | 32 random bytes, base64 (44 characters ending in `=`), that encrypt authenticator secrets at rest. Generate once: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep it **outside the database and back it up separately from database backups**: without it no enrolled user can complete sign-in (recovery: identity-and-access §3.2.5). Never commit it. |
| `WAM_SESSION_IDLE_MINUTES` | no | `30` | Sign-out after this much inactivity (5–240). |
| `WAM_SESSION_ABSOLUTE_HOURS` | no | `12` | Sign-out after this long regardless of activity (1–24). |
| `WAM_HTTP_HOST` | no | `127.0.0.1` | Loopback: in production the server sits behind a reverse proxy on the same machine. |
| `WAM_HTTP_PORT` | no | `3000` | |
| `WAM_DB_POOL_MAX` | no | `10` | Connections per server process (1–100). |
| `WAM_DB_STATEMENT_TIMEOUT_MS` | no | `15000` | Per-statement limit for the server (100–600000). |
| `WAM_LOG_LEVEL` | no | `info` | `fatal` `error` `warn` `info` `debug` `trace` `silent`. Logs are JSON on stdout. Request lines record the method and path, never the query string: query strings carry search terms, a person's name among them, and erasure cannot reach a log line (PD-05). Errors appear only as an allowlisted summary (see [Log privacy](#log-privacy)). |
| `WAM_IMPORT_ENABLED` | no | `false` | `true` or `false`. Whether the staged-import routes (`/api/warehouses/:id/imports…`) exist at all. **Keep it `false`**: imports stay disabled until gates G-2…G-9 pass and O-14 admits real spreadsheets (decision O-16). Import retention runs daily either way. |

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
npm run owner -- recover --yes             # owner locked out: new setup code, owner signed out, throttling and MFA lock lifted
npm run owner -- recover --reset-mfa --yes # as above, and removes the owner's authenticator (lost phone, no recovery codes)
npm run owner -- transfer --to <username> --yes                     # ownership moves to another active user (administrator profiles of both accounts are removed)
npm run owner -- end-all-sessions --yes                             # incident response: everyone signs in again
```

A setup code is shown once, works once, and expires after 24 hours. Hand it over in person or by phone, never by
e-mail or chat. The owner then chooses a password on the sign-in page ("Set password with a setup code") and, at the
first sign-in, sets up an authenticator app: the owner and administrators can never sign in without one.
`status` also shows whether the owner has an authenticator, whether it is locked, and the MFA policy.

## What the server refuses at startup (`src/db/safety.ts`)

It will not listen if its database role: is a superuser; has `BYPASSRLS`, `CREATEROLE`, `CREATEDB` or
`REPLICATION`; owns or can create objects in schema `wam`; can create schemas in the database; can create
objects in `public`; or if PostgreSQL is older than 16, migrations are pending, or the database has
migrations this code does not know. Each case has a test.

## Log privacy

A log line never contains an error's message, a database error's `detail`, `hint`, `where` or internal query,
SQL, parameters, row values, request bodies, cookies or tokens (finding NF-1: PostgreSQL's
`Failing row contains (…)` carries a user's name and the start of their password hash). Errors are logged only as
an allowlisted summary (`src/logPrivacy.ts`): kind, type, SQLSTATE and its class, severity, constraint name,
application or Node error code, HTTP status, validation keyword and schema path, stack frames (code locations
only), and the same for a nested cause. This holds for every logging path: the server's pino options,
`buildApp` whatever logger options it is given, the request error handler, the pool and timer listeners, start-up,
the CLIs' unexpected errors, and uncaught exceptions and unhandled rejections (one summary line, then exit 1).

**PostgreSQL's own log is outside the application and must be configured at deployment.** With the default
`log_error_verbosity`, the database server writes the same `DETAIL: Failing row contains (…)` into its log
(verified on 16.15). Set `log_error_verbosity = terse`, keep `log_parameter_max_length_on_error = 0` (the
default) and `log_statement = none`, and treat the database server's log as personal data.

## HTTP conventions (apply to every endpoint)

- Every route declares who may call it (`config.access`: public, authenticated, owner, a system permission, or a
  warehouse permission for the warehouse in the URL). A route without one stops the server from starting.
- Requests that are not `GET`/`HEAD`/`OPTIONS` must send `X-WAM-CSRF: 1` and an `Origin` equal to
  `WAM_PUBLIC_ORIGIN`; otherwise `403`.
- Changes in the admin API need an `Idempotency-Key: <uuid>` header (one per user action, reused for that action's
  retries) and, for edits, the `version` the edit is based on (`409 VERSION_CONFLICT` if someone else changed it).
- `GET /health/live` → `200 {"status":"ok"}`; `GET /health/ready` → `200` or `503 {"status":"unavailable"}`.
- Errors always look like `{"error":{"code":"NOT_FOUND","message":"Not found","requestId":"…"}}`, with `details`
  only for information meant for the caller. A warehouse the caller may not see answers exactly like one that does
  not exist.
- Every response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; over https also HSTS.
- Responses declare JSON schemas, so only listed fields are ever serialized; request bodies reject unknown fields.

## API (Phase 1B-2)

| Area | Endpoints |
|---|---|
| Sign-in | `POST /api/auth/login` (`200` signed in, or `202` with `next` = `mfa_verify` or `mfa_enroll` and a short-lived second-step cookie), `POST /api/auth/mfa/verify`, `POST /api/auth/mfa/enroll/start`, `/enroll/confirm`, `POST /api/auth/logout`, `/change-password`, `/setup-password` |
| Own account | `GET /api/me`, `GET /api/me/sessions`, `POST /api/me/sessions/end-others`, `GET /api/me/mfa`, `POST /api/me/mfa/enroll/start`, `/enroll/confirm`, `/recovery-codes`, `/disable` |
| Users | `GET /api/admin/users`, `GET/PATCH /api/admin/users/:id`, `POST /api/admin/users`, `PUT /api/admin/users/:id/access` (administrator profiles only for users who already have an authenticator: `409 ADMIN_MFA_REQUIRED` otherwise), `POST /api/admin/users/:id/setup-code`, `POST /api/admin/users/:id/reset-mfa` (never for the owner account; for an administrator only after removing the administrator profiles), `POST /api/admin/users/:id/end-sessions` |
| Security policy (owner only) | `GET/PUT /api/admin/security-policy` — who must use MFA beyond the owner and administrators (`privileged` or `all_users`) |
| Access catalogue | `GET /api/admin/permissions`, `GET/POST /api/admin/profiles`, `PATCH/DELETE /api/admin/profiles/:id`, `GET/POST /api/admin/job-titles`, `PATCH /api/admin/job-titles/:id` |
| Warehouses | `GET/POST /api/admin/warehouses`, `PATCH /api/admin/warehouses/:id` |
| Audit | `GET /api/admin/audit-events` (everything), `GET /api/warehouses/:warehouseId/audit-events` (one warehouse) |

Rules, outcomes and limitations: [`../docs/security/identity-and-access.md`](../docs/security/identity-and-access.md).

## API (Phase 1B-3)

Every change needs an `Idempotency-Key` header and, for an existing record, its `version`. Warehouse routes answer
404 without the named permission in that warehouse, and run with that warehouse's row-level-security context.

| Area | Endpoints |
|---|---|
| Catalogue (global) | `GET /api/catalog/:kind` (signed in; `kind` = `statuses`, `item-types`, `workshops`, `countries`), `POST /api/catalog/:kind`, `PATCH /api/catalog/:kind/:id` (`catalog.manage`) |
| Assets | `GET /api/warehouses/:warehouseId/assets` (`?q=`, `statusId`, `itemTypeId`, `after`, `limit`), `/assets/count`, `/assets/:assetId`, `/assets/:assetId/history` (`asset.view`); `POST /assets` (`asset.create`); `PATCH /assets/:assetId` (`asset.edit`; `null` clears a field); `POST /assets/:assetId/status` (`asset.change_status`) |
| People without accounts | `GET/POST /api/warehouses/:warehouseId/persons`, `PATCH /persons/:personId` (`asset.view` / `asset.edit`); `POST /persons/:personId/erase` (system permission `person.erase`; one-way; also in an inactive warehouse). After erasure, replaying an earlier create or rename request of that person returns an id-only tombstone (`displayName: null, erased: true`), never the name (migration 0008) |
| Imports (only with `WAM_IMPORT_ENABLED=true`) | `GET /api/warehouses/:warehouseId/imports`, `/imports/:batchId` (rows paged), `POST /imports/:batchId/preview`, `/commit`, `/cancel` (`asset.import`). No upload route: no parser is approved (O-13, O-14). **A batch holds at most 5,000 non-blank data rows** (O-17; blank rows — every cell empty or whitespace — and the header do not count, invalid rows do): staging, preview and commit each refuse a larger batch with `422 IMPORT_TOO_LARGE`. The server never splits a batch: split a larger file into separate batches. Each batch is previewed and committed on its own and atomically; there is no whole-file atomicity, so batches committed earlier stay committed if a later one fails |

Design and rules: [`../docs/architecture/asset-schema-proposal.md`](../docs/architecture/asset-schema-proposal.md).

## Performance check

`npm run test:perf` (not part of `verify`; about 20 seconds in the sandbox for the identity part) seeds a synthetic volume — 2,000 users, 50 warehouses,
5,000 sessions, 200,000 audit events, about 600 enrolled authenticators — measures login, the second sign-in step and
authenticated reads over real HTTP, and checks with `EXPLAIN` that the per-request queries use indexes. Targets and
results: `docs/STATUS.md`. It also stages, previews and commits a 50,000-row import of invented rows (creates, then
updates) and clears both batches by retention — several minutes; results in the asset-schema proposal §13.1.

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
