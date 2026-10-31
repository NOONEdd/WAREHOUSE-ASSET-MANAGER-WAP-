# Asset-schema design proposal (Phase 1B-3) — for owner review

Status: **revision 2.2, approved by you (O-16, 2026-10-30)** together with the draft DDL and the guarded reverse, and
**implemented in the working tree** (§13.1; uncommitted). You reviewed revisions 1, 2 and 2.1 on 2026-10-30 and
**formally accepted all ten decisions PD-01…PD-10** (§11.1); revision 2.2 closed the last SQL blocker (§0.1). Two
corrections came with the approval and are applied: the reverse script's documentation now requires
`psql --single-transaction -v ON_ERROR_STOP=1 -f …`, and import issue metadata may name only an internal field
identifier or a column index, never a raw header or cell value (enforced by `import_rows_issues_shape`).

Migrations 0005–0007 reproduce the approved draft exactly (verified by comparing schema dumps, §13.1) and have been
applied only to throwaway test databases, with invented records. Approval does **not** admit any spreadsheet (O-14),
approve ExcelJS or any import dependency for operational use (O-13), enable real spreadsheet ingestion, or satisfy any
other gate; import routes exist only when `WAM_IMPORT_ENABLED=true`, which is off by default. **PostgreSQL 17, the
deployment target, has not been tested**; validating the migrations on it is a required check before any deployment
or production migration (§13). Nothing here claims operational readiness.

## 0. Changes

### 0.1 Revision 2.2 (your review of revision 2.1: one blocker)

| Finding | Change | Evidence (§12) |
|---|---|---|
| Premature batch expiry: `uploaded`/`previewed` → `expired` skipped the actor and active-warehouse checks, and `wam_app` has `UPDATE` on `state`, so the server's role could expire a batch directly | Expiry is accepted only while running with the **schema owner's rights** (new helper `wam.running_as_schema_owner()`: `current_user` equals the owner of schema `wam`) **and** with the retention marker set — i.e. only inside `wam.apply_import_retention()`. `wam_app` can set the marker but can never have the owner's rights (not the owner, not a member, no `SET ROLE`). The check is NULL-safe (an unset marker refuses). No grant changes; the other transitions are unchanged | The server's role cannot expire an uploaded or previewed batch, directly or with the marker set by hand, with or without an actor; a `wam_owner` session without the marker cannot either; the retention function still expires abandoned batches after 7 days (a 6-day batch stays open), also in an inactive warehouse; the 7/7/90-day clearing unchanged |

While testing this, the owner-session case exposed a defect in my first version of the check: written as `NOT (owner
AND marker = 'on')`, an unset marker made the condition NULL, which PL/pgSQL treats as "do not refuse". Fixed with
`coalesce`; the NULL form is one of the seeded defects now detected (§12).

The other marker-gated changes — `applied_at`, staged cells and the file name — were reviewed for the same weakness.
Their boundary is not the marker but the column privileges: the server's role has no privilege to write those
columns at all, so setting a marker gains it nothing. They are left as they were (§5.1).

### 0.2 Revision 2.1 (your review of revision 2)

| Finding | Change | Evidence (§12) |
|---|---|---|
| 1 `applied_at` integrity | The server's role has no privilege on `applied_at`. A commit runs through an internal state, `committing`, that exists only inside the committing transaction (a deferred check at `COMMIT` refuses to leave a batch in it). A row becomes applied only through the `SECURITY DEFINER` trigger `assets_apply_import_row`, which fires on the row's actual asset operation — the insert of the asset the row creates, or the update of the asset it matched at the version its preview saw — and stamps the database's time. `committed` requires every create and update row applied. One application per row | Forgery refused (server role, schema owner on a previewed batch, schema owner inside a commit); a commit applying nothing cannot complete; a failed commit rolls back assets, row markers, batch state and audit event together; a valid commit stamps one timestamp; update rows applied once, only to their asset, only at the previewed version |
| 2 Down concurrency | The reverse locks every relevant table **before** checking: tables it drops `ACCESS EXCLUSIVE`, `audit_events` and the permission tables `SHARE ROW EXCLUSIVE`, all in the same transaction as the DDL. The migration runner was verified to run each `down()` in one transaction | Runner test (a `down()` failing after the reverse leaves everything in place); two race tests in both orders (a write that started first makes the reverse wait and refuse; a write that starts after it waits and then fails, `42P01`) |
| 3 File name retention | `file_name` is cleared together with the staged cells, on the same schedule; only the fixed retention function can clear it; nothing can restore it. Hash, format, size, identity, timestamps, counts and provenance remain | Retention test: names kept before due, cleared when due, not restorable, not writable by the server role, not clearable early even by the schema owner |
| 4 PD-05 | Option C as you directed; erasure needs the new narrow system permission **`person.erase`** (or the owner), checked by the database against the request's actor; as a system permission it is held only through a system profile, so its holder must have MFA (rule A7). Automatic anonymization disabled for the first release. Account-holder names: §7 | Erasure refused without the permission, allowed with it, one-way |
| 5 Catalogue scope and names | Scope kept global, with the documented rationale (§3.1). Name uniqueness no longer uses the identifier match key: a new, less aggressive **catalogue-name key** keeps punctuation and separators (§4.5) | Distinct names accepted (`1/2 inch`/`12 inch`, `A-1`/`A1`, `Type A`/`TypeA`, …); true duplicates refused |
| 6 `UNASSIGNED` | Verified: a seeded, always-active system warehouse with an immutable code, reached through ordinary warehouse profiles. Gap: "at most one system warehouse" was not a database rule — added as a partial unique index (§3.5) | Single system warehouse; cannot be deactivated or recoded; access only through its scope |
| 7 Validation boundary | PostgreSQL 17 recorded as untested and required before deployment (§13) | — |

### 0.3 Revision 2 (your review of revision 1)
Provenance that survives transfers; imports read-only in an inactive warehouse; the `missing` status; byte-exact
comparison in `COLLATE "C"`; a database-enforced import state machine and actor attribution; the RLS threat model;
handover parties as ids with erasure; a retention lifecycle; guarded rollback; definer-function review; the
enforcement-boundary table.

## 1. Evidence this design rests on

- The web server at HEAD `4dfc246`: roles `wam_owner` (migrations, owner CLI) and `wam_app` (server), column grants,
  no default privileges, append-only `audit_events`, warehouse permissions read from the database on every request,
  404 without permission, idempotency keys, optimistic `version` columns, the startup gate refusing a server role
  with `BYPASSRLS`, the migration CLI refusing `down` when `WAM_ENV=production`, rules A1–A7 (identity-and-access
  §2.3) with A7 enforced by migration 0004.
- The migration runner (`src/db/migrator.ts`, Kysely's `Migrator` on PostgreSQL, whose adapter supports
  transactional DDL, with no `disableTransactions`): every `up` or `down` run executes in **one transaction** under an
  advisory lock (Kysely source; existing test for `up`; new test for `down`, §12).
- Migration 0002: the warehouse `UNASSIGNED` (`is_system`, code immutable for the server's role, `CHECK` keeping a
  system warehouse active); `src/admin/warehouses.ts` refuses to rename or deactivate it.
- The readiness sheet (D-02): "`workshops` is a department/unit lookup, not a warehouse list … workshops must not be
  treated as warehouses." The desktop schema keeps workshops, item types, countries and statuses global, with
  trimmed exact names unique among active entries.
- The desktop schema's four protected statuses, and its comment that «مفقود» was deliberately not seeded there; WAM's
  requirements include it (your review), so the web app seeds it.
- Recorded rules: identifiers stored exactly as written, no serial number invented, suspected duplicates reported
  and never merged, blank cells never erase, provenance on every imported record, unresolved records stay
  `UNASSIGNED` (review §2.7, D-03); E-18 ceilings; D-05; D-06 (1B-5); desktop finding F-3.

## 2. Overview

```
 warehouses ─┬─< assets >── catalogue: item_types, workshops, countries, asset_statuses     (§3.1)
 (UNASSIGNED │     │  ├──< asset_status_history     (trigger-written, append-only; party ids, no names)
  = the one  │     │  └──< asset_warehouse_history  (trigger-written, append-only)
  system     │     └── delivered_by / received_by → users (WAM accounts) or persons (no account)  (§7)
  warehouse) ├─< persons                             (per warehouse; erasable name, permanent id)
             └─< import_batches ─< import_rows       (state machine, staging, provenance, retention)  (§6)
                                       ▲
     assets (origin_import_row_id, origin_warehouse_id) ─┘   original import warehouse, survives transfers
```

## 3. Tables

### 3.1 Catalogue: global, by design
`asset_statuses`, `item_types`, `workshops`, `countries`: name 1–100 characters, `is_active`, timestamps, `version`;
deactivated, never deleted. The five system statuses — `in_stock` «در انبار», `issued` «صادر شده», `returned`
«مرجوع شده», `damaged` «آسیب‌دیده», `missing` «مفقود» — can be neither renamed, recoded nor deactivated; retirement is
not a status. Managing the catalogue needs `catalog.manage` (PD-06).

**Why global.** Item types, countries and statuses are organization-wide vocabularies. Workshops are, per the
recorded project evidence, the organization's departments or units — not warehouses and not warehouse-bound — and
the desktop app keeps one list. A global list lets every warehouse refer to the same unit, and keeps a unit
reachable after an asset is transferred. The consequence: two different units cannot share one active name; they
must be told apart in the name ("Workshop — North site"). **If your workshops are in fact local to warehouses, with
names repeated across them, say so (PD-10):** the minimum change is the `persons` pattern — a `warehouse_id` on
`workshops`, uniqueness per warehouse, row-level security, and a check that a newly chosen workshop belongs to the
asset's warehouse.

Names are unique among active entries by the **catalogue-name key** (§4.5), not by the identifier match key.

### 3.2 `assets`

| Column | Type | Required | Notes |
|---|---|---|---|
| `warehouse_id` | → warehouses | yes | Changed only by a transfer (1B-5, D-06); `UNASSIGNED` for unresolved records (§3.5) |
| `asset_code` | text ≤ 100, `COLLATE "C"` | yes | Exactly as written; unique among unretired assets, byte-exact (PD-01, §4.3); never blank |
| `asset_code_key` | generated, `COLLATE "C"` | — | Match key, for duplicate detection only |
| `name` | text 1–300 | yes | |
| `item_type_id` | → item_types | yes | |
| `model` | text ≤ 200 | no | |
| `serial_number` | text ≤ 100, `COLLATE "C"` | no | Unknown = NULL; not unique (PD-02) |
| `serial_number_key` | generated | — | NULL when the serial is unknown |
| `country_id`, `workshop_id` | → lookups | no | |
| `status_id` | → asset_statuses | yes | Every change goes into the status history |
| `entry_date`, `exit_date` | `date` | no | `exit_date ≥ entry_date`; Jalali only at the edges |
| `delivered_by_user_id` / `_person_id`, `received_by_user_id` / `_person_id` | → users / persons | no | At most one of each pair (PD-05) |
| `notes` | text ≤ 2000 | no | |
| `origin`, `origin_import_row_id`, `origin_warehouse_id` | | yes / when imported | Provenance; set at creation, never changed |
| `retired_at`, `retired_by`, `retirement_reason` | | no | Retirement instead of deletion; granted in 1B-5 |
| `created_*`, `updated_*`, `version` | | yes | Set by the database from the request's actor |

Rules enforced on every write, for every role: an actor is required; a retired asset cannot change; provenance cannot
change; an inactive warehouse is read-only, including moving an asset out of it; newly chosen catalogue entries must
be active; a newly chosen person must belong to this warehouse and not be erased; an imported asset must come from a
`create` row of a batch being committed (§6.1). `DELETE` and `TRUNCATE` are rejected for every role.

### 3.3 History and audit
`asset_status_history` (from → to, when, who, reason, handover parties **as ids**, import row, request ID) and
`asset_warehouse_history` (placement and every move) are written only by the `SECURITY DEFINER` trigger
`assets_record_history`; append-only for every role. Field edits go into `audit_events` as before/after values in the
same transaction, with two content rules: handover parties and persons are recorded by **id**, never by name; import
events name the batch id and hash, never the **file name** (both application-enforced, §10).

### 3.4 Staged import
A batch keeps SHA-256, size (≤ 10 MiB), format and the given file name; the file itself is never stored. Rows hold
the cells as text exactly as parsed (a blank cell is absent), sheet and row number, outcome, value-free issues, and
for `update`/`unchanged` the matched asset and the version the preview saw. Neither batches nor rows are deleted.
State machine, commit protocol, retention: §6.

### 3.5 `UNASSIGNED` (finding 6)
Verified against migrations 0002–0004 and the warehouse service:
- It is a row of `warehouses`, seeded by migration 0002 with code `UNASSIGNED` and `is_system = true`. Its code is
  unique and cannot be changed by the server's role (no `UPDATE` grant on `code`); a `CHECK` keeps a system warehouse
  active for every role; the service refuses to rename or deactivate it. Code finds it by code and system flag,
  never by a hard-coded id.
- Access to it is explicit: like any warehouse, only through warehouse profiles assigned to that warehouse (rule
  A6), or as the owner. Row-level security treats it as an ordinary scope.
- Assets require a `warehouse_id`; an unresolved record is placed in `UNASSIGNED` explicitly, by an import or entry
  that targets it (which needs `asset.import` or `asset.create` there), never by inference. Moving it to a real
  warehouse is an audited assignment (D-03, 1B-5).
- **Gap found and closed:** nothing in the database prevented a second system warehouse (only the owner role could
  create one, but nothing stopped it). The draft adds a partial unique index: at most one system warehouse.

## 4. Identifiers, match keys and exact comparison

### 4.1 Identifier match key
Stored values never change. The match key (`server/src/assets/matchKey.ts`, property-tested; SQL twin
`wam.match_key`) is NFKC; whitespace, invisible format characters and the separators `- _ / . \` and Unicode dashes
removed; Persian and Arabic-Indic digits → ASCII; ي ى → ی, ك → ک; A–Z → a–z, ASCII only; leading zeros kept. It is
used only for **suspected duplicates of asset codes and serial numbers**. The database function is the authority.

### 4.2 Measured difference between the two implementations
On all 1,112,063 Unicode scalar values and 20,000 generated identifiers they agree except on 37 code points (U+A7F1,
U+1CCD6–U+1CCF9) that Unicode decomposed after the version PostgreSQL 16.15 implements (Node 24.22.1: Unicode
17.0); PostgreSQL leaves them unchanged. The test lists them exactly. To be re-run on PostgreSQL 17.

### 4.3 Exact comparison independent of the database collation
"Exact" means byte-for-byte equality of the stored UTF-8 text. Identifier and code columns and every name-key index
are `COLLATE "C"`: comparison and index order are byte-based, independent of the database's default collation and of
operating-system or ICU collation upgrades (which can silently invalidate a btree index on a locale-collated column).
Display sorting chooses its collation in the query. Tested in a database whose default collation is ICU `fa`.

### 4.4 Upgrade procedure (Phase 1D runbook)
After a PostgreSQL major upgrade, re-run the equivalence test; if normalization changed, recompute the generated
keys before reopening imports.

### 4.5 Catalogue-name key (finding 5)
Removing all whitespace and punctuation is right for identifiers (`AB-12` and `ab12` probably are one asset code)
but too aggressive for names people read: it would merge `1/2 inch` with `12 inch`, `Model 3.5` with `Model 35`,
`A-1` with `A1`. The desktop app compares trimmed names exactly, which is too weak in the other direction («كيف» and
«کیف», or `Store  Room` and `store room`, become two entries). `wam.name_key` sits between them:

1. NFKC (full-width and presentation forms → base characters);
2. Persian and Arabic-Indic digits → ASCII; ي ى → ی; ك → ک; A–Z → a–z;
3. every whitespace character and the zero-width non-joiner → a space (Persian writes the same compound with a
   ZWNJ or a space; «آسیب‌دیده» and «آسیب دیده» are one name); other invisible format characters removed;
4. runs of spaces collapsed to one; leading and trailing spaces removed;
5. **punctuation and separators kept.**

Used for the active-name uniqueness of all four catalogue tables and for searching persons. Tested both ways (§12).

## 5. Warehouse isolation

### 5.1 Threat model
The application check is the primary control (route permission, 404). Row-level security is a second layer against
**mistakes**. Its scope comes from `wam.warehouse_scope`, a setting the server writes into each transaction: **trusted
request context, not a security boundary.** Code that can run arbitrary SQL as `wam_app` can set it, and likewise
`wam.actor_user_id`, `wam.change_reason` and `wam.import_row_id` (demonstrated by a test). What still holds against
such code is what privileges and triggers enforce (§8.2, §10). The two internal markers `wam.applying_import_row` and
`wam.applying_retention` are set by the definer functions, and a marker is **never a boundary on its own**: `wam_app`
can set it too. Where the server's role could otherwise make the change — expiring a batch, since it may update
`state` — the guard also requires the schema owner's rights, which only the definer functions (and a `wam_owner`
session) have. Where it could not — `applied_at`, staged cells, the file name — the boundary is that `wam_app` has no
privilege on those columns at all. Defences against injection itself:
parameterized queries only, schema-validated bodies, least-privilege grants.

### 5.2 Mechanism
Each asset, person or import operation runs in a transaction that first sets the scope (normally exactly one
warehouse, after the permission check), the actor, the request ID and optionally a reason, with
`set_config(name, value, true)`, so nothing carries over to the next user of a pooled connection (tested). No scope →
no rows and no writes; a malformed scope → error; the owner gets an explicit list of warehouse ids. Policies cover
assets, persons, both history tables, import batches and rows; computed once per statement.

## 6. Import lifecycle

### 6.1 Batch state machine — enforced by triggers for every role, the owner role included

```
 uploaded ──► uploaded (staging) ─► previewed ─► previewed (re-validation) ─► committing ─► committed
    │                                   │                                      (inside one transaction only)
    ├─► failed (with a failure code)    ├─► cancelled
    ├─► cancelled                       └─► expired (retention)
    └─► expired (retention)
 committed, cancelled, failed, expired: closed and frozen, except the retention step clearing content.
```

- Insert always starts at `uploaded`; `created_by`, timestamps and `version` come from the database; a batch's
  warehouse, hash, size, format and creator never change; its file name changes only when the retention step clears
  it.
- **`committing`** is entered from `previewed` and left only for `committed`, in the same transaction. A deferred
  check at `COMMIT` (a `SECURITY DEFINER` constraint trigger, so it sees the batch whatever scope is set) refuses a
  transaction that would leave a batch in it: no other transaction ever sees `committing`.
- **`expired`** is the retention step's alone: accepted only with the schema owner's rights and the retention marker,
  so only inside `wam.apply_import_retention()` (§0.1). It is a system action (no actor) and also runs in an inactive
  warehouse.
- **`committed`** requires every `create` and `update` row to be applied. Closing sets `closed_at` and `closed_by`
  (NULL only for expiry). Two concurrent commits of one batch are serialized by the row lock; exactly one succeeds.
- **Rows** are inserted only while the batch is `uploaded`; cells are written once; rows are re-validated only while
  the batch is `uploaded` or `previewed`; a row change and a commit of the same batch are serialized.
- **`applied_at`** (finding 1): the server's role has no privilege on it. It is set only by the `SECURITY DEFINER`
  trigger `assets_apply_import_row`, which fires **after the row's own asset operation**:
  - the insert of an asset whose `origin_import_row_id` is a `create` row of a batch in `committing`;
  - the update of the asset a row matched, made with `wam.import_row_id` set to that row, an `update` row of a batch
    in `committing`, with the asset at exactly the version the preview saw.
  The trigger checks the row's warehouse, that it is not yet applied, and stamps `applied_at` with the transaction's
  time; the rows guard accepts the change only from that trigger and only while the batch is `committing`. A second
  operation on the same row, a row of another warehouse, a wrong outcome, another asset or a changed version is
  refused. Applied rows are frozen.

### 6.2 Commit protocol (application, one transaction, `Idempotency-Key`)
1. `UPDATE` the batch to `committing` where its version is the one the preview returned (locks it; refuses a stale
   preview).
2. Lock every matched asset `FOR UPDATE` in id order.
3. For each create or update row: set `wam.import_row_id`; insert or update the asset — one statement per row; the
   database marks the row applied; write the audit event.
4. `UPDATE` the batch to `committed`; record the reconciliation counts in the audit event.
5. `COMMIT`. Any error at any step — a code in use, a changed asset, a lost lock — rolls back assets, row markers,
   batch state and audit events **together** (tested); the batch stays `previewed` and can be previewed again.

### 6.3 Retention lifecycle (PD-09; finding 3)

| Batch | Staged cells and file name | Then |
|---|---|---|
| `uploaded` or `previewed`, untouched for **7 days** (abandoned) | kept | set to `expired` by the system |
| `failed` | kept for diagnosis | cleared **7 days** after failing |
| `cancelled` | kept | cleared **7 days** after cancelling |
| `expired` | kept | cleared **7 days** after expiring (14 days after the last activity) |
| `committed` | kept | cleared **90 days** after committing |

- **Clearing** replaces each row's cells with an empty object, sets the batch's `file_name` to NULL and stamps
  `content_cleared_at`, once; nothing can restore either (not even the schema owner).
- **What remains permanently:** batch id, warehouse, SHA-256, size, format, row count, state, failure code, who and
  when created and closed, when the content was cleared; for each row, sheet, row number, outcome, issue codes and
  columns, matched asset and version, `applied_at`; the links from assets and history.
- **Who:** only `wam.apply_import_retention()`, a `SECURITY DEFINER` function owned by `wam_owner`, executable by
  `wam_app` only, with the periods as constants (a change is a migration). **Expiry** needs the schema owner's rights
  plus the function's marker, so the server's role cannot expire a batch early even though it may update `state`.
  **Clearing** needs the marker, on columns the server's role has no privilege on (`cells` after insert, `file_name`
  after insert, `content_cleared_at`).
- **When:** daily by the server's scheduler (after approval), plus a manual CLI run; idempotent; a missed run is
  caught up; also in inactive warehouses.
- **Audit:** every run writes one `import.retention_applied` event with counts (system actor); Phase 1D alerts when
  none appears for 48 hours. Audit events never contain file names (application rule, §3.3).
- Real spreadsheet ingestion stays disabled.

## 7. Personal data in handovers (PD-05 — option C, as you directed)

- **WAM users** are referenced by user id. **People without accounts** are entries in `persons`, scoped to the
  warehouse that registered them (row-level security), referenced by person id. History and audit hold **ids, never
  names.** A newly chosen person must belong to the asset's warehouse and not be erased; after a transfer the
  reference stays, and the receiving warehouse sees the id, not the name (PD-08, 1B-5).
- **Erasure** sets the person's name to NULL, once and for good; the id and every historical reference stay valid;
  persons are never deleted; erasure works even in an inactive warehouse.
- **Who may erase:** the owner, or a holder of the new system permission **`person.erase`** — narrower than reusing
  `user.manage`, which governs accounts, not people without accounts; the existing model gives no reason to combine
  them. The database checks that the request's actor holds it through an active system profile (or is the owner).
  Being a system permission, it is held only through a system profile: only the owner can assign it (A1) and its
  holder must have an enrolled authenticator (A7, migration 0004), so erasure is MFA-protected by the existing
  privileged-access policy. Audited as `person.erased` with the id only.
- **Automatic anonymization** of unreferenced persons is **disabled** in the first release; manual, authorized erasure
  is the only mechanism. To be revisited before real company data is admitted (O-14).
- **Account-holder names** stay subject to the existing user-account rules: accounts are disabled, never deleted
  (the server's role has no `DELETE` on users); display names are maintained by holders of `user.manage`; no
  retention period or erasure procedure for former employees' account names is defined in the current documents.
  This proposal does not change that; a retention rule for accounts would be a separate decision.

## 8. Privileges and definer functions

### 8.1 Grants to `wam_app`
Column by column. **Not granted:** any `DELETE`; any write to the history tables; `assets.warehouse_id`, provenance
and retirement columns after insert; `created_*`, `updated_*`, `closed_*`, `version`, `content_cleared_at`; staged
cells after insert; **`applied_at`**; **`file_name` after insert**; status codes and the system flag; persons'
warehouse. Full list: draft §10.

### 8.2 `SECURITY DEFINER` review
Four functions run with the owner's rights: `assets_record_history` (history), `assets_apply_import_row` (applied
markers), `import_batches_check_not_committing` (the deferred check) and `apply_import_retention` (retention). All are
owned by `wam_owner`, revoked from `PUBLIC` (the retention function is executable by `wam_app` only), pin
`search_path = pg_catalog, pg_temp`, take no arguments and name every relation with its schema. The guard recognizes
them by their rights: `wam.running_as_schema_owner()` (an ordinary, invoker function) is true exactly when
`current_user` is the owner of schema `wam`. The server's role
cannot alter, re-own, replace or redefine them, drop or disable the triggers or row-level security, or set
`session_replication_role` (tested). Whoever holds the `wam_owner` credentials can change all of this; they stay a
separately held, two-person break-glass control (D-01).

## 9. Rollback strategy

- **Before first use:** the guarded reverse removes the asset schema completely; tested, and the draft applies again.
- **After first use:** refused — as soon as assets, history, import batches, persons, catalogue entries, a profile
  holding `catalog.manage` or `person.erase`, or any audit event about assets, imports, persons or the catalogue
  exist. In the database, in addition to the CLI's refusal of `down` when `WAM_ENV=production`.
- **Concurrency (finding 2):** the reverse takes its locks first — `ACCESS EXCLUSIVE` on every table it drops (assets,
  both history tables, import batches and rows, persons, the four catalogue tables) and `SHARE ROW EXCLUSIVE` on
  `audit_events`, `permission_profile_permissions` and `permissions` — then checks, then drops, all in one transaction
  (the runner's, verified). A write that started first makes it wait and is then seen by the checks; a write that
  starts later waits and then fails against the removed schema. Should a concurrent transaction take locks in the
  opposite order, PostgreSQL's deadlock detection aborts one of the two; neither commits a lost write.
- **Correcting a mistake in production:** a forward migration, or a restore (Phase 1D restore drill).

## 10. What the database enforces and what only the application does

| Guarantee | Enforced by |
|---|---|
| No scope → nothing visible or writable; a given scope confines every query on the scoped tables | **Database** |
| The scope equals the warehouses the user is permitted for this request | **Application** (the database trusts the setting) |
| Every change has an actor; attribution columns, timestamps and versions are stamped | **Database** |
| The actor is the signed-in user | **Application** (trusted setting) |
| History complete and append-only | **Database** |
| No hard delete of assets, persons, history, import batches or rows | **Database** |
| Inactive warehouse read-only for assets, persons (except erasure), batches and rows, also under concurrent deactivation | **Database** |
| Batch state machine; `committing` never visible outside its transaction; closed batches frozen; cells written once | **Database** |
| A row is applied only by its own asset operation inside the commit, once, with the database's timestamp; `committed` only when every create and update row is applied | **Database** |
| An update row applies only at the asset version its preview saw | **Database** (apply trigger); the application also locks matched assets and uses `WHERE version = …` |
| A failed commit rolls back everything it did | **Database** (one transaction); the application must keep the whole commit in it |
| Provenance valid and immutable; a matched asset belongs to the batch's warehouse when matched | **Database** |
| Exact code uniqueness, byte-based; blank identifiers refused; catalogue names unique by the name key; newly chosen entries active; persons of the same warehouse and not erased | **Database** |
| At most one system warehouse; `UNASSIGNED` always active, code immutable | **Database** |
| Issues hold no cell values; file size ≤ 10 MiB; row count ≤ 50,000 | **Database** |
| Batch expiry only by the retention function (schema owner's rights and its marker; not the server role, not even with the marker set) | **Database** |
| Retention periods fixed; cells and file names cleared only by the retention function and never restored | **Database** (the server role has no privilege on those columns) |
| Person erasure only by the owner or a `person.erase` holder; one-way | **Database** (against the trusted actor) |
| A holder of `catalog.manage` or `person.erase` has an enrolled authenticator | **Database** (migration 0004, A7) |
| Only the owner assigns system profiles; who may manage the catalogue | **Application** (A1; permission checks) |
| Blank cells never erase; identical values are not changes | **Application** (`fieldChanges.ts`) |
| Suspected duplicates reported in the preview | **Application** (the database provides keys and indexes) |
| An audit event for every change, in the same transaction; no names and no file names in audit details | **Application** |
| Idempotent writes | **Application**, with the primary key of `idempotency_keys` |
| E-18 limits other than file size and row count; parser confinement | **Parser process** |
| Retention runs daily | **Application / operations** |

## 11. Decisions

### 11.1 Owner decisions

| ID | Decision | State |
|---|---|---|
| **O-16** | Approve this proposal and draft as the basis for migrations 0005–0007 | **Open — your final technical approval** |
| PD-01 | Globally unique, byte-exact asset codes among unretired assets | **Accepted by you, 2026-10-30** |
| PD-02 | Serial number optional, not unique | **Accepted, 2026-10-30** |
| PD-03 | Five system statuses including `missing`; retirement separate | **Accepted, 2026-10-30** |
| PD-04 | Code, name, item type, status required | **Accepted, 2026-10-30** |
| PD-05 | Option C; dedicated `person.erase` system permission; MFA through A7; no automatic anonymization in the first release | **Accepted, 2026-10-30** |
| PD-06 | `catalog.manage`, unassigned initially, grantable only by the owner, with MFA | **Accepted, 2026-10-30** |
| PD-07 | Inactive warehouses read-only, including imports | **Accepted, 2026-10-30** |
| PD-08 | Restrictive history visibility until 1B-5 | **Accepted, 2026-10-30** |
| PD-09 | 7/7/90-day retention, the file name cleared with the staged cells | **Accepted, 2026-10-30** |
| PD-10 | Global catalogue including workshops (organizational units, not warehouses), names unique by the catalogue-name key | **Accepted, 2026-10-30** |

### 11.2 Engineering decisions (reversible; trade-offs)

| ID | Decision | Trade-off |
|---|---|---|
| ED-1 | Row-level security in 1B-3, against mistakes, not against a compromised role | Every asset query runs in a transaction with context |
| ED-2 | History written by a `SECURITY DEFINER` trigger | Logic in PL/pgSQL; reviewed and tested |
| ED-3 | Match keys as stored generated columns | Tied to PostgreSQL's Unicode tables (§4.4) |
| ED-4 | Field edits in `audit_events`; parties as ids only | Two places to read for a full history |
| ED-5 | No hard delete | Mistakes are retired or erased, not removed |
| ED-6 | `date` columns; Jalali at the edges | Specified with the field contract |
| ED-7 | Attribution stamped by the database | The actor setting must be present |
| ED-8 | Uploaded files not stored | A cancelled import is uploaded again |
| ED-9 | Byte-exact uniqueness in `C` | Display sorting names its collation |
| ED-10 | Provenance keeps the original import warehouse | The source row stays in the original warehouse's scope |
| ED-11 | Import state machine in triggers, for every role | Retention is the single, narrow exception |
| ED-12 | Retention as a fixed-policy definer function | Periods change by migration |
| ED-13 | Guarded reverse in the database, with locks first | A used schema can only be fixed forward or restored |
| ED-14 | `committing` state plus a definer apply trigger for `applied_at` | One asset statement per row during a commit; two more definer functions to review |
| ED-15 | Separate catalogue-name key | Two normalizations to maintain (identifiers, names) |
| ED-16 | Batch expiry gated on the schema owner's rights plus the retention marker, rather than removing `UPDATE` on `state` and adding one function per transition | One check in the existing guard; no change to the permission model; the guard depends on the schema being owned by the migration role |
| ED-17 | Erasure tombstones stored idempotency responses through an explicit link (`idempotency_keys.subject_person_id`, migration 0008) and a `SECURITY DEFINER` trigger on erasure, rather than matching stored responses by their shape, deleting them, or storing person responses without the name | The link is set by the two routes that return a name (a new such route must set it too; tested); the trigger also replaces the request fingerprint, a hash of the name; after erasure any request with such a key replays the tombstone instead of `422` for a different body; one more definer function |
| ED-18 | O-17's 5,000-row limit enforced in the service (staging under the batch row lock; preview and commit re-count the stored rows), without a database constraint | No migration; the existing `row_count BETWEEN 0 AND 50000` check stays as the outer bound; code that runs SQL as `wam_app` outside the service is out of scope as in §5.1 |

## 12. Validation evidence (2026-10-30, PostgreSQL 16.15, Node 24.22.1, non-root user, invented records only)

- Draft validation suite (`server/tests/integration/assetSchemaDraft.test.ts`): **53 of 53 passed** against the final
  draft and reverse. New in 2.2: the server's role cannot expire an uploaded or a previewed batch — directly, or with
  `wam.applying_retention = 'on'` set by hand, with or without an actor; a `wam_owner` session without the marker
  cannot either; the retention function expires abandoned batches after 7 days while a 6-day batch stays open, and
  also expires an abandoned batch in an inactive warehouse; failed, cancelled, expired and committed batches are
  cleared on the 7/7/90-day schedule as before. All earlier tests still pass, among them the state machine,
  `applied_at` forgery and atomic commit, the concurrent-commit, row-versus-commit and down-migration races, and
  the runner's transactional `down()`.
- Seeded-defect check against the **final** draft: **33 of 33 defects detected**, each applied alone to a copy — 4 for
  the expiry rule (no check, as in 2.1; marker alone; owner's rights alone; the NULL-unsafe form), the 12 of
  revision 2.1 and the 17 of revisions 1 and 2. Two further defects — the owner's-rights check removed from the
  `applied_at` and file-name paths, in a version I tried and then withdrew — were not detected, because no role can
  reach those paths without the column privileges; that is why the check is not used there (§0.1).
- Full server suite: typecheck, ESLint, **412 of 412 tests** (181 unit, 231 integration), build — all passed.
- **Not executed:** **PostgreSQL 17** (deployment target; required before any deployment or production migration,
  §13); the desktop suite (no desktop file changed); cost at E-18's 50,000-row maximum; the real services and routes
  (not written). The transfer in the tests is a fixture run as `wam_owner`, standing in for 1B-5.

## 13. After approval: implementation sequence and required checks

1. Migrations 0005 (single system warehouse, catalogue, name key, `catalog.manage`, `person.erase`;
   `src/access/permissions.ts` updated and tested), 0006 (persons, assets, history, triggers, row-level security),
   0007 (import staging, apply trigger, retention), each with the guarded `down` of §9; the validation tests move onto
   the migrated schema.
2. Request-context helper; catalogue, persons and asset APIs with idempotency, audit rules of §3.3, optimistic
   concurrency and 404 for missing permission.
3. Import staging, preview, commit (§6.2) and the retention scheduler on synthetic fixtures, **behind a setting off by
   default** until G-2…G-9 pass; ExcelJS only after its O-13 conditions; no real spreadsheet before O-14 admits one;
   commit and retention measured at E-18's maximums.
4. Isolation suite (1B-4) extended to every new endpoint.
5. **Required before any deployment or production migration:** the full server suite and the schema validation
   suite on **PostgreSQL 17** (including the Unicode equivalence test and the ICU collation test), with the results
   recorded.

### 13.1 Implementation status (2026-10-30, working tree, uncommitted; PostgreSQL 16.15, Node 24.22.1, non-root user, invented records only)

| Step | State |
|---|---|
| 1. Migrations | **Done.** `server/src/db/migrations/0005_asset_catalogue.ts`, `0006_assets_and_history.ts`, `0007_import_staging.ts`, generated from the approved draft; each `down` is the guarded, lock-first reverse of §9 for its part. The schema suite (`server/tests/integration/assetSchema.test.ts`, formerly `assetSchemaDraft.test.ts`) runs on the migrated schema: **54 of 54**, including a schema-dump comparison proving the migrations produce exactly the draft's schema, grants and seed rows, one-migration-per-run reversal and re-application, the runner's transactional `down()`, and the down-migration races of 0007 |
| 2. Request context and APIs | **Done.** `server/src/db/dataContext.ts` sets the warehouse scope, actor, request and reason with `set_config(…, true)`: transaction-local, never on the pooled session. Catalogue (`/api/catalog/:kind`: read signed-in, change with `catalog.manage`), assets (`/api/warehouses/:id/assets`: list, search, count, detail, history, create, edit, status change), persons (list, create, rename; erase with `person.erase`). Idempotency-Key on every change, version checks, audit per §3.3 (no person names, no file names), 404 for missing permission, `WAREHOUSE_INACTIVE` in an inactive warehouse. Tests: `assetApi.test.ts`, **13 of 13** |
| 3. Import | **Done, disabled by default.** `server/src/imports/imports.ts`: staging (rows keyed by internal field identifiers; no parser and no upload route), preview (re-validation; issue codes plus field identifiers only), commit per §6.2 (committing → lock matched assets in id order → re-validate, refuse if anything changed → one asset statement per row with `wam.import_row_id` set → committed, in one transaction), cancel, and the retention step. Routes `/api/warehouses/:id/imports…` (list, detail with paged rows, preview, commit, cancel; `asset.import`) are registered only with `WAM_IMPORT_ENABLED=true` (default `false`). Retention runs at start-up and then daily, whether or not imports are enabled, with its own 10-minute statement timeout. Tests: `importApi.test.ts`, **18 of 18**, plus start-up tests in `server.test.ts` |
| 4. Isolation | **Done for every new endpoint**: as a user of another warehouse, a user without access, and (for imports) users of the same warehouse without `asset.import`, every list, search, count, detail, history, audit, create, edit, status, person and import endpoint answers 404; another warehouse's record through the own warehouse's URL answers 404; a mismatched data context hides a batch even when the service is asked for it directly (row-level security); asset and import audit events appear only in their own warehouse's trail |
| 5. PostgreSQL 17 | **Not done** — required before any deployment or production migration |

**Measured cost at E-18's maximum (sandbox, 4 vCPUs, PostgreSQL 16.15; indicative only — not the gate measurement,
which must run on the target host, G-3).** `server/tests/perf/import.perf.test.ts`, 50,000 invented rows:

| Step | 50,000 new assets | 50,000 updates of them |
|---|---|---|
| Stage | 4.7 s | 4.5 s |
| Preview | 6.8 s | 11.0 s |
| Commit (one transaction) | **83.8 s** | **67.6 s** |
| Retention, clearing both batches (100,000 rows) | 4.4 s | |

Two improvements came out of this measurement before it was recorded: staging and preview write rows in chunks rather
than one statement per row, and the commit reads matched assets in one query and writes its audit events in chunks
(preview at 5,000 rows went from 3.1 s to 0.5 s). The commit keeps one asset statement per row (§6.2); about 1.4 ms of
each insert and 1 ms of each update is spent in the database (triggers, constraints, match-key indexes), so the commit
cannot become much faster without changing the approved protocol. **A commit at the maximum therefore takes more than
a minute in one request** — longer than common reverse-proxy timeouts. This needs your decision before imports are
enabled (register, O-17 proposed). **Decided 2026-10-30 (O-17): at most 5,000 non-blank data rows per batch, enforced by the server; implemented, §13.2.**

### 13.2 Review remediation (2026-10-30, after the independent review of the working tree)

| Finding | Change | Evidence |
|---|---|---|
| S-2 (privacy, PD-05) | Migration **0008** `idempotency_person_subjects`: `idempotency_keys.subject_person_id` (FK to persons, partial index, `UPDATE` grant on that column only), definer trigger `persons_tombstone_idempotency` that, on erasure, replaces linked responses with `{id, displayName: null, erased: true, version}` and their fingerprints with 32 zero bytes; person create and rename set the link; a replay overlapping an erasure waits for it (its `INSERT … ON CONFLICT` waits on the row being changed) and then replays the tombstone. Guarded, lock-first down (refuses while links exist) | `personPrivacy.test.ts`; fails on the pre-remediation tree |
| S-1 | Tests on **one physical connection** (pool of 1, backend pid asserted) after commit, rollback, a failing request, a failing import commit, a context-less transaction and a request of another warehouse | `requestContext.test.ts`; seeded session-level faults detected |
| O-17 | `MAX_IMPORT_BATCH_ROWS = 5000`; blank rows (all cells missing, empty or `trim()`-whitespace) skipped and not counted; invalid rows counted; per-batch count under the batch row lock; whole call refused before any write (`IMPORT_TOO_LARGE`, 422); preview and commit re-count stored rows and refuse a mismatch with the batch's count | `importLimit.test.ts` |
| S-5, S-6 | Erasure in an inactive warehouse over HTTP; each defence layer tested alone (asset row lock, version comparison, `UPDATE` version condition, commit lock, commit re-validation, warehouse filter, row-level security); down races for 0006 and 0005; per-migration guard tests | `personPrivacy.test.ts`, `defenseLayers.test.ts`, `assetSchema.test.ts` |

0005–0007 are unchanged and still equal the approved draft (the dump comparison now runs against a database migrated
exactly to 0007); 0008 is the only schema addition and the fifth `SECURITY DEFINER` function.

## 14. Not in this proposal
Transfers, retirement and approvals (1B-5, D-06); assignment from `UNASSIGNED` (D-03); the import field contract and
header mapping, including mapping names to persons (O-14 stage 2); real data; UI (1C); backup and restore drills (1D).
