-- APPROVED (O-16, 2026-10-30), revision 2.2 — the guarded reverse of asset-schema-draft.sql (proposal §9).
-- NOT a migration. After approval it becomes the down() steps of migrations 0007–0005.
--
-- Reverting is meant only for a database that has never held asset work: a development or test
-- database, or a deployment rolled back before first use. It refuses as soon as anything below
-- exists, so it can never silently destroy asset, import, person or audit history. Two layers:
--   1. the migration CLI already refuses "down" when WAM_ENV=production (src/cli/migrate.ts);
--   2. this guard, in the database, refuses whatever the environment says.
-- After the system holds data, a mistake is corrected by a forward migration, or by restoring a
-- backup (Phase 1D restore drill) — never by this script.
--
-- Concurrency (finding 2): the whole script must run as ONE transaction. The migration runner wraps each
-- down() run in one (Kysely's Migrator on PostgreSQL, tested), and a single multi-statement query is one
-- implicit transaction. Run by hand ONLY as
--     psql --single-transaction -v ON_ERROR_STOP=1 -f asset-schema-draft-down.sql
-- (or inside an explicit BEGIN … COMMIT): a plain "psql -f" commits every statement on its own, so the
-- locks would be released before the drops and the guard would protect nothing. LOCK itself refuses to
-- run outside a transaction block. The LOCK below comes FIRST, before any check, and holds
-- until COMMIT: a write that started earlier makes it wait, and is then seen by the checks; a write
-- that starts later waits for this transaction and then finds the tables gone. Tables to be dropped
-- are locked ACCESS EXCLUSIVE (DROP needs that lock anyway); the tables that stay are locked SHARE ROW
-- EXCLUSIVE, which blocks writes but not reads. If a concurrent transaction holds locks in the opposite
-- order, PostgreSQL's deadlock detection aborts one of the two; neither commits a lost write.

LOCK TABLE wam.assets, wam.asset_status_history, wam.asset_warehouse_history, wam.import_batches, wam.import_rows,
           wam.persons, wam.asset_statuses, wam.item_types, wam.workshops, wam.countries
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE wam.audit_events, wam.permission_profile_permissions, wam.permissions IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  reasons text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM wam.assets) THEN reasons := reasons || 'assets'::text; END IF;
  IF EXISTS (SELECT 1 FROM wam.asset_status_history) OR EXISTS (SELECT 1 FROM wam.asset_warehouse_history) THEN
    reasons := reasons || 'asset history'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM wam.import_batches) THEN reasons := reasons || 'import batches'::text; END IF;
  IF EXISTS (SELECT 1 FROM wam.persons) THEN reasons := reasons || 'persons'::text; END IF;
  IF EXISTS (SELECT 1 FROM wam.item_types) OR EXISTS (SELECT 1 FROM wam.workshops) OR EXISTS (SELECT 1 FROM wam.countries)
     OR EXISTS (SELECT 1 FROM wam.asset_statuses WHERE NOT is_system) THEN
    reasons := reasons || 'catalogue entries'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM wam.permission_profile_permissions WHERE permission IN ('catalog.manage', 'person.erase')) THEN
    reasons := reasons || 'profiles holding catalog.manage or person.erase'::text;
  END IF;
  -- Audit events cannot be deleted; once the asset schema has been used, it stays.
  IF EXISTS (SELECT 1 FROM wam.audit_events
              WHERE action LIKE 'asset.%' OR action LIKE 'import.%' OR action LIKE 'catalog.%' OR action LIKE 'person.%') THEN
    reasons := reasons || 'audit events about assets, imports, persons or the catalogue'::text;
  END IF;
  IF cardinality(reasons) > 0 THEN
    RAISE EXCEPTION 'refusing to revert the asset schema; it holds %. Write a forward migration or restore from backup instead',
      array_to_string(reasons, ', ')
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

DROP FUNCTION wam.apply_import_retention();
ALTER TABLE wam.assets DROP CONSTRAINT assets_origin_import_row_fk;
DROP TABLE wam.asset_warehouse_history;
DROP TABLE wam.asset_status_history;
DROP TABLE wam.import_rows;
DROP TABLE wam.import_batches;
DROP TABLE wam.assets;
DROP TABLE wam.persons;
DROP TABLE wam.countries;
DROP TABLE wam.workshops;
DROP TABLE wam.item_types;
DROP TABLE wam.asset_statuses;
DROP FUNCTION wam.assets_apply_import_row();
DROP FUNCTION wam.import_batches_check_not_committing();
DROP FUNCTION wam.import_rows_guard();
DROP FUNCTION wam.import_batches_guard();
DROP FUNCTION wam.assets_record_history();
DROP FUNCTION wam.assets_stamp_change();
DROP FUNCTION wam.persons_stamp_change();
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
