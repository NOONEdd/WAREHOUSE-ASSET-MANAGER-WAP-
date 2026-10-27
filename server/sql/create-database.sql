-- Create one WAM database. Run as a superuser, after create-roles.sql:
--
--   psql -v ON_ERROR_STOP=1 -v dbname=wam -f server/sql/create-database.sql
--
-- Then apply migrations as wam_owner (see server/README.md). The automated
-- tests run this exact file once per test file, with a random dbname.

CREATE DATABASE :"dbname" OWNER wam_owner ENCODING 'UTF8' TEMPLATE template0;

-- By default every role may connect to every database; only the two WAM
-- roles (and superusers) may connect to this one.
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO wam_app;

\connect :"dbname"

-- WAM uses schema `wam` only. PostgreSQL 15+ already denies CREATE in
-- `public` to ordinary roles; this also removes USAGE so nothing can be
-- resolved through it.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
