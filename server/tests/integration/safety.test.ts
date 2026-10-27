import { randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '../../src/db/connection.js'
import { createMigrator } from '../../src/db/migrator.js'
import { assertDatabaseReadyForServer, DatabaseNotReadyError } from '../../src/db/safety.js'
import { connectionUrl } from '../support/ephemeralPostgres.js'
import { clusterInfo, connect, createTestDatabase, type TestDatabase } from '../support/testDatabase.js'

// The server's startup gate (src/db/safety.ts) against real roles. Each
// negative case is a role a careless deployment could plausibly configure.

let tdb: TestDatabase
let owner: Kysely<Database>
let superuser: Kysely<Database>

beforeAll(async () => {
  tdb = await createTestDatabase()
  owner = connect(tdb.urls.owner)
  superuser = connect(tdb.urls.superuser)
})

afterAll(async () => {
  await owner.destroy()
  await superuser.destroy()
  await tdb.drop()
})

async function readinessProblems(url: string): Promise<readonly string[]> {
  const db = connect(url)
  try {
    await assertDatabaseReadyForServer(db)
    return []
  } catch (err) {
    if (err instanceof DatabaseNotReadyError) return err.problems
    throw err
  } finally {
    await db.destroy()
  }
}

describe('before migrations are applied', () => {
  it('refuses to start: the schema is missing migrations', async () => {
    expect(await readinessProblems(tdb.urls.app)).toEqual([
      'the database is missing migration(s) 0001_baseline; run "npm run db:migrate -- up --apply" as wam_owner'
    ])
  })
})

describe('after migrations are applied', () => {
  beforeAll(async () => {
    const { error } = await createMigrator(owner).migrateToLatest()
    expect(error).toBeUndefined()
  })

  it('accepts the runtime role wam_app', async () => {
    expect(await readinessProblems(tdb.urls.app)).toEqual([])
  })

  it('refuses the migration role (it owns the schema)', async () => {
    expect(await readinessProblems(tdb.urls.owner)).toContain(
      'role "wam_owner" owns schema wam: the server must not use the migration role'
    )
  })

  it('refuses a superuser', async () => {
    expect(await readinessProblems(tdb.urls.superuser)).toContain('role "wam_test_superuser" is a superuser')
  })

  it.each([
    ['BYPASSRLS', '', /has BYPASSRLS/],
    ['CREATEDB', '', /can create databases/],
    ['CREATEROLE', '', /can create roles/],
    ['', 'GRANT CREATE ON SCHEMA wam TO', /can create objects in schema wam/],
    ['', 'GRANT CREATE ON DATABASE {db} TO', /can create schemas in this database/],
    ['', 'GRANT USAGE, CREATE ON SCHEMA public TO', /can create objects in schema public/]
  ])('refuses an otherwise-correct role with %s %s', async (attribute, grant, expected) => {
    const role = `wam_test_role_${randomBytes(4).toString('hex')}`
    const password = randomBytes(16).toString('hex')
    await sql.raw(`CREATE ROLE ${role} LOGIN ${attribute} PASSWORD '${password}'`).execute(superuser)
    try {
      // Everything wam_app has, so the attribute/grant under test is the only problem.
      await sql.raw(`GRANT CONNECT ON DATABASE "${tdb.name}" TO ${role}`).execute(superuser)
      await sql.raw(`GRANT USAGE ON SCHEMA wam TO ${role}; GRANT SELECT ON wam.kysely_migration TO ${role}`).execute(superuser)
      if (grant !== '') await sql.raw(`${grant.replace('{db}', `"${tdb.name}"`)} ${role}`).execute(superuser)

      const problems = await readinessProblems(connectionUrl(clusterInfo(), role, password, tdb.name))
      expect(problems).toHaveLength(1)
      expect(problems[0]).toMatch(expected)
    } finally {
      await sql.raw(`DROP OWNED BY ${role}; DROP ROLE ${role}`).execute(superuser)
    }
  })

  it('wam_app really cannot change the schema', async () => {
    const app = connect(tdb.urls.app)
    try {
      for (const ddl of ['CREATE TABLE wam.intruder (id int)', 'CREATE TABLE public.intruder (id int)', 'CREATE SCHEMA intruder']) {
        await expect(sql.raw(ddl).execute(app), ddl).rejects.toMatchObject({ code: '42501' })
      }
    } finally {
      await app.destroy()
    }
  })

  it('pooled connections resolve unqualified names only in schema wam', async () => {
    const app = connect(tdb.urls.app)
    try {
      const { rows } = await sql<{ search_path: string }>`SHOW search_path`.execute(app)
      expect(rows[0]?.search_path).toBe('wam')
    } finally {
      await app.destroy()
    }
  })

  it('refuses to start against a database migrated by a newer server version', async () => {
    await sql`INSERT INTO wam.kysely_migration (name, timestamp) VALUES ('9999_from_the_future', now()::text)`.execute(owner)
    try {
      expect(await readinessProblems(tdb.urls.app)).toEqual([
        'the database has migration(s) this server version does not know (9999_from_the_future); deploy the matching server version'
      ])
    } finally {
      await sql`DELETE FROM wam.kysely_migration WHERE name = '9999_from_the_future'`.execute(owner)
    }
  })

  it('refuses to start when wam_app cannot read the migration history', async () => {
    await sql`REVOKE SELECT ON wam.kysely_migration FROM wam_app`.execute(owner)
    try {
      expect(await readinessProblems(tdb.urls.app)).toEqual([
        'role cannot read the migration history; has migration 0001_baseline been applied?'
      ])
    } finally {
      await sql`GRANT SELECT ON wam.kysely_migration TO wam_app`.execute(owner)
    }
  })
})
