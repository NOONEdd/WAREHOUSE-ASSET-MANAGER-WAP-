import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely'
import pg from 'pg'
import type { DatabaseConfig } from '../config.js'

// Row types of the tables in schema `wam` (migration 0002), keyed by table
// name. A migration that changes a table changes its type here in the same
// commit. `never` in an insert/update position marks columns the server's
// role may not write (see the column grants in the migration).

/** Read as Date; written by the database (`now()`) or as an explicit value. */
type Timestamp = ColumnType<Date, Date | undefined, Date>
type ReadOnly<T> = ColumnType<T, never, never>
type InsertOnly<T> = ColumnType<T, T, never>

export interface WarehousesTable {
  id: Generated<number>
  code: InsertOnly<string>
  name: string
  is_system: ReadOnly<boolean>
  is_active: Generated<boolean>
  created_at: ColumnType<Date, never, never>
  updated_at: Timestamp
  version: Generated<number>
}

export interface PermissionsTable {
  code: ReadOnly<string>
  scope: ReadOnly<'system' | 'warehouse'>
  description: ReadOnly<string>
}

export interface PermissionProfilesTable {
  id: Generated<number>
  name: string
  description: Generated<string>
  scope: InsertOnly<'system' | 'warehouse'>
  is_active: Generated<boolean>
  created_at: ColumnType<Date, never, never>
  updated_at: Timestamp
  version: Generated<number>
}

export interface PermissionProfilePermissionsTable {
  profile_id: InsertOnly<number>
  scope: InsertOnly<'system' | 'warehouse'>
  permission: InsertOnly<string>
}

export interface JobTitlesTable {
  id: Generated<number>
  name: string
  description: Generated<string>
  is_active: Generated<boolean>
  created_at: ColumnType<Date, never, never>
  updated_at: Timestamp
  version: Generated<number>
}

export interface UsersTable {
  id: Generated<number>
  username: InsertOnly<string>
  display_name: string
  job_title_id: number | null
  status: ColumnType<'active' | 'disabled', never, 'active' | 'disabled'>
  is_owner: ReadOnly<boolean>
  password_hash: ColumnType<string | null, never, string | null>
  password_changed_at: ColumnType<Date | null, never, Date | null>
  last_login_at: ColumnType<Date | null, never, Date | null>
  created_by: InsertOnly<number | null>
  created_at: ColumnType<Date, never, never>
  updated_at: Timestamp
  version: Generated<number>
}

export interface UserSystemProfilesTable {
  user_id: InsertOnly<number>
  profile_id: InsertOnly<number>
  scope: ColumnType<'system', never, never>
  granted_by: InsertOnly<number | null>
  granted_at: ColumnType<Date, never, never>
}

export interface UserWarehouseProfilesTable {
  user_id: InsertOnly<number>
  warehouse_id: InsertOnly<number>
  profile_id: InsertOnly<number>
  scope: ColumnType<'warehouse', never, never>
  granted_by: InsertOnly<number | null>
  granted_at: ColumnType<Date, never, never>
}

export interface SessionsTable {
  id: Generated<number>
  token_hash: InsertOnly<Buffer>
  user_id: InsertOnly<number>
  created_at: ColumnType<Date, never, never>
  last_seen_at: Timestamp
  expires_at: InsertOnly<Date>
  revoked_at: ColumnType<Date | null, never, Date | null>
  revoked_reason: ColumnType<string | null, never, string | null>
  source_ip: InsertOnly<string | null>
  user_agent: InsertOnly<string | null>
}

export interface AuthFailuresTable {
  id: ColumnType<string, never, never>
  kind: InsertOnly<'login' | 'setup'>
  username_key: InsertOnly<string>
  source_ip: InsertOnly<string>
  occurred_at: ColumnType<Date, Date | undefined, never>
}

export interface PasswordSetupCodesTable {
  user_id: number
  code_hash: Buffer
  expires_at: Date
  created_at: Timestamp
  created_by: number | null
}

export interface IdempotencyKeysTable {
  user_id: InsertOnly<number>
  key: InsertOnly<string>
  fingerprint: InsertOnly<Buffer>
  status_code: ColumnType<number | null, never, number>
  response_body: ColumnType<unknown, never, string>
  created_at: ColumnType<Date, Date | undefined, never>
}

export interface AuditEventsTable {
  /** bigint: pg returns it as a string. */
  id: ColumnType<string, never, never>
  occurred_at: ColumnType<Date, never, never>
  actor_user_id: InsertOnly<number | null>
  actor_username: InsertOnly<string | null>
  action: InsertOnly<string>
  outcome: InsertOnly<'success' | 'denied' | 'failure'>
  target_type: InsertOnly<string | null>
  target_id: InsertOnly<string | null>
  warehouse_id: InsertOnly<number | null>
  request_id: InsertOnly<string | null>
  source_ip: InsertOnly<string | null>
  details: ColumnType<Record<string, unknown>, string, never>
}

export interface Database {
  warehouses: WarehousesTable
  permissions: PermissionsTable
  permission_profiles: PermissionProfilesTable
  permission_profile_permissions: PermissionProfilePermissionsTable
  job_titles: JobTitlesTable
  users: UsersTable
  user_system_profiles: UserSystemProfilesTable
  user_warehouse_profiles: UserWarehouseProfilesTable
  sessions: SessionsTable
  auth_failures: AuthFailuresTable
  password_setup_codes: PasswordSetupCodesTable
  idempotency_keys: IdempotencyKeysTable
  audit_events: AuditEventsTable
}

/** The application schema. Nothing the server uses lives in `public`. */
export const APP_SCHEMA = 'wam'

export function createPool(config: DatabaseConfig, onIdleClientError: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.poolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: config.statementTimeoutMs,
    // A request that opens a transaction and then stalls must not hold
    // row locks indefinitely.
    idle_in_transaction_session_timeout: 60_000,
    application_name: 'wam-server',
    // Unqualified names resolve only in `wam` (after pg_catalog, which
    // PostgreSQL always searches first) — never in `public`.
    options: `-c search_path=${APP_SCHEMA}`
  })
  // pg emits 'error' when an idle pooled connection breaks (database
  // restart, network drop). Without a listener Node treats that as an
  // unhandled 'error' event and the whole server process exits.
  pool.on('error', onIdleClientError)
  return pool
}

/** Destroying the returned instance also ends the pool. */
export function createDatabase(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
