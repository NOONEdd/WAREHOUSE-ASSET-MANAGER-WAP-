-- WAM — O-06 read-only data-quality assessment of a COPY of the desktop database (SQLite)
--
-- Decision O-06 (option B, 2026-10-27). Review this file before running it. The owner runs it on
-- their own PC, against a COPY made with the desktop app's own backup function, inspects the
-- output, and decides what may be shared. Runbook: tools/data-quality/README.md.
--
-- Guarantees, by construction (check them while reviewing):
--   * Read-only: the runbook opens the copy read-only and immutable; the first statement below
--     switches the connection to query_only, so SQLite itself refuses any write; and this file
--     contains only SELECT statements and read-only PRAGMA functions — no INSERT, UPDATE, DELETE,
--     CREATE, DROP, ALTER, ATTACH, VACUUM or REINDEX.
--   * Never the live database: section 0 stops the run if query_only is off, if the file still has
--     the live name (asset-warehouse.db), if it lies in an application-data folder (where the app
--     keeps its live database and its own backups), or if it is not a WAM desktop database. Work
--     only on a renamed copy of a backup in a separate folder.
--   * Aggregates only: no asset name, asset code, serial number, person name, username, note,
--     lookup name or file path is printed. Besides counts and percentages, the only values printed
--     from the database are: status names and role names (lookup labels), the audit log's action
--     and entity-type codes (e.g. "create", "asset"), the earliest and latest dates in the history
--     and audit logs, the journal mode, and SQLite's own table, index and integrity messages.
--   * [FACT] rows report what the database contains. [HEURISTIC] rows are classifications by
--     pattern; they can be wrong both ways and only indicate where to look.
--
-- Requires the sqlite3 command-line shell, version 3.38 or later (README.md). The four lines
-- starting with a dot are shell settings, not SQL.
.bail on
.headers on
.mode box
.nullvalue NULL

PRAGMA query_only = ON;

-- ====================================================================================================
-- 0. Safety checks and environment  [FACT]
-- ====================================================================================================
-- Each check below either prints "ok: …" or STOPS the run with an error message beginning "bad JSON
-- path: '$ STOP: …'" (a deliberate error: the reason follows STOP). Nothing has been read beyond the
-- check at that point, and nothing has been changed. The file path itself is never printed: it can
-- contain the Windows user name.

-- 0a. SQLite must refuse writes on this connection.
SELECT CASE WHEN (SELECT query_only FROM pragma_query_only) = 1
            THEN 'ok: query_only is on, so SQLite refuses any write'
            ELSE json_extract('{}', '$ STOP: query_only is off; use the unmodified script') END AS query_only_check;

-- 0b. Only a renamed copy, outside the folders where the app keeps its live database and backups.
SELECT CASE
         WHEN file IS NULL OR file = ''
           THEN json_extract('{}', '$ STOP: no database file is open (temporary or in-memory database)')
         WHEN lower(replace(file, '\', '/')) LIKE '%/asset-warehouse.db'
           THEN json_extract('{}', '$ STOP: the file is named like the live desktop database; use a renamed copy of a backup')
         WHEN lower(replace(file, '\', '/')) LIKE '%/appdata/%'
           OR lower(replace(file, '\', '/')) LIKE '%/.config/%'
           OR lower(replace(file, '\', '/')) LIKE '%/library/application support/%'
           THEN json_extract('{}', '$ STOP: the file is inside an application-data folder; copy the backup to a separate working folder first')
         ELSE 'ok: a renamed copy outside application-data folders'
       END AS copy_location_check
  FROM pragma_database_list WHERE name = 'main';

-- 0c. It must be a WAM desktop database.
SELECT CASE WHEN (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN
                   ('assets', 'asset_transactions', 'audit_log', 'asset_statuses', 'item_types',
                    'workshops', 'countries', 'users', 'roles', 'settings')) = 10
            THEN 'ok: all ten desktop tables are present'
            ELSE json_extract('{}', '$ STOP: this is not a WAM desktop database (expected tables are missing)') END AS database_kind_check;

SELECT (SELECT query_only FROM pragma_query_only) AS query_only_enabled_1_means_yes,
       sqlite_version() AS sqlite_version,
       (SELECT journal_mode FROM pragma_journal_mode) AS journal_mode,
       (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) AS file_bytes;

-- ====================================================================================================
-- 1. Tables and row counts  [FACT]
-- ====================================================================================================
SELECT 'table present in schema' AS check_name, name AS table_name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;
SELECT * FROM (
SELECT 'assets' AS table_name, count(*) AS row_count FROM assets
  UNION ALL SELECT 'asset_transactions' AS table_name, count(*) AS row_count FROM asset_transactions
  UNION ALL SELECT 'audit_log' AS table_name, count(*) AS row_count FROM audit_log
  UNION ALL SELECT 'asset_statuses' AS table_name, count(*) AS row_count FROM asset_statuses
  UNION ALL SELECT 'item_types' AS table_name, count(*) AS row_count FROM item_types
  UNION ALL SELECT 'workshops' AS table_name, count(*) AS row_count FROM workshops
  UNION ALL SELECT 'countries' AS table_name, count(*) AS row_count FROM countries
  UNION ALL SELECT 'users' AS table_name, count(*) AS row_count FROM users
  UNION ALL SELECT 'roles' AS table_name, count(*) AS row_count FROM roles
  UNION ALL SELECT 'settings' AS table_name, count(*) AS row_count FROM settings
);
-- Schema signals: which desktop migrations this copy has (the desktop keeps no version table).
SELECT 'idx_assets_serial_active (migration 002: serial unique among active assets only)' AS signal,
       count(*) AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_assets_serial_active'
UNION ALL SELECT 'idx_assets_code_active (migration 002)', count(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_assets_code_active'
UNION ALL SELECT 'asset_statuses.is_active (migration 003)', count(*) FROM pragma_table_info('asset_statuses') WHERE name = 'is_active'
UNION ALL SELECT 'item_types.is_active (migration 004)', count(*) FROM pragma_table_info('item_types') WHERE name = 'is_active'
UNION ALL SELECT 'users.needs_password_setup (migration 005)', count(*) FROM pragma_table_info('users') WHERE name = 'needs_password_setup'
UNION ALL SELECT 'idx_assets_updated_at (migration 006)', count(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_assets_updated_at';

-- ====================================================================================================
-- 2. Warehouse assignment  [FACT]
-- ====================================================================================================
-- The desktop data model has no warehouse field (review F-2). Workshops are units/departments and
-- are NEVER treated as warehouses (project rule); their blanks appear in section 4 only as a field.
SELECT (SELECT count(*) FROM pragma_table_info('assets')
         WHERE lower(name) LIKE '%warehouse%' AND name NOT IN ('warehouse_entry_date', 'warehouse_exit_date')) AS warehouse_columns_in_assets,
       (SELECT count(*) FROM assets WHERE is_deleted = 0) AS active_assets,
       CASE WHEN (SELECT count(*) FROM pragma_table_info('assets')
                   WHERE lower(name) LIKE '%warehouse%' AND name NOT IN ('warehouse_entry_date', 'warehouse_exit_date')) = 0
            THEN (SELECT count(*) FROM assets WHERE is_deleted = 0)
            ELSE NULL END AS active_assets_without_a_warehouse_field,
       'NULL in the last column means a warehouse column exists: report it, nothing is inferred' AS note;

-- ====================================================================================================
-- 3. Assets: active and soft-deleted  [FACT]
-- ====================================================================================================
SELECT count(*) AS all_rows,
       sum(is_deleted = 0) AS active,
       sum(is_deleted = 1) AS soft_deleted,
       sum(is_deleted NOT IN (0, 1) OR is_deleted IS NULL) AS unexpected_is_deleted_values,
       sum(is_deleted = 1 AND deleted_at IS NULL) AS deleted_without_deleted_at,
       sum(is_deleted = 0 AND deleted_at IS NOT NULL) AS active_with_deleted_at
  FROM assets;

-- ====================================================================================================
-- 4. Blank fields in ACTIVE assets  [FACT]
-- ====================================================================================================
-- "blank" = NULL, empty, or only spaces/tabs/line breaks/no-break or zero-width characters.
WITH a AS (SELECT * FROM assets WHERE is_deleted = 0), n AS (SELECT count(*) AS total FROM a)
SELECT field, blank, total, CASE WHEN total = 0 THEN NULL ELSE printf('%.1f', 100.0 * blank / total) END AS blank_percent
  FROM (
    SELECT 'asset_code' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(asset_code, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'asset_name' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(asset_name, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'serial_number' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(serial_number, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'model' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(model, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'item_type_id' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(item_type_id, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'status_id' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(status_id, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'country_id' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(country_id, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'workshop_id (unit, NOT a warehouse)' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(workshop_id, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'warehouse_entry_date' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(warehouse_entry_date, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'warehouse_exit_date' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(warehouse_exit_date, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'delivered_by' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(delivered_by, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'received_by' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(received_by, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  UNION ALL
    SELECT 'notes' AS field, (SELECT count(*) FROM a WHERE trim(coalesce(notes, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '') AS blank, (SELECT total FROM n) AS total
  );

-- ====================================================================================================
-- 5. Serial numbers of ACTIVE assets
-- ====================================================================================================
-- [FACT] Blank, duplicated, reused and formatting facts.
WITH a AS (SELECT *, trim(serial_number, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) AS s,
                   trim(asset_code, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) AS c FROM assets WHERE is_deleted = 0)
SELECT 'blank serial (would have been an invented placeholder or an error)' AS fact, count(*) AS count FROM a WHERE s = ''
UNION ALL SELECT 'distinct serial values used by more than one active asset (exact)',
       count(*) FROM (SELECT serial_number FROM a WHERE s <> '' GROUP BY serial_number HAVING count(*) > 1)
UNION ALL SELECT 'active assets involved in those exact duplicates',
       coalesce(sum(n), 0) FROM (SELECT count(*) AS n FROM a WHERE s <> '' GROUP BY serial_number HAVING count(*) > 1)
UNION ALL SELECT 'active assets whose serial also appears on a soft-deleted asset',
       count(*) FROM a WHERE s <> '' AND serial_number IN (SELECT serial_number FROM assets WHERE is_deleted = 1)
UNION ALL SELECT 'serial with leading or trailing spaces/invisible characters',
       count(*) FROM a WHERE serial_number <> s
UNION ALL SELECT 'serial made of ASCII digits only', count(*) FROM a WHERE length(s) > 0 AND s NOT GLOB '*[^0-9]*'
UNION ALL SELECT '… of which start with 0 (leading zeros must be preserved)', count(*) FROM a WHERE length(s) > 1 AND s NOT GLOB '*[^0-9]*' AND s GLOB '0*'
UNION ALL SELECT 'serial containing Persian digits (۰–۹)', count(*) FROM a WHERE serial_number GLOB '*[۰-۹]*'
UNION ALL SELECT 'serial containing Arabic-Indic digits (٠–٩)', count(*) FROM a WHERE serial_number GLOB '*[٠-٩]*'
UNION ALL SELECT 'serial containing Persian/Arabic letters', count(*) FROM a WHERE serial_number GLOB '*[آ-یپچژکگ]*';

-- [FACT] Length of trimmed serials (characters).
WITH a AS (SELECT trim(serial_number, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) AS s FROM assets WHERE is_deleted = 0)
SELECT CASE WHEN length(s) = 0 THEN '0 (blank)'
            WHEN length(s) <= 2 THEN '1–2'
            WHEN length(s) <= 5 THEN '3–5'
            WHEN length(s) <= 10 THEN '6–10'
            WHEN length(s) <= 20 THEN '11–20'
            ELSE 'more than 20' END AS serial_length,
       count(*) AS active_assets
  FROM a GROUP BY 1 ORDER BY min(length(s));

-- [HEURISTIC] Near-duplicates: different raw values that become equal after ignoring case, spaces,
-- - _ / . \ and invisible characters, Persian/Arabic digits and Arabic ي/ك. Likely the same asset
-- typed twice — or genuinely different assets. Never merged automatically.
WITH n0 AS (SELECT serial_number AS raw, lower(trim(serial_number, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279))) AS v FROM assets WHERE is_deleted = 0 AND trim(serial_number, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) <> ''),
     n1 AS (SELECT raw, replace(replace(replace(replace(replace(v, '۰', '0'), '۱', '1'), '۲', '2'), '۳', '3'), '۴', '4') AS v FROM n0),
     n2 AS (SELECT raw, replace(replace(replace(replace(replace(v, '۵', '5'), '۶', '6'), '۷', '7'), '۸', '8'), '۹', '9') AS v FROM n1),
     n3 AS (SELECT raw, replace(replace(replace(replace(replace(v, '٠', '0'), '١', '1'), '٢', '2'), '٣', '3'), '٤', '4') AS v FROM n2),
     n4 AS (SELECT raw, replace(replace(replace(replace(replace(v, '٥', '5'), '٦', '6'), '٧', '7'), '٨', '8'), '٩', '9') AS v FROM n3),
     n5 AS (SELECT raw, replace(replace(v, 'ي', 'ی'), 'ك', 'ک') AS v FROM n4),
     n6 AS (SELECT raw, replace(replace(replace(replace(replace(replace(v, ' ', ''), '-', ''), '_', ''), '/', ''), '.', ''), '\', '') AS v FROM n5),
     nk AS (SELECT raw, replace(replace(replace(v, char(160), ''), char(8204), ''), char(8205), '') AS k FROM n6),
     groups AS (SELECT k, count(*) AS n FROM nk GROUP BY k HAVING count(DISTINCT raw) > 1)
SELECT 'groups of differently written serials that look the same' AS heuristic, count(*) AS groups, coalesce(sum(n), 0) AS active_assets_involved FROM groups;

-- [HEURISTIC] Placeholder-looking serials, rule by rule (a row can match several rules).
WITH a AS (SELECT *, trim(serial_number, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) AS s,
                   trim(asset_code, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) AS c FROM assets WHERE is_deleted = 0)
SELECT 'P1' AS rule, 'one character repeated (e.g. 0000, xxxx, ----)' AS looks_like, count(*) AS active_assets FROM a WHERE length(s) > 0 AND replace(s, substr(s, 1, 1), '') = ''
UNION ALL SELECT 'P2', 'very short: 1–2 characters', count(*) FROM a WHERE length(s) BETWEEN 1 AND 2
UNION ALL SELECT 'P3', 'no letter or digit at all (punctuation only)', count(*) FROM a WHERE length(s) > 0 AND s NOT GLOB '*[A-Za-z0-9۰-۹٠-٩آ-یپچژکگ]*'
UNION ALL SELECT 'P4', 'a placeholder word (n/a, unknown, ندارد, نامشخص, …)', count(*) FROM a WHERE lower(s) IN ('n/a', 'na', 'n.a', 'n.a.', 'none', 'null', 'nil', 'unknown', 'no', 'nosn', 'no sn', 'no-sn', 'no serial', 'noserial', 'sn', 's/n', '-', '--', '?', 'x', 'xx', 'xxx', 'tbd', 'tba', 'temp', 'tmp', 'test', 'dummy', 'ندارد', 'نامشخص', 'نامعلوم', 'بدون سریال', 'بی سریال', 'بدون شماره', 'ن.م', 'ن م', 'ندارد.', '؟')
UNION ALL SELECT 'P5', 'a placeholder prefix (temp…, test…, nosn…, بدون…, …)', count(*) FROM a WHERE (lower(s) LIKE 'temp%' OR lower(s) LIKE 'tmp%' OR lower(s) LIKE 'test%' OR lower(s) LIKE 'nosn%' OR lower(s) LIKE 'no-sn%' OR lower(s) LIKE 'no sn%' OR lower(s) LIKE 'ns-%' OR lower(s) LIKE 'unknown%' OR lower(s) LIKE 'dummy%' OR lower(s) LIKE 'بدون%' OR lower(s) LIKE 'ندارد%' OR lower(s) LIKE 'نامشخص%')
UNION ALL SELECT 'P6', 'identical to the asset code', count(*) FROM a WHERE s = c AND length(s) > 0
UNION ALL SELECT 'P7', 'digits only, at most 4 digits (e.g. 1, 25, 0001)', count(*) FROM a WHERE length(s) BETWEEN 1 AND 4 AND s NOT GLOB '*[^0-9]*'
UNION ALL SELECT 'any', 'matches at least one rule above', count(*) FROM a WHERE (length(s) > 0 AND replace(s, substr(s, 1, 1), '') = '') OR (length(s) BETWEEN 1 AND 2) OR (length(s) > 0 AND s NOT GLOB '*[A-Za-z0-9۰-۹٠-٩آ-یپچژکگ]*') OR (lower(s) IN ('n/a', 'na', 'n.a', 'n.a.', 'none', 'null', 'nil', 'unknown', 'no', 'nosn', 'no sn', 'no-sn', 'no serial', 'noserial', 'sn', 's/n', '-', '--', '?', 'x', 'xx', 'xxx', 'tbd', 'tba', 'temp', 'tmp', 'test', 'dummy', 'ندارد', 'نامشخص', 'نامعلوم', 'بدون سریال', 'بی سریال', 'بدون شماره', 'ن.م', 'ن م', 'ندارد.', '؟')) OR ((lower(s) LIKE 'temp%' OR lower(s) LIKE 'tmp%' OR lower(s) LIKE 'test%' OR lower(s) LIKE 'nosn%' OR lower(s) LIKE 'no-sn%' OR lower(s) LIKE 'no sn%' OR lower(s) LIKE 'ns-%' OR lower(s) LIKE 'unknown%' OR lower(s) LIKE 'dummy%' OR lower(s) LIKE 'بدون%' OR lower(s) LIKE 'ندارد%' OR lower(s) LIKE 'نامشخص%')) OR (s = c AND length(s) > 0) OR (length(s) BETWEEN 1 AND 4 AND s NOT GLOB '*[^0-9]*');

-- ====================================================================================================
-- 6. Asset codes of ACTIVE assets  [FACT; last query HEURISTIC]
-- ====================================================================================================
WITH a AS (SELECT *, trim(serial_number, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) AS s,
                   trim(asset_code, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) AS c FROM assets WHERE is_deleted = 0)
SELECT 'blank asset code' AS check_name, count(*) AS count FROM a WHERE c = ''
UNION ALL SELECT 'distinct codes used by more than one active asset (exact)', count(*) FROM (SELECT asset_code FROM a GROUP BY asset_code HAVING count(*) > 1)
UNION ALL SELECT 'active assets whose code also appears on a soft-deleted asset', count(*) FROM a WHERE asset_code IN (SELECT asset_code FROM assets WHERE is_deleted = 1)
UNION ALL SELECT 'code with leading or trailing spaces/invisible characters', count(*) FROM a WHERE asset_code <> c
UNION ALL SELECT 'code containing Persian or Arabic-Indic digits', count(*) FROM a WHERE asset_code GLOB '*[۰-۹]*' OR asset_code GLOB '*[٠-٩]*';

-- [HEURISTIC] Near-duplicate asset codes, normalized as for serial numbers.
WITH n0 AS (SELECT asset_code AS raw, lower(trim(asset_code, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279))) AS v FROM assets WHERE is_deleted = 0 AND trim(asset_code, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) <> ''),
     n1 AS (SELECT raw, replace(replace(replace(replace(replace(v, '۰', '0'), '۱', '1'), '۲', '2'), '۳', '3'), '۴', '4') AS v FROM n0),
     n2 AS (SELECT raw, replace(replace(replace(replace(replace(v, '۵', '5'), '۶', '6'), '۷', '7'), '۸', '8'), '۹', '9') AS v FROM n1),
     n3 AS (SELECT raw, replace(replace(replace(replace(replace(v, '٠', '0'), '١', '1'), '٢', '2'), '٣', '3'), '٤', '4') AS v FROM n2),
     n4 AS (SELECT raw, replace(replace(replace(replace(replace(v, '٥', '5'), '٦', '6'), '٧', '7'), '٨', '8'), '٩', '9') AS v FROM n3),
     n5 AS (SELECT raw, replace(replace(v, 'ي', 'ی'), 'ك', 'ک') AS v FROM n4),
     n6 AS (SELECT raw, replace(replace(replace(replace(replace(replace(v, ' ', ''), '-', ''), '_', ''), '/', ''), '.', ''), '\', '') AS v FROM n5),
     nk AS (SELECT raw, replace(replace(replace(v, char(160), ''), char(8204), ''), char(8205), '') AS k FROM n6)
SELECT 'groups of differently written codes that look the same' AS heuristic, count(*) AS groups
  FROM (SELECT k FROM nk GROUP BY k HAVING count(DISTINCT raw) > 1);

-- ====================================================================================================
-- 7. Status values  [FACT]
-- ====================================================================================================
-- Status names are lookup labels, the only text printed from the data. "seeded" = one of the four
-- names the current desktop seeds; others were added by an administrator or come from older versions
-- (migration 001 knew 'تعمیر' and 'مفقود').
SELECT s.id AS status_id, s.name AS status_name, s.is_active, s.sort_order,
       CASE WHEN s.name IN ('در انبار', 'صادر شده', 'مرجوع شده', 'آسیب‌دیده') THEN 'yes' ELSE 'no' END AS seeded,
       CASE WHEN s.name GLOB '*[A-Za-z]*' THEN 'yes' ELSE 'no' END AS has_latin_letters,
       (SELECT count(*) FROM assets x WHERE x.status_id = s.id AND x.is_deleted = 0) AS active_assets,
       (SELECT count(*) FROM assets x WHERE x.status_id = s.id AND x.is_deleted = 1) AS soft_deleted_assets,
       (SELECT count(*) FROM asset_transactions t WHERE t.new_status_id = s.id) AS times_set_in_history
  FROM asset_statuses s ORDER BY s.sort_order, s.id;

SELECT 'active assets whose status_id matches no status row' AS fact, count(*) AS count
  FROM assets a WHERE a.is_deleted = 0 AND NOT EXISTS (SELECT 1 FROM asset_statuses s WHERE s.id = a.status_id)
UNION ALL SELECT 'active assets in an inactive status', count(*)
  FROM assets a JOIN asset_statuses s ON s.id = a.status_id WHERE a.is_deleted = 0 AND s.is_active = 0;

-- ====================================================================================================
-- 8. Status history consistency  [FACT]
-- ====================================================================================================
-- Review F-3: an import with "update" changes status without writing history. Here: assets whose
-- latest history entry disagrees with their current status, and assets with no history at all.
WITH latest AS (
  SELECT t.asset_id, t.new_status_id
    FROM asset_transactions t
   WHERE t.id = (SELECT max(t2.id) FROM asset_transactions t2 WHERE t2.asset_id = t.asset_id)
)
SELECT 'active assets with no status-history entry' AS fact, count(*) AS count
  FROM assets a WHERE a.is_deleted = 0 AND NOT EXISTS (SELECT 1 FROM asset_transactions t WHERE t.asset_id = a.id)
UNION ALL SELECT 'active assets whose latest history entry differs from the current status', count(*)
  FROM assets a JOIN latest l ON l.asset_id = a.id WHERE a.is_deleted = 0 AND l.new_status_id <> a.status_id
UNION ALL SELECT 'history entries whose previous status differs from the entry before them', count(*)
  FROM asset_transactions t
 WHERE t.previous_status_id IS NOT NULL
   AND t.previous_status_id <> (SELECT t2.new_status_id FROM asset_transactions t2
                                 WHERE t2.asset_id = t.asset_id AND t2.id < t.id ORDER BY t2.id DESC LIMIT 1);

-- ====================================================================================================
-- 9. Date formats in ACTIVE assets  [HEURISTIC]
-- ====================================================================================================
SELECT 'warehouse_entry_date' AS field, CASE
         WHEN trim(coalesce(warehouse_entry_date, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '' THEN '0 blank'
         WHEN warehouse_entry_date GLOB '*[۰-۹٠-٩]*' THEN '5 contains Persian/Arabic digits'
         WHEN warehouse_entry_date GLOB '1[34][0-9][0-9][-/][0-1][0-9][-/][0-3][0-9]*' THEN '1 YYYY-MM-DD, year 13xx–14xx (looks Jalali)'
         WHEN warehouse_entry_date GLOB '[12][09][0-9][0-9][-/][0-1][0-9][-/][0-3][0-9]*' THEN '2 YYYY-MM-DD, year 19xx–20xx (looks Gregorian)'
         WHEN warehouse_entry_date GLOB '[0-3][0-9][-/][0-1][0-9][-/][0-9][0-9][0-9][0-9]*' THEN '3 DD-MM-YYYY or MM-DD-YYYY (ambiguous)'
         WHEN warehouse_entry_date NOT GLOB '*[^0-9.]*' THEN '4 a bare number (spreadsheet serial date?)'
         ELSE '6 other' END AS format, count(*) AS active_assets
  FROM assets WHERE is_deleted = 0 GROUP BY 2
UNION ALL
SELECT 'warehouse_exit_date', CASE
         WHEN trim(coalesce(warehouse_exit_date, ''), ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279)) = '' THEN '0 blank'
         WHEN warehouse_exit_date GLOB '*[۰-۹٠-٩]*' THEN '5 contains Persian/Arabic digits'
         WHEN warehouse_exit_date GLOB '1[34][0-9][0-9][-/][0-1][0-9][-/][0-3][0-9]*' THEN '1 YYYY-MM-DD, year 13xx–14xx (looks Jalali)'
         WHEN warehouse_exit_date GLOB '[12][09][0-9][0-9][-/][0-1][0-9][-/][0-3][0-9]*' THEN '2 YYYY-MM-DD, year 19xx–20xx (looks Gregorian)'
         WHEN warehouse_exit_date GLOB '[0-3][0-9][-/][0-1][0-9][-/][0-9][0-9][0-9][0-9]*' THEN '3 DD-MM-YYYY or MM-DD-YYYY (ambiguous)'
         WHEN warehouse_exit_date NOT GLOB '*[^0-9.]*' THEN '4 a bare number (spreadsheet serial date?)'
         ELSE '6 other' END, count(*)
  FROM assets WHERE is_deleted = 0 GROUP BY 2
ORDER BY 1, 2;

SELECT 'exit date before entry date (both YYYY-MM-DD, same calendar range)' AS heuristic, count(*) AS active_assets
  FROM assets
 WHERE is_deleted = 0
   AND substr(warehouse_entry_date, 1, 2) = substr(warehouse_exit_date, 1, 2)
   AND warehouse_entry_date GLOB '[12][0-9][0-9][0-9][-/][0-1][0-9][-/][0-3][0-9]*'
   AND warehouse_exit_date GLOB '[12][0-9][0-9][0-9][-/][0-1][0-9][-/][0-3][0-9]*'
   AND replace(substr(warehouse_exit_date, 1, 10), '/', '-') < replace(substr(warehouse_entry_date, 1, 10), '/', '-');

-- ====================================================================================================
-- 10. Lookup lists (counts only)  [FACT]
-- ====================================================================================================
SELECT 'item_types' AS lookup, count(*) AS rows, sum(is_active = 1) AS active,
       (SELECT count(*) FROM item_types l WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.item_type_id = l.id)) AS unused,
       (SELECT count(*) FROM assets a JOIN item_types l ON l.id = a.item_type_id WHERE a.is_deleted = 0 AND l.is_active = 0) AS active_assets_using_inactive_row
  FROM item_types
UNION ALL SELECT 'workshops (units, NOT warehouses)', count(*), sum(is_active = 1),
       (SELECT count(*) FROM workshops l WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.workshop_id = l.id)),
       (SELECT count(*) FROM assets a JOIN workshops l ON l.id = a.workshop_id WHERE a.is_deleted = 0 AND l.is_active = 0)
  FROM workshops
UNION ALL SELECT 'countries', count(*), sum(is_active = 1),
       (SELECT count(*) FROM countries l WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.country_id = l.id)),
       (SELECT count(*) FROM assets a JOIN countries l ON l.id = a.country_id WHERE a.is_deleted = 0 AND l.is_active = 0)
  FROM countries;

-- [HEURISTIC] Lookup names that look the same after normalization (e.g. ي/ی, spaces).
WITH n0 AS (SELECT id AS raw, lower(trim(name, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279))) AS v FROM item_types WHERE is_active = 1),
     n1 AS (SELECT raw, replace(replace(replace(replace(replace(v, '۰', '0'), '۱', '1'), '۲', '2'), '۳', '3'), '۴', '4') AS v FROM n0),
     n2 AS (SELECT raw, replace(replace(replace(replace(replace(v, '۵', '5'), '۶', '6'), '۷', '7'), '۸', '8'), '۹', '9') AS v FROM n1),
     n3 AS (SELECT raw, replace(replace(replace(replace(replace(v, '٠', '0'), '١', '1'), '٢', '2'), '٣', '3'), '٤', '4') AS v FROM n2),
     n4 AS (SELECT raw, replace(replace(replace(replace(replace(v, '٥', '5'), '٦', '6'), '٧', '7'), '٨', '8'), '٩', '9') AS v FROM n3),
     n5 AS (SELECT raw, replace(replace(v, 'ي', 'ی'), 'ك', 'ک') AS v FROM n4),
     n6 AS (SELECT raw, replace(replace(replace(replace(replace(replace(v, ' ', ''), '-', ''), '_', ''), '/', ''), '.', ''), '\', '') AS v FROM n5),
     nk AS (SELECT raw, replace(replace(replace(v, char(160), ''), char(8204), ''), char(8205), '') AS k FROM n6)
SELECT 'item_types' AS lookup, count(*) AS groups_of_similar_active_names FROM (SELECT k FROM nk GROUP BY k HAVING count(*) > 1);
WITH n0 AS (SELECT id AS raw, lower(trim(name, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279))) AS v FROM workshops WHERE is_active = 1),
     n1 AS (SELECT raw, replace(replace(replace(replace(replace(v, '۰', '0'), '۱', '1'), '۲', '2'), '۳', '3'), '۴', '4') AS v FROM n0),
     n2 AS (SELECT raw, replace(replace(replace(replace(replace(v, '۵', '5'), '۶', '6'), '۷', '7'), '۸', '8'), '۹', '9') AS v FROM n1),
     n3 AS (SELECT raw, replace(replace(replace(replace(replace(v, '٠', '0'), '١', '1'), '٢', '2'), '٣', '3'), '٤', '4') AS v FROM n2),
     n4 AS (SELECT raw, replace(replace(replace(replace(replace(v, '٥', '5'), '٦', '6'), '٧', '7'), '٨', '8'), '٩', '9') AS v FROM n3),
     n5 AS (SELECT raw, replace(replace(v, 'ي', 'ی'), 'ك', 'ک') AS v FROM n4),
     n6 AS (SELECT raw, replace(replace(replace(replace(replace(replace(v, ' ', ''), '-', ''), '_', ''), '/', ''), '.', ''), '\', '') AS v FROM n5),
     nk AS (SELECT raw, replace(replace(replace(v, char(160), ''), char(8204), ''), char(8205), '') AS k FROM n6)
SELECT 'workshops' AS lookup, count(*) AS groups_of_similar_active_names FROM (SELECT k FROM nk GROUP BY k HAVING count(*) > 1);
WITH n0 AS (SELECT id AS raw, lower(trim(name, ' ' || char(9, 10, 13, 160, 8203, 8204, 8205, 65279))) AS v FROM countries WHERE is_active = 1),
     n1 AS (SELECT raw, replace(replace(replace(replace(replace(v, '۰', '0'), '۱', '1'), '۲', '2'), '۳', '3'), '۴', '4') AS v FROM n0),
     n2 AS (SELECT raw, replace(replace(replace(replace(replace(v, '۵', '5'), '۶', '6'), '۷', '7'), '۸', '8'), '۹', '9') AS v FROM n1),
     n3 AS (SELECT raw, replace(replace(replace(replace(replace(v, '٠', '0'), '١', '1'), '٢', '2'), '٣', '3'), '٤', '4') AS v FROM n2),
     n4 AS (SELECT raw, replace(replace(replace(replace(replace(v, '٥', '5'), '٦', '6'), '٧', '7'), '٨', '8'), '٩', '9') AS v FROM n3),
     n5 AS (SELECT raw, replace(replace(v, 'ي', 'ی'), 'ك', 'ک') AS v FROM n4),
     n6 AS (SELECT raw, replace(replace(replace(replace(replace(replace(v, ' ', ''), '-', ''), '_', ''), '/', ''), '.', ''), '\', '') AS v FROM n5),
     nk AS (SELECT raw, replace(replace(replace(v, char(160), ''), char(8204), ''), char(8205), '') AS k FROM n6)
SELECT 'countries' AS lookup, count(*) AS groups_of_similar_active_names FROM (SELECT k FROM nk GROUP BY k HAVING count(*) > 1);

-- ====================================================================================================
-- 11. User accounts (counts only)  [FACT]
-- ====================================================================================================
SELECT count(*) AS user_accounts, sum(is_active = 1) AS active, sum(needs_password_setup = 1) AS awaiting_first_password
  FROM users;
SELECT r.name AS role_name, count(u.id) AS user_accounts
  FROM roles r LEFT JOIN users u ON u.role_id = r.id GROUP BY r.id ORDER BY r.id;

-- ====================================================================================================
-- 12. History and audit span  [FACT]
-- ====================================================================================================
SELECT 'asset_transactions' AS log, count(*) AS rows, min(transaction_date) AS earliest, max(transaction_date) AS latest FROM asset_transactions
UNION ALL SELECT 'audit_log', count(*), min(occurred_at), max(occurred_at) FROM audit_log;
SELECT entity_type, action, count(*) AS entries FROM audit_log GROUP BY entity_type, action ORDER BY entity_type, action;

-- ====================================================================================================
-- 13. SQLite integrity checks  [FACT]
-- ====================================================================================================
-- 'ok' means SQLite found no corruption. Messages name tables, indexes and row numbers only.
SELECT integrity_check AS integrity_check_result FROM pragma_integrity_check LIMIT 50;
-- Broken references (enforced or not), grouped; no row values.
SELECT "table" AS child_table, parent AS parent_table, count(*) AS broken_references
  FROM pragma_foreign_key_check GROUP BY "table", parent ORDER BY 1, 2;
SELECT CASE WHEN (SELECT count(*) FROM pragma_foreign_key_check) = 0 THEN 'ok: no broken references' ELSE 'see the table above' END AS foreign_key_check_result;

-- ====================================================================================================
-- End of report
-- ====================================================================================================
SELECT 'end of report' AS status, (SELECT query_only FROM pragma_query_only) AS query_only_still_enabled;
