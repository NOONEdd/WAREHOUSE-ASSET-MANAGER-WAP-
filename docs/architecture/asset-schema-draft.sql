-- APPROVED (O-16, 2026-10-30), revision 2.2 with two owner-directed corrections — docs/architecture/asset-schema-proposal.md.
-- NOT a migration and not applied to any database the application uses. After approval (O-16)
-- it becomes migrations 0005–0007 (proposal §13). The guarded reverse is
-- asset-schema-draft-down.sql.
--
-- Validated on PostgreSQL 16.15 in throwaway test clusters, as wam_owner after migrations
-- 0001–0004, with synthetic data only (proposal §12). Every statement runs in one transaction;
-- an error leaves the database unchanged.
--
-- Conventions:
--   * Identifier and code columns are COLLATE "C": equality is byte equality and index order is
--     byte order, independent of the database's default collation and of the operating system's
--     or ICU's collation version (proposal §4.3). Display sorting chooses a collation per query.
--   * Every function pins search_path; SECURITY DEFINER functions pin pg_catalog, pg_temp with
--     pg_temp last, and name every relation with its schema.
--   * Request context comes from transaction-local settings (proposal §5). They are trusted
--     input from the server, not a security boundary against code that can run SQL as wam_app.

-- 0. Preconditions --------------------------------------------------------------------------------
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

-- 4. People without WAM accounts (PD-05, recommended option C; proposal §7) ---------------------------
-- A handover names either a WAM user (by user id) or a person registered here (by person id).
-- History and audit hold only these ids, never names, so erasing a person's name here removes it
-- everywhere at once; the id stays, so the history stays intact ("person 17").
CREATE TABLE wam.persons (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id integer NOT NULL REFERENCES wam.warehouses (id),
  display_name text,
  erased_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by integer NOT NULL REFERENCES wam.users (id),
  updated_at timestamptz NOT NULL,
  updated_by integer NOT NULL REFERENCES wam.users (id),
  version integer NOT NULL,
  CONSTRAINT persons_erasure CHECK ((display_name IS NULL) = (erased_at IS NOT NULL)),
  CONSTRAINT persons_display_name_length CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200)
);
CREATE INDEX persons_warehouse_idx ON wam.persons (warehouse_id, id);
CREATE INDEX persons_name_match_idx ON wam.persons (warehouse_id, (wam.name_key(display_name) COLLATE "C"))
  WHERE display_name IS NOT NULL;

-- Stamps the actor; erasure is one-way and is allowed even in an inactive warehouse (a privacy
-- duty is not suspended by deactivating a warehouse); any other change needs an active warehouse.
CREATE FUNCTION wam.persons_stamp_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor integer := wam.request_actor();
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'change without an actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'an erased person cannot be changed' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id THEN
      RAISE EXCEPTION 'a person stays in the warehouse that registered them' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.version := OLD.version + 1;
    IF NEW.erased_at IS NULL THEN
      PERFORM wam.require_active_warehouse(NEW.warehouse_id);
    ELSE
      -- Erasure needs person.erase (held only through a system profile, hence with MFA) or the owner.
      IF NOT EXISTS (SELECT 1 FROM wam.users u WHERE u.id = actor AND u.is_owner)
         AND NOT EXISTS (
           SELECT 1 FROM wam.user_system_profiles usp
             JOIN wam.permission_profiles pp ON pp.id = usp.profile_id AND pp.is_active
             JOIN wam.permission_profile_permissions ppp ON ppp.profile_id = pp.id
            WHERE usp.user_id = actor AND ppp.permission = 'person.erase') THEN
        RAISE EXCEPTION 'erasing a person requires the person.erase permission' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.erased_at := now();
    END IF;
  ELSE
    IF NEW.erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'a person cannot be registered as erased' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM wam.require_active_warehouse(NEW.warehouse_id);
    NEW.created_at := now();
    NEW.created_by := actor;
    NEW.version := 1;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := actor;
  RETURN NEW;
END
$$;
CREATE TRIGGER persons_stamp_change BEFORE INSERT OR UPDATE ON wam.persons
  FOR EACH ROW EXECUTE FUNCTION wam.persons_stamp_change();
CREATE TRIGGER persons_reject_delete BEFORE DELETE ON wam.persons
  FOR EACH ROW EXECUTE FUNCTION wam.reject_change('persons are erased, never deleted: history refers to them');
CREATE TRIGGER persons_reject_truncate BEFORE TRUNCATE ON wam.persons
  FOR EACH STATEMENT EXECUTE FUNCTION wam.reject_change('persons are erased, never deleted: history refers to them');

-- 5. Assets (proposal §3.2) -------------------------------------------------------------------------------
CREATE TABLE wam.assets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id integer NOT NULL REFERENCES wam.warehouses (id),
  asset_code text COLLATE "C" NOT NULL,
  asset_code_key text COLLATE "C" GENERATED ALWAYS AS (wam.match_key(asset_code)) STORED,
  name text NOT NULL,
  item_type_id integer NOT NULL REFERENCES wam.item_types (id),
  model text,
  serial_number text COLLATE "C",
  serial_number_key text COLLATE "C" GENERATED ALWAYS AS (wam.match_key(serial_number)) STORED,
  country_id integer REFERENCES wam.countries (id),
  workshop_id integer REFERENCES wam.workshops (id),
  status_id integer NOT NULL REFERENCES wam.asset_statuses (id),
  entry_date date,
  exit_date date,
  delivered_by_user_id integer REFERENCES wam.users (id),
  delivered_by_person_id bigint REFERENCES wam.persons (id),
  received_by_user_id integer REFERENCES wam.users (id),
  received_by_person_id bigint REFERENCES wam.persons (id),
  notes text,
  -- Provenance. origin_warehouse_id is the warehouse the asset was imported into; it never changes,
  -- so the source row stays valid after a transfer (finding 1.1). Set by the trigger, not the server.
  origin text NOT NULL,
  origin_import_row_id bigint,
  origin_warehouse_id integer,
  retired_at timestamptz,
  retired_by integer REFERENCES wam.users (id),
  retirement_reason text,
  -- Set by wam.assets_stamp_change() from wam.actor_user_id; the server cannot write them.
  created_at timestamptz NOT NULL,
  created_by integer NOT NULL REFERENCES wam.users (id),
  updated_at timestamptz NOT NULL,
  updated_by integer NOT NULL REFERENCES wam.users (id),
  version integer NOT NULL,
  CONSTRAINT assets_asset_code_length CHECK (char_length(asset_code) <= 100),
  CONSTRAINT assets_asset_code_not_blank CHECK (asset_code_key <> ''),
  CONSTRAINT assets_serial_number_length CHECK (char_length(serial_number) <= 100),
  CONSTRAINT assets_serial_number_not_blank CHECK (serial_number_key <> ''),
  CONSTRAINT assets_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 300),
  CONSTRAINT assets_model_length CHECK (char_length(model) <= 200),
  CONSTRAINT assets_notes_length CHECK (char_length(notes) <= 2000),
  CONSTRAINT assets_dates CHECK (exit_date >= entry_date),
  CONSTRAINT assets_delivered_by_one CHECK (num_nonnulls(delivered_by_user_id, delivered_by_person_id) <= 1),
  CONSTRAINT assets_received_by_one CHECK (num_nonnulls(received_by_user_id, received_by_person_id) <= 1),
  CONSTRAINT assets_origin CHECK (origin IN ('manual', 'import')),
  CONSTRAINT assets_origin_import_row CHECK ((origin = 'import') = (origin_import_row_id IS NOT NULL)),
  CONSTRAINT assets_origin_warehouse CHECK ((origin_import_row_id IS NULL) = (origin_warehouse_id IS NULL)),
  CONSTRAINT assets_retirement CHECK (
    (retired_at IS NULL) = (retired_by IS NULL) AND (retired_at IS NULL) = (retirement_reason IS NULL)),
  CONSTRAINT assets_retirement_reason_length CHECK (char_length(btrim(retirement_reason)) BETWEEN 1 AND 500),
  CONSTRAINT assets_version_positive CHECK (version >= 1)
);
-- Exact value (byte equality, COLLATE "C"), unique among assets in use, across all warehouses (PD-01).
CREATE UNIQUE INDEX assets_asset_code_key ON wam.assets (asset_code) WHERE retired_at IS NULL;
-- Match keys: duplicate detection only, never unique (suspected duplicates are reported).
CREATE INDEX assets_asset_code_match_idx ON wam.assets (asset_code_key);
CREATE INDEX assets_serial_number_match_idx ON wam.assets (serial_number_key) WHERE serial_number_key IS NOT NULL;
CREATE INDEX assets_warehouse_id_idx ON wam.assets (warehouse_id, id);
CREATE INDEX assets_item_type_id_idx ON wam.assets (item_type_id);
CREATE INDEX assets_country_id_idx ON wam.assets (country_id);
CREATE INDEX assets_workshop_id_idx ON wam.assets (workshop_id);
CREATE INDEX assets_status_id_idx ON wam.assets (status_id);
CREATE INDEX assets_delivered_by_person_idx ON wam.assets (delivered_by_person_id) WHERE delivered_by_person_id IS NOT NULL;
CREATE INDEX assets_received_by_person_idx ON wam.assets (received_by_person_id) WHERE received_by_person_id IS NOT NULL;
CREATE UNIQUE INDEX assets_origin_import_row_id_key ON wam.assets (origin_import_row_id);

-- Every write, every role: stamps the actor and refuses what the database can recognize as wrong.
CREATE FUNCTION wam.assets_stamp_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor integer := wam.request_actor();
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'asset change without an actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'a retired asset cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.origin, NEW.origin_import_row_id, NEW.origin_warehouse_id)
       IS DISTINCT FROM (OLD.origin, OLD.origin_import_row_id, OLD.origin_warehouse_id) THEN
      RAISE EXCEPTION 'provenance cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.version := OLD.version + 1;
    -- Read-only means nothing leaves an inactive warehouse either.
    PERFORM wam.require_active_warehouse(OLD.warehouse_id);
    IF NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id THEN
      PERFORM wam.require_active_warehouse(NEW.warehouse_id);
    END IF;
  ELSE
    NEW.created_at := now();
    NEW.created_by := actor;
    NEW.version := 1;
    NEW.origin_warehouse_id := CASE WHEN NEW.origin = 'import' THEN NEW.warehouse_id END;
    PERFORM wam.require_active_warehouse(NEW.warehouse_id);
    -- That an imported asset really comes from a row being committed is checked, and the row marked
    -- applied, by wam.assets_apply_import_row() after the insert (section 7).
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := actor;

  -- Newly chosen catalogue entries must be active; newly chosen persons must be registered in
  -- this warehouse and not erased. (A reference kept through a transfer is not re-checked.)
  IF TG_OP = 'INSERT' OR NEW.status_id IS DISTINCT FROM OLD.status_id THEN
    PERFORM FROM wam.asset_statuses s WHERE s.id = NEW.status_id AND s.is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'inactive asset status' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.item_type_id IS DISTINCT FROM OLD.item_type_id THEN
    PERFORM FROM wam.item_types t WHERE t.id = NEW.item_type_id AND t.is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'inactive item type' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF NEW.country_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.country_id IS DISTINCT FROM OLD.country_id) THEN
    PERFORM FROM wam.countries c WHERE c.id = NEW.country_id AND c.is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'inactive country' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF NEW.workshop_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.workshop_id IS DISTINCT FROM OLD.workshop_id) THEN
    PERFORM FROM wam.workshops k WHERE k.id = NEW.workshop_id AND k.is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'inactive workshop' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF NEW.delivered_by_person_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.delivered_by_person_id IS DISTINCT FROM OLD.delivered_by_person_id) THEN
    PERFORM FROM wam.persons p WHERE p.id = NEW.delivered_by_person_id AND p.warehouse_id = NEW.warehouse_id AND p.erased_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown person for this warehouse' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF NEW.received_by_person_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.received_by_person_id IS DISTINCT FROM OLD.received_by_person_id) THEN
    PERFORM FROM wam.persons p WHERE p.id = NEW.received_by_person_id AND p.warehouse_id = NEW.warehouse_id AND p.erased_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown person for this warehouse' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER assets_stamp_change BEFORE INSERT OR UPDATE ON wam.assets
  FOR EACH ROW EXECUTE FUNCTION wam.assets_stamp_change();
CREATE TRIGGER assets_reject_delete BEFORE DELETE ON wam.assets
  FOR EACH ROW EXECUTE FUNCTION wam.reject_change('assets are never deleted; retire them instead');
CREATE TRIGGER assets_reject_truncate BEFORE TRUNCATE ON wam.assets
  FOR EACH STATEMENT EXECUTE FUNCTION wam.reject_change('assets are never deleted; retire them instead');

-- 6. History (proposal §3.3) — written only by the trigger below -----------------------------------------
-- Handover parties are recorded as ids (PD-05), never as names.
CREATE TABLE wam.asset_status_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id bigint NOT NULL REFERENCES wam.assets (id),
  warehouse_id integer NOT NULL REFERENCES wam.warehouses (id),
  from_status_id integer REFERENCES wam.asset_statuses (id),
  to_status_id integer NOT NULL REFERENCES wam.asset_statuses (id),
  changed_at timestamptz NOT NULL,
  changed_by integer NOT NULL REFERENCES wam.users (id),
  reason text,
  delivered_by_user_id integer REFERENCES wam.users (id),
  delivered_by_person_id bigint REFERENCES wam.persons (id),
  received_by_user_id integer REFERENCES wam.users (id),
  received_by_person_id bigint REFERENCES wam.persons (id),
  import_row_id bigint,
  request_id uuid,
  CONSTRAINT asset_status_history_change CHECK (from_status_id IS DISTINCT FROM to_status_id),
  CONSTRAINT asset_status_history_reason_length CHECK (char_length(reason) <= 500)
);
CREATE INDEX asset_status_history_asset_idx ON wam.asset_status_history (asset_id, id);
CREATE INDEX asset_status_history_warehouse_idx ON wam.asset_status_history (warehouse_id, id);

CREATE TABLE wam.asset_warehouse_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id bigint NOT NULL REFERENCES wam.assets (id),
  from_warehouse_id integer REFERENCES wam.warehouses (id),
  to_warehouse_id integer NOT NULL REFERENCES wam.warehouses (id),
  changed_at timestamptz NOT NULL,
  changed_by integer NOT NULL REFERENCES wam.users (id),
  reason text,
  import_row_id bigint,
  request_id uuid,
  CONSTRAINT asset_warehouse_history_change CHECK (from_warehouse_id IS DISTINCT FROM to_warehouse_id),
  CONSTRAINT asset_warehouse_history_reason_length CHECK (char_length(reason) <= 500)
);
CREATE INDEX asset_warehouse_history_asset_idx ON wam.asset_warehouse_history (asset_id, id);
CREATE INDEX asset_warehouse_history_to_idx ON wam.asset_warehouse_history (to_warehouse_id, id);
CREATE INDEX asset_warehouse_history_from_idx ON wam.asset_warehouse_history (from_warehouse_id, id);

-- SECURITY DEFINER, owned by wam_owner: the server's role has no INSERT on the history tables, so it
-- can neither skip nor forge a history row. It cannot alter, replace or re-own this function (not
-- the owner, not a member of wam_owner, no CREATE on the schema), nor disable the trigger (not the
-- table owner; session_replication_role needs a superuser). Proposal §8.2; tested.
CREATE FUNCTION wam.assets_record_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  reason text := nullif(current_setting('wam.change_reason', true), '');
  import_row bigint := nullif(current_setting('wam.import_row_id', true), '')::bigint;
  request uuid := nullif(current_setting('wam.request_id', true), '')::uuid;
  from_status integer;
  from_warehouse integer;
BEGIN
  -- The setting is trusted context, but a row of another warehouse is never accepted as provenance.
  IF import_row IS NOT NULL THEN
    PERFORM FROM wam.import_rows r WHERE r.id = import_row AND r.warehouse_id = NEW.warehouse_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the import row does not belong to this warehouse' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    from_status := OLD.status_id;
    from_warehouse := OLD.warehouse_id;
  END IF;
  IF NEW.status_id IS DISTINCT FROM from_status THEN
    INSERT INTO wam.asset_status_history
      (asset_id, warehouse_id, from_status_id, to_status_id, changed_at, changed_by, reason,
       delivered_by_user_id, delivered_by_person_id, received_by_user_id, received_by_person_id, import_row_id, request_id)
    VALUES (NEW.id, NEW.warehouse_id, from_status, NEW.status_id, NEW.updated_at, NEW.updated_by, reason,
            NEW.delivered_by_user_id, NEW.delivered_by_person_id, NEW.received_by_user_id, NEW.received_by_person_id,
            import_row, request);
  END IF;
  IF NEW.warehouse_id IS DISTINCT FROM from_warehouse THEN
    INSERT INTO wam.asset_warehouse_history
      (asset_id, from_warehouse_id, to_warehouse_id, changed_at, changed_by, reason, import_row_id, request_id)
    VALUES (NEW.id, from_warehouse, NEW.warehouse_id, NEW.updated_at, NEW.updated_by, reason, import_row, request);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION wam.assets_record_history() FROM PUBLIC;
CREATE TRIGGER assets_record_history AFTER INSERT OR UPDATE OF status_id, warehouse_id ON wam.assets
  FOR EACH ROW EXECUTE FUNCTION wam.assets_record_history();

CREATE TRIGGER asset_status_history_append_only BEFORE UPDATE OR DELETE ON wam.asset_status_history
  FOR EACH ROW EXECUTE FUNCTION wam.reject_change('asset_status_history is append-only');
CREATE TRIGGER asset_status_history_no_truncate BEFORE TRUNCATE ON wam.asset_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION wam.reject_change('asset_status_history is append-only');
CREATE TRIGGER asset_warehouse_history_append_only BEFORE UPDATE OR DELETE ON wam.asset_warehouse_history
  FOR EACH ROW EXECUTE FUNCTION wam.reject_change('asset_warehouse_history is append-only');
CREATE TRIGGER asset_warehouse_history_no_truncate BEFORE TRUNCATE ON wam.asset_warehouse_history
  FOR EACH STATEMENT EXECUTE FUNCTION wam.reject_change('asset_warehouse_history is append-only');

-- 7. Staged import (proposal §3.4, §6) ---------------------------------------------------------------------
-- The uploaded file is never stored: only its SHA-256, size and name. Parsed cells are staged as
-- text exactly as the parser produced them, and cleared by the retention step (PD-09).
--
-- State machine, enforced by the trigger below for every role:
--   uploaded   → uploaded (staging), previewed, cancelled, failed, expired
--   previewed  → previewed (re-validation), committing, cancelled, expired
--   committing → committed, only once every create and update row has been applied. 'committing'
--                exists only inside the committing transaction: a COMMIT that would leave a batch in
--                it fails (deferred check below), so no other transaction ever sees it.
--   committed, cancelled, failed, expired: closed — nothing changes afterwards except the retention
--   step clearing the staged cells and the file name (proposal §6.3).
CREATE TABLE wam.import_batches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id integer NOT NULL REFERENCES wam.warehouses (id),
  state text COLLATE "C" NOT NULL,
  file_name text,
  file_sha256 bytea NOT NULL,
  file_size_bytes bigint NOT NULL,
  file_format text COLLATE "C" NOT NULL,
  row_count integer,
  failure_code text COLLATE "C",
  -- Set by wam.import_batches_guard(); the server cannot write them.
  created_at timestamptz NOT NULL,
  created_by integer NOT NULL REFERENCES wam.users (id),
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by integer REFERENCES wam.users (id),
  content_cleared_at timestamptz,
  version integer NOT NULL,
  CONSTRAINT import_batches_id_warehouse_key UNIQUE (id, warehouse_id),
  CONSTRAINT import_batches_state CHECK (state IN ('uploaded', 'previewed', 'committing', 'committed', 'cancelled', 'failed', 'expired')),
  CONSTRAINT import_batches_file_name_length CHECK (char_length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT import_batches_sha256_length CHECK (octet_length(file_sha256) = 32),
  -- E-18: compressed file at most 10 MiB; at most 50,000 rows in total.
  CONSTRAINT import_batches_file_size CHECK (file_size_bytes BETWEEN 1 AND 10485760),
  CONSTRAINT import_batches_file_format CHECK (file_format IN ('xlsx', 'csv')),
  CONSTRAINT import_batches_row_count CHECK (row_count BETWEEN 0 AND 50000),
  CONSTRAINT import_batches_closed CHECK (
    (state IN ('committed', 'cancelled', 'failed', 'expired')) = (closed_at IS NOT NULL)),
  -- Only expiry is done by the system; every other closing names the user who did it.
  CONSTRAINT import_batches_closed_by CHECK ((closed_by IS NULL) = (closed_at IS NULL OR state = 'expired')),
  CONSTRAINT import_batches_failure CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT import_batches_failure_code_format CHECK (failure_code ~ '^[a-z_]{1,64}$'),
  CONSTRAINT import_batches_content_cleared CHECK (content_cleared_at IS NULL OR closed_at IS NOT NULL),
  -- The file name is user-provided content: kept until the retention step clears it with the cells.
  CONSTRAINT import_batches_file_name_cleared CHECK ((file_name IS NULL) = (content_cleared_at IS NOT NULL))
);
CREATE INDEX import_batches_warehouse_idx ON wam.import_batches (warehouse_id, id);
CREATE INDEX import_batches_sha256_idx ON wam.import_batches (file_sha256);
CREATE INDEX import_batches_open_idx ON wam.import_batches (updated_at) WHERE closed_at IS NULL;
CREATE INDEX import_batches_retention_idx ON wam.import_batches (closed_at) WHERE closed_at IS NOT NULL AND content_cleared_at IS NULL;

CREATE FUNCTION wam.import_batches_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor integer := wam.request_actor();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF actor IS NULL THEN
      RAISE EXCEPTION 'import change without an actor' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM wam.require_active_warehouse(NEW.warehouse_id);
    NEW.state := 'uploaded';
    NEW.failure_code := NULL;
    NEW.created_at := now();
    NEW.created_by := actor;
    NEW.updated_at := now();
    NEW.closed_at := NULL;
    NEW.closed_by := NULL;
    NEW.content_cleared_at := NULL;
    NEW.version := 1;
    RETURN NEW;
  END IF;

  IF (NEW.warehouse_id, NEW.file_sha256, NEW.file_size_bytes, NEW.file_format, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.warehouse_id, OLD.file_sha256, OLD.file_size_bytes, OLD.file_format, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what identifies an import batch cannot change' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.closed_at IS NOT NULL THEN
    -- The only change after closing, made only by wam.apply_import_retention(): the file name is
    -- cleared together with the staged cells, once, and the time recorded. Nothing can restore it.
    IF pg_catalog.current_setting('wam.applying_retention', true) = 'on'
       AND OLD.content_cleared_at IS NULL AND NEW.content_cleared_at IS NOT NULL AND NEW.file_name IS NULL
       AND (NEW.state, NEW.row_count, NEW.failure_code, NEW.updated_at, NEW.closed_at, NEW.closed_by, NEW.version)
           IS NOT DISTINCT FROM
           (OLD.state, OLD.row_count, OLD.failure_code, OLD.updated_at, OLD.closed_at, OLD.closed_by, OLD.version) THEN
      NEW.content_cleared_at := now();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a closed import batch cannot change' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF NEW.file_name IS DISTINCT FROM OLD.file_name OR NEW.content_cleared_at IS NOT NULL THEN
    RAISE EXCEPTION 'the file name is cleared only by the retention step' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.state = 'uploaded' AND NEW.state IN ('uploaded', 'previewed', 'cancelled', 'failed', 'expired'))
       OR (OLD.state = 'previewed' AND NEW.state IN ('previewed', 'committing', 'cancelled', 'expired'))
       OR (OLD.state = 'committing' AND NEW.state = 'committed')) THEN
    RAISE EXCEPTION 'invalid import batch transition' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.closed_by IS DISTINCT FROM OLD.closed_by THEN
    RAISE EXCEPTION 'closing details are set by the database' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'committed' AND EXISTS (
       SELECT 1 FROM wam.import_rows r
        WHERE r.batch_id = NEW.id AND r.outcome IN ('create', 'update') AND r.applied_at IS NULL) THEN
    RAISE EXCEPTION 'every create and update row must be applied before the batch is committed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Expiry belongs to wam.apply_import_retention() alone (proposal §6.3): it needs the schema owner's
  -- rights and the retention marker — the server's role has UPDATE on state, and could set the marker,
  -- but can never have the owner's rights. It is a system action: no actor, and it also runs in an
  -- inactive warehouse. Everything else is a user action in an active warehouse.
  IF NEW.state = 'expired' THEN
    -- coalesce: an unset marker is NULL, and NOT (… AND NULL) would be NULL, which would not refuse.
    IF NOT (wam.running_as_schema_owner() AND coalesce(pg_catalog.current_setting('wam.applying_retention', true), '') = 'on') THEN
      RAISE EXCEPTION 'only the retention step expires an import batch' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF actor IS NULL THEN
      RAISE EXCEPTION 'import change without an actor' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM wam.require_active_warehouse(OLD.warehouse_id);
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  IF NEW.state IN ('committed', 'cancelled', 'failed', 'expired') THEN
    NEW.closed_at := now();
    NEW.closed_by := CASE WHEN NEW.state = 'expired' THEN NULL ELSE actor END;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER import_batches_guard BEFORE INSERT OR UPDATE ON wam.import_batches
  FOR EACH ROW EXECUTE FUNCTION wam.import_batches_guard();
-- 'committing' must not outlive its transaction. Checked at COMMIT, for every role; SECURITY DEFINER so
-- that it reads the batch whatever scope the transaction has set by then.
CREATE FUNCTION wam.import_batches_check_not_committing() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM wam.import_batches b WHERE b.id = NEW.id AND b.state = 'committing') THEN
    RAISE EXCEPTION 'an import batch cannot be left in the committing state' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION wam.import_batches_check_not_committing() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER import_batches_not_left_committing AFTER UPDATE ON wam.import_batches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.state = 'committing') EXECUTE FUNCTION wam.import_batches_check_not_committing();
CREATE TRIGGER import_batches_reject_delete BEFORE DELETE ON wam.import_batches
  FOR EACH ROW EXECUTE FUNCTION wam.reject_change('import batches are kept as provenance');
CREATE TRIGGER import_batches_reject_truncate BEFORE TRUNCATE ON wam.import_batches
  FOR EACH STATEMENT EXECUTE FUNCTION wam.reject_change('import batches are kept as provenance');

CREATE TABLE wam.import_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id bigint NOT NULL,
  warehouse_id integer NOT NULL,
  sheet_name text,
  row_number integer NOT NULL,
  cells jsonb NOT NULL,
  outcome text COLLATE "C" NOT NULL,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The asset this row matched in its batch's warehouse, and the version the preview saw. A plain
  -- foreign key (finding 1.1): the asset may later be transferred; the warehouse is checked when
  -- the match is recorded, and a commit refuses any asset whose version changed since the preview.
  matched_asset_id bigint REFERENCES wam.assets (id),
  matched_asset_version integer,
  applied_at timestamptz,
  CONSTRAINT import_rows_id_warehouse_key UNIQUE (id, warehouse_id),
  CONSTRAINT import_rows_position_key UNIQUE NULLS NOT DISTINCT (batch_id, sheet_name, row_number),
  CONSTRAINT import_rows_batch_fk FOREIGN KEY (batch_id, warehouse_id) REFERENCES wam.import_batches (id, warehouse_id),
  CONSTRAINT import_rows_sheet_name_length CHECK (char_length(sheet_name) BETWEEN 1 AND 100),
  CONSTRAINT import_rows_row_number CHECK (row_number BETWEEN 1 AND 1048576),
  CONSTRAINT import_rows_cells_is_object CHECK (jsonb_typeof(cells) = 'object'),
  CONSTRAINT import_rows_cells_size CHECK (pg_column_size(cells) <= 65536),
  -- Issues name a problem code and a field, never a cell value or a raw header, so clearing the cells removes
  -- all spreadsheet content. The field is an internal field identifier (lower-case ASCII, e.g. "serial_number")
  -- or a 0-based column index below 100 (E-18: at most 100 columns) — never text taken from the file.
  CONSTRAINT import_rows_issues_shape CHECK (
    jsonb_typeof(issues) = 'array'
    AND NOT jsonb_path_exists(issues, '$[*] ? (@.type() != "object")', '{}', true)
    AND NOT jsonb_path_exists(issues, '$[*].keyvalue() ? (@.key != "code" && @.key != "column")', '{}', true)
    AND NOT jsonb_path_exists(issues, '$[*] ? (!(exists(@.code)))', '{}', true)
    AND NOT jsonb_path_exists(issues, '$[*].code ? (@.type() != "string" || !(@ like_regex "^[a-z_]{1,64}$"))', '{}', true)
    AND NOT jsonb_path_exists(issues,
      '$[*].column ? (!((@.type() == "string" && @ like_regex "^[a-z][a-z0-9_]{0,63}$")
                        || (@.type() == "number" && @ >= 0 && @ <= 99 && @ == @.floor())))', '{}', true)),
  CONSTRAINT import_rows_outcome CHECK (outcome IN ('create', 'update', 'unchanged', 'suspected_duplicate', 'invalid')),
  CONSTRAINT import_rows_matched CHECK (
    (matched_asset_id IS NULL) = (matched_asset_version IS NULL)
    AND (outcome NOT IN ('update', 'unchanged') OR matched_asset_id IS NOT NULL)
    AND (outcome <> 'create' OR matched_asset_id IS NULL)),
  CONSTRAINT import_rows_applied CHECK (applied_at IS NULL OR outcome IN ('create', 'update'))
);
CREATE INDEX import_rows_warehouse_idx ON wam.import_rows (warehouse_id, batch_id);
CREATE INDEX import_rows_matched_asset_idx ON wam.import_rows (matched_asset_id) WHERE matched_asset_id IS NOT NULL;

-- Rows are staged only while their batch is uploading and re-validated only while it is open for preview.
-- A row becomes applied only through wam.assets_apply_import_row(), inside the commit, after its asset
-- operation; the timestamp is the database's. Applied rows and rows of a closed batch are frozen; the only
-- later change is the retention step clearing the cells. The batch row is locked FOR SHARE, so a row
-- change and a commit of the same batch are serialized.
CREATE FUNCTION wam.import_rows_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  batch_state text;
  batch_closed boolean;
BEGIN
  SELECT b.state, b.closed_at IS NOT NULL INTO batch_state, batch_closed
    FROM wam.import_batches b WHERE b.id = NEW.batch_id FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF batch_state IS DISTINCT FROM 'uploaded' THEN
      RAISE EXCEPTION 'rows are staged only while their batch is being uploaded' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    PERFORM wam.require_active_warehouse(NEW.warehouse_id);
    NEW.applied_at := NULL;
  ELSE
    IF (NEW.batch_id, NEW.warehouse_id, NEW.sheet_name, NEW.row_number)
       IS DISTINCT FROM (OLD.batch_id, OLD.warehouse_id, OLD.sheet_name, OLD.row_number) THEN
      RAISE EXCEPTION 'the position of an import row cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF batch_closed OR OLD.applied_at IS NOT NULL THEN
      IF batch_closed AND pg_catalog.current_setting('wam.applying_retention', true) = 'on' AND NEW.cells = '{}'::jsonb
         AND (NEW.outcome, NEW.issues, NEW.matched_asset_id, NEW.matched_asset_version, NEW.applied_at)
             IS NOT DISTINCT FROM (OLD.outcome, OLD.issues, OLD.matched_asset_id, OLD.matched_asset_version, OLD.applied_at) THEN
        RETURN NEW;  -- retention: cells cleared, everything else kept
      END IF;
      RAISE EXCEPTION 'an applied import row, or a row of a closed batch, cannot change' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW.cells IS DISTINCT FROM OLD.cells THEN
      RAISE EXCEPTION 'staged cells are written once' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
      IF batch_state IS DISTINCT FROM 'committing'
         OR pg_catalog.current_setting('wam.applying_import_row', true) IS DISTINCT FROM NEW.id::text
         OR (NEW.outcome, NEW.issues, NEW.matched_asset_id, NEW.matched_asset_version)
            IS DISTINCT FROM (OLD.outcome, OLD.issues, OLD.matched_asset_id, OLD.matched_asset_version) THEN
        RAISE EXCEPTION 'an import row is marked applied only by its asset operation during the commit'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      NEW.applied_at := now();
      RETURN NEW;
    END IF;
    IF NOT coalesce(batch_state IN ('uploaded', 'previewed'), false) THEN
      RAISE EXCEPTION 'rows are re-validated only while their batch is open for preview' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    PERFORM wam.require_active_warehouse(NEW.warehouse_id);
  END IF;
  IF NEW.matched_asset_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.matched_asset_id IS DISTINCT FROM OLD.matched_asset_id) THEN
    PERFORM FROM wam.assets a WHERE a.id = NEW.matched_asset_id AND a.warehouse_id = NEW.warehouse_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the matched asset is not in this warehouse' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER import_rows_guard BEFORE INSERT OR UPDATE ON wam.import_rows
  FOR EACH ROW EXECUTE FUNCTION wam.import_rows_guard();
CREATE TRIGGER import_rows_reject_delete BEFORE DELETE ON wam.import_rows
  FOR EACH ROW EXECUTE FUNCTION wam.reject_change('import rows are kept as provenance');
CREATE TRIGGER import_rows_reject_truncate BEFORE TRUNCATE ON wam.import_rows
  FOR EACH STATEMENT EXECUTE FUNCTION wam.reject_change('import rows are kept as provenance');

-- Marks an import row applied when, and only when, its asset operation happens during the commit: the
-- insert of the asset the row creates (which names the row as its source), or the update of the asset the
-- row matched, at the version its preview saw. SECURITY DEFINER: the server's role has no privilege on
-- applied_at at all. One operation per row; a second one, or a row that is not being committed, is refused.
CREATE FUNCTION wam.assets_apply_import_row() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  from_setting bigint := nullif(current_setting('wam.import_row_id', true), '')::bigint;
  target bigint;
  r record;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.origin = 'import' THEN
    IF from_setting IS NOT NULL AND from_setting <> NEW.origin_import_row_id THEN
      RAISE EXCEPTION 'the import row setting does not match the asset''s source row' USING ERRCODE = 'check_violation';
    END IF;
    target := NEW.origin_import_row_id;
  ELSE
    target := from_setting;
  END IF;
  IF target IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT ir.warehouse_id, ir.outcome, ir.matched_asset_id, ir.matched_asset_version, ir.applied_at, b.state
    INTO r
    FROM wam.import_rows ir JOIN wam.import_batches b ON b.id = ir.batch_id
   WHERE ir.id = target;
  IF NOT FOUND OR r.warehouse_id <> NEW.warehouse_id THEN
    RAISE EXCEPTION 'the import row does not belong to this warehouse' USING ERRCODE = 'check_violation';
  END IF;
  IF r.state IS DISTINCT FROM 'committing' OR r.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'the import row is not being committed, or was already applied' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin IS DISTINCT FROM 'import' OR r.outcome <> 'create' THEN
      RAISE EXCEPTION 'only a create row creates an asset, and that asset names it as its source' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF r.outcome <> 'update' OR r.matched_asset_id IS DISTINCT FROM NEW.id OR r.matched_asset_version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'an update row applies only to its matched asset, at the version its preview saw' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('wam.applying_import_row', target::text, true);
  UPDATE wam.import_rows SET applied_at = now() WHERE id = target;
  PERFORM set_config('wam.applying_import_row', '', true);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION wam.assets_apply_import_row() FROM PUBLIC;
CREATE TRIGGER assets_apply_import_row AFTER INSERT OR UPDATE ON wam.assets
  FOR EACH ROW EXECUTE FUNCTION wam.assets_apply_import_row();

-- Provenance: an imported asset names the row it came from, in the warehouse it was imported into.
ALTER TABLE wam.assets ADD CONSTRAINT assets_origin_import_row_fk
  FOREIGN KEY (origin_import_row_id, origin_warehouse_id) REFERENCES wam.import_rows (id, warehouse_id);
ALTER TABLE wam.asset_status_history ADD CONSTRAINT asset_status_history_import_row_fk
  FOREIGN KEY (import_row_id) REFERENCES wam.import_rows (id);
ALTER TABLE wam.asset_warehouse_history ADD CONSTRAINT asset_warehouse_history_import_row_fk
  FOREIGN KEY (import_row_id) REFERENCES wam.import_rows (id);
CREATE INDEX asset_status_history_import_row_idx ON wam.asset_status_history (import_row_id) WHERE import_row_id IS NOT NULL;
CREATE INDEX asset_warehouse_history_import_row_idx ON wam.asset_warehouse_history (import_row_id) WHERE import_row_id IS NOT NULL;

-- 8. Retention (PD-09; proposal §6) ---------------------------------------------------------------------------
-- The only way the server's role can expire abandoned batches or clear staged cells, and it can only
-- apply the policy below: the periods are fixed here, changing them is a migration. Idempotent;
-- every run, including one that changes nothing, writes one audit event. Run daily by the server's
-- scheduler (proposal §6); a run that is missed is caught up by the next one.
--   open batch untouched for 7 days               → expired (closed by the system)
--   failed, cancelled or expired, closed 7 days    → staged cells and the file name cleared
--   committed, closed 90 days                     → staged cells and the file name cleared
-- It sets wam.applying_retention for its own transaction. Expiry is accepted only with that marker AND the
-- schema owner's rights (which this function has and the server's role never does); clearing cells and
-- file names is accepted only with the marker, on columns the server's role has no privilege to write.
CREATE FUNCTION wam.apply_import_retention()
  RETURNS TABLE (expired_batches integer, cleared_batches integer, cleared_rows integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  abandoned_after constant interval := interval '7 days';
  keep_unapplied constant interval := interval '7 days';
  keep_committed constant interval := interval '90 days';
  n_expired integer;
  n_batches integer := 0;
  n_rows integer := 0;
  n integer;
  due record;
BEGIN
  PERFORM set_config('wam.applying_retention', 'on', true);
  UPDATE wam.import_batches SET state = 'expired'
   WHERE closed_at IS NULL AND updated_at < now() - abandoned_after;
  GET DIAGNOSTICS n_expired = ROW_COUNT;

  FOR due IN
    SELECT b.id FROM wam.import_batches b
     WHERE b.closed_at IS NOT NULL AND b.content_cleared_at IS NULL
       AND b.closed_at < now() - CASE WHEN b.state = 'committed' THEN keep_committed ELSE keep_unapplied END
     ORDER BY b.id
     FOR UPDATE
  LOOP
    UPDATE wam.import_rows SET cells = '{}'::jsonb WHERE batch_id = due.id AND cells <> '{}'::jsonb;
    GET DIAGNOSTICS n = ROW_COUNT;
    n_rows := n_rows + n;
    UPDATE wam.import_batches SET file_name = NULL, content_cleared_at = now() WHERE id = due.id;
    n_batches := n_batches + 1;
  END LOOP;
  PERFORM set_config('wam.applying_retention', '', true);

  INSERT INTO wam.audit_events (action, outcome, details)
  VALUES ('import.retention_applied', 'success',
          jsonb_build_object('expired_batches', n_expired, 'cleared_batches', n_batches, 'cleared_rows', n_rows));
  RETURN QUERY SELECT n_expired, n_batches, n_rows;
END
$$;
REVOKE ALL ON FUNCTION wam.apply_import_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wam.apply_import_retention() TO wam_app;

-- 9. Row-level security (proposal §5) — defense in depth under the application's checks -------------------
-- wam_owner owns the tables and is not subject to these policies (no FORCE), so migrations, the owner
-- CLI and the SECURITY DEFINER functions work as before. (SELECT …) makes the planner compute the
-- scope once per statement, not once per row.
ALTER TABLE wam.persons ENABLE ROW LEVEL SECURITY;
CREATE POLICY persons_warehouse_scope ON wam.persons TO wam_app
  USING (warehouse_id = ANY ((SELECT wam.scope_warehouse_ids())::integer[]))
  WITH CHECK (warehouse_id = ANY ((SELECT wam.scope_warehouse_ids())::integer[]));

ALTER TABLE wam.assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY assets_warehouse_scope ON wam.assets TO wam_app
  USING (warehouse_id = ANY ((SELECT wam.scope_warehouse_ids())::integer[]))
  WITH CHECK (warehouse_id = ANY ((SELECT wam.scope_warehouse_ids())::integer[]));

ALTER TABLE wam.asset_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY asset_status_history_warehouse_scope ON wam.asset_status_history FOR SELECT TO wam_app
  USING (warehouse_id = ANY ((SELECT wam.scope_warehouse_ids())::integer[]));

ALTER TABLE wam.asset_warehouse_history ENABLE ROW LEVEL SECURITY;
-- A move is visible to the warehouse it left and the one it reached.
CREATE POLICY asset_warehouse_history_warehouse_scope ON wam.asset_warehouse_history FOR SELECT TO wam_app
  USING (to_warehouse_id = ANY ((SELECT wam.scope_warehouse_ids())::integer[])
         OR from_warehouse_id = ANY ((SELECT wam.scope_warehouse_ids())::integer[]));

ALTER TABLE wam.import_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY import_batches_warehouse_scope ON wam.import_batches TO wam_app
  USING (warehouse_id = ANY ((SELECT wam.scope_warehouse_ids())::integer[]))
  WITH CHECK (warehouse_id = ANY ((SELECT wam.scope_warehouse_ids())::integer[]));

ALTER TABLE wam.import_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY import_rows_warehouse_scope ON wam.import_rows TO wam_app
  USING (warehouse_id = ANY ((SELECT wam.scope_warehouse_ids())::integer[]))
  WITH CHECK (warehouse_id = ANY ((SELECT wam.scope_warehouse_ids())::integer[]));

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

GRANT SELECT ON wam.persons TO wam_app;
GRANT INSERT (warehouse_id, display_name) ON wam.persons TO wam_app;
GRANT UPDATE (display_name, erased_at) ON wam.persons TO wam_app;

GRANT SELECT ON wam.assets TO wam_app;
GRANT INSERT (warehouse_id, asset_code, name, item_type_id, model, serial_number, country_id, workshop_id,
              status_id, entry_date, exit_date, delivered_by_user_id, delivered_by_person_id,
              received_by_user_id, received_by_person_id, notes, origin, origin_import_row_id)
  ON wam.assets TO wam_app;
GRANT UPDATE (asset_code, name, item_type_id, model, serial_number, country_id, workshop_id, status_id,
              entry_date, exit_date, delivered_by_user_id, delivered_by_person_id,
              received_by_user_id, received_by_person_id, notes)
  ON wam.assets TO wam_app;
GRANT SELECT ON wam.asset_status_history, wam.asset_warehouse_history TO wam_app;

GRANT SELECT ON wam.import_batches TO wam_app;
GRANT INSERT (warehouse_id, file_name, file_sha256, file_size_bytes, file_format, row_count) ON wam.import_batches TO wam_app;
GRANT UPDATE (state, row_count, failure_code) ON wam.import_batches TO wam_app;
GRANT SELECT ON wam.import_rows TO wam_app;
GRANT INSERT (batch_id, warehouse_id, sheet_name, row_number, cells, outcome, issues, matched_asset_id, matched_asset_version)
  ON wam.import_rows TO wam_app;
GRANT UPDATE (outcome, issues, matched_asset_id, matched_asset_version) ON wam.import_rows TO wam_app;
