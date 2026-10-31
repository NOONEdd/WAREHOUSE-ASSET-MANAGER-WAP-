import { sql, type Kysely } from 'kysely'

// Phase 1B-3, part 2 of 3 (decision O-16): people without WAM accounts (PD-05), assets with their
// stamping trigger, the trigger-written status and warehouse history, row-level security on these
// tables and the server role's column grants. Approved draft, copied verbatim by section.

export const UP = String.raw`-- 4. People without WAM accounts (PD-05, recommended option C; proposal §7) ---------------------------
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

-- 10. Runtime privileges (proposal §8.1): exactly what Phase 1B-3 needs ------------------------------------
-- Not granted to wam_app: any DELETE; any write to the history tables; assets.warehouse_id and the
-- retirement columns after insert (transfers and retirement are Phase 1B-5, D-06); provenance
-- columns after insert; created_*, updated_*, closed_*, version and content_cleared_at (the triggers
-- set them); staged cells after insert; applied_at (only the apply trigger sets it); the file name after
-- insert (only the retention step clears it); status codes and the system flag.
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
`

export const DOWN = String.raw`-- Guarded reverse (approved draft: docs/architecture/asset-schema-draft-down.sql, proposal §9). It runs in
-- the migration runner's single transaction; the LOCK comes first and holds until COMMIT, so a concurrent
-- write is either seen by the checks (refused) or finds the schema gone. It refuses as soon as anything
-- this migration created holds data, or any audit event about it exists: after first use, fix forward or
-- restore from backup. The CLI also refuses "down" when WAM_ENV=production.

LOCK TABLE wam.assets, wam.asset_status_history, wam.asset_warehouse_history, wam.persons IN ACCESS EXCLUSIVE MODE;
LOCK TABLE wam.audit_events IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  reasons text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM wam.assets) THEN reasons := reasons || 'assets'::text; END IF;
  IF EXISTS (SELECT 1 FROM wam.asset_status_history) OR EXISTS (SELECT 1 FROM wam.asset_warehouse_history) THEN reasons := reasons || 'asset history'::text; END IF;
  IF EXISTS (SELECT 1 FROM wam.persons) THEN reasons := reasons || 'persons'::text; END IF;
  IF EXISTS (SELECT 1 FROM wam.audit_events WHERE action LIKE 'asset.%' OR action LIKE 'person.%') THEN reasons := reasons || 'audit events about assets or persons'::text; END IF;
  IF cardinality(reasons) > 0 THEN
    RAISE EXCEPTION 'refusing to revert; the database holds %. Write a forward migration or restore from backup instead',
      array_to_string(reasons, ', ')
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

DROP TABLE wam.asset_warehouse_history;
DROP TABLE wam.asset_status_history;
DROP TABLE wam.assets;
DROP TABLE wam.persons;
DROP FUNCTION wam.assets_record_history();
DROP FUNCTION wam.assets_stamp_change();
DROP FUNCTION wam.persons_stamp_change();
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db)
}
