import type { MigrationResultSet } from 'kysely/migration'
import { ConfigError, describeDatabaseTarget, loadMigrationConfig, type Env } from '../config.js'
import { createDatabase, createPool } from '../db/connection.js'
import { createMigrator, readMigrationState, type MigrationState } from '../db/migrator.js'
import { checkMigrationRole } from '../db/safety.js'

// The only way the schema changes. Explicit by design:
//   status          show applied / pending migrations (read-only)
//   up              show what WOULD be applied (dry run, the default)
//   up --apply      apply every pending migration in one transaction
//   down --apply    revert the most recent migration; refused when WAM_ENV=production
//
// Production recovery is a forward migration or a restore from backup, never
// `down`: reverting can drop data that was written after the migration.
// The server never migrates on startup; it refuses to start instead.

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

export const USAGE = 'usage: npm run db:migrate -- <status | up [--apply] | down [--apply]>'

export async function runMigrateCli(args: readonly string[], env: Env, io: CliIo): Promise<number> {
  const [command, ...flags] = args
  if ((command !== 'status' && command !== 'up' && command !== 'down') || flags.some((f) => f !== '--apply')) {
    io.err(USAGE)
    return 2
  }
  const apply = flags.includes('--apply')
  if (command === 'status' && apply) {
    io.err(USAGE)
    return 2
  }

  let config
  try {
    config = loadMigrationConfig(env)
  } catch (err) {
    if (err instanceof ConfigError) {
      io.err(err.message)
      return 2
    }
    throw err
  }
  if (command === 'down' && config.environment === 'production') {
    io.err('"down" is disabled when WAM_ENV=production: write a forward migration or restore from backup instead.')
    return 1
  }

  const db = createDatabase(
    createPool(config.database, (e) => {
      io.err(`database connection error: ${e.message}`)
    })
  )
  try {
    io.out(`Target: ${describeDatabaseTarget(config.database.connectionString)} (WAM_ENV=${config.environment})`)
    const roleProblems = await checkMigrationRole(db)
    if (roleProblems.length > 0) {
      for (const p of roleProblems) io.err(`Refusing: ${p}`)
      return 1
    }
    const state = await readMigrationState(db)
    printState(state, io)
    if (state.unknown.length > 0) {
      io.err('Refusing: the database has migrations this code does not know. Use the matching code version.')
      return 1
    }
    if (command === 'status') return 0

    if (command === 'up') {
      if (state.pending.length === 0) {
        io.out('Nothing to apply.')
        return 0
      }
      if (!apply) {
        io.out(`Dry run: would apply ${state.pending.join(', ')}. Re-run with --apply to apply.`)
        return 0
      }
      return report(await createMigrator(db).migrateToLatest(), io)
    }

    const last = state.applied.at(-1)
    if (last === undefined) {
      io.out('Nothing to revert.')
      return 0
    }
    if (!apply) {
      io.out(`Dry run: would revert ${last}. Re-run with --apply to revert.`)
      return 0
    }
    return report(await createMigrator(db).migrateDown(), io)
  } finally {
    await db.destroy()
  }
}

function printState(state: MigrationState, io: CliIo): void {
  io.out(`Applied: ${state.applied.length > 0 ? state.applied.join(', ') : '(none)'}`)
  io.out(`Pending: ${state.pending.length > 0 ? state.pending.join(', ') : '(none)'}`)
  if (state.unknown.length > 0) io.out(`Unknown to this code: ${state.unknown.join(', ')}`)
}

function report({ error, results }: MigrationResultSet, io: CliIo): number {
  for (const r of results ?? []) {
    const verb = r.direction === 'Up' ? 'apply' : 'revert'
    if (r.status === 'Success') io.out(`OK      ${verb} ${r.migrationName}`)
    else if (r.status === 'Error') io.err(`FAILED  ${verb} ${r.migrationName}`)
    else io.err(`SKIPPED ${verb} ${r.migrationName}`)
  }
  if (error === undefined) return 0
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
  io.err(`Migration failed and was rolled back; nothing from this run was applied. Cause: ${message}`)
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '55P03') {
    io.err(
      'Another session holds a lock on a table this migration changes. Stop the server (or wait for the long ' +
        'transaction to end), then run the command again; WAM_MIGRATION_LOCK_TIMEOUT_MS sets how long it waits.'
    )
  }
  return 1
}
