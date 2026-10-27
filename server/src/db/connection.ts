import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { DatabaseConfig } from '../config.js'

/**
 * Row types of the tables in schema `wam`, keyed by table name. Empty in
 * Phase 1B-1: the baseline migration creates no application tables. A
 * migration that adds a table adds its row type here in the same commit.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by later migrations
export interface Database {}

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
