-- Migration 002: scope asset_code / serial_number uniqueness to ACTIVE
-- (not soft-deleted) assets only.
--
-- The bug this fixes: asset_code and serial_number were UNIQUE as plain
-- column constraints, which SQLite enforces across every row in the
-- table regardless of is_deleted. So deleting an asset didn't free up
-- its code/serial number — the soft-deleted row was still physically
-- present and still "owned" that value — meaning re-adding or
-- re-importing the exact same asset was rejected as a duplicate of a
-- row the user could no longer even see or recover. Application code
-- (assetRepository.findByCodeOrSerial / findAllCodesAndSerials) had the
-- same gap: neither filtered is_deleted, so the duplicate-check queries
-- agreed with the bug rather than catching it.
--
-- SQLite has no ALTER TABLE ... DROP CONSTRAINT, so removing a
-- column-level UNIQUE requires rebuilding the table — this follows
-- SQLite's own documented procedure for that: disable foreign-key
-- enforcement, copy every row into a new table that doesn't have the
-- constraint, swap it in under the old name, restore foreign keys. Every
-- asset and its id is preserved exactly as-is (explicit column list, not
-- SELECT *, so column order differences can't silently misalign data);
-- asset_transactions.asset_id and audit_log.entity_id references stay
-- valid since ids never change, and AUTOINCREMENT continues from the
-- same point since ALTER TABLE RENAME (not a manual DROP+CREATE) carries
-- the sqlite_sequence entry over correctly.
--
-- Guarded in connection.js to run only if idx_assets_code_active doesn't
-- exist yet, so this rebuild happens once per database, not on every
-- launch — unlike the simple UPDATE statements in migration 001, a table
-- rebuild isn't naturally a no-op to repeat.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE assets_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_code TEXT NOT NULL,
    asset_name TEXT NOT NULL,
    item_type_id INTEGER NOT NULL REFERENCES item_types(id) ON DELETE RESTRICT,
    model TEXT,
    serial_number TEXT NOT NULL,
    country_id INTEGER REFERENCES countries(id) ON DELETE RESTRICT,
    workshop_id INTEGER REFERENCES workshops(id) ON DELETE RESTRICT,
    warehouse_entry_date TEXT,
    warehouse_exit_date TEXT,
    delivered_by TEXT,
    received_by TEXT,
    status_id INTEGER NOT NULL REFERENCES asset_statuses(id) ON DELETE RESTRICT,
    notes TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    deleted_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO assets_new (
    id, asset_code, asset_name, item_type_id, model, serial_number, country_id, workshop_id,
    warehouse_entry_date, warehouse_exit_date, delivered_by, received_by, status_id, notes,
    is_deleted, deleted_at, deleted_by, created_at, updated_at
)
SELECT
    id, asset_code, asset_name, item_type_id, model, serial_number, country_id, workshop_id,
    warehouse_entry_date, warehouse_exit_date, delivered_by, received_by, status_id, notes,
    is_deleted, deleted_at, deleted_by, created_at, updated_at
FROM assets;

DROP TABLE assets;

ALTER TABLE assets_new RENAME TO assets;

CREATE INDEX idx_assets_name ON assets(asset_name);
CREATE INDEX idx_assets_model ON assets(model);
CREATE INDEX idx_assets_status ON assets(status_id);
CREATE INDEX idx_assets_workshop ON assets(workshop_id);
CREATE INDEX idx_assets_item_type ON assets(item_type_id);
CREATE INDEX idx_assets_country ON assets(country_id);
CREATE INDEX idx_assets_entry_date ON assets(warehouse_entry_date);
CREATE INDEX idx_assets_is_deleted ON assets(is_deleted);
CREATE UNIQUE INDEX idx_assets_code_active ON assets(asset_code) WHERE is_deleted = 0;
CREATE UNIQUE INDEX idx_assets_serial_active ON assets(serial_number) WHERE is_deleted = 0;

-- DROP TABLE removes triggers defined on that table, so this needs
-- recreating exactly as schema.sql defines it.
CREATE TRIGGER update_assets_timestamp AFTER UPDATE ON assets
BEGIN UPDATE assets SET updated_at = datetime('now') WHERE id = NEW.id; END;

COMMIT;

PRAGMA foreign_keys = ON;
