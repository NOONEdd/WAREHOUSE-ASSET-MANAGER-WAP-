import { sql, type Kysely } from 'kysely'

// Phase 1B-3, part 1 of 3 (decision O-16, approved 2026-10-30): the system-warehouse rule, the
// identifier match key and the catalogue-name key, the request-context functions, the catalogue
// (asset statuses with the five system statuses, item types, workshops, countries) and the
// permissions catalog.manage and person.erase. Design: docs/architecture/asset-schema-proposal.md;
// the SQL below is the approved draft (docs/architecture/asset-schema-draft.sql), copied verbatim
// by section — a test proves that migrations 0005–0007 produce exactly the draft's schema.

export const UP = String.raw`-- 0. Preconditions --------------------------------------------------------------------------------
DO $$
BEGIN
  IF pg_catalog.current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'the WAM database must use UTF8: match keys depend on Unicode normalization';
  END IF;
END
$$;

-- 0b. The system warehouse (proposal §3.5) -------------------------------------------------------------
-- Migration 0002 seeds exactly one system warehouse, UNASSIGNED; this makes "at most one" a database rule
-- for every role, so it is always found by its code and system flag.
CREATE UNIQUE INDEX warehouses_single_system ON wam.warehouses (is_system) WHERE is_system;

-- 1. Match keys (proposal §4; TypeScript twin: server/src/assets/matchKey.ts) ----------------------
-- NFKC, then one translate(): the first 49 characters of the second argument become the characters
-- of the third (Persian and Arabic-Indic digits → ASCII; Arabic yeh and alef maksura → Persian yeh;
-- Arabic kaf → Persian keheh; A–Z → a–z); every later character (whitespace, invisible format
-- characters, separators) is removed. No lower(): it depends on a collation; the key must not.
CREATE FUNCTION wam.match_key(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN pg_catalog.translate(
    pg_catalog.normalize(value, 'NFKC'),
    E'\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u064a\u0649\u0643ABCDEFGHIJKLMNOPQRSTUVWXYZ\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\u00ad\u180e\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2060\u2066\u2067\u2068\u2069\ufeff-_/.\\\u2010\u2011\u2012\u2013\u2014\u2015\u2212',
    E'01234567890123456789\u06cc\u06cc\u06a9abcdefghijklmnopqrstuvwxyz');

-- Catalogue-name key (proposal §4.5): less aggressive than the identifier match key, for names people
-- read. NFKC; Persian and Arabic-Indic digits → ASCII; Arabic yeh and alef maksura → Persian yeh; Arabic
-- kaf → Persian keheh; A–Z → a–z; every whitespace character and the zero-width non-joiner → one space;
-- invisible format characters removed; runs of spaces collapsed; leading and trailing spaces trimmed.
-- Punctuation and separators are KEPT, so "1/2 inch" and "12 inch", or "A-1" and "A1", stay distinct.
CREATE FUNCTION wam.name_key(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN pg_catalog.btrim(
    pg_catalog.regexp_replace(
      pg_catalog.translate(
        pg_catalog.normalize(value, 'NFKC'),
        E'\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u064a\u0649\u0643ABCDEFGHIJKLMNOPQRSTUVWXYZ\u0009\u000a\u000b\u000c\u000d\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\u200c\u00ad\u180e\u200b\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2060\u2066\u2067\u2068\u2069\ufeff',
        E'01234567890123456789\u06cc\u06cc\u06a9abcdefghijklmnopqrstuvwxyz\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020') COLLATE "C",
      ' {2,}', ' ', 'g'),
    ' ');

-- 2. Request context and shared checks (proposal §5) ---------------------------------------------------
--   wam.warehouse_scope  comma-separated warehouse ids this request may touch (row-level security)
--   wam.actor_user_id    the signed-in user (required for every change except retention)
--   wam.change_reason    optional reason, copied into history rows
--   wam.import_row_id    the import row being applied, during an import commit
--   wam.request_id       the request ID, copied into history rows
-- All are set with set_config(name, value, true), so they end with the transaction.
CREATE FUNCTION wam.scope_warehouse_ids() RETURNS integer[]
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN coalesce(
    pg_catalog.string_to_array(nullif(pg_catalog.current_setting('wam.warehouse_scope', true), ''), ',')::integer[],
    '{}'::integer[]);

CREATE FUNCTION wam.request_actor() RETURNS integer
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN nullif(pg_catalog.current_setting('wam.actor_user_id', true), '')::integer;

-- True only while running with the rights of the schema's owner (wam_owner): inside one of this schema's
-- SECURITY DEFINER functions, or a wam_owner session. Unlike a custom setting — which wam_app can set to
-- anything — this cannot be faked by the server's role: it is not the owner, not a member of wam_owner,
-- and cannot SET ROLE to it. Used for batch expiry, the one marker-gated change on a column (state) the
-- server's role may otherwise update. The other marker-gated changes — applied_at, staged cells, the file
-- name — are on columns the server's role has no privilege on at all; the privilege is their boundary.
CREATE FUNCTION wam.running_as_schema_owner() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'wam');

CREATE FUNCTION wam.reject_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = 'insufficient_privilege';
END
$$;

-- An inactive warehouse is read-only for assets, persons and imports (PD-07). FOR SHARE: a
-- concurrent deactivation waits for the writing transaction, or the writer sees it and stops.
CREATE FUNCTION wam.require_active_warehouse(warehouse integer) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  active boolean;
BEGIN
  SELECT w.is_active INTO active FROM wam.warehouses w WHERE w.id = warehouse FOR SHARE;
  IF active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the warehouse is not active; its assets and imports are read-only' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- 3. Catalogue (proposal §3.1) --------------------------------------------------------------------------
CREATE TABLE wam.asset_statuses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text COLLATE "C",
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT asset_statuses_code_key UNIQUE (code),
  CONSTRAINT asset_statuses_code_format CHECK (code ~ '^[a-z][a-z_]{1,31}$'),
  CONSTRAINT asset_statuses_system_has_code CHECK (is_system = (code IS NOT NULL)),
  CONSTRAINT asset_statuses_system_is_active CHECK (NOT is_system OR is_active),
  CONSTRAINT asset_statuses_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX asset_statuses_name_key ON wam.asset_statuses ((wam.name_key(name) COLLATE "C")) WHERE is_active;

-- The desktop app's four protected statuses (src/main/database/schema.sql) plus "missing", which
-- WAM's requirements include (owner, 2026-10-30; the desktop app deliberately did not seed it).
-- Retirement is not a status (§3.2). PD-03: the owner confirms this list before it is migrated.
-- 'آسیب‌دیده' contains U+200C ZERO WIDTH NON-JOINER between its two parts, as in the desktop seed.
INSERT INTO wam.asset_statuses (code, name, is_system, sort_order) VALUES
  ('in_stock', 'در انبار', true, 1),
  ('issued', 'صادر شده', true, 2),
  ('returned', 'مرجوع شده', true, 3),
  ('damaged', 'آسیب‌دیده', true, 4),
  ('missing', 'مفقود', true, 5);

CREATE FUNCTION wam.protect_system_status() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.is_system AND (NEW.name IS DISTINCT FROM OLD.name OR NEW.code IS DISTINCT FROM OLD.code
                        OR NEW.is_system IS DISTINCT FROM OLD.is_system) THEN
    RAISE EXCEPTION 'a system status cannot be renamed or recoded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER asset_statuses_protect_system BEFORE UPDATE ON wam.asset_statuses
  FOR EACH ROW EXECUTE FUNCTION wam.protect_system_status();

CREATE TABLE wam.item_types (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT item_types_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX item_types_name_key ON wam.item_types ((wam.name_key(name) COLLATE "C")) WHERE is_active;

CREATE TABLE wam.workshops (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT workshops_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX workshops_name_key ON wam.workshops ((wam.name_key(name) COLLATE "C")) WHERE is_active;

CREATE TABLE wam.countries (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  iso_code text COLLATE "C",
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT countries_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT countries_iso_code_format CHECK (iso_code ~ '^[A-Z]{2}$')
);
CREATE UNIQUE INDEX countries_name_key ON wam.countries ((wam.name_key(name) COLLATE "C")) WHERE is_active;
CREATE UNIQUE INDEX countries_iso_code_key ON wam.countries (iso_code) WHERE is_active;

-- PD-06 and PD-05. Both system permissions, assigned to no profile here: only the owner can put them into
-- a system profile (rule A1), and a holder of a system profile must have an enrolled authenticator
-- (rule A7, migration 0004), so both operations are MFA-protected by the existing privileged-access policy.
INSERT INTO wam.permissions (code, scope, description) VALUES
  ('catalog.manage', 'system', 'Create, rename and deactivate item types, workshops, countries and asset statuses'),
  ('person.erase', 'system', 'Erase the name of a person without a WAM account (one-way; history keeps the id)');

-- 10. Runtime privileges (proposal §8.1): exactly what Phase 1B-3 needs ------------------------------------
-- Not granted to wam_app: any DELETE; any write to the history tables; assets.warehouse_id and the
-- retirement columns after insert (transfers and retirement are Phase 1B-5, D-06); provenance
-- columns after insert; created_*, updated_*, closed_*, version and content_cleared_at (the triggers
-- set them); staged cells after insert; applied_at (only the apply trigger sets it); the file name after
-- insert (only the retention step clears it); status codes and the system flag.
GRANT SELECT ON wam.asset_statuses, wam.item_types, wam.workshops, wam.countries TO wam_app;
GRANT INSERT (name, sort_order) ON wam.asset_statuses TO wam_app;
GRANT UPDATE (name, is_active, sort_order, updated_at, version) ON wam.asset_statuses TO wam_app;
GRANT INSERT (name) ON wam.item_types, wam.workshops TO wam_app;
GRANT UPDATE (name, is_active, updated_at, version) ON wam.item_types, wam.workshops TO wam_app;
GRANT INSERT (name, iso_code) ON wam.countries TO wam_app;
GRANT UPDATE (name, iso_code, is_active, updated_at, version) ON wam.countries TO wam_app;
`

export const DOWN = String.raw`-- Guarded reverse (approved draft: docs/architecture/asset-schema-draft-down.sql, proposal §9). It runs in
-- the migration runner's single transaction; the LOCK comes first and holds until COMMIT, so a concurrent
-- write is either seen by the checks (refused) or finds the schema gone. It refuses as soon as anything
-- this migration created holds data, or any audit event about it exists: after first use, fix forward or
-- restore from backup. The CLI also refuses "down" when WAM_ENV=production.

LOCK TABLE wam.asset_statuses, wam.item_types, wam.workshops, wam.countries IN ACCESS EXCLUSIVE MODE;
LOCK TABLE wam.audit_events, wam.permission_profile_permissions, wam.permissions IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  reasons text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM wam.item_types) OR EXISTS (SELECT 1 FROM wam.workshops) OR EXISTS (SELECT 1 FROM wam.countries) OR EXISTS (SELECT 1 FROM wam.asset_statuses WHERE NOT is_system) THEN reasons := reasons || 'catalogue entries'::text; END IF;
  IF EXISTS (SELECT 1 FROM wam.permission_profile_permissions WHERE permission IN ('catalog.manage', 'person.erase')) THEN reasons := reasons || 'profiles holding catalog.manage or person.erase'::text; END IF;
  IF EXISTS (SELECT 1 FROM wam.audit_events WHERE action LIKE 'catalog.%') THEN reasons := reasons || 'audit events about the catalogue'::text; END IF;
  IF cardinality(reasons) > 0 THEN
    RAISE EXCEPTION 'refusing to revert; the database holds %. Write a forward migration or restore from backup instead',
      array_to_string(reasons, ', ')
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

DROP TABLE wam.countries;
DROP TABLE wam.workshops;
DROP TABLE wam.item_types;
DROP TABLE wam.asset_statuses;
DROP FUNCTION wam.protect_system_status();
DROP FUNCTION wam.require_active_warehouse(integer);
DROP FUNCTION wam.reject_change();
DROP FUNCTION wam.running_as_schema_owner();
DROP FUNCTION wam.request_actor();
DROP FUNCTION wam.scope_warehouse_ids();
DROP FUNCTION wam.name_key(text);
DROP FUNCTION wam.match_key(text);
DROP INDEX wam.warehouses_single_system;
DELETE FROM wam.permissions WHERE code IN ('catalog.manage', 'person.erase');
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db)
}
