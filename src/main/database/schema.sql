PRAGMA foreign_keys = ON;

-- LOOKUP TABLES
CREATE TABLE roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT
);

CREATE TABLE item_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_item_types_name_active ON item_types(name) WHERE is_active = 1;

CREATE TABLE workshops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_workshops_name_active ON workshops(name) WHERE is_active = 1;

CREATE TABLE countries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    iso_code TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_countries_name_active ON countries(name) WHERE is_active = 1;

CREATE TABLE asset_statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER
);

-- USERS
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    is_active INTEGER NOT NULL DEFAULT 1,
    -- First-Run Security phase — 1 only for the bootstrap-created
    -- Administrator row, and only until they complete first-run setup
    -- (authService.completeFirstRunSetup). password_hash for such a row
    -- is a bcrypt hash of a discarded, never-revealed random value — not
    -- a usable temporary password, just a NOT NULL placeholder — so this
    -- flag is what actually gates login, not "is password_hash a real
    -- password". DEFAULT 0 means every other row (every user created any
    -- other way, forever) is unaffected by this mechanism entirely.
    needs_password_setup INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
);

-- ASSETS
CREATE TABLE assets (
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

CREATE INDEX idx_assets_name ON assets(asset_name);
CREATE INDEX idx_assets_model ON assets(model);
CREATE INDEX idx_assets_status ON assets(status_id);
CREATE INDEX idx_assets_workshop ON assets(workshop_id);
CREATE INDEX idx_assets_item_type ON assets(item_type_id);
CREATE INDEX idx_assets_country ON assets(country_id);
CREATE INDEX idx_assets_entry_date ON assets(warehouse_entry_date);
CREATE INDEX idx_assets_is_deleted ON assets(is_deleted);
CREATE INDEX idx_assets_created_at ON assets(created_at);
CREATE INDEX idx_assets_updated_at ON assets(updated_at);

-- asset_code and serial_number are unique only among ACTIVE (not
-- soft-deleted) assets — a partial index, not a plain column UNIQUE
-- constraint, so deleting an asset frees up its code/serial number for
-- reuse instead of permanently squatting on it. A plain column-level
-- UNIQUE is enforced across every row regardless of is_deleted, which
-- was the root cause of a real bug: delete an asset, then try to re-add
-- or re-import the exact same asset, and it was rejected as a duplicate
-- of a row the user could no longer even see. See assetRepository.js
-- (findByCodeOrSerial / findAllCodesAndSerials) for the matching
-- application-level fix, and migrations/002-scope-unique-constraints-to-
-- active-assets.sql for the equivalent change applied to databases that
-- already exist.
CREATE UNIQUE INDEX idx_assets_code_active ON assets(asset_code) WHERE is_deleted = 0;
CREATE UNIQUE INDEX idx_assets_serial_active ON assets(serial_number) WHERE is_deleted = 0;

-- ASSET TRANSACTIONS
CREATE TABLE asset_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    previous_status_id INTEGER REFERENCES asset_statuses(id),
    new_status_id INTEGER NOT NULL REFERENCES asset_statuses(id),
    transaction_date TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_by TEXT,
    received_by TEXT,
    notes TEXT,
    performed_by_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_transactions_asset ON asset_transactions(asset_id);
CREATE INDEX idx_transactions_date ON asset_transactions(transaction_date);

-- AUDIT LOG
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    username_snapshot TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    changes TEXT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE INDEX idx_audit_date ON audit_log(occurred_at);

-- SETTINGS
CREATE TABLE settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- TRIGGERS
CREATE TRIGGER prevent_audit_log_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log rows cannot be modified'); END;

CREATE TRIGGER prevent_audit_log_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log rows cannot be deleted'); END;

CREATE TRIGGER prevent_transactions_update BEFORE UPDATE ON asset_transactions
BEGIN SELECT RAISE(ABORT, 'asset_transactions rows cannot be modified'); END;

CREATE TRIGGER prevent_transactions_delete BEFORE DELETE ON asset_transactions
BEGIN SELECT RAISE(ABORT, 'asset_transactions rows cannot be deleted'); END;

CREATE TRIGGER update_assets_timestamp AFTER UPDATE ON assets
BEGIN UPDATE assets SET updated_at = datetime('now') WHERE id = NEW.id; END;

-- SEED DATA
INSERT INTO roles (name, description) VALUES
    ('Administrator', 'Full access to all features'),
    ('Manager', 'Reserved for future use'),
    ('Warehouse Staff', 'Reserved for future use'),
    ('Read Only', 'Reserved for future use');

-- Manual Status Management phase — asset_statuses is no longer a fixed,
-- code-hardcoded enum. Exactly these four are seeded as the permanent
-- "system" set (see lookupService.js's SYSTEM_STATUS_NAMES — matched by
-- name, protected from delete/rename/deactivate everywhere). Everything
-- beyond these four (e.g. "تعمیر") is created by an administrator
-- through Settings → داده‌های پایه → وضعیت, never hardcoded here or
-- anywhere else — see that same comment for the full reasoning,
-- including why "مفقود" is deliberately NOT seeded (a past product
-- decision, not an oversight). Existing (already-schema'd) databases are
-- untouched by this: this INSERT only ever runs once, for a brand-new
-- database file (see connection.js's hasSchema check).
INSERT INTO asset_statuses (name, is_active, sort_order) VALUES
    ('در انبار', 1, 1), ('صادر شده', 1, 2), ('مرجوع شده', 1, 3), ('آسیب‌دیده', 1, 4);
