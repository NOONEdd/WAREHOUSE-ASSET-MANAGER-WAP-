import { describe, expect, it } from 'vitest'
import { ConfigError, describeDatabaseTarget, loadConfig, loadMigrationConfig } from '../../src/config.js'

const PASSWORD = 'S3cret-Pa55word'
const URL_WITH_PASSWORD = `postgresql://wam_app:${PASSWORD}@db.internal:5432/wam`
const ORIGIN = 'https://wam.example'
const MFA_KEY_BYTES = Buffer.alloc(32, 0x5a)
const MFA_KEY = MFA_KEY_BYTES.toString('base64')

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
    expect(
      loadConfig({ WAM_ENV: 'production', WAM_DATABASE_URL: URL_WITH_PASSWORD, WAM_PUBLIC_ORIGIN: ORIGIN, WAM_MFA_ENCRYPTION_KEY: MFA_KEY })
    ).toEqual({
      environment: 'production',
      publicOrigin: ORIGIN,
      http: { host: '127.0.0.1', port: 3000 },
      database: { connectionString: URL_WITH_PASSWORD, poolMax: 10, statementTimeoutMs: 15_000 },
      sessions: { idleMinutes: 30, absoluteHours: 12 },
      mfaEncryptionKey: MFA_KEY_BYTES,
      logLevel: 'info',
      importEnabled: false,
      search: { perUser: 2, total: 5 }
    })
  })

  it('limits name searches to half the pool by default, and refuses limits that could take the whole pool (O-20)', () => {
    const base = { WAM_ENV: 'test', WAM_DATABASE_URL: URL_WITH_PASSWORD, WAM_PUBLIC_ORIGIN: ORIGIN, WAM_MFA_ENCRYPTION_KEY: MFA_KEY }
    expect(loadConfig({ ...base, WAM_DB_POOL_MAX: '4' }).search).toEqual({ perUser: 2, total: 2 })
    expect(loadConfig({ ...base, WAM_DB_POOL_MAX: '1' }).search).toEqual({ perUser: 1, total: 1 })
    expect(loadConfig({ ...base, WAM_SEARCH_MAX_PER_USER: '3', WAM_SEARCH_MAX_TOTAL: '6' }).search).toEqual({ perUser: 3, total: 6 })
    expect(problemsOf(() => loadConfig({ ...base, WAM_SEARCH_MAX_TOTAL: '10' }))).toEqual([
      'WAM_SEARCH_MAX_TOTAL must be smaller than WAM_DB_POOL_MAX, so ordinary requests always find a connection'
    ])
    expect(problemsOf(() => loadConfig({ ...base, WAM_SEARCH_MAX_PER_USER: '4', WAM_SEARCH_MAX_TOTAL: '3' }))).toEqual([
      'WAM_SEARCH_MAX_PER_USER must not exceed WAM_SEARCH_MAX_TOTAL'
    ])
  })

  it('reads every optional setting', () => {
    const config = loadConfig({
      WAM_ENV: 'development',
      WAM_DATABASE_URL: URL_WITH_PASSWORD,
      WAM_PUBLIC_ORIGIN: 'http://localhost:5173',
      WAM_MFA_ENCRYPTION_KEY: MFA_KEY,
      WAM_SESSION_IDLE_MINUTES: '15',
      WAM_SESSION_ABSOLUTE_HOURS: '8',
      WAM_HTTP_HOST: '0.0.0.0',
      WAM_HTTP_PORT: '8080',
      WAM_DB_POOL_MAX: '20',
      WAM_DB_STATEMENT_TIMEOUT_MS: '5000',
      WAM_LOG_LEVEL: 'debug',
      WAM_IMPORT_ENABLED: 'true'
    })
    expect(config.http).toEqual({ host: '0.0.0.0', port: 8080 })
    expect(config.importEnabled).toBe(true)
    expect(config.database).toMatchObject({ poolMax: 20, statementTimeoutMs: 5000 })
    expect(config.logLevel).toBe('debug')
    expect(config.publicOrigin).toBe('http://localhost:5173')
    expect(config.sessions).toEqual({ idleMinutes: 15, absoluteHours: 8 })
  })

  it('has no default environment, database, public origin or MFA key: all four are required', () => {
    const problems = problemsOf(() => loadConfig({}))
    expect(problems).toHaveLength(4)
    expect(problems[0]).toMatch(/^WAM_ENV is required/)
    expect(problems[1]).toMatch(/^WAM_DATABASE_URL is required/)
    expect(problems[2]).toMatch(/^WAM_PUBLIC_ORIGIN is required/)
    expect(problems[3]).toMatch(/^WAM_MFA_ENCRYPTION_KEY is required/)
  })

  it('reports every invalid value at once', () => {
    const problems = problemsOf(() =>
      loadConfig({
        WAM_ENV: 'prod',
        WAM_DATABASE_URL: URL_WITH_PASSWORD,
        WAM_PUBLIC_ORIGIN: ORIGIN,
        WAM_MFA_ENCRYPTION_KEY: MFA_KEY,
        WAM_HTTP_PORT: '70000',
        WAM_DB_POOL_MAX: '0',
        WAM_DB_STATEMENT_TIMEOUT_MS: '1e4',
        WAM_LOG_LEVEL: 'verbose',
        WAM_SESSION_IDLE_MINUTES: '1',
        WAM_SESSION_ABSOLUTE_HOURS: '48',
        WAM_IMPORT_ENABLED: 'yes'
      })
    )
    expect(problems.map((p) => p.split(' ')[0])).toEqual([
      'WAM_ENV',
      'WAM_HTTP_PORT',
      'WAM_DB_POOL_MAX',
      'WAM_DB_STATEMENT_TIMEOUT_MS',
      'WAM_LOG_LEVEL',
      'WAM_SESSION_IDLE_MINUTES',
      'WAM_SESSION_ABSOLUTE_HOURS',
      'WAM_IMPORT_ENABLED'
    ])
  })

  it.each([
    ['not a URL', `wam_app:${PASSWORD}@db.internal/wam`, /not a valid URL/],
    ['another scheme', `mysql://wam_app:${PASSWORD}@db.internal/wam`, /must start with postgresql:\/\//],
    ['no database name', `postgresql://wam_app:${PASSWORD}@db.internal:5432/`, /must name a database/]
  ])('rejects a database URL with %s, without echoing the password', (_label, url, expected) => {
    let message = ''
    try {
      loadConfig({ WAM_ENV: 'test', WAM_DATABASE_URL: url, WAM_PUBLIC_ORIGIN: ORIGIN, WAM_MFA_ENCRYPTION_KEY: MFA_KEY })
    } catch (err) {
      message = err instanceof Error ? err.message : ''
    }
    expect(message).toMatch(expected)
    expect(message).not.toContain(PASSWORD)
  })
})

describe('WAM_MFA_ENCRYPTION_KEY', () => {
  const base = { WAM_ENV: 'production', WAM_DATABASE_URL: URL_WITH_PASSWORD, WAM_PUBLIC_ORIGIN: ORIGIN }

  it.each([
    ['too short', Buffer.alloc(16, 1).toString('base64')],
    ['too long', Buffer.alloc(48, 1).toString('base64')],
    ['not base64', `${'!'.repeat(43)}=`],
    ['hex instead of base64', Buffer.alloc(32, 1).toString('hex')]
  ])('rejects a key that is %s, without echoing it', (_label, value) => {
    const problems = problemsOf(() => loadConfig({ ...base, WAM_MFA_ENCRYPTION_KEY: value }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^WAM_MFA_ENCRYPTION_KEY must be exactly 32 bytes/)
    expect(problems[0]).not.toContain(value)
  })
})

describe('WAM_PUBLIC_ORIGIN', () => {
  const base = { WAM_DATABASE_URL: URL_WITH_PASSWORD, WAM_MFA_ENCRYPTION_KEY: MFA_KEY }

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

  it('uses one connection, no statement timeout, and a bounded lock wait (10 s unless set)', () => {
    const config = loadMigrationConfig({ WAM_ENV: 'test', WAM_MIGRATION_DATABASE_URL: URL_WITH_PASSWORD })
    expect(config.database).toEqual({ connectionString: URL_WITH_PASSWORD, poolMax: 1, statementTimeoutMs: 0, lockTimeoutMs: 10_000 })
    const custom = loadMigrationConfig({ WAM_ENV: 'test', WAM_MIGRATION_DATABASE_URL: URL_WITH_PASSWORD, WAM_MIGRATION_LOCK_TIMEOUT_MS: '2500' })
    expect(custom.database.lockTimeoutMs).toBe(2_500)
    for (const bad of ['0', '-1', '600001', 'soon']) {
      expect(problemsOf(() => loadMigrationConfig({ WAM_ENV: 'test', WAM_MIGRATION_DATABASE_URL: URL_WITH_PASSWORD, WAM_MIGRATION_LOCK_TIMEOUT_MS: bad }))).toEqual([
        expect.stringMatching(/^WAM_MIGRATION_LOCK_TIMEOUT_MS must be a whole number from 100 to 600000/)
      ])
    }
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
