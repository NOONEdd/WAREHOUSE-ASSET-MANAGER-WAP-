# Web architecture and security review

Date: 2026-10-27 · Basis: the repository at `phase-1a/repo-safety-net` (`c819994`) plus the Phase 1B-1 server
foundation (`e00ac9e`). Labels: **[V]** verified by a command, test or the code itself in this session;
**[X]** from current external sources (named); **[R]** recommendation; **[U]** unknown.

Owner-facing decisions arising from this review are in [`../decisions/decision-register.md`](../decisions/decision-register.md);
the security verification plan is in [`../security/security-acceptance-matrix.md`](../security/security-acceptance-matrix.md).

## 1. Findings, ranked by severity

| # | Severity | Finding | Affects | Action |
|---|---|---|---|---|
| F-1 | **Critical** (for web) | **No authorization exists.** The desktop app authenticates but never checks a role: the four roles are seeded as "Reserved for future use" and no IPC handler or service tests one [V: `grep` of `src/main`]. Any signed-in user can restore a backup, import, bulk-delete and read the audit log. | Web design | Server authorization is new work, not a port. **Server: implemented for access data and audit in 1B-2** (identity-and-access §2); assets follow in 1B-3/1B-4. Desktop: acceptable only while it stays single-user. |
| F-2 | **Critical** (for web) | **No warehouse in the data model.** `assets` has no warehouse column; `workshops` is a unit/department list, not a warehouse list [V: `schema.sql`]. | Web design, migration | New schema + `UNASSIGNED` default; mapping is a business task (D-02, D-03). |
| F-3 | **High — affects the desktop app today** | **Import "update" erases data and skips status history.** With duplicate policy *update*, every column is overwritten: blank cells become empty, **and so do columns that are not in the file at all**. A status changed this way writes no `asset_transactions` row, and the audit entry records only code and name, no before/after. [V: probe on a scratch copy — `model`, `workshop`, entry date and notes were erased (two of them were not file columns), status changed with 0 history rows.] | Desktop data integrity; server import design | **Interim:** staff should choose *skip*, not *update*, for duplicates. Fix needs owner approval (O-03). Server import: blank = "no change" unless explicitly cleared; status changes always write history; audit stores before/after. |
| F-4 | **High** | **Electron 43.2.0 is shipped with 12 published advisories (5 high)**, all fixed in 43.8.1 (same major) [V: `npm audit`]. It is a `devDependency` by convention, so `npm audit --omit=dev` hides it even though it is the desktop app's runtime. The app's hardening (sandboxed renderer, context isolation, no `<webview>`, navigation and pop-ups denied [V: `src/main/index.js`]) limits several, but not e.g. the certificate-mitigation and preload-cache advisories. | Desktop | Separate, approved desktop update with a Windows check (O-04). |
| F-5 | **High** | **`xlsx@0.18.5` parses user-chosen spreadsheets** (`XLSX.readFile` in `excelParser.js`) and has two high advisories — prototype pollution (fixed in 0.19.3) and ReDoS (fixed in 0.20.2) — with **no fixed version on npm** [V: `npm audit`]. | Desktop now; server if reused | The server must not parse uploads with it (D-15). Desktop exposure is a crafted file opened by a user. |
| F-6 | **High** (for web) | **The first-run setup is unauthenticated by design** (`auth:completeFirstRunSetup`): correct for one PC, but on a server it would make the first visitor the administrator [V]. | Web design | **Server: implemented in 1B-2** — owner created only by the owner CLI with the migration credentials; no setup web page exists. |
| F-7 | Medium | **Serial numbers are mandatory and unique** among active assets [V: `schema.sql`, `assetImportSchema.js`]. Since real serials are often missing, operators were probably forced to invent placeholders [U: needs the real data]. | Migration | Measure on a copy of the real database (O-06); server schema allows "serial unknown" and never invents one. |
| F-8 | Medium | Login has no throttling; an unknown username skips the bcrypt comparison (timing reveals which usernames exist); the session is one in-memory global [V: `authService.js`]. Fine on one PC; not portable. | Web design | **Server: implemented in 1B-2** (hashed server-side sessions, sliding-window throttling, same Argon2id work for unknown users). |
| F-9 | Medium | IPC handlers accept arbitrary file paths from the UI for import parsing and backup restore [V: `import.ipc.js`, `backup.ipc.js`]. | Web design | Never port: the server receives uploads as size-limited streams, never paths. |
| F-10 | Medium | Desktop restore validation checks only the SQLite header and that an `assets` table exists — no `integrity_check`, no schema-version check [V: `backupService.js`]. Desktop migrations are detected by probing columns, with no version table and no `foreign_key_check` after the two table rebuilds (002, 004) [V]. | Migration rehearsal | Run `PRAGMA integrity_check` and `foreign_key_check` on a **copy** before any ETL (O-06). |
| F-11 | Low | Node 24 entered **maintenance** on 2026-10-20 (end of life 2028-04-30); Node 26 becomes **Active LTS on 2026-10-28** (EOL 2029-04-30) [X: nodejs.org release index and `nodejs/Release` schedule, fetched 2026-10-27]. | Server runtime | Keep 24 for Phase 1B; decide 26 before the pilot (T-2). |
| F-12 | Low | Developer-tool advisories (Vite dev server, root Vitest 4.1.10) affect only developers' machines, not the shipped app [V]. | Dev tooling | Bundle with the desktop maintenance task (T-6). |

Not findings (checked and fine): the PDF report escapes every value and renders it in a sandboxed window; the
XLSX export writes strings as strings, so cell contents are not executed as formulas [V: `exportService.js`].
A future **CSV** export would need a formula-injection guard. Lockfiles: 706/706 packages match
registry-signed integrity [V: `npm run verify:deps`].

## 2. Recommendations by area

### 2.1 Application architecture — modular monolith [R, adopted for 1B]
One Node.js process (Fastify) and one PostgreSQL database. Inside it, modules by business area (identity,
warehouses, assets, imports, audit), each split into **routes** (HTTP + JSON schema), **services** (permission
check + business rules + transaction boundary) and **repositories** (Kysely queries that always take the
caller's warehouse scope). No microservices, queues, Redis or Kubernetes: nothing in the expected scale
(hundreds of users, ~10⁴–10⁵ assets) needs them, and each would add an operational failure mode for a small team.
The React/Vite UI is reused in Phase 1C by replacing the preload bridge (`window.api` → IPC) with an HTTP
client of the same shape; pages and components stay.

### 2.2 Backend and runtime [V where marked]
Node 24.22.1 · TypeScript 6.0.3 (typescript-eslint 8.72.0 supports `<6.1.0` [V]) · Fastify 5.12.7 · pg 8.23.1 ·
Kysely 0.29.7. All pinned exactly; `npm ci --ignore-scripts`; 0 advisories [V]. Security updates are applied as
they appear; modernization (Node 26, TypeScript 7, Vitest 5) is a separate, planned step, never bundled.

### 2.3 Database [V for what exists; R for what follows]
PostgreSQL 16+ (tested on 16.15; target 17 on Debian 13 — **17 is untested** [U]). Implemented in 1B-1: two
roles (`wam_owner` migrates, `wam_app` runs), schema `wam` only, explicit per-table grants (no default
privileges), transactional migrations via an explicit CLI, and a startup gate that refuses an over-privileged
role or a schema/code mismatch. To follow: real foreign keys and `CHECK` constraints for every invariant;
`timestamptz` everywhere; partial unique indexes as today (active rows only); optimistic concurrency
(`version` column) on editable rows; idempotency keys on write APIs (D-05); `pg_dump`-based backups with a
**timed restore drill** (Phase 1D). **Row-level security** [R]: adopt as defense in depth in 1B-4 only, with
transaction-local context (`set_config(…, true)` inside the request's transaction) and tests proving it does
not leak between pooled connections; application checks remain the primary control.

### 2.4 Authentication and sessions [specified 2026-10-27; implemented from 1B-2]
The binding rules are in [`../security/identity-and-access.md`](../security/identity-and-access.md) §1, §3–§5,
written against the ASVS 5.0.0 requirement text. In short: owner bootstrap and recovery only through the server-side
owner CLI with the separately held migration credentials (decision O-09); Argon2id via Node's built-in
`crypto.argon2` (present in Node 24.22.1, absent in Node 22 [V]); 15-character minimum and an offline
common-password list; one-time setup codes instead of administrator-chosen passwords; hashed reference-token
sessions in a `__Host-` cookie with idle and absolute timeouts; a required anti-forgery header plus `Origin` checks;
throttling that cannot permanently lock an account. **MFA is required for ASVS Level 2 (V6.3.3)** and is the next
slice after the core (decision O-07). Desktop password hashes are **not** migrated: web accounts are issued fresh.

### 2.5 Authorization and warehouse isolation [specified 2026-10-27; implemented from 1B-2]
The owner configures access in the admin panel (decision O-09): code-defined **permissions**, owner-configurable
**permission profiles**, descriptive **job titles** that grant nothing, and explicit per-warehouse **assignments**
(no "all warehouses" grant). Escalation rules A1–A6 keep administrators from appointing administrators, acting
on each other, or granting themselves access. Full model: identity-and-access §2. Every service call checks the
action and resolves the warehouse scope server-side; every repository query filters by that scope — including
counts, search, export, import targets and audit-log reads. Deny by default; client-supplied role or warehouse
values are never trusted. An object outside the caller's scope answers **404**, not 403, so existence is not
revealed. Tested adversarially as each data type arrives (1B-2 for access data and audit, 1B-4 for assets).

### 2.6 Audit and business operations [R]
Append-only audit table: `wam_app` gets `INSERT, SELECT` only, never `UPDATE/DELETE`, plus a trigger that
rejects both (as the desktop app does today). Each event: actor, action, target, warehouse, before/after of
changed fields, outcome, request ID, timestamp. Failed logins and authorization denials are recorded.
Never: passwords, tokens, session IDs. Approval rules wait for D-06.

### 2.7 Imports and data migration [R, for 1B-3]
Staged pipeline: upload → parse → stage rows → validate → preview with row-level results → explicit commit,
idempotent by file hash and row key. Per-column merge rules (blank = no change). Suspected duplicates are
reported, never merged automatically. Source provenance (source file/row or SQLite id) is kept on every
migrated record with a reversible mapping; unresolved records stay `UNASSIGNED`. Reconciliation: row counts
and per-record checks between source and destination. Real company data only after explicit approval.

### 2.8 Operational resilience [R, for 1D/1E]
A single VPS is a single point of failure; the proportionate mitigation for R1 is **tested restores**, not
high availability: nightly encrypted `pg_dump` copied off the server plus WAL archiving if a recovery point
under 24 h is required (owner to set RPO/RTO), a documented rebuild procedure, and a restore drill whose time is
measured. Monitoring: `/health/ready`, disk space, backup age, certificate expiry. **Outages:** the application
is online-only (decision D-05) — there is no offline mode and no paper workflow in the product — so work in the
system stops during an outage. That makes availability, monitoring, backups and a measured restore the controls,
and the recovery objectives (O-08) the business commitment.

### 2.9 Security baseline [V]
OWASP ASVS **5.0.0** (May 2025) is the latest stable release — verified 2026-10-27 from the OWASP/ASVS repository
README ("Latest Stable Version - 5.0.0"; next target 5.0.1, unreleased). The requirement text was read from the
official `v5.0.0` CSV (345 requirements; SHA-256 `98c8fe911b9edb403af8ee05d3ce8201ecac2659e313b053890a62847cdcf680`).
Target: Level 2. The security matrix maps rows to requirement IDs in the `v5.0.0-<id>` form the standard recommends.

## 3. Engineering decisions taken (reversible, within engineering authority)

| ID | Decision | Why | Revisit when |
|---|---|---|---|
| E-01 | Modular monolith, Fastify + PostgreSQL | §2.1 | Measured load demands otherwise |
| E-02 | Kysely (typed SQL builder) over an ORM | SQL stays visible and reviewable; zero dependencies; raw SQL when needed | Kysely stalls before 1.0 |
| E-03 | Two fixed DB roles; explicit grants; startup privilege gate | Least privilege enforced by the server itself | Never weakened without review |
| E-04 | Migrations only via CLI, dry run by default, no `down` in production | Schema change is always a deliberate act | — |
| E-05 | Throwaway PostgreSQL cluster per test run (no Docker) | No service, no Docker Desktop licence, runs in WSL2; cannot reach real data | A CI service is adopted |
| E-06 | Exact pins; ≥ 7-day release age for new versions; `--ignore-scripts` | Supply-chain hygiene (sheet T-7) | — |
| E-07 | Generic error bodies + server-generated request IDs | No internal detail reaches callers | — |
