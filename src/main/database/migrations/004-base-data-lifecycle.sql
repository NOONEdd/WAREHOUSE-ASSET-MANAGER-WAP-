-- Migration 004: Base Data Lifecycle — is_active for item_types,
-- workshops, and countries, with uniqueness scoped to active rows only.
--
-- The problem this fixes: assets.item_type_id / country_id / workshop_id
-- are FKs with ON DELETE RESTRICT, and a soft-deleted asset row still
-- physically exists with that FK intact (is_deleted is an application
-- concept SQLite's FK enforcement knows nothing about) — so a lookup
-- value referenced by even a single soft-deleted (never mind active)
-- asset could never actually be deleted, only ever produce a "still in
-- use" error the user had no way past. Verified this empirically:
-- bypassing the application and running a raw SQL DELETE against a
-- lookup with only soft-deleted references still fails at the database
-- level with a foreign-key violation, so no purely application-level fix
-- was possible — this is the same is_active pattern already proven for
-- asset_statuses (migrations/003-status-management-columns.sql):
-- deactivate instead of delete when history depends on the row, hard
-- delete only when genuinely nothing references it at all.
--
-- Uniqueness is rebuilt as a partial index scoped to is_active = 1,
-- mirroring assets.asset_code/serial_number's own active-only uniqueness
-- (migration 002) — the exact same reasoning: a deactivated "Laptop
-- Dell" and a newly (re)created active "Laptop Dell" are not the same
-- thing and must be allowed to coexist, while two ACTIVE rows with the
-- same name still never should. SQLite has no ALTER TABLE DROP
-- CONSTRAINT for a column-level UNIQUE, so — same as migration 002 —
-- this rebuilds each table via SQLite's own documented procedure:
-- disable foreign-key enforcement, copy every row into a new table with
-- the new shape, swap it in under the old name, restore foreign keys.
-- Every id is preserved exactly (explicit column lists, not SELECT *),
-- so assets.item_type_id/country_id/workshop_id values — and
-- audit_log.entity_id references to these rows — all stay valid without
-- needing to touch the assets table at all in this migration.
--
-- Existing rows all become is_active = 1 (the column's own DEFAULT),
-- exactly as instructed — nothing that already worked is retroactively
-- deactivated.
--
-- Guarded in connection.js to run only if item_types doesn't have
-- is_active yet, so this rebuild happens once per database, not on
-- every launch — same guard style as migration 002/003.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE item_types_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO item_types_new (id, name) SELECT id, name FROM item_types;
DROP TABLE item_types;
ALTER TABLE item_types_new RENAME TO item_types;
CREATE UNIQUE INDEX idx_item_types_name_active ON item_types(name) WHERE is_active = 1;

CREATE TABLE workshops_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO workshops_new (id, name) SELECT id, name FROM workshops;
DROP TABLE workshops;
ALTER TABLE workshops_new RENAME TO workshops;
CREATE UNIQUE INDEX idx_workshops_name_active ON workshops(name) WHERE is_active = 1;

CREATE TABLE countries_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    iso_code TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO countries_new (id, name, iso_code) SELECT id, name, iso_code FROM countries;
DROP TABLE countries;
ALTER TABLE countries_new RENAME TO countries;
CREATE UNIQUE INDEX idx_countries_name_active ON countries(name) WHERE is_active = 1;

COMMIT;

PRAGMA foreign_keys = ON;
