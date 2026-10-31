-- Checks the database server's own logging settings against the WAM policy (finding NF-2). PostgreSQL writes
-- its log outside the application's control: with its default settings a failed statement is logged with
-- "DETAIL: Failing row contains (...)" — a row's values, a user's name or a password-hash prefix among them —
-- and slow-statement or statement logging can print bind parameters. Run it against the production database
-- after every configuration change, as any role (the settings are readable by all):
--
--   psql -v ON_ERROR_STOP=1 -d wam -f server/sql/check-logging-settings.sql
--
-- It fails, naming every unsafe setting, or prints "logging settings follow the WAM policy". It checks the
-- values in effect for this session (pg_settings gives them without units), so run it as the server's role
-- (wam_app) to see what the server gets.
-- Policy and reasons: server/README.md, "Log privacy".
DO $$
DECLARE
  problems text[] := '{}';
BEGIN
  IF current_setting('log_error_verbosity') <> 'terse' THEN
    problems := array_append(problems, 'log_error_verbosity must be terse (default and verbose log DETAIL lines such as "Failing row contains (...)")');
  END IF;
  IF (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name = 'log_parameter_max_length_on_error') <> 0 THEN
    problems := array_append(problems, 'log_parameter_max_length_on_error must be 0 (otherwise a failed statement is logged with its bind parameters)');
  END IF;
  IF (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name = 'log_parameter_max_length') <> 0 THEN
    problems := array_append(problems, 'log_parameter_max_length must be 0 (otherwise statement and duration lines include bind parameters)');
  END IF;
  IF current_setting('log_statement') NOT IN ('none', 'ddl') THEN
    problems := array_append(problems, 'log_statement must be none or ddl (mod and all log every change)');
  END IF;
  IF (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name = 'log_min_duration_statement') BETWEEN 0 AND 99 THEN
    problems := array_append(problems, 'log_min_duration_statement must be -1 or at least 100 ms (lower values log nearly every statement)');
  END IF;
  IF current_setting('log_min_error_statement') IN ('debug5', 'debug4', 'debug3', 'debug2', 'debug1', 'info', 'notice', 'warning', 'log') THEN
    problems := array_append(problems, 'log_min_error_statement must be error or higher');
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'unsafe database logging settings: %', array_to_string(problems, '; ');
  END IF;
  RAISE NOTICE 'logging settings follow the WAM policy';
END
$$;
