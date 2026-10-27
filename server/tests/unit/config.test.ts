import { describe, expect, it } from 'vitest'
import { ConfigError, describeDatabaseTarget, loadConfig, loadMigrationConfig } from '../../src/config.js'

const PASSWORD = 'S3cret-Pa55word'
const URL_WITH_PASSWORD = `postgresql://wam_app:${PASSWORD}@db.internal:5432/wam`
const ORIGIN = 'https://wam.example'

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
    expect(loadConfig({ WAM_ENV: 'production', WAM_DATABASE_URL: URL_WITH_PASSWORD, WAM_PUBLIC_ORIGIN: ORIGIN })).toEqual({
      environment: 'production',
      publicOrigin: ORIGIN,
      http: { host: '127.0.0.1', port: 3000 },
      database: { connectionString: URL_WITH_PASSWORD, poolMax: 10, statementTimeoutMs: 15_000 },
      sessions: { idleMinutes: 30, absoluteHours: 12 },
      logLevel: 'info'
    })
  })

  it('reads every optional setting', () => {
    const config = loadConfig({
      WAM_ENV: 'development',
      WAM_DATABASE_URL: URL_WITH_PASSWORD,
      WAM_PUBLIC_ORIGIN: 'http://localhost:5173',
      WAM_SESSION_IDLE_MINUTES: '15',
      WAM_SESSION_ABSOLUTE_HOURS: '8',
      WAM_HTTP_HOST: '0.0.0.0',
      WAM_HTTP_PORT: '8080',
      WAM_DB_POOL_MAX: '20',
      WAM_DB_STATEMENT_TIMEOUT_MS: '5000',
      WAM_LOG_LEVEL: 'debug'
    })
    expect(config.http).toEqual({ host: '0.0.0.0', port: 8080 })
    expect(config.database).toMatchObject({ poolMax: 20, statementTimeoutMs: 5000 })
    expect(config.logLevel).toBe('debug')
    expect(config.publicOrigin).toBe('http://localhost:5173')
    expect(config.sessions).toEqual({ idleMinutes: 15, absoluteHours: 8 })
  })

  it('has no default environment, database or public origin: all three are required', () => {
    const problems = problemsOf(() => loadConfig({}))
    expect(problems).toHaveLength(3)
    expect(problems[0]).toMatch(/^WAM_ENV is required/)
    expect(problems[1]).toMatch(/^WAM_DATABASE_URL is required/)
    expect(problems[2]).toMatch(/^WAM_PUBLIC_ORIGIN is required/)
  })

  it('reports every invalid value at once', () => {
    const problems = problemsOf(() =>
      loadConfig({
        WAM_ENV: 'prod',
        WAM_DATABASE_URL: URL_WITH_PASSWORD,
        WAM_PUBLIC_ORIGIN: ORIGIN,
        WAM_HTTP_PORT: '70000',
        WAM_DB_POOL_MAX: '0',
        WAM_DB_STATEMENT_TIMEOUT_MS: '1e4',
        WAM_LOG_LEVEL: 'verbose',
        WAM_SESSION_IDLE_MINUTES: '1',
        WAM_SESSION_ABSOLUTE_HOURS: '48'
      })
    )
    expect(problems.map((p) => p.split(' ')[0])).toEqual([
      'WAM_ENV',
      'WAM_HTTP_PORT',
      'WAM_DB_POOL_MAX',
      'WAM_DB_STATEMENT_TIMEOUT_MS',
      'WAM_LOG_LEVEL',
      'WAM_SESSION_IDLE_MINUTES',
      'WAM_SESSION_ABSOLUTE_HOURS'
    ])
  })

  it.each([
    ['not a URL', `wam_app:${PASSWORD}@db.internal/wam`, /not a valid URL/],
    ['another scheme', `mysql://wam_app:${PASSWORD}@db.internal/wam`, /must start with postgresql:\/\//],
    ['no database name', `postgresql://wam_app:${PASSWORD}@db.internal:5432/`, /must name a database/]
  ])('rejects a database URL with %s, without echoing the password', (_label, url, expected) => {
    let message = ''
    try {
      loadConfig({ WAM_ENV: 'test', WAM_DATABASE_URL: url, WAM_PUBLIC_ORIGIN: ORIGIN })
    } catch (err) {
      message = err instanceof Error ? err.message : ''
    }
    expect(message).toMatch(expected)
    expect(message).not.toContain(PASSWORD)
  })
})

describe('WAM_PUBLIC_ORIGIN', () => {
  const base = { WAM_DATABASE_URL: URL_WITH_PASSWORD }

  it('is normalized to the bare origin', () => {
    expect(loadConfig({ ...base, WAM_ENV: 'production', WAM_PUBLIC_ORIGIN: 'https://WAM.Example:443' }).publicOrigin).toBe(
      'https://wam.example'
    )
  })

  it('must be https in production — a Secure cookie is impossible over http', () => {
    expect(problemsOf(() => loadConfig({ ...base, WAM_ENV: 'production', WAM_PUBLIC_ORIGIN: 'http://wam.example' }))).toEqual([
      'WAM_PUBLIC_ORIGIN must use https:// when WAM_ENV=production'
    ])
  })

  it('may be http for development and tests', () => {
    expect(loadConfig({ ...base, WAM_ENV: 'development', WAM_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' }).publicOrigin).toBe(
      'http://127.0.0.1:3000'
    )
  })

  it.each(['https://wam.example/app', 'https://wam.example/?x=1', 'https://user:pw@wam.example', 'ftp://wam.example', 'wam.example'])(
    'rejects %s',
    (value) => {
      expect(problemsOf(() => loadConfig({ ...base, WAM_ENV: 'test', WAM_PUBLIC_ORIGIN: value }))).toHaveLength(1)
    }
  )
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
