import { describe, expect, it } from 'vitest'
import { ConfigError, describeDatabaseTarget, loadConfig, loadMigrationConfig } from '../../src/config.js'

const PASSWORD = 'S3cret-Pa55word'
const URL_WITH_PASSWORD = `postgresql://wam_app:${PASSWORD}@db.internal:5432/wam`

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn()
  } catch (err) {
    if (err instanceof ConfigError) return err.problems
    throw err
  }
  throw new Error('expected a ConfigError')
}

describe('loadConfig', () => {
  it('accepts a minimal configuration and applies safe defaults', () => {
    expect(loadConfig({ WAM_ENV: 'production', WAM_DATABASE_URL: URL_WITH_PASSWORD })).toEqual({
      environment: 'production',
      http: { host: '127.0.0.1', port: 3000 },
      database: { connectionString: URL_WITH_PASSWORD, poolMax: 10, statementTimeoutMs: 15_000 },
      logLevel: 'info'
    })
  })

  it('reads every optional setting', () => {
    const config = loadConfig({
      WAM_ENV: 'development',
      WAM_DATABASE_URL: URL_WITH_PASSWORD,
      WAM_HTTP_HOST: '0.0.0.0',
      WAM_HTTP_PORT: '8080',
      WAM_DB_POOL_MAX: '20',
      WAM_DB_STATEMENT_TIMEOUT_MS: '5000',
      WAM_LOG_LEVEL: 'debug'
    })
    expect(config.http).toEqual({ host: '0.0.0.0', port: 8080 })
    expect(config.database).toMatchObject({ poolMax: 20, statementTimeoutMs: 5000 })
    expect(config.logLevel).toBe('debug')
  })

  it('has no default environment and no default database: both are required', () => {
    const problems = problemsOf(() => loadConfig({}))
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/^WAM_ENV is required/)
    expect(problems[1]).toMatch(/^WAM_DATABASE_URL is required/)
  })

  it('reports every invalid value at once', () => {
    const problems = problemsOf(() =>
      loadConfig({
        WAM_ENV: 'prod',
        WAM_DATABASE_URL: URL_WITH_PASSWORD,
        WAM_HTTP_PORT: '70000',
        WAM_DB_POOL_MAX: '0',
        WAM_DB_STATEMENT_TIMEOUT_MS: '1e4',
        WAM_LOG_LEVEL: 'verbose'
      })
    )
    expect(problems.map((p) => p.split(' ')[0])).toEqual([
      'WAM_ENV',
      'WAM_HTTP_PORT',
      'WAM_DB_POOL_MAX',
      'WAM_DB_STATEMENT_TIMEOUT_MS',
      'WAM_LOG_LEVEL'
    ])
  })

  it.each([
    ['not a URL', `wam_app:${PASSWORD}@db.internal/wam`, /not a valid URL/],
    ['another scheme', `mysql://wam_app:${PASSWORD}@db.internal/wam`, /must start with postgresql:\/\//],
    ['no database name', `postgresql://wam_app:${PASSWORD}@db.internal:5432/`, /must name a database/]
  ])('rejects a database URL with %s, without echoing the password', (_label, url, expected) => {
    let message = ''
    try {
      loadConfig({ WAM_ENV: 'test', WAM_DATABASE_URL: url })
    } catch (err) {
      message = err instanceof Error ? err.message : ''
    }
    expect(message).toMatch(expected)
    expect(message).not.toContain(PASSWORD)
  })
})

describe('loadMigrationConfig', () => {
  it('reads WAM_MIGRATION_DATABASE_URL, never WAM_DATABASE_URL', () => {
    expect(problemsOf(() => loadMigrationConfig({ WAM_ENV: 'test', WAM_DATABASE_URL: URL_WITH_PASSWORD }))).toEqual([
      expect.stringMatching(/^WAM_MIGRATION_DATABASE_URL is required/)
    ])
  })

  it('uses one connection and no statement timeout', () => {
    const config = loadMigrationConfig({ WAM_ENV: 'test', WAM_MIGRATION_DATABASE_URL: URL_WITH_PASSWORD })
    expect(config.database).toEqual({ connectionString: URL_WITH_PASSWORD, poolMax: 1, statementTimeoutMs: 0 })
  })
})

describe('describeDatabaseTarget', () => {
  it('keeps user, host and database, and drops the password and query string', () => {
    expect(describeDatabaseTarget(`${URL_WITH_PASSWORD}?sslmode=require`)).toBe('postgresql://wam_app@db.internal:5432/wam')
  })

  it('decodes a Unix-socket host', () => {
    expect(describeDatabaseTarget(`postgresql://wam_app:${PASSWORD}@%2Ftmp%2Fsock:5432/wam`)).toBe(
      'postgresql://wam_app@/tmp/sock:5432/wam'
    )
  })

  it('never throws on garbage', () => {
    expect(describeDatabaseTarget('::::')).toBe('(unparseable database URL)')
  })
})
