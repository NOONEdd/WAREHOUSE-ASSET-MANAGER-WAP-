-- WAM database roles. Run ONCE per PostgreSQL cluster, as a superuser:
--
--   psql -v ON_ERROR_STOP=1 -f server/sql/create-roles.sql
--
-- Then give each role a password interactively, so it never appears on a
-- command line, in shell history or in a file:
--
--   psql -c '\password wam_owner'
--   psql -c '\password wam_app'
--
-- wam_owner  owns the database and schema `wam`. Used ONLY by
--            `npm run db:migrate`. Never configured in the running server.
-- wam_app    what the running server connects as. No DDL, never superuser,
--            never BYPASSRLS. The server checks this at startup and refuses
--            to start otherwise (server/src/db/safety.ts).
--
-- The names are fixed: migrations grant privileges to them by name.
-- The automated tests run this exact file against a throwaway cluster.

CREATE ROLE wam_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE wam_app   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
