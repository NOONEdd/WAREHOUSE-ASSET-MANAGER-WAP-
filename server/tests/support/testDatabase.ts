import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { inject } from 'vitest'
import type { Env } from '../../src/config.js'
import { createDatabase, createPool, type Database } from '../../src/db/connection.js'
import { assertEphemeralTestCluster, connectionUrl, runPsql, SQL_DIR, SUPERUSER, type ClusterInfo } from './ephemeralPostgres.js'

export interface TestDatabase {
  readonly name: string
  readonly urls: { readonly superuser: string; readonly owner: string; readonly app: string }
  drop(): Promise<void>
}

export function clusterInfo(): ClusterInfo {
  return inject('wamPostgres')
}

function urlsFor(info: ClusterInfo, database: string): TestDatabase['urls'] {
  return {
    superuser: connectionUrl(info, SUPERUSER, info.passwords.superuser, database),
    owner: connectionUrl(info, 'wam_owner', info.passwords.owner, database),
    app: connectionUrl(info, 'wam_app', info.passwords.app, database)
  }
}

/** A new, empty database in the throwaway cluster, set up with the real server/sql/create-database.sql. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const info = clusterInfo()
  await assertEphemeralTestCluster(urlsFor(info, 'postgres').superuser, info.token)
  const name = `wam_test_${randomBytes(6).toString('hex')}`
  await runPsql(info, 'postgres', ['-v', `dbname=${name}`, '-f', join(SQL_DIR, 'create-database.sql')])
  return {
    name,
    urls: urlsFor(info, name),
    drop: () => runPsql(info, 'postgres', ['-c', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`])
  }
}

/** A small pool for direct queries in a test; destroy it in afterAll/finally. */
export function connect(url: string): Kysely<Database> {
  return createDatabase(createPool({ connectionString: url, poolMax: 2, statementTimeoutMs: 10_000 }, () => undefined))
}

export function serverEnv(url: string, overrides: Env = {}): Env {
  return { WAM_ENV: 'test', WAM_DATABASE_URL: url, WAM_HTTP_PORT: '0', WAM_LOG_LEVEL: 'silent', ...overrides }
}

export function migrationEnv(url: string, overrides: Env = {}): Env {
  return { WAM_ENV: 'test', WAM_MIGRATION_DATABASE_URL: url, ...overrides }
}
