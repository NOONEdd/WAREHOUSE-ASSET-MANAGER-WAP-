import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '../../src/db/connection.js'
import { createMigrator } from '../../src/db/migrator.js'
import { clusterInfo, connect, createTestDatabase, type TestDatabase } from '../support/testDatabase.js'

// Finding NF-2: PostgreSQL's own server log is outside the application's log privacy. What it writes is
// checked here on the test cluster, setting by setting: with its defaults it logs a failed row's values and
// bind parameters; with the WAM policy (server/README.md, "Log privacy") it does not. The policy's checker,
// server/sql/check-logging-settings.sql, is run against both. Statements run as the server's role, wam_app,
// with the settings applied to the session (they are what postgresql.conf would set for every session).

const POLICY = {
  log_error_verbosity: 'terse',
  log_parameter_max_length_on_error: '0',
  log_parameter_max_length: '0',
  log_statement: 'none',
  log_min_error_statement: 'error'
} as const
const DEFAULTS = {
  log_error_verbosity: 'default',
  log_parameter_max_length_on_error: '0',
  log_parameter_max_length: '-1',
  log_statement: 'none',
  log_min_error_statement: 'error'
} as const
const CHECK = readFileSync(new URL('../../sql/check-logging-settings.sql', import.meta.url), 'utf8')

let tdb: TestDatabase
let superDb: Kysely<Database>
const logFile = () => join(dirname(clusterInfo().socketDir), 'postgres.log')

beforeAll(async () => {
  tdb = await createTestDatabase()
  const owner = connect(tdb.urls.owner)
  expect((await createMigrator(owner).migrateToLatest()).error).toBeUndefined()
  await owner.destroy()
  superDb = connect(tdb.urls.superuser)
}, 120_000)

afterAll(async () => {
  await superDb.destroy()
  await tdb.drop()
})

/** Runs `fn` as wam_app on one connection with `settings` and returns what the server log gained meanwhile. */
async function logged(settings: Record<string, string>, extra: Record<string, string>, fn: (db: Kysely<Database>) => Promise<unknown>): Promise<string> {
  const before = readFileSync(logFile(), 'utf8').length
  await superDb.connection().execute(async (conn) => {
    for (const [name, value] of Object.entries({ ...settings, ...extra })) await sql`SELECT set_config(${name}, ${value}, false)`.execute(conn)
    await sql`SET ROLE wam_app`.execute(conn)
    try {
      await fn(conn).catch(() => undefined)
    } finally {
      await sql`RESET ROLE`.execute(conn)
      await sql`RESET ALL`.execute(conn)
    }
  })
  await new Promise((r) => setTimeout(r, 300))
  return readFileSync(logFile(), 'utf8').slice(before)
}

const marker = (what: string) => `zq.${what}.${randomBytes(4).toString('hex')}`
/** A constraint failure on a table without row-level security, with a marker in the row (as in NF-1). */
const failingUserRow = (value: string) => (db: Kysely<Database>) =>
  sql`INSERT INTO wam.users (username, display_name) VALUES (${value}, ${' '})`.execute(db)
/** A statement with a bind parameter, logged as a slow statement (every statement at log_min_duration_statement = 0). */
const parameterised = (value: string) => (db: Kysely<Database>) => sql`SELECT length(${value}::text) AS n`.execute(db)

describe('NF-2: what PostgreSQL itself logs', () => {
  it('with its defaults: the failing row (DETAIL) and bind parameters reach the server log', async () => {
    const row = marker('row')
    const param = marker('param')
    const rowLog = await logged(DEFAULTS, {}, failingUserRow(row))
    expect(rowLog).toContain('DETAIL:  Failing row contains')
    expect(rowLog).toContain(row)
    const slowLog = await logged(DEFAULTS, { log_min_duration_statement: '0' }, parameterised(param))
    expect(slowLog).toMatch(/duration: [\d.]+ ms/)
    expect(slowLog).toContain(param)
  })

  it('with the WAM policy: neither the row nor any parameter, while the error and the statement (with $1 placeholders) are still logged', async () => {
    const row = marker('row')
    const param = marker('param')
    const rowLog = await logged(POLICY, {}, failingUserRow(row))
    expect(rowLog).toContain('violates check constraint "users_display_name_length"')
    expect(rowLog).toMatch(/STATEMENT:\s+insert into "wam"\."users"|STATEMENT:\s+INSERT INTO wam\.users/i)
    expect(rowLog).toContain('$1')
    expect(rowLog).not.toContain('Failing row contains')
    expect(rowLog).not.toContain(row)
    // Slow-statement logging stays usable for diagnosis (durations, statement text) without parameter values.
    const slowLog = await logged(POLICY, { log_min_duration_statement: '0' }, parameterised(param))
    expect(slowLog).toMatch(/duration: [\d.]+ ms/)
    expect(slowLog).not.toContain(param)
  })

  it("PostgreSQL's primary error message can still quote an invalid input value, which is why the server validates input before the database", async () => {
    // A characterization, not a defect of the policy: no setting removes the value from this message, e.g.
    // 22P02 'invalid input syntax for type integer: "…"'. Route schemas and services validate types and
    // formats first, so such values do not normally reach PostgreSQL; the residue is covered by restricted
    // access to and limited retention of the database log (review recommendation R-3).
    const value = marker('cast')
    const castLog = await logged(POLICY, {}, (db) => sql`SELECT ${value}::integer`.execute(db))
    expect(castLog).toContain('invalid input syntax for type integer')
    expect(castLog).toContain(value)
  })

  it('server/sql/check-logging-settings.sql refuses the defaults, names each unsafe setting, and accepts the policy', async () => {
    const run = (settings: Record<string, string>) =>
      superDb.connection().execute(async (conn) => {
        for (const [name, value] of Object.entries(settings)) await sql`SELECT set_config(${name}, ${value}, false)`.execute(conn)
        await sql`SET ROLE wam_app`.execute(conn) // readable by the server's role, not only by a superuser
        try {
          await sql.raw(CHECK).execute(conn)
          return 'accepted'
        } catch (err) {
          return (err as Error).message
        } finally {
          await sql`RESET ROLE`.execute(conn)
          await sql`RESET ALL`.execute(conn)
        }
      })
    const refused = await run(DEFAULTS)
    expect(refused).toMatch(/^unsafe database logging settings: log_error_verbosity must be terse.*; log_parameter_max_length must be 0/)
    expect(await run({ ...POLICY, log_statement: 'all' })).toMatch(/log_statement must be none or ddl/)
    expect(await run({ ...POLICY, log_min_duration_statement: '0' })).toMatch(/log_min_duration_statement must be -1 or at least 100 ms/)
    expect(await run({ ...POLICY, log_parameter_max_length_on_error: '64' })).toMatch(/log_parameter_max_length_on_error must be 0/)
    expect(await run(POLICY)).toBe('accepted')
    expect(await run({ ...POLICY, log_min_duration_statement: '250', log_statement: 'ddl' })).toBe('accepted')
  })
})
