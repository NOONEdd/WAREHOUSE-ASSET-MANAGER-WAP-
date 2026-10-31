import { sql, type Kysely } from 'kysely'

// Phase 1B-3, part 3 of 3 (decision O-16): staged import (batches, rows, the state machine with the
// transaction-internal 'committing' state, the apply trigger that alone marks rows applied), the
// provenance foreign keys, the fixed-policy retention function (PD-09: 7/7/90 days), row-level
// security and grants. Approved draft, copied verbatim by section. Imports stay disabled in the
// server by default (WAM_IMPORT_ENABLED); no spreadsheet parser is integrated in this phase.

export const UP = String.raw`-- 7. Staged import (proposal §3.4, §6) ---------------------------------------------------------------------
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
GRANT SELECT ON wam.import_batches TO wam_app;
GRANT INSERT (warehouse_id, file_name, file_sha256, file_size_bytes, file_format, row_count) ON wam.import_batches TO wam_app;
GRANT UPDATE (state, row_count, failure_code) ON wam.import_batches TO wam_app;
GRANT SELECT ON wam.import_rows TO wam_app;
GRANT INSERT (batch_id, warehouse_id, sheet_name, row_number, cells, outcome, issues, matched_asset_id, matched_asset_version)
  ON wam.import_rows TO wam_app;
GRANT UPDATE (outcome, issues, matched_asset_id, matched_asset_version) ON wam.import_rows TO wam_app;
`

export const DOWN = String.raw`-- Guarded reverse (approved draft: docs/architecture/asset-schema-draft-down.sql, proposal §9). It runs in
-- the migration runner's single transaction; the LOCK comes first and holds until COMMIT, so a concurrent
-- write is either seen by the checks (refused) or finds the schema gone. It refuses as soon as anything
-- this migration created holds data, or any audit event about it exists: after first use, fix forward or
-- restore from backup. The CLI also refuses "down" when WAM_ENV=production.

LOCK TABLE wam.assets, wam.asset_status_history, wam.asset_warehouse_history, wam.import_batches, wam.import_rows
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE wam.audit_events IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  reasons text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM wam.import_batches) THEN reasons := reasons || 'import batches'::text; END IF;
  IF EXISTS (SELECT 1 FROM wam.audit_events WHERE action LIKE 'import.%') THEN reasons := reasons || 'audit events about imports'::text; END IF;
  IF cardinality(reasons) > 0 THEN
    RAISE EXCEPTION 'refusing to revert; the database holds %. Write a forward migration or restore from backup instead',
      array_to_string(reasons, ', ')
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

DROP FUNCTION wam.apply_import_retention();
DROP TRIGGER assets_apply_import_row ON wam.assets;
DROP FUNCTION wam.assets_apply_import_row();
ALTER TABLE wam.assets DROP CONSTRAINT assets_origin_import_row_fk;
ALTER TABLE wam.asset_status_history DROP CONSTRAINT asset_status_history_import_row_fk;
ALTER TABLE wam.asset_warehouse_history DROP CONSTRAINT asset_warehouse_history_import_row_fk;
DROP INDEX wam.asset_status_history_import_row_idx;
DROP INDEX wam.asset_warehouse_history_import_row_idx;
DROP TABLE wam.import_rows;
DROP TABLE wam.import_batches;
DROP FUNCTION wam.import_batches_check_not_committing();
DROP FUNCTION wam.import_rows_guard();
DROP FUNCTION wam.import_batches_guard();
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(UP).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DOWN).execute(db)
}
