# Project status

Snapshot: **2026-10-30, Phase 1B-3 implemented and its independent review remediated in the working tree (O-16, O-17 approved): migrations 0005–0008, catalogue, persons, assets and the staged import (at most 5,000 rows per batch), imports disabled by default; system test 22/22 after two Phase 1B-1 defects it found were fixed; review finding NF-1 (database row values, a user's name and the start of a password hash, in error logs) remediated; sandbox performance measured at 1,000 / 10,000 / 50,000 assets (name search does not scale: O-20 proposed); READY FOR COMMIT REVIEW; everything uncommitted; PostgreSQL 17 validation and the target host pending**. Replace this file's contents at the end of each work session; history
stays in Git.

## Where things are

| Reference | Commit | On GitHub? | Content |
|---|---|---|---|
| `main` | `efbd65a9ca123c1ac03d464087628097671a0290` | yes (unchanged) | Desktop baseline |
| tag `desktop-baseline-efbd65a` | tag object `6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5` → `efbd65a9…` | **no** — a separate task you run locally (O-02); see [owner actions](#owner-actions) | Protects the baseline |
| `phase-1a/repo-safety-net` | `c819994e80cfdc0262677b0e359eb14a5b9765cc` | yes (unchanged) | Phase 1A |
| `ccr-1860034b-yp0csr` (session branch) | GitHub: **`67e3d2e94e248e10bc642cc07c7ca6914903de41`** (sixth push under O-10, 2026-10-28, verified with `git ls-remote` and the GitHub API). **Locally ahead by `4dfc246`** (not pushed); this session's Phase 1B-3 changes are uncommitted in the working tree | up to `67e3d2e` | Phase 1B-1, 1B-2 with MFA, O-12, O-06 tools and disposition, D-15, O-13/E-18 evaluation |

Pushed on 2026-10-28, each as a fast-forward with no force, after checking ancestry, full diffs, remote state,
secrets and personal data, and that desktop source, build configuration, root package files, `server/`, `main` and
`phase-1a/repo-safety-net` were untouched: `6ac697d`, `8039708`, `18b4c6b` (fifth push, `9c3ac79..18b4c6b`), then
`416d2f9`, `67e3d2e` (sixth push, `18b4c6b..67e3d2e`). The bundle backups were kept until the remote branch was
verified, and are still kept.

**Local only** — committing and pushing each need a new approval:

| Commit | Content |
|---|---|
| `4dfc246` (committed, not pushed) | O-06 disposition recorded in the decision register and STATUS, with the alignment of six documents |
| working tree (uncommitted) | O-06/G-1 acceptance and O-15 recorded (2026-10-28); Phase 1B-3: match keys, the blank-never-erases rule, the approved asset-schema proposal (revision 2.2) with its draft DDL and guarded reverse, PD-01…PD-10, O-16; **the implementation**: migrations 0005–0007, request context, catalogue, person register, asset and import services and routes, their tests, an import measurement, documentation (2026-10-30); the review remediation (migration 0008, the O-17 batch limit, new tests) and two fixes found by the system test (`db/connection.ts`, `server.ts`, with tests) |

Nothing was merged into `main`, tagged, released or deployed. No desktop file changed and no dependency was added. In `server/`: four migrations and the asset, catalogue, person and import modules and routes were added; existing files changed to register them (`app.ts`, migrations index, `permissions.ts`, `connection.ts` table types, `appError.ts` codes, `audit.ts` bulk insert, `config.ts`/`server.ts` for `WAM_IMPORT_ENABLED` and the daily retention run, the test harness, README) and for the two system-test fixes (`connection.ts`: an error listener on every pooled client; `server.ts`: request logs without query strings).

## Phase 1B-3 gate — **passed; Phase 1B-3 authorized (O-15, 2026-10-28)**

| # | Condition | State |
|---|---|---|
| 1 | Authorized commits pushed and verified | **Met** for everything up to `67e3d2e` |
| 2 | O-06 | **Met — resolved, and accepted by you on 2026-10-28, through the accepted alternative** (not option B's owner-side run, which did not take place): the desktop source database was inspected and contains test data only; no desktop data migration is required for the WAM web application. Not an empty database: 5 assets (1 active, 4 soft-deleted), 9 `asset_transactions` rows and 118 `audit_log` rows, which the owner confirmed are disposable test data. Evidence: register, O-06 |
| 3 | D-15 (server) recorded; dependency selected | **Met** for selection (O-13, 2026-10-28); ExcelJS is **not approved for operational use** (acceptance gates G-1…G-9 below) |
| 4 | O-12 recorded and enforced | **Met** (`5ddf4cf`, on GitHub) |
| 5 | Documents agree | **Met**: `4dfc246` aligned the register, STATUS and the six documents that assumed a desktop data migration; the 2026-10-28 acceptance is recorded in all of them (working tree) |
| 6 | Your explicit authorization to start Phase 1B-3 | **Met — given 2026-10-28 (O-15)**: local work with synthetic data only |

With O-06 resolved there is **no desktop data migration, no migration-rehearsal database and no SQLite → PostgreSQL
rehearsal** of desktop data. Phase 1B-3 is **authorized** (O-15, 2026-10-28) for local work with synthetic data
only; commits, pushes and deployment each need a separate approval. The asset-schema design proposal
([`architecture/asset-schema-proposal.md`](architecture/asset-schema-proposal.md)) is put to you before any
schema-dependent implementation; until you approve it, no asset schema is finalized or implemented and no asset
table exists. Real spreadsheet data is governed separately by the Excel Source
Admission Gate (O-14, proposed), whose stages are each approved on their own: (1) the file as schema design input,
D-03 may be deferred here; (2) a preview-only test without commit, which also needs D-03 decided and the minimum
preview controls of [`security/import-evaluation.md`](security/import-evaluation.md) §7.1 (they satisfy no gate
G-2…G-9); (3) operational import, which also needs D-02, D-03 and gates G-2…G-9. **No preview or import of the
real spreadsheet is authorized.**

## This session (through 2026-10-30)

| Item | Result |
|---|---|
| **State checked first** | Branch `ccr-1860034b-yp0csr`, HEAD `4dfc246`, GitHub at `67e3d2e` (no divergence); tree clean before this work |
| **O-06 / G-1** | Your acceptance of 2026-10-28 recorded in the register, STATUS and four further documents: satisfied through the accepted alternative, the owner-side procedure did not take place, scope limited to the supplied backup |
| **Server review for 1B-3** | No defect found in the reviewed paths. One gap carried into the design: asset writes must be refused in an inactive warehouse (`hasWarehousePermission` does not check `is_active`) — enforced in the draft schema |
| **Match keys** (`server/src/assets/matchKey.ts`) | Duplicate-detection keys; stored values never changed. Examples plus property tests (generated identifiers, seeded and replayable) |
| **Blank never erases** (`server/src/imports/fieldChanges.ts`) | Plans and applies field changes: blank cells change nothing, clearing needs an explicit marker, identical values are not changes, unknown fields are refused. Examples plus property tests (incl. "re-importing changes nothing") |
| **Asset-schema proposal, revision 1** | [`architecture/asset-schema-proposal.md`](architecture/asset-schema-proposal.md) with draft DDL [`architecture/asset-schema-draft.sql`](architecture/asset-schema-draft.sql): catalogue, assets, trigger-written history, staged import with provenance, row-level security, grants, concurrency and import-commit protocol; nine open decisions PD-01…PD-09 with recommended defaults; engineering decisions ED-1…ED-9 with trade-offs. Reviewed by you on 2026-10-30: **not approved**; findings answered in revision 2 |
| **Revision 2** (your review of 2026-10-30) | Provenance that survives transfers (`origin_warehouse_id`; plain matched-asset key); imports read-only in an inactive warehouse, also under concurrent deactivation; `missing` status; identifier columns `COLLATE "C"`; import state machine, frozen closed batches and applied rows, database-stamped attribution; RLS threat model; PD-05 option C (party ids, per-warehouse persons, one-way erasure); PD-09 lifecycle with a fixed-policy retention function; guarded reverse; definer review; enforcement-boundary table; decision table (proposal §0, §11.1). **Stopped at the gate again: O-16 awaits your explicit approval; no migration, service or route written** |
| **Revision 2.1** (your review of revision 2: accepted in principle, seven findings) | `applied_at` only from the row's own asset operation inside the commit (transaction-internal `committing` state, definer apply trigger, deferred check); lock-first guarded reverse, runner verified transactional; file name cleared with staged cells; PD-05 option C with `person.erase`; catalogue-name key; at most one system warehouse; PostgreSQL 17 recorded as untested and required before deployment (proposal §0.1). **Stopped at the gate: O-16 awaits your formal approval; no migration, service or route written** |
| **Revision 2.2** (your review of revision 2.1: PD-01…PD-10 accepted; one blocker) | Batch expiry restricted to the retention function: the guard requires the schema owner's rights plus the retention marker, so the server's role cannot expire a batch even with the marker set; a NULL-handling defect in the first version of that check was found by the new owner-session test and fixed (proposal §0.1). **Stopped at the gate: only O-16's final technical approval remains; no migration, service or route written** |
| **Found and fixed while validating** | The draft's separator list lost its backslash (a file-writing step turned the escape into a literal character; the line is now pure-ASCII escapes, and the test files no longer contain invisible characters); three statements PostgreSQL rejected |
| **Measured limit** | SQL and TypeScript match keys differ on 37 rare code points that Unicode decomposed after PostgreSQL 16's Unicode version (proposal §4); the database is the authority; the test pins the list |
| **O-16 approved (2026-10-30)** | With the SQL draft and guarded reverse. Both required corrections applied: the reverse's documentation requires `psql --single-transaction -v ON_ERROR_STOP=1 -f …` (plain `psql -f` commits statement by statement, and `LOCK` refuses to run outside a transaction block); `issues.column` accepts only an internal field identifier (`^[a-z][a-z0-9_]{0,63}$`) or a column index 0–99 |
| **Migrations 0005–0007** | Generated from the approved draft; a schema-dump comparison proves they produce exactly its schema, grants and seed rows. Each `down` is the guarded, lock-first reverse: it refuses once its tables, permissions or audit events are in use, and otherwise removes everything its `up` added; one migration per run, transactional in the runner |
| **Request context** | `server/src/db/dataContext.ts`: warehouse scope, actor, request id and change reason set with `set_config(…, true)` inside the request's transaction only |
| **Catalogue, persons, assets** | `/api/catalog/:kind` (read signed-in; change with `catalog.manage`); `/api/warehouses/:id/assets` list, search, count, detail, history, create, edit (set/clear), status change with handover parties; `/persons` list, create, rename, erase (`person.erase`, system permission). Idempotency-Key on every change, version checks, audit without person or file names, 404 for missing access, `WAREHOUSE_INACTIVE` in an inactive warehouse |
| **Staged import (disabled)** | `server/src/imports/imports.ts`: stage (no parser, no upload route), preview, commit per proposal §6.2, cancel, retention. Routes only with `WAM_IMPORT_ENABLED=true` (default `false`, README). Retention 7/7/90 days runs at start-up and daily, with its own statement timeout |
| **Isolation** | Every new endpoint probed across warehouses and without permission: 404 everywhere; no record through the own warehouse's URL; row-level security hides a batch even from a mismatched direct service call; audit events only in their own warehouse's trail |
| **Independent review remediated (2026-10-30)** | S-2: person erasure now tombstones stored idempotency responses and their request fingerprints (migration 0008; a regression test fails on the reviewed tree). S-1: request-context isolation tested on one physical connection; session-level faults detected. O-17: 5,000-row batch limit in staging, preview and commit. S-3: generic answers tested; O-19 proposed. S-4: O-18 proposed (no code change). S-5: erasure in an inactive warehouse tested. S-6: each defence layer tested alone; down races for 0006 and 0005. Details: proposal §13.2 |
| **System test (2026-10-30)** | The real server process, migration CLI and owner CLI driven over HTTP against a disposable database (harness outside the repository; synthetic data; the import flag set only in throwaway processes): **22/22** in the fourth run. It found **two defects in Phase 1B-1 code**, both fixed in the working tree with regression tests: (1) the process **exited** when the database terminated a connection a request was holding (`db/connection.ts`: every pooled client gets an error listener); (2) **request logs recorded query strings**, so names searched for reached the logs, which erasure cannot (`server.ts`: the request serializer drops the query string). Observations put to you: database unavailability and statement timeouts answer 500 (O-21 proposed) |
| **NF-1 remediated (2026-10-30)** | The source review found that an unexpected database error was logged whole: for a table without row-level security PostgreSQL's `detail` is `Failing row contains (…)` — on `users` a username, a display name and the first 64 bytes of the password hash; a validation error also logged client-chosen JSON key names. Reachable through `PATCH`/`POST /api/admin/users` with a whitespace-only display name. Fixed: errors reach a log line only as an allowlisted summary (`server/src/logPrivacy.ts`) on every path (server logger options, `buildApp` whatever options it gets, the request error handler, pool, timers, start-up, CLIs, uncaught exceptions and unhandled rejections); user display names are validated after trimming. 22 new tests (10 unit, 12 integration) assert on captured log lines with sentinels and injected database faults; on the previous tree the unit file cannot load and 8 of the 12 integration tests fail on leaked values or a 500, while the other 4 guard behavior that was already right; 12 seeded faults, one per layer, all detected. 2 further tests assert the pool's per-client error listener directly (ST-1), so removing it now fails assertions rather than only the runner's unhandled-error count. PostgreSQL's own server log is a deployment setting (`log_error_verbosity = terse`; README, Log privacy) |
| **Performance (sandbox, 2026-10-30; not the target host)** | Real server process, 4 users, 1,000 → 10,000 → 50,000 assets. Lists, filters, details, history, catalogue, persons and writes stay flat (≤ 7 ms p50 at 50k; writes 9–11 ms, ~500/s at concurrency 8; 0 lost updates with 8 users editing one asset). **Name search and search counts scan the warehouse** (`wam.name_key` per asset, ~10 µs): a no-match search costs 0.5 s of database time at 50k, code-prefix searches 0.2 s; mixed-read throughput falls from ~618 to ~129 req/s; one user's 10 concurrent searches cut other users to 19 req/s (**O-20 proposed**; a stored key column measured 466 → 11 ms, with a trigram index 0.02–5 ms, on the disposable database only). A 5,000-row import at 50k: commit 8.6 s (creates) / 6.9 s (updates), with no lock waits for concurrent users; with durable settings 7.4 s |
| **Import measurement (sandbox, indicative)** | 50,000 invented rows: commit **84 s** (creates) / **68 s** (updates) in one transaction; preview 7 s / 11 s; staging 5 s; retention of 100,000 rows 4 s (proposal §13.1). Two improvements made first (chunked staging and preview writes; one query for matched assets; chunked audit writes). The remaining cost is the approved one-statement-per-row protocol: **decision O-17 (proposed)** before imports are enabled |

## Verification of this session (Linux sandbox; **nothing run on Windows or on company data, not the target host**)

Earlier sessions' verification: this file at `4dfc246`.

| Check | Result |
|---|---|
| Server `npm run verify` steps on a copy of the working tree, non-root user, Node 24.22.1, PostgreSQL 16.15 | After the review remediation: typecheck exit 0; ESLint `strictTypeChecked` exit 0; tests **515/515 passed in 30 files** (unit 192/192 in 11, integration 323/323 in 19); build exit 0. Before the NF-1 remediation: 491/491; before the system-test fixes: 489/489; before the remediation: 445/445 in 22 files. Vitest ran with `--configLoader runner` because the non-root user cannot write Vite's temporary config into the shared `node_modules` |
| Schema suite on the **migrated** schema (`server/tests/integration/assetSchema.test.ts`, formerly the draft suite) | **54/54 passed**: the 53 draft checks now run against migrations 0005–0007, plus the schema-dump equivalence with the approved draft and the corrected `issues.column` rule. Draft-stage checks (proposal §12): expiry only by the retention step (not the server role, not with the marker set by hand, not a schema-owner session without the marker; 7-day boundary; inactive warehouse), `applied_at` forgery and atomic commit, down-migration races in both orders and runner transaction, file-name retention, `person.erase`, catalogue names, `UNASSIGNED`, plus all earlier checks (Unicode equivalence, ICU `fa` collation, isolation, history, state machine, retention) |
| Seeded-defect checks | Schema: **33 of 33** against the final draft (proposal §12); the migrations equal the draft by dump comparison. Import routes: flag ignored and `asset.view` instead of `asset.import` each detected. Review remediation: **27 of 28** detected, each by the test of its own layer (7 session-level context faults: 6 detected, the seventh writes only an empty value and cannot leak; 9 independent-layer faults; 8 O-17 faults; 4 erasure faults); one further fault showed a share lock without effect, which was removed. System-test fixes: **3 of 3** (client error listener removed; query string kept in request logs, two ways) |
| API and import tests | `assetApi.test.ts` 13/13, `importApi.test.ts` 18/18 (synthetic rows only), `server.test.ts` 6/6 (imports absent by default at the real entry path; retention runs at start-up; the process survives terminated connections) |
| System test (real `node dist/main.js` over HTTP, migration and owner CLIs, disposable database; harness outside the repository) | **22/22** in its fourth run: environment, authentication, the eight business scenarios (administration, asset lifecycle, cross-warehouse isolation, person erasure, a 5,000-row import and a refused 5,001-row one, import without permission, inactive warehouse, edit conflict), authorization, catalogue, asset rules, sessions, audit, retention, database outage, statement timeout, a crash during a commit, log hygiene. The import flag was set only in throwaway server processes. Run 2 found two defects in Phase 1B-1 code, both fixed with regression tests: **the process exited when the database terminated a connection a request held**, and **request logs recorded query strings, with names searched for** |
| Import measurement | `server/tests/perf/import.perf.test.ts` (`npm run test:perf`, not part of `npm test`): numbers above; sandbox only |
| Desktop suite | **not run**: no desktop file changed |
| Not tested | **PostgreSQL 17** (deployment target; its validation — full schema suite including Unicode equivalence and ICU collation, and the full server suite — is required before any deployment or production migration); commit and retention cost **on the target host** at E-18's maximum (required before operational imports); a parser, an upload route and the UI (not built) |
| Scope | Working tree only; nothing committed or pushed; no dependency added; no real spreadsheet, production data, real asset record or the desktop test database used |

## Acceptance gates before any operational import (ExcelJS not approved for operational use until all pass)

| # | Gate | State |
|---|---|---|
| G-1 | O-06 owner-side assessment done; approved aggregate report reviewed | **Satisfied through the accepted alternative, not by the original procedure** (O-06; accepted by you on 2026-10-28): you did not run the assessment on your own PC; it ran in the development sandbox on a read-only copy of the backup you supplied, at your request, and its aggregate report was presented to you; you confirmed test data only and accepted this alternative in place of the owner-side run |
| G-2 | Workbooks saved by Microsoft Excel (invented data) pass the harness with correct values | Open |
| G-3 | Limits re-evaluated on the target server (full harness; memory limits re-derived; timing margin) | Open |
| G-4 | Concurrency 2 only after the 2-parallel worst-case evidence on the target host; default 1 | Open (default 1) |
| G-5 | Every confinement layer available on the target host; imports refused (fail closed) if not | Open |
| G-6 | `npm audit signatures` passes | Open (blocked here) |
| G-7 | Third-party notice file with every licence text | Open |
| G-8 | After integration into `server/`: corpus as automated tests, audits, `verify_artifacts.py`, complete verification suite | Open |
| G-9 | Preview, confirmation, blank-never-erases, one transaction, idempotency, duplicates never merged (1B-3) | Open — server-side parts implemented and tested on invented rows; confirmation is a UI step; not assessed as a gate |

Details: [`security/import-evaluation.md`](security/import-evaluation.md) §5.2 and §7.

## Known limitations and risks

1. **Trusted network only (O-11):** MFA for all staff before any public exposure.
2. **Deployment blocker:** behind a reverse proxy, `trustProxy` must be set to the proxy's address.
3. **MFA key (L-8):** no rotation command yet; a tested key-rotation and recovery procedure is required before
   production.
4. **First enrolment trusts the password** (always before appointment, A7); TOTP is not phishing-resistant (L-9).
5. **Spreadsheet import (staging built, parsing not; disabled):** ExcelJS is unmaintained and loads deprecated
   packages; sandbox timings and memory are not evidence for the target host; gates G-2…G-9 and, for real
   spreadsheet data, the Excel Source Admission Gate (O-14, proposed). A 50,000-row commit takes over a minute in
   one request here, so O-17 limits a batch to 5,000 non-blank rows (about 8 s here). Status changes through an import need only `asset.import` (the import's own
   permission, as designed); the field contract (O-14 stage 2) decides whether a status column is accepted.
6. **Desktop:** `xlsx@0.18.5` (two high advisories) stays until the separate replacement task; interim rules apply.
7. **O-06 script:** its `sqlite3`-shell steps remain unverified (the 2026-10-28 run used Python's SQLite); relevant
   only if a desktop database holding company data must ever be assessed. Heuristics can misclassify both ways.
8. No breached-password check; no general rate limit; audit trail not shipped off the server.
9. **PostgreSQL 17 untested:** every check so far ran on PostgreSQL 16.15; the migrations and the schema validation
   suite must pass on PostgreSQL 17 before any deployment or production migration.
10. **Retention by hand:** the proposal also names a manual CLI run of the retention step; it is not built (the
    daily run catches up a missed day). Planned with the Phase 1D runbook.
11. **Name search cost (O-20, proposed):** asset search and search counts evaluate the name key for every asset of the
    warehouse; at 50,000 assets about 0.5 s of database time per search in the sandbox, and a few concurrent searches
    from one user occupy the database pool. Decide O-20 before R1 at that volume.
12. **Unavailability answers 500 (O-21, proposed):** a database outage or statement timeout gives a generic 500,
    not a retryable 503.
13. **PostgreSQL's own log (deployment):** with the default `log_error_verbosity` the database server logs a failing
    row's values (`DETAIL: Failing row contains (…)`, verified on 16.15); set `log_error_verbosity = terse` before
    deployment (README, Log privacy).
14. **Blank names on older admin paths:** a whitespace-only warehouse, permission-profile or job-title name still
    reaches the database check and answers 500 (Phase 1B-2 code; nothing sensitive is logged since NF-1). The same
    normalized validation as for user display names belongs in Phase 1B-4.

None of this is production readiness: unit, integration and synthetic tests, audits and sandbox measurements do not
replace the deployment gates (O-11, L-8, G-2…G-9, Phase 1E).

## Owner actions

1. **Next approvals:** (a) final code review of Phase 1B-3 in the working tree, then commit and push approvals;
   (b) **authorize Phase 1C start** (login screen, session expiry, read-only asset list) — no web UI exists, so no
   browser testing is possible until then; (c) D-06 (and D-03) before Phase 1B-5; (d) O-18, O-19, O-20 and O-21 (proposed);
   (e) separately, whether to adopt the Excel Source Admission Gate (O-14, proposed), each of whose stages is then
   approved on its own. None of these authorizes a preview or an import of the real spreadsheet. The desktop
   app and its database stay as they are.
2. **Commit and push approvals:** `4dfc246` is committed locally and not pushed; everything after it, including
   the whole Phase 1B-3 implementation, is uncommitted in the working tree. Each needs your separate approval.
3. **Before any deployment or production migration:** a PostgreSQL 17 environment for the schema and server suites.
4. **ExcelJS acceptance (later):** a few workbooks saved by Microsoft Excel on your PC (invented data only) through
   the harness (G-2); the target server for G-3…G-5 when it exists.
5. **Staff rules now:** the desktop interim restrictions on workbooks, and **Skip**, never **Update**, for
   duplicates (O-03).
6. **Separate items needing their own authorization:** O-03 (desktop import data-loss fix), O-04 (desktop Electron
   and dependency update), the desktop replacement of `xlsx@0.18.5` (before a new desktop release).
7. **L-8:** MFA encryption-key rotation and recovery procedure — to be designed, documented and tested before
   production (Phase 1E).
8. **Publish the baseline tag (O-02)** — a separate task you run locally; I perform no tag operation. On your PC, in
   the repository folder, with `WAM_Phase1A_closure.bundle`:
   ```
   git fetch "PATH\TO\WAM_Phase1A_closure.bundle" refs/tags/desktop-baseline-efbd65a:refs/tags/desktop-baseline-efbd65a
   git rev-parse "desktop-baseline-efbd65a^{commit}"     # must print efbd65a9ca123c1ac03d464087628097671a0290
   git push origin refs/tags/desktop-baseline-efbd65a
   git ls-remote origin refs/tags/desktop-baseline-efbd65a   # must print 6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5
   ```
   Then in GitHub → Settings → Rules, protect `main` (require a pull request) and protect tags `desktop-baseline-*`.
9. When you can: D-02 (warehouse list, privately), D-03 (mapping source and reviewer), D-06 (approvals), the WSL2
   readiness checks (sheet T-5).
