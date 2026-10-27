import { sql, type Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'
import { describe, expect, it } from 'vitest'
import type { Database } from '../../src/db/connection.js'
import { runMigrateCli } from '../../src/cli/migrate.js'
import { createMigrator, readMigrationState } from '../../src/db/migrator.js'
import { migrations } from '../../src/db/migrations/index.js'
import { connect, createTestDatabase, migrationEnv, type TestDatabase } from '../support/testDatabase.js'

const ALL = Object.keys(migrations)

function capture(): { io: { out(l: string): void; err(l: string): void }; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err }
}

/** Every test gets its own empty database (server/sql/create-database.sql), dropped afterwards. */
async function withDatabase(fn: (tdb: TestDatabase, owner: Kysely<Database>) => Promise<void>): Promise<void> {
  const tdb = await createTestDatabase()
  const owner = connect(tdb.urls.owner)
  try {
    await fn(tdb, owner)
  } finally {
    await owner.destroy()
    await tdb.drop()
  }
}

async function cli(url: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture()
  const code = await runMigrateCli(args, migrationEnv(url, env), io)
  return { code, out, err }
}

describe('migration CLI', () => {
  it('status on a fresh database lists every migration as pending and changes nothing', () =>
    withDatabase(async (tdb, owner) => {
      const r = await cli(tdb.urls.owner, ['status'])
      expect(r.code).toBe(0)
      expect(r.out).toContain(`Pending: ${ALL.join(', ')}`)
      expect((await readMigrationState(owner)).pending).toEqual(ALL)
    }))

  it('"up" without --apply is a dry run', () =>
    withDatabase(async (tdb, owner) => {
      const r = await cli(tdb.urls.owner, ['up'])
      expect(r.code).toBe(0)
      expect(r.out.at(-1)).toBe(`Dry run: would apply ${ALL.join(', ')}. Re-run with --apply to apply.`)
      expect((await readMigrationState(owner)).applied).toEqual([])
    }))

  it('"up --apply" applies pending migrations once; a second run has nothing to do', () =>
    withDatabase(async (tdb, owner) => {
      const first = await cli(tdb.urls.owner, ['up', '--apply'])
      expect(first).toMatchObject({ code: 0, err: [] })
      expect(first.out).toContain('OK      apply 0001_baseline')
      expect(await readMigrationState(owner)).toEqual({ applied: ALL, pending: [], unknown: [] })

      const second = await cli(tdb.urls.owner, ['up', '--apply'])
      expect(second.code).toBe(0)
      expect(second.out.at(-1)).toBe('Nothing to apply.')
    }))

  it('refuses to run as the runtime role, and applies nothing', () =>
    withDatabase(async (tdb, owner) => {
      const r = await cli(tdb.urls.app, ['up', '--apply'])
      expect(r.code).toBe(1)
      expect(r.err).toEqual(['Refusing: migrations must run as wam_owner, not "wam_app"'])
      expect((await readMigrationState(owner)).applied).toEqual([])
    }))

  it('refuses to run as a superuser (objects would get the wrong owner)', () =>
    withDatabase(async (tdb, owner) => {
      const r = await cli(tdb.urls.superuser, ['up', '--apply'])
      expect(r.code).toBe(1)
      expect(r.err.join('\n')).toMatch(/is a superuser; run migrations as wam_owner/)
      expect((await readMigrationState(owner)).applied).toEqual([])
    }))

  it('refuses "down" when WAM_ENV=production; in development it reverts exactly one migration', () =>
    withDatabase(async (tdb, owner) => {
      expect((await cli(tdb.urls.owner, ['up', '--apply'])).code).toBe(0)

      const prod = await cli(tdb.urls.owner, ['down', '--apply'], { WAM_ENV: 'production' })
      expect(prod.code).toBe(1)
      expect(prod.err[0]).toMatch(/disabled when WAM_ENV=production/)
      expect((await readMigrationState(owner)).applied).toEqual(ALL)

      const dry = await cli(tdb.urls.owner, ['down'], { WAM_ENV: 'development' })
      expect(dry.out.at(-1)).toBe(`Dry run: would revert ${String(ALL.at(-1))}. Re-run with --apply to revert.`)
      expect((await readMigrationState(owner)).applied).toEqual(ALL)

      const real = await cli(tdb.urls.owner, ['down', '--apply'], { WAM_ENV: 'development' })
      expect(real.code).toBe(0)
      expect((await readMigrationState(owner)).pending).toEqual([ALL.at(-1)])
    }))

  it('refuses a database that has a migration this code does not know (database newer than code)', () =>
    withDatabase(async (tdb, owner) => {
      expect((await cli(tdb.urls.owner, ['up', '--apply'])).code).toBe(0)
      await sql`INSERT INTO wam.kysely_migration (name, timestamp) VALUES ('9999_from_the_future', now()::text)`.execute(owner)

      for (const args of [['status'], ['up', '--apply']]) {
        const r = await cli(tdb.urls.owner, args)
        expect(r.code).toBe(1)
        expect(r.out).toContain('Unknown to this code: 9999_from_the_future')
        expect(r.err.at(-1)).toMatch(/does not know/)
      }
    }))

  it.each([[['frobnicate']], [['up', '--force']], [['status', '--apply']], [[]]])(
    'rejects the usage %j with exit code 2 before connecting',
    async (args) => {
      const { io, err } = capture()
      // An unreachable URL: reaching the database would fail differently.
      const code = await runMigrateCli(args, migrationEnv('postgresql://x:y@%2Fnonexistent:5432/none'), io)
      expect(code).toBe(2)
      expect(err[0]).toMatch(/^usage:/)
    }
  )

  it('rejects missing configuration with exit code 2', async () => {
    const { io, err } = capture()
    expect(await runMigrateCli(['status'], {}, io)).toBe(2)
    expect(err[0]).toMatch(/WAM_ENV is required[\s\S]*WAM_MIGRATION_DATABASE_URL is required/)
  })
})

describe('migrator guarantees (PostgreSQL)', () => {
  it('a failing migration rolls back the whole run: nothing from it is recorded or left behind', () =>
    withDatabase(async (_tdb, owner) => {
      const set: Record<string, Migration> = {
        ...migrations,
        '0002_creates_a_table': { up: async (db) => sql`CREATE TABLE wam.rollback_probe (id int)`.execute(db).then(() => undefined) },
        '0003_fails': {
          up: () => Promise.reject(new Error('deliberate failure'))
        }
      }
      const { error } = await createMigrator(owner, set).migrateToLatest()
      expect(error).toBeInstanceOf(Error)
      expect(await readMigrationState(owner, set)).toEqual({ applied: [], pending: Object.keys(set), unknown: [] })
      const { rows } = await sql<{ t: string | null }>`SELECT to_regclass('wam.rollback_probe')::text AS t`.execute(owner)
      expect(rows[0]?.t).toBeNull()
    }))

  it('two concurrent runs apply each migration exactly once', () =>
    withDatabase(async (tdb, owner) => {
      const a = connect(tdb.urls.owner)
      const b = connect(tdb.urls.owner)
      try {
        const results = await Promise.all([createMigrator(a).migrateToLatest(), createMigrator(b).migrateToLatest()])
        expect(results.map((r) => r.error)).toEqual([undefined, undefined])
      } finally {
        await a.destroy()
        await b.destroy()
      }
      const { rows } = await sql<{ name: string; n: number }>`
        SELECT name, count(*)::int AS n FROM wam.kysely_migration GROUP BY name ORDER BY name`.execute(owner)
      expect(rows).toEqual(ALL.map((name) => ({ name, n: 1 })))
    }))
})
