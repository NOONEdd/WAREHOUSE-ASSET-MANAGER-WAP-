# Phase 1A — disposition of the 23 baseline test failures

Baseline `efbd65a`: 552 tests, 529 passed, 23 failed (reproduced independently).
After Phase 1A closure: **533 tests, 533 passed, 0 failed** (see "Count arithmetic" at the end).
No source file under `src/` was changed. No test was weakened to obtain a pass: every retired or replaced test is
mapped below with the reason its old contract no longer applies.

## A. `statusCleanup.test.js` — 19 failures: retired (obsolete), with replacements

The file tested three functions (`listStatusesForCleanup`, `deleteLegacyStatus`,
`migrateAndDeleteLegacyStatus`) from the older fixed five-status model. They no longer exist:
the Manual Status Management phase replaced them with `listStatuses`, `deleteStatus` and
`migrateAndDeleteStatus` (`src/main/services/lookupService.js`) and changed the model from five
"canonical" statuses to **four system statuses + administrator-managed custom statuses**.
Every scenario below has a named replacement in `tests/main/services/statusManagement.test.js` (SM)
or `baseDataLifecycle.test.js` (BDL). The one test of the 20 that was passing at baseline (#19) is
retired together with the file because it is duplicated three times over.

| # | Retired scenario (statusCleanup) | Baseline | Replacement test |
|---|---|---|---|
| 1 | lists all five canonical statuses as protected, zero usage | fail | SM "lists all four system statuses as protected and active, ordered by sort_order" (five→four is the intended model change) |
| 2 | marks a legacy value as not canonical and reports its usage count | fail | SM "marks an administrator-created status as not system" + **new** SM "reports how many assets use a custom status (active assets are counted)" (added in Phase 1A to close a real gap) |
| 3 | counts a soft-deleted asset toward legacy usage | fail | SM "counts a soft-deleted asset toward a custom status usage count too" |
| 4 | deleteLegacyStatus: deletes an unused one | fail | SM "deletes a custom status nothing references" |
| 5 | …records an audit entry with no reassignment target | fail | SM "records a STATUS_DELETED audit entry with no reassignment target" |
| 6 | …refuses to delete a canonical status | fail | SM "refuses to delete any of the four system statuses" |
| 7 | …refuses when an active asset uses it, naming the count | fail | SM "refuses to delete a custom status an active asset uses, suggesting deactivation instead" |
| 8 | …refuses when only a soft-deleted asset uses it | fail | SM "refuses to delete a custom status only a soft-deleted asset uses" |
| 9 | …rejects an id that no longer exists | fail | SM "rejects an id that no longer exists" (deleteStatus block) |
| 10 | migrateAndDelete: refuses a canonical status | fail | SM "refuses to migrate any of the four system statuses" |
| 11 | …refuses a target that is **not canonical** | fail | **Rule intentionally replaced**: the target must now be any *active* status, not one of five fixed names. SM "refuses an inactive target", "can migrate onto a system status target", "moves every asset onto a custom target status, then deletes the source". The old invariant has no equivalent by design. |
| 12 | …refuses a nonexistent target | fail | SM "refuses a target status name that does not exist" |
| 13 | …moves every asset onto the target | fail | SM "moves every asset onto a custom target status, then deletes the source" / "can migrate onto a system status target" |
| 14 | …also reassigns soft-deleted assets | fail | SM "also reassigns soft-deleted assets, so the source row can actually be deleted" |
| 15 | …writes a ledger row per reassigned asset | fail | SM "writes a transaction-ledger entry per reassigned asset, naming the old status in notes" |
| 16 | …writes exactly one audit entry | fail | SM "records exactly one audit entry for the whole migration, not one per asset" |
| 17 | …works with zero affected assets | fail | SM "works with zero assets too — a plain delete with no transaction rows" |
| 18 | …refuses and rolls back on a historical FK reference | fail | SM "refuses (and rolls back the reassignment) when historical transaction records still reference the status" |
| 19 | `deleteLookup("statuses")` still throws | **pass** | SM "deleteLookup(\"statuses\", ...) still throws even for a deletable custom status"; BDL "still refuses \"statuses\" entirely — unchanged, Status Management is not part of this phase"; `lookupDeletion.test.js` "refuses to delete asset_statuses through this path…" |
| 20 | `createLookup("statuses")` refuses | fail | SM "createLookup(\"statuses\", ...) redirects to the dedicated status screen instead of creating anything" (only the error wording changed) |

(SM = `statusManagement.test.js`, BDL = `baseDataLifecycle.test.js`; titles are exact. The retired file remains available via `git show desktop-baseline-efbd65a:tests/main/services/statusCleanup.test.js`.)

**Evidence the replacements are not decorative.** Seven mutations were applied one at a time to `src/main` in a scratch copy
(drop the ledger insert; skip soft-deleted assets in reassignment; ignore the usage count in `deleteStatus`; drop the
migration audit entry; disable system-status protection; allow an inactive migration target; let `createLookup` accept
`statuses`) and `statusManagement.test.js` failed on each. The source was restored after each run.

## B. `lookupDeletion.test.js` — 4 failures: updated to the owner-approved contract (P-1, P-2, P-3)

The four tests encoded the contract from *before* the Base Data Lifecycle phase (migration 004). The code
(`lookupService.deleteLookup` / `deleteLookupsBulk`), the Settings screen (`SettingsPage.jsx` reads
`result.action`, `deletedCount`, `deactivatedCount`, `blocked`) and `baseDataLifecycle.test.js` (e.g. "Case B: ONLY a soft-deleted asset references it → deactivated, not blocked, not hard-deleted") all implement the
*current* contract. On 2026-10-26 the owner approved that contract as intended (P-1 Option A, P-2 deactivate,
P-3 result shapes; see `docs/decisions/phase-1a-owner-decisions.md`). No `src/` change was needed or made.

| # | Old test (baseline) | Disposition | New test / assertion | Why the old contract no longer applies |
|---|---|---|---|---|
| 1 | "deletes a value that no asset uses" — expected result `{ id, name }` | **Updated** (same title) | expects `{ id, name, action: 'deleted' }` | P-3. Since migration 004 the result names the outcome so callers can tell a hard delete from a deactivation; the Settings screen reads `result.action`. |
| 2 | "refuses to delete a value only a SOFT-DELETED asset uses — matches the database FK…" — expected a thrown error | **Replaced** | "deactivates a value only a SOFT-DELETED asset uses, preserving the historical reference" | P-2. A hard DELETE is impossible (the FK ignores `is_deleted`), so refusing left the value permanently undeletable; the approved behavior is deactivation. The new test first asserts the soft-delete really happened (`is_deleted = 1`), that `countUsage` is 1 and `countActiveUsage` is 0, then asserts `{ action: 'deactivated', historicalUsage: 1 }`, that the row still exists with `is_active = 0`, and that the soft-deleted asset still points at it. Related: BDL "Case B…" and "a genuine raw-SQL hard DELETE would actually fail on Case B…". |
| 3 | "deletes every selected value when none are in use" — expected `{ count: 2 }` | **Updated** (same title) | expects `{ deletedCount: 2, deactivatedCount: 0, blocked: [] }` | P-3. Bulk results report per-outcome counts plus the blocked list. |
| 4 | "is all-or-nothing: if even one selected value is in use, NOTHING is deleted" | **Replaced** (contract reversed) | "processes each selected value independently: an in-use value is reported as blocked and left untouched, the others still proceed" | P-1 Option A. The all-or-nothing rule is superseded: an in-use value must not stop unrelated eligible rows. The new test asserts the exact result (`deletedCount: 1`, `blocked: [{ id, name, activeUsage: 1 }]`), that the eligible row was deleted, and that the blocked row still exists and is active. Related BDL tests: "A (unused) is hard-deleted, B (historical-only) is deactivated, C (active) is protected — all in the same call", "one blocked record does not prevent a different, safe record in the same selection from being processed", "is transactional: every delete/deactivate in the plan either all apply or none do". |

**Evidence the updated tests are not decorative.** Five mutations were applied one at a time to `lookupService.js`
(drop `action` from the hard-delete result; block instead of deactivate when only soft-deleted assets reference a
value; make "deactivate" a no-op; make bulk all-or-nothing again; drop `blocked[]` from the bulk result). Each made exactly
one `lookupDeletion.test.js` test fail, and the source was restored after each run (`git status` showed no `src/` change).

## C. Vacuous tests found while reviewing

`lookupDeletion.test.js` called `assetRepository.softDelete(asset.id, null)` where `asset` is the plain numeric id
returned by `seedAssetUsing()` — so `asset.id` was `undefined` and nothing was soft-deleted (probe: `is_deleted` stayed 0).

1. "counts soft-deleted assets too, matching what the FK constraint actually enforces" **passed without ever
   soft-deleting an asset**. Fixed in Phase 1A (uses the id, and now asserts `is_deleted = 1`); with the fix, making
   `countUsage` ignore soft-deleted rows makes it fail, which it did not before.
2. The SOFT-DELETED single-delete test had the same setup defect. It was replaced as part of P-2 (row 2 above); its setup now
   asserts `is_deleted = 1` before exercising the behavior.

A broader vacuity review (fault-injection of the security-critical tests) is a Phase 1B task, when those tests exist.

## Count arithmetic

552 baseline − 20 retired (`statusCleanup`: 19 failing + 1 passing) + 1 added (SM active-usage test) = **533** tests.
Passing: 529 baseline − 1 retired passing test + 1 added + 4 updated/replaced `lookupDeletion` tests (previously failing) = **533**.
Failing: 23 − 19 (retired) − 4 (updated) = **0**. The `lookupDeletion` count is unchanged at 11 tests (2 updated in place, 2 replaced one-for-one).
