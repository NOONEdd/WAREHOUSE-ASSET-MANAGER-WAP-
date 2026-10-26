# Phase 1A — disposition of the 23 baseline test failures

Baseline `efbd65a`: 552 tests, 529 passed, 23 failed (reproduced independently).
After Phase 1A: **533 tests, 529 passed, 4 failed** (see "Count arithmetic" at the end).
No source file under `src/` was changed. No test was weakened to obtain a pass.

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

## B. `lookupDeletion.test.js` — 4 failures: **left failing, awaiting an owner decision**

These encode the contract from *before* the Base Data Lifecycle phase (migration 004). The code
(`lookupService.deleteLookup` / `deleteLookupsBulk`), the Settings screen (`SettingsPage.jsx` reads
`result.action`, `deletedCount`, `deactivatedCount`, `blocked`) and `baseDataLifecycle.test.js` (e.g. "Case B: ONLY a soft-deleted asset references it → deactivated, not blocked, not hard-deleted") all agree on
the *new* contract. Phase 1A does not choose between them.

| Test | Old expectation | Current code | Decision needed |
|---|---|---|---|
| single: "deletes a value that no asset uses" | result lacks `action` | returns `{ id, name, action: 'deleted' }` | **P-3** confirm result shape |
| single: "refuses to delete a value only a SOFT-DELETED asset uses" | blocked with an error | **deactivates** it (FK would block a hard DELETE, so refusing left no way forward) | **P-2** confirm deactivate-instead-of-block |
| bulk: "deletes every selected value when none are in use" | `{ count }` | `{ deletedCount, deactivatedCount, blocked[] }` | **P-3** |
| bulk: "all-or-nothing…" | one in-use value aborts the whole batch | each row decided independently; in-use rows are left alone, others still change | **P-1** partial vs all-or-nothing |

**Decisions requested**

- **P-1 Bulk deletion of base data (item types / workshops / countries):** (A) per-row outcomes — *current behavior*, one in-use value never blocks the others, the UI reports exactly what happened; or (B) all-or-nothing — one in-use value rejects the whole batch.
  My recommendation: **A** (already shipped, already what the Settings UI renders, avoids "one stray value blocks cleanup of fifty"). B would need a service change, a UI change and rewriting `baseDataLifecycle.test.js` — a separate authorized change, not a test edit.
- **P-2 Value referenced only by soft-deleted assets:** deactivate (current) or refuse. Recommendation: **deactivate**.
- **P-3 Result shapes** (`action`, `deletedCount`, `deactivatedCount`, `blocked`): confirm as the contract. Recommendation: confirm.

**If A + deactivate + shapes are approved,** the follow-up is test-only: update the 3 single/shape assertions to the current
contract and retire the all-or-nothing test with a mapping to `baseDataLifecycle.test.js` ("one blocked record does not
prevent…" and the transaction test). If B is chosen, that is a behavior change and needs its own authorization.

## C. Vacuous tests found while reviewing

`lookupDeletion.test.js` called `assetRepository.softDelete(asset.id, null)` where `asset` is the plain numeric id
returned by `seedAssetUsing()` — so `asset.id` was `undefined` and nothing was soft-deleted (probe: `is_deleted` stayed 0).

1. "counts soft-deleted assets too, matching what the FK constraint actually enforces" **passed without ever
   soft-deleting an asset**. Fixed in Phase 1A (uses the id, and now asserts `is_deleted = 1`); with the fix, making
   `countUsage` ignore soft-deleted rows makes it fail, which it did not before.
2. The SOFT-DELETED single-delete test above has the same setup defect, and its current failure message ("…فعال استفاده می‌شود")
   is partly an artifact of it. **Not changed here** because that test is part of decision P-2; fix its setup when it is updated.

A broader vacuity review (fault-injection of the security-critical tests) is a Phase 1B task, when those tests exist.

## Count arithmetic

552 baseline − 20 retired (`statusCleanup`: 19 failing + 1 passing) + 1 added (SM active-usage test) = **533**;
529 passed − 1 retired passing test + 1 added passing test = **529**; 23 − 19 = **4 failing**.
