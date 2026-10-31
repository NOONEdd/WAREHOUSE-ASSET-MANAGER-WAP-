import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely'
import pg from 'pg'
import type { DatabaseConfig } from '../config.js'

// Row types of the tables in schema `wam` (migrations 0002–0007), keyed by table
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
  mfa_verified: ColumnType<boolean, boolean | undefined, boolean>
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
  /** Migration 0008: the person whose name the stored response contains (tombstoned on erasure). */
  subject_person_id: ColumnType<string | null, never, string | null>
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

export type MfaRequiredFor = 'privileged' | 'all_users'

export interface SecurityPolicyTable {
  id: ReadOnly<boolean>
  mfa_required_for: ColumnType<MfaRequiredFor, never, MfaRequiredFor>
  updated_at: ColumnType<Date, never, Date>
  updated_by: ColumnType<number | null, never, number | null>
  version: ColumnType<number, never, number>
}

export interface UserMfaTable {
  user_id: InsertOnly<number>
  /** AES-256-GCM sealed (src/auth/secretBox.ts). */
  totp_secret: InsertOnly<Buffer>
  totp_key_id: InsertOnly<string>
  /** bigint: pg returns it as a string. */
  totp_last_step: ColumnType<string, number, number>
  failed_attempts: ColumnType<number, number | undefined, number>
  enrolled_at: ColumnType<Date, never, never>
}

export interface MfaRecoveryCodesTable {
  user_id: InsertOnly<number>
  code_hash: InsertOnly<Buffer>
  used_at: ColumnType<Date | null, never, Date | null>
}

export interface MfaEnrollmentsTable {
  user_id: number
  totp_secret: Buffer
  totp_key_id: string
  created_at: Timestamp
  expires_at: Date
}

export interface LoginChallengesTable {
  id: Generated<number>
  token_hash: InsertOnly<Buffer>
  user_id: InsertOnly<number>
  purpose: InsertOnly<'verify' | 'enroll'>
  created_at: ColumnType<Date, never, never>
  expires_at: InsertOnly<Date>
}

/** bigint columns arrive from node-postgres as strings. */
type BigId = ColumnType<string, never, never>
type BigRef = ColumnType<string | null, string | number | null, string | number | null>

// --- Phase 1B-3 (migrations 0005–0007). Columns the triggers stamp are read-only here: the server's
// role has no privilege to write them. Dates are selected as text (to_char), never as Date objects.

export interface AssetStatusesTable {
  id: Generated<number>
  code: ReadOnly<string | null>
  name: string
  is_system: ReadOnly<boolean>
  is_active: ColumnType<boolean, never, boolean>
  sort_order: Generated<number>
  created_at: ColumnType<Date, never, never>
  updated_at: Timestamp
  version: Generated<number>
}

export interface CatalogEntriesTable {
  id: Generated<number>
  name: string
  is_active: ColumnType<boolean, never, boolean>
  created_at: ColumnType<Date, never, never>
  updated_at: Timestamp
  version: Generated<number>
}

export interface CountriesTable extends CatalogEntriesTable {
  iso_code: string | null
}

export interface PersonsTable {
  id: BigId
  warehouse_id: InsertOnly<number>
  display_name: string | null
  erased_at: ColumnType<Date | null, never, Date | null>
  created_at: ReadOnly<Date>
  created_by: ReadOnly<number>
  updated_at: ReadOnly<Date>
  updated_by: ReadOnly<number>
  version: ReadOnly<number>
}

export interface AssetsTable {
  id: BigId
  warehouse_id: InsertOnly<number>
  asset_code: string
  asset_code_key: ReadOnly<string>
  name: string
  item_type_id: number
  model: string | null
  serial_number: string | null
  serial_number_key: ReadOnly<string | null>
  country_id: number | null
  workshop_id: number | null
  status_id: number
  entry_date: ColumnType<Date | null, string | null, string | null>
  exit_date: ColumnType<Date | null, string | null, string | null>
  delivered_by_user_id: number | null
  delivered_by_person_id: BigRef
  received_by_user_id: number | null
  received_by_person_id: BigRef
  notes: string | null
  origin: InsertOnly<'manual' | 'import'>
  origin_import_row_id: ColumnType<string | null, string | number | null, never>
  origin_warehouse_id: ReadOnly<number | null>
  retired_at: ReadOnly<Date | null>
  retired_by: ReadOnly<number | null>
  retirement_reason: ReadOnly<string | null>
  created_at: ReadOnly<Date>
  created_by: ReadOnly<number>
  updated_at: ReadOnly<Date>
  updated_by: ReadOnly<number>
  version: ReadOnly<number>
}

export interface AssetStatusHistoryTable {
  id: BigId
  asset_id: ReadOnly<string>
  warehouse_id: ReadOnly<number>
  from_status_id: ReadOnly<number | null>
  to_status_id: ReadOnly<number>
  changed_at: ReadOnly<Date>
  changed_by: ReadOnly<number>
  reason: ReadOnly<string | null>
  delivered_by_user_id: ReadOnly<number | null>
  delivered_by_person_id: ReadOnly<string | null>
  received_by_user_id: ReadOnly<number | null>
  received_by_person_id: ReadOnly<string | null>
  import_row_id: ReadOnly<string | null>
  request_id: ReadOnly<string | null>
}

export interface AssetWarehouseHistoryTable {
  id: BigId
  asset_id: ReadOnly<string>
  from_warehouse_id: ReadOnly<number | null>
  to_warehouse_id: ReadOnly<number>
  changed_at: ReadOnly<Date>
  changed_by: ReadOnly<number>
  reason: ReadOnly<string | null>
  import_row_id: ReadOnly<string | null>
  request_id: ReadOnly<string | null>
}

export type ImportBatchState = 'uploaded' | 'previewed' | 'committing' | 'committed' | 'cancelled' | 'failed' | 'expired'
export type ImportRowOutcome = 'create' | 'update' | 'unchanged' | 'suspected_duplicate' | 'invalid'

export interface ImportBatchesTable {
  id: BigId
  warehouse_id: InsertOnly<number>
  state: ColumnType<ImportBatchState, never, ImportBatchState>
  file_name: ColumnType<string | null, string, never>
  file_sha256: InsertOnly<Buffer>
  file_size_bytes: ColumnType<string, number, never>
  file_format: InsertOnly<'xlsx' | 'csv'>
  row_count: ColumnType<number | null, number | null | undefined, number | null>
  failure_code: ColumnType<string | null, never, string | null>
  created_at: ReadOnly<Date>
  created_by: ReadOnly<number>
  updated_at: ReadOnly<Date>
  closed_at: ReadOnly<Date | null>
  closed_by: ReadOnly<number | null>
  content_cleared_at: ReadOnly<Date | null>
  version: ReadOnly<number>
}

export interface ImportRowsTable {
  id: BigId
  batch_id: ColumnType<string, string | number, never>
  warehouse_id: InsertOnly<number>
  sheet_name: InsertOnly<string | null>
  row_number: InsertOnly<number>
  cells: ColumnType<Record<string, string>, string, never>
  outcome: ImportRowOutcome
  issues: ColumnType<unknown[], string, string>
  matched_asset_id: BigRef
  matched_asset_version: number | null
  applied_at: ReadOnly<Date | null>
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
  security_policy: SecurityPolicyTable
  user_mfa: UserMfaTable
  mfa_recovery_codes: MfaRecoveryCodesTable
  mfa_enrollments: MfaEnrollmentsTable
  login_challenges: LoginChallengesTable
  asset_statuses: AssetStatusesTable
  item_types: CatalogEntriesTable
  workshops: CatalogEntriesTable
  countries: CountriesTable
  persons: PersonsTable
  assets: AssetsTable
  asset_status_history: AssetStatusHistoryTable
  asset_warehouse_history: AssetWarehouseHistoryTable
  import_batches: ImportBatchesTable
  import_rows: ImportRowsTable
}

/** The application schema. Nothing the server uses lives in `public`. */
export const APP_SCHEMA = 'wam'

export function createPool(config: DatabaseConfig, onConnectionError: (err: Error) => void): pg.Pool {
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
  // pg emits 'error' when a pooled connection breaks (database restart,
  // terminated backend, network drop). Without a listener Node treats that as
  // an unhandled 'error' event and the whole server process exits. The pool
  // reports idle connections; a connection that breaks while a request holds
  // it reports on its own client, so every client gets a listener too (found
  // by the system test: a terminated backend crashed the server). The query
  // in flight still fails, and the broken client is not returned to the pool.
  pool.on('error', onConnectionError)
  pool.on('connect', (client) => {
    client.on('error', onConnectionError)
  })
  return pool
}

/** Destroying the returned instance also ends the pool. */
export function createDatabase(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
