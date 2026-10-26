# Phase 1A — owner decisions P-1 to P-3 (base-data deletion contract)

Recorded: 2026-10-26. Source: the owner's "Phase 1A Closure Decisions and Phase 1B Readiness Review" message.
Status: **APPROVED by the owner.** These approvals confirm the intended behavior of the existing desktop code.
They do **not** authorize any unrelated desktop behavior change, and no file under `src/` was changed.

| ID | Decision | Approved option |
|---|---|---|
| P-1 | Bulk base-data deletion when some selected rows cannot be removed | **Option A — independent per-row outcomes.** A blocked row must not prevent unrelated eligible rows from being processed. (Supersedes the old "all-or-nothing" rule.) |
| P-2 | A base-data value referenced **only** by soft-deleted assets | **Deactivate, do not hard-delete**, so the historical reference is preserved. (A hard `DELETE` is impossible anyway: the foreign key ignores `is_deleted`.) |
| P-3 | Result contract of the delete operations | Confirmed. Single delete: `{ id, name, action: 'deleted' }` or `{ id, name, action: 'deactivated', historicalUsage }`. Bulk delete: `{ deletedCount, deactivatedCount, blocked: [{ id, name, activeUsage }] }`. |

## Where the approved behavior lives (verified in the repository)

- Implementation: `src/main/services/lookupService.js` (`deleteLookup`, `deleteLookupsBulk`); migration 004 (base-data lifecycle).
- UI consumer: `src/renderer/src/pages/SettingsPage.jsx` reads `result.action`, `deletedCount`, `deactivatedCount`, `blocked`.
- Existing tests that already encoded this contract: `tests/main/services/baseDataLifecycle.test.js`.
- Tests updated in Phase 1A to match: `tests/main/services/lookupDeletion.test.js` (4 tests; old→new mapping and reasons in
  `docs/testing/phase-1a-test-dispositions.md`, section B).

## Consequence for the future web server

The server's base-data deletion must reproduce these three rules (per-row outcomes, deactivate-when-only-historically-referenced,
same result fields) unless the owner later decides otherwise. They become acceptance criteria for the Phase 1B port of the lookup
service; they are not implemented on the server yet.
