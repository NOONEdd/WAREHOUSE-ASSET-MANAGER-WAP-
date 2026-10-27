import { sql, type Kysely } from 'kysely'
import { DEFAULT_MIGRATION_TABLE, Migrator, type Migration } from 'kysely/migration'
import { APP_SCHEMA } from './connection.js'
import { migrations as allMigrations } from './migrations/index.js'

type MigrationSet = Readonly<Record<string, Migration>>

/**
 * Kysely's migrator, configured for WAM. On PostgreSQL it applies every
 * pending migration inside ONE transaction (a failure leaves none of that
 * run applied) and serializes concurrent runs with an advisory lock.
 * `migrationSet` is replaceable only so tests can exercise failure paths.
 */
export function createMigrator<DB>(db: Kysely<DB>, migrationSet: MigrationSet = allMigrations): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrationSet) },
    migrationTableSchema: APP_SCHEMA
  })
}

export interface MigrationState {
  /** Known to this code and recorded as applied. */
  readonly applied: readonly string[]
  /** Known to this code, not yet applied. */
  readonly pending: readonly string[]
  /** Recorded as applied but unknown to this code: the database is newer than the code. */
  readonly unknown: readonly string[]
}

/** Read-only: creates nothing, so it is safe to call as the runtime role. */
export async function readMigrationState<DB>(
  db: Kysely<DB>,
  migrationSet: MigrationSet = allMigrations
): Promise<MigrationState> {
  const { rows } = await sql<{ present: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${APP_SCHEMA} AND c.relname = ${DEFAULT_MIGRATION_TABLE}
    ) AS present`.execute(db)
  const executed =
    rows[0]?.present === true
      ? (await sql<{ name: string }>`SELECT name FROM ${sql.id(APP_SCHEMA, DEFAULT_MIGRATION_TABLE)}`.execute(db)).rows.map(
          (row) => row.name
        )
      : []
  const known = Object.keys(migrationSet).sort()
  return {
    applied: known.filter((name) => executed.includes(name)),
    pending: known.filter((name) => !executed.includes(name)),
    unknown: executed.filter((name) => !known.includes(name)).sort()
  }
}
