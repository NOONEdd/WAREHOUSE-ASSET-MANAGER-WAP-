# Phase 1B readiness — decision sheet and technical review

Date: 2026-10-26 · Branch: `phase-1a/repo-safety-net` · Status: **for owner review. Nothing in this document is approved
or implemented.** Phase 1B has not been started and needs separate explicit authorization.

> **Update 2026-10-27:** the current status of every decision below is kept in
> [`decision-register.md`](decision-register.md); this sheet remains the detailed analysis as of 2026-10-26.
> Phase 1B-1 has since been authorized and implemented; D-08 no longer blocks it (see `../STATUS.md`).
> **D-05 below is superseded:** the owner decided an online-only application with **no** paper-based or offline
> workflow (register, section 1). D-01 is settled at design level by decision O-09.

Labels used: **[V]** verified by me with a command or an official page, **[P]** Phase 0 report statement (not re-verified),
**[R]** my recommendation, **[U]** unknown / unverified.

The decision text below is copied from the Phase 0 *Decision Register* (Deliverable 3). IDs D-01…D-09 are the register's own.
Nothing was added to or reworded in the questions.

---

## 1. Readiness verdict

- **Phase 1A is complete** (evidence in `PHASE_1A_CLOSURE_REPORT.md` and `docs/dev/VERIFY.md`).
- **One slice of Phase 1B can start with a single decision (D-08).** I propose authorizing only that slice first:
  **1B-1 "Server foundation and PostgreSQL test harness"**: configuration loading, Fastify skeleton with a health route,
  `pg` + Kysely connection, migration runner with an empty baseline, ephemeral-PostgreSQL integration-test harness,
  lint rules (including `no-floating-promises`), `npm run verify` for `server/`. It creates **no** business tables, **no**
  authentication, **no** asset or user data, touches **no** production data, and needs no VPS.
- Every other D-item blocks a *later* slice (section 3), not 1B-1.

## 2. D-01 … D-09

Quick view (details per item follow):

| ID | Decision (register text) | Blocks 1B-1? | Blocks later | Recommended default | Owner approval needed |
|---|---|---|---|---|---|
| D-01 | Who is the Owner (named person) and who are the two break-glass custodians? | No | 1B-2 (bootstrap, recovery) | Owner created only by a server CLI; recovery needs both custodians | Yes — supply names **outside the repository** |
| D-02 | Official list of warehouses (names, codes) and who maintains it | No | 1B-2 (warehouse seed) | You supply it, plus a system warehouse `UNASSIGNED` | Yes — supply the data |
| D-03 | Source and reviewer for asset→warehouse mapping | No | 1B-3 (useful pilot data) | Everything migrates to `UNASSIGNED`; audited bulk-assign tool; never infer | Yes — name source and reviewer |
| D-04 | Confirm concurrent users (notes say 60–100) and which sites have unreliable internet | No | Sizing, infra | Size for 100 concurrent sessions | Yes — confirm the facts |
| D-05 | Accept online-only R1 with a paper fallback during outages | No | Scope of every write API | Yes; paper form + later staged import | Yes — it defers offline sync |
| D-06 | Approval scope in R1 | No | 1B-5 (approvals) | Registration approval + retirement by Manager+; field-level change approvals deferred | Yes |
| D-07 | Authorize a throwaway 72-hour trial VPS for connectivity/TLS/deployment rehearsal (small cost, no data) | No | Infrastructure phase | **Do not approve now** (see conflict note) | Only when you choose to |
| D-08 | Dev environment on your PC: WSL2 (Debian/Ubuntu) vs Windows-native PostgreSQL | **Yes** | 1B-3 rehearsal on real data | WSL2; fall back to Windows-native | **Yes — required to start 1B-1** |
| D-09 | Domain and DNS: do you own a .ir domain; who can edit DNS | No | Infrastructure phase | Confirm what exists; decide before infrastructure | Yes — supply the facts |

### D-01 — Who is the Owner and who are the two break-glass custodians?

- **Impact.** The Owner is the root of trust for the web system. Without this the bootstrap and recovery procedures cannot be
  designed, and the Owner Console cannot be scoped. Project rule: the Owner is a designated identity, not "every Administrator".
- **Evidence.** [V] The desktop first-run route `auth:completeFirstRunSetup` is unauthenticated, so whoever reaches a fresh
  web server first would become Administrator [P Phase 0 risk 2]. [P] Phase 0 Deliverable 6: the Owner is created **only** by a
  server CLI run by someone with OS access; lost password → CLI reset with both custodians recorded; application-level Owner
  exclusivity cannot protect against root or DB-superuser access, so that is an operations control.
- **Recommended default [R].** Owner = the person you nominate; created only by the server CLI; recovery needs both custodians.
- **Blocks 1B-1?** No. Blocks the bootstrap CLI and recovery design (1B-2).
- **Owner action.** Name the Owner and two custodians **in a private note, not in this public repository.** If the company
  cannot name two custodians, say so; I would then propose and document an alternative (for example one custodian plus a sealed
  recovery code held by a second trusted person) for your review.
- **Related, not in the register [U].** How a *user's* real-world identity is verified when an invitation is issued (project
  rule: the process must be explicitly designed). It is needed before account activation is built.

### D-02 — Official list of warehouses (names, codes) and who maintains it

- **Impact.** No scoping model can be seeded; warehouse isolation is a mandatory security objective.
- **Evidence.** [V] `assets` has no warehouse column; `workshops` is a department/unit lookup, not a warehouse list
  (Phase 0 risk 1; `src/main/database/schema.sql`). Project rule: workshops must not be treated as warehouses.
- **Recommended default [R].** You supply the list (name, short code, active flag, and the role that maintains it), plus one
  system warehouse `UNASSIGNED` that holds anything not yet mapped.
- **Blocks 1B-1?** No. Blocks the warehouse seed and schema design (1B-2).
- **Owner action.** Provide the list. The repository is public, so the list is loaded from a private, untracked file, never committed.

### D-03 — Source and reviewer for asset→warehouse mapping

- **Impact.** About 10,000 assets carry no warehouse. A pilot has no usable data until they are mapped; Phase 0 calls this the
  real critical path, and it is a business task, not a coding task.
- **Evidence.** [V] No warehouse column in the schema. [P] The 11-column reconciled import layout you specified earlier has
  `واحد/بخش` (unit/section) but no warehouse column, so the mapping needs a source that does not exist in that workbook.
- **Recommended default [R].** Migrate everything to `UNASSIGNED`; map with an audited bulk-assign tool from a reconciled
  workbook that a named reviewer signs off; never infer a warehouse from workshop names, employee names or incomplete rows.
- **Blocks 1B-1?** No. A migration rehearsal (1B-3) can run with everything in `UNASSIGNED`; D-03 matters when real pilot data is needed.
- **Owner action.** Name the source of truth for the mapping and who reviews it.

### D-04 — Concurrent users and sites with unreliable internet

- **Impact.** Sizing (Phase 0 estimate 2 vCPU / 4 GB), database pool size, Argon2id concurrency cap (2–4) and the load-test
  target; the site list also shows how much the online-only choice (D-05) will hurt.
- **Evidence.** [P] The 60–100 figure is unconfirmed; Phase 0 plans a 100-concurrent-session test and a 60-login burst test. [U] No measurement exists.
- **Recommended default [R].** Size for 100 concurrent sessions.
- **Blocks 1B-1?** No.
- **Owner action.** Confirm the real number of people who may be logged in at once and list the sites with unreliable internet.

### D-05 — Accept online-only R1 with a paper fallback during outages

- **Impact.** Scope: removes offline write synchronization from release 1 (the largest source of conflict, replay and stale-permission
  risk). Business: during an outage warehouse work goes on paper and is entered later, so records are not real-time and a backlog
  must be entered. Project baseline lists offline operation as an important requirement, so this is a deliberate deferral.
- **Evidence.** [P] Phase 0: release 1 online and centralized; the paper workaround is the agreed fallback.
- **Recommended default [R].** Yes: paper form plus a later staged import. **Additional recommendation [R] (needs approval):** make every
  write API accept a client-generated operation ID so a retried request can never duplicate a record; it costs little now and avoids a
  redesign if offline support is added later.
- **Blocks 1B-1?** No (but it shapes the API conventions the first endpoints will use).
- **Owner action.** Approve or reject the deferral, and approve or reject the operation-ID convention.

### D-06 — Approval scope in R1

- **Impact.** The largest feature-size variable. Business: with the default, changes to approved assets (for example serial or
  code) apply directly and are audited, instead of waiting for approval; only registration and retirement/transfer are gated.
- **Evidence.** [P] Phase 0 Deliverable 6, item 5: registration requires requester ≠ approver and an approver holding the
  permission in that warehouse; retirement and transfer need Manager+ with a reason; self-approval is impossible by database constraint.
  Interacts with D-12 and D-13 (decided later).
- **Recommended default [R].** As in the register: registration approval (same-warehouse manager, never self) + retirement by
  Manager+; field-level change approvals deferred.
- **Blocks 1B-1?** No. Blocks the approvals slice (1B-5) and the final permission catalogue.
- **Owner action.** Approve or amend.

### D-07 — Throwaway 72-hour trial VPS

- **Conflict to resolve.** The register proposes a **72-hour** trial in **week 1** with default "Approve". Your Phase 1
  authorization says the trial is **optional, one day, near the end, not approved, and never a development dependency.** I treat
  your authorization as current; **"approved" on this sheet must not be read as accepting the register's version.**
- **Impact.** The largest unknowns are reachability from each of your sites and operators, TLS issuance/renewal, and package
  availability (Phase 0 IB-1…IB-3). They cannot be settled without a real server; the trial is the cheapest way to learn them
  early, but it is not needed for any Phase 1B slice.
- **Evidence.** [P] Phase 0 risk 6 and Deliverable 9. [U] No network test from any of your sites has been run.
- **Recommended default [R].** Do not approve now. Re-raise before the infrastructure phase with a concrete test script, a cost
  ceiling and a deletion date; no company data on it, ever.
- **Blocks 1B-1?** No.
- **Owner action.** None now.

### D-08 — Development environment on your PC

- **Impact.** Test/prod drift. It also decides where the **real-data migration rehearsal** runs: your production database copy
  should not leave your PC, so a PostgreSQL that runs on your PC is needed for that rehearsal as well as for running the suite yourself.
- **Evidence.** [V] My sandbox is Ubuntu 24.04 with PostgreSQL **16.15 only**; every PostgreSQL probe so far ran there. [P] Phase 0
  production target Debian 13 (PostgreSQL 17 from the OS repository). [V] Microsoft: WSL needs Windows 10 version 2004 (build
  19041) or later, or Windows 11; `wsl --install` installs Ubuntu by default; `wsl --install -d Debian` selects Debian. See T-5.
- **Recommended default [R].** WSL2 with Debian if the image is Debian 13, otherwise Ubuntu 24.04; Windows-native PostgreSQL only
  if WSL2 is not practical. The server's PostgreSQL tests start a private, temporary cluster per test run, so no always-on database
  service is required.
- **Blocks 1B-1?** **Yes** — the integration-test harness needs PostgreSQL binaries available.
- **Owner action.** Run the readiness checks in T-5 and tell me the results. I cannot inspect your PC.

### D-09 — Domain and DNS

- **Impact.** TLS certificates cannot be planned until you know who controls DNS: HTTP-01 issuance needs inbound port 80 reachable
  by validators outside Iran; DNS-01 needs access to the DNS provider; certificate lifetimes are shrinking (Phase 0 IB-2).
- **Evidence.** [P] Phase 0 IB-2. [U] Whether a domain exists, and who can edit DNS, is unknown.
- **Recommended default [R].** Tell me what exists today; no purchase or registration is needed for Phase 1B. The server reads its
  public host name from configuration, so nothing in 1B-1 depends on the answer.
- **Blocks 1B-1?** No.
- **Owner action.** State whether you own a domain, where it is registered, and who can change its DNS records.

---

## 3. Proposed slicing of Phase 1B (recommendation only — each slice needs your authorization)

| Slice | Content | Needs |
|---|---|---|
| **1B-1** | Server foundation + PostgreSQL harness (section 1). No domain tables, auth or data. | **D-08** |
| 1B-2 | Warehouses, users, roles/permissions schema; Owner bootstrap CLI; sessions; first authorization tests | D-01, D-02, D-10, D-14 (register items due Day 7) |
| 1B-3 | Asset schema; SQLite→PostgreSQL ETL rehearsal on a sanitized **copy**, run on your PC | D-02, D-03 (for real mapping), D-11, D-24, D-25 |
| 1B-4 | Warehouse-isolation test suite for every read/export/search path | D-10 |
| 1B-5 | Registration/retirement/transfer approvals | D-06, D-12, D-13 |

Standing constraints for all slices: the original SQLite database is never modified; no secrets, real databases or backups are
committed; the desktop app stays usable; the base-data rules P-1…P-3 are reproduced on the server.

---

## 4. Technical items (not in the Phase 0 register)

### T-1 — Root `.nvmrc` (Node 22 vs aligning with the server's Node 24)

- **Evidence [V].** The root `npm run verify` chain passes on Node 22.23.4 (npm 10.9.9) and Node 24.22.1 (npm 11.21.1). I also ran the root
  tests (37 files, 533/533) and the production build on **Node 26.12.1** directly (no install step on 26). `engines.node` stays
  `>=22.13.0`. The desktop app's shipped runtime is Electron's embedded Node, so `.nvmrc` only affects developer tooling.
- **Official support [V].** Node 22: maintenance since 2025-10-21, end-of-life **2027-04-30**. Node 24: maintenance since 2026-10-20,
  end-of-life **2028-04-30**. Node 26: Active LTS from 2026-10-28, end-of-life 2029-04-30 (schedule: github.com/nodejs/release).
- **Recommendation [R].** Change root `.nvmrc` from `22` to `24` so your PC needs one Node line for both packages, and leave
  `engines` unchanged. **Not applied.** Needs your approval; it is a one-line change.

### T-2 — Server Node line (24 vs 26) — new question

- **Facts [V].** The Phase 0 choice of 24 over 26 was made while 26 was not yet LTS; 26 becomes LTS in two days. Server typecheck + tests
  pass on 26.12.1; `crypto.argon2` works on 24.22.1 and 26.12.1 without an experimental warning; Fastify 5.12.7 and Kysely 0.29.7 + pg 8.23.1
  (against PostgreSQL 16.15, including transaction-local `set_config` not leaking after COMMIT) pass the same probe on both.
  Node 22.23.4 lacks `crypto.argon2` (verified absent), so 22 cannot be the server line.
- **Recommendation [R].** Start 1B-1 on **Node 24** (already the approved direction and the most tested set), and schedule a planned
  review of moving to **Node 26 LTS** before the pilot or during 2027, because 24 is already maintenance-only and ends 2028-04-30.
  The switch is a version bump plus a re-run of the suite since the server plans no native modules. Costs of 26 now: it deviates from
  the approved direction, `@types/node` would move to the 26 line (type probes were run only with 24.19.2), and how Node itself is
  installed on a Debian/Ubuntu server inside Iran is unresolved for either line [U].
- **Owner action.** Confirm 24 for 1B-1, or ask for 26.

### T-3 — TypeScript: keep 6.0.3

- **Evidence [V].** `typescript@6.0.3` (2026-04-16) compiles the server skeleton and the Fastify/Kysely/pg type probes under strict
  NodeNext settings. `typescript@7.0.2` (2026-07-08) is the current `latest`. `typescript-eslint@8.72.1` (the linter needed for
  `no-floating-promises`) declares peer `typescript >=4.8.4 <6.1.0`, so 7.x is outside its supported range; TypeScript 7's stable
  programmatic API is not expected before 7.1 (TypeScript's own 7.0 notes, read earlier in this work; not re-read today).
- **Recommendation [R].** Keep **6.0.3** pinned. Revisit when typescript-eslint supports 7.x. No verified assessment supports changing it.

### T-4 — Compatibility matrix (checked 2026-10-26)

| Component | Version checked | Official support / status | Our evidence | Caveat |
|---|---|---|---|---|
| Node.js 22 | 22.23.4 | Maintenance; EOL 2027-04-30 | Root verify OK | No `crypto.argon2` |
| Node.js 24 | 24.22.1 | Maintenance since 2026-10-20; EOL 2028-04-30 | Root and server verify OK; argon2, Fastify, Kysely/pg probes OK | — |
| Node.js 26 | 26.12.1 | Current → LTS 2026-10-28; EOL 2029-04-30 | Root tests+build, server typecheck+tests, probes OK | Windows and OS packaging unverified |
| PostgreSQL | 16.15 (probed) | Supported majors: 18.6 (to 2030-11-14), 17.11 (2029-11-08), 16.15 (2028-11-09), 15.19 (2027-11-11), **14.24 (EOL 2026-11-12)**; 19 is RC1 | Probes on 16.15 only | **17/18 not tested by me** |
| Fastify | 5.12.7 (2026-10-13) | LTS table: v5 supported, end-of-LTS "TBD", lists Node 20 and 22 | Smoke test on Node 24 and 26 | The table does not list 24 or 26; treat Node support as tested, not promised |
| Kysely | 0.29.7 (2026-10-17) | engines `node >=22` | Probe OK on 24 and 26 | Pre-1.0: minor versions can break; pin exactly |
| pg | 8.23.1 (2026-09-30) | engines `node >=16` | Probe OK on 24 and 26 | `pg-native` is an optional peer; not used |
| TypeScript | 6.0.3 (kept) | 7.0.2 is `latest` | Compiles server + probes | See T-3 |
| Vitest (server) | 4.1.12 (2026-10-15) | engines `^20 \|\| ^22 \|\| >=24` | Server tests pass on 24 and 26 | Vitest **5.0.5** exists (engines `^22.12 \|\| ^24 \|\| >=26`); a new major, **not evaluated** |
| Vitest (root) | 4.1.10 (unchanged) | — | 533/533 on 22, 24, 26 | Two moderate advisories (see T-6) |
| typescript-eslint | 8.72.1 (published today) | peer TS `<6.1.0`, eslint `^8.57 \|\| ^9 \|\| ^10` | Not yet installed | Too new for a 7-day release-age rule (T-7); pin a slightly older release at Step 0 |
| @types/node | 24.19.2 | latest line is 26.x | Matches Node 24 | Re-pin if the Node line changes |
| npm | 10.9.9 (Node 22), 11.21.1 (Node 24) | — | Install behavior identical for `--ignore-scripts` | npm 11 has `--min-release-age` |

Sources: nodejs.org/en/about/previous-releases, github.com/nodejs/release, postgresql.org/support/versioning, fastify.dev/docs/latest/Reference/LTS,
and `npm view` against registry.npmjs.org on 2026-10-26.

### T-5 — Local PostgreSQL setup (recommendation; nothing to install until you authorize it)

Prefer **WSL2** because production is Linux (Debian 13 → PostgreSQL 17, per the Phase 0 plan); it avoids Windows-specific
behavior differences (paths, permissions, line endings). Checks to run first, in PowerShell, and report the output:

```
winver                       # Windows 10 build >= 19041, or Windows 11
wsl --status                 # is WSL already installed, and is WSL 2 the default version?
wsl --list --online          # which distributions can be installed from your network?
```
Also check Task Manager → Performance → CPU → "Virtualization: Enabled", and free disk space (≥ 10 GB) and RAM (≥ 8 GB recommended).

If those pass, the setup is (do not run before authorization):

```
wsl --install -d Debian
# inside Debian:
cat /etc/os-release                      # expect VERSION_ID="13"; if not, use Ubuntu 24.04 instead
sudo apt update && sudo apt install -y postgresql postgresql-client
psql --version                           # Debian 13 should give 17.x
```
Notes [R, general PostgreSQL behavior; not tested on your machine]: keep the repository **inside the WSL filesystem** (for example
`~/wam`), not under `/mnt/c`, because PostgreSQL requires its data directory to be private to the user and `/mnt/c` cannot reliably
provide that; PostgreSQL refuses to run as root, so tests run as your normal WSL user; the temporary clusters the tests create do not
use the service the package installs, which can stay stopped.

Fallback if WSL2 is not practical [U]: a Windows-native PostgreSQL 17 or 18 from the official downloads, with `initdb`/`pg_ctl`
on `PATH`. The harness would need a Windows run that I have not performed.

Parity limitation [V]: the suite that I run in my sandbox uses PostgreSQL 16.15; yours would use 17.x. Run the suite on both before
trusting any behavior that differs between majors.

### T-6 — Root dependency findings (observation only; **not changed**)

`npm audit` on the desktop `package-lock.json` reports 15 findings (4 moderate, 11 high) in total, 4 of them in production
dependencies: `xlsx` (high, **no fixed version on npm**), `brace-expansion` (high, transitive, fix available), `exceljs` and `uuid`
(moderate; npm's suggested fix is a semver-major downgrade). The direct dependencies flagged are `electron`, `vite`, `xlsx`,
`exceljs` and `vitest`; the others are transitive (`@xmldom/xmldom`, `fast-uri`, `http-cache-semantics`, `js-yaml`, `nanoid`,
`source-map-js`, `undici`, `@vitest/mocker`, `uuid`, `brace-expansion`). The root `vitest@4.1.10` carries the same two moderate
advisories (`vitest`, `@vitest/mocker`) that I removed from `server/` by moving to 4.1.12. I could not read the advisory texts (the sandbox
blocked them), so I cannot say which findings are reachable in this application. **Recommendation [R]:** do not change the desktop
dependencies as part of 1B; handle them as a separate, approved task with regression tests, starting from D-15 (`xlsx` handling).

### T-7 — Supply-chain practice

Reproducible procedure: `docs/dev/DEPENDENCY_VERIFICATION.md`. Results today: all 706 locked packages across both lockfiles match
registry-signed integrity. **Not verified:** Sigstore provenance (blocked in my sandbox; `npm audit signatures` should be run on your
network), install-script contents, advisory texts. **Proposals [R], needing your approval:** exact version pins for `server/`;
`npm ci --ignore-scripts` as the standard install; a 7-day minimum age before adopting a new version (`--min-release-age=7` on npm 11;
several current pins are only 9–17 days old, so this would have delayed them but not blocked them).

---

## 5. What I could not verify

- Anything on Windows (see `docs/dev/VERIFY.md` for the exact steps you can run).
- Network reachability of any provider, registry or Microsoft/WSL download from your sites in Iran.
- PostgreSQL 17 or 18 behavior (only 16.15 was available).
- Advisory texts, Sigstore provenance, install-script contents.
- Whether Debian's WSL image is Debian 13.

## 6. Stop

I will not begin Phase 1B, PostgreSQL schema design, authentication, asset migration, production-data work, VPS setup or deployment
until you give separate explicit authorization (suggested wording: "Authorize Phase 1B-1 only, with Node 24 and D-08 = WSL2").
