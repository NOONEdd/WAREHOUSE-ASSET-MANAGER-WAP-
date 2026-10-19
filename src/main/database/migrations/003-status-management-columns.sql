-- Migration 003: manual status management (active/inactive + display
-- order).
--
-- asset_statuses moves from a fixed, code-hardcoded enum to an
-- administrator-managed list (see lookupService.js's status-management
-- functions and SettingsPage.jsx's status panel). This requires two new
-- columns:
--
--   is_active  — lets a status be retired without deleting it. Deleting
--                a status that any asset or historical transaction has
--                ever referenced is exactly what this phase is meant to
--                avoid (the FK from assets/asset_transactions would
--                refuse it anyway) — deactivating instead keeps every
--                existing asset and every historical record fully valid,
--                while making the status unavailable for new selections.
--   sort_order — lets the administrator control display order instead
--                of the fixed alphabetical order every other lookup kind
--                uses. Nullable at the column level only so ADD COLUMN
--                doesn't require a default expression referencing other
--                rows; the UPDATE below immediately backfills every
--                existing row, so in practice it's never actually null
--                once this migration has run.
--
-- ADD COLUMN is safe and lightweight in SQLite — unlike migration 002's
-- constraint change, this needs no table rebuild: it only appends new
-- columns with defaults, so every existing status row, every asset's
-- status_id, and every historical asset_transactions row referencing a
-- status_id continue to work completely unchanged.
--
-- is_active defaults to 1 (active) for every existing row — nothing
-- that already worked stops working after this migration runs, and
-- nothing pre-existing is silently deactivated.
--
-- sort_order is seeded from each row's own id, so the display order
-- immediately after migrating is identical to today's (id/insertion)
-- order — nothing visually reshuffles for an existing install.
--
-- Guarded in connection.js to run only if the column doesn't exist yet,
-- same pattern as migration 001's plain-statement idempotency (ADD
-- COLUMN itself isn't naturally repeatable — it errors if the column
-- already exists — so this one genuinely needs the guard, not just a
-- courtesy check).

ALTER TABLE asset_statuses ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE asset_statuses ADD COLUMN sort_order INTEGER;

UPDATE asset_statuses SET sort_order = id WHERE sort_order IS NULL;
