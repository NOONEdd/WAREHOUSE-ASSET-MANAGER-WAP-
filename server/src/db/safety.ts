import { sql, type Kysely } from 'kysely'
import { APP_SCHEMA } from './connection.js'
import { readMigrationState } from './migrator.js'

// Checks that fail closed before the server or the migration CLI touches a
// database. They exist because the most damaging misconfigurations are
// silent: a server connected as a superuser, or as the schema owner, works
// perfectly — until the day a bug or an attacker uses privileges it should
// never have had (dropping tables, bypassing row-level security).

/** Lowest PostgreSQL major version the server is tested against. */
export const MIN_POSTGRES_VERSION_NUM = 160000

/** Fixed role names; migrations grant to them by name (see server/sql/). */
export const OWNER_ROLE = 'wam_owner'
export const RUNTIME_ROLE = 'wam_app'

export class DatabaseNotReadyError extends Error {
  readonly problems: readonly string[]

  constructor(purpose: string, problems: readonly string[]) {
    super(`Refusing to ${purpose}:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'DatabaseNotReadyError'
    this.problems = problems
  }
}

interface RoleFacts {
  role: string
  server_version_num: number
  rolsuper: boolean
  rolbypassrls: boolean
  rolcreaterole: boolean
  rolcreatedb: boolean
  rolreplication: boolean
  can_create_in_database: boolean
  can_create_in_public: boolean
  can_create_in_app_schema: boolean
  owns_app_schema: boolean
}

async function readRoleFacts<DB>(db: Kysely<DB>): Promise<RoleFacts> {
  const { rows } = await sql<RoleFacts>`
    SELECT r.rolname AS role,
           current_setting('server_version_num')::int AS server_version_num,
           r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
           has_database_privilege(current_database(), 'CREATE') AS can_create_in_database,
           has_schema_privilege('public', 'CREATE') AS can_create_in_public,
           COALESCE((SELECT has_schema_privilege(n.oid, 'CREATE') FROM pg_catalog.pg_namespace n
                     WHERE n.nspname = ${APP_SCHEMA}), false) AS can_create_in_app_schema,
           EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
                   WHERE n.nspname = ${APP_SCHEMA} AND pg_has_role(n.nspowner, 'MEMBER')) AS owns_app_schema
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = current_user`.execute(db)
  const facts = rows[0]
  if (facts === undefined) throw new Error('could not read the connected role from pg_roles')
  return facts
}

function versionProblems(facts: RoleFacts): string[] {
  return facts.server_version_num < MIN_POSTGRES_VERSION_NUM
    ? [`PostgreSQL ${String(MIN_POSTGRES_VERSION_NUM / 10000)} or later is required`]
    : []
}

/** Problems with the role the HTTP server connects as; empty when safe. */
export async function checkRuntimeRole<DB>(db: Kysely<DB>): Promise<string[]> {
  const facts = await readRoleFacts(db)
  const problems = versionProblems(facts)
  if (facts.rolsuper) problems.push(`role "${facts.role}" is a superuser`)
  if (facts.rolbypassrls) problems.push(`role "${facts.role}" has BYPASSRLS (it would ignore row-level security)`)
  if (facts.rolcreaterole) problems.push(`role "${facts.role}" can create roles`)
  if (facts.rolcreatedb) problems.push(`role "${facts.role}" can create databases`)
  if (facts.rolreplication) problems.push(`role "${facts.role}" has REPLICATION`)
  if (facts.owns_app_schema) {
    problems.push(`role "${facts.role}" owns schema ${APP_SCHEMA}: the server must not use the migration role`)
  } else if (facts.can_create_in_app_schema) {
    problems.push(`role "${facts.role}" can create objects in schema ${APP_SCHEMA}`)
  }
  if (facts.can_create_in_database) problems.push(`role "${facts.role}" can create schemas in this database`)
  if (facts.can_create_in_public) problems.push(`role "${facts.role}" can create objects in schema public`)
  return problems
}

/** Problems with the role the migration CLI connects as; empty when safe. */
export async function checkMigrationRole<DB>(db: Kysely<DB>): Promise<string[]> {
  const facts = await readRoleFacts(db)
  const problems = versionProblems(facts)
  // Objects belong to whoever creates them; running migrations as a
  // superuser (or anyone else) would leave tables owned by the wrong role.
  if (facts.rolsuper) problems.push(`role "${facts.role}" is a superuser; run migrations as ${OWNER_ROLE}`)
  else if (facts.role !== OWNER_ROLE) problems.push(`migrations must run as ${OWNER_ROLE}, not "${facts.role}"`)
  if (facts.rolbypassrls) problems.push(`role "${facts.role}" has BYPASSRLS`)
  return problems
}

/**
 * Called before the HTTP server starts listening. Refuses an over-privileged
 * role and any database whose migrations do not exactly match this code
 * (older: run the migration CLI first; newer: deploy the matching version).
 */
export async function assertDatabaseReadyForServer<DB>(db: Kysely<DB>): Promise<void> {
  const problems = await checkRuntimeRole(db)
  try {
    const state = await readMigrationState(db)
    if (state.pending.length > 0) {
      problems.push(
        `the database is missing migration(s) ${state.pending.join(', ')}; run "npm run db:migrate -- up --apply" as ${OWNER_ROLE}`
      )
    }
    if (state.unknown.length > 0) {
      problems.push(
        `the database has migration(s) this server version does not know (${state.unknown.join(', ')}); deploy the matching server version`
      )
    }
  } catch (err) {
    if (!isInsufficientPrivilege(err)) throw err
    problems.push(`role cannot read the migration history; has migration 0001_baseline been applied?`)
  }
  if (problems.length > 0) throw new DatabaseNotReadyError('start the server', problems)
}

function isInsufficientPrivilege(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '42501'
}
