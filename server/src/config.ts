// Runtime configuration for the WAM web server (Phase 1B-1).
//
// Read once at startup from environment variables and validated as a whole:
// every problem is reported together, so a misconfigured deployment fails
// with one complete list instead of one error per restart. No value is ever
// echoed back in an error message — in particular never a database URL,
// which carries a password.

export type AppEnvironment = 'development' | 'test' | 'production'
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'

export interface DatabaseConfig {
  readonly connectionString: string
  readonly poolMax: number
  /** 0 disables the timeout (used only by the migration CLI). */
  readonly statementTimeoutMs: number
  /**
   * How long one statement may wait for a lock before it fails (PostgreSQL lock_timeout). Set only for the
   * migration CLI (finding NF-6); the server's statements are bounded by the statement timeout.
   */
  readonly lockTimeoutMs?: number
}

export interface SessionConfig {
  readonly idleMinutes: number
  readonly absoluteHours: number
}

export interface AppConfig {
  readonly environment: AppEnvironment
  /**
   * The origin users' browsers load the application from, e.g.
   * https://wam.example. Requests that change state must come from it
   * (docs/security/identity-and-access.md §5); https selects the
   * `__Host-` secure session cookie.
   */
  readonly publicOrigin: string
  readonly http: { readonly host: string; readonly port: number }
  readonly database: DatabaseConfig
  readonly sessions: SessionConfig
  /**
   * 32 bytes that encrypt authenticator secrets at rest
   * (docs/security/identity-and-access.md §3.2.2). Kept outside the
   * database, and backed up separately from it.
   */
  readonly mfaEncryptionKey: Buffer
  readonly logLevel: LogLevel
  /**
   * Whether the staged-import routes exist (decision O-16). Off by default, and
   * to stay off until gates G-2…G-9 pass and O-14 admits real spreadsheets.
   */
  readonly importEnabled: boolean
  /** Name searches running at once (decision O-20; src/http/searchLimiter.ts). */
  readonly search: { readonly perUser: number; readonly total: number }
}

export interface MigrationConfig {
  readonly environment: AppEnvironment
  readonly database: DatabaseConfig
}

export type Env = Readonly<Record<string, string | undefined>>

export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

const ENVIRONMENTS: readonly AppEnvironment[] = ['development', 'test', 'production']
const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']
const SWITCH: readonly ('true' | 'false')[] = ['true', 'false']

/** Configuration for the HTTP server process (`npm start`). */
export function loadConfig(env: Env): AppConfig {
  const problems: string[] = []
  const environment = readEnum(env, 'WAM_ENV', ENVIRONMENTS, undefined, problems)
  // Loopback by default: in production the server sits behind a reverse
  // proxy on the same machine and must not be reachable directly.
  const host = readString(env, 'WAM_HTTP_HOST') ?? '127.0.0.1'
  const port = readInteger(env, 'WAM_HTTP_PORT', 3000, 0, 65535, problems)
  const connectionString = readDatabaseUrl(env, 'WAM_DATABASE_URL', problems)
  const poolMax = readInteger(env, 'WAM_DB_POOL_MAX', 10, 1, 100, problems)
  const statementTimeoutMs = readInteger(env, 'WAM_DB_STATEMENT_TIMEOUT_MS', 15_000, 100, 600_000, problems)
  const logLevel = readEnum(env, 'WAM_LOG_LEVEL', LOG_LEVELS, 'info', problems)
  const publicOrigin = readOrigin(env, 'WAM_PUBLIC_ORIGIN', environment, problems)
  const idleMinutes = readInteger(env, 'WAM_SESSION_IDLE_MINUTES', 30, 5, 240, problems)
  const absoluteHours = readInteger(env, 'WAM_SESSION_ABSOLUTE_HOURS', 12, 1, 24, problems)
  const mfaEncryptionKey = readKey(env, 'WAM_MFA_ENCRYPTION_KEY', problems)
  const importEnabled = readEnum(env, 'WAM_IMPORT_ENABLED', SWITCH, 'false', problems) === 'true'
  // Searches may use at most half the pool (5 of the default 10), so ordinary requests always find a connection.
  const searchTotal = readInteger(env, 'WAM_SEARCH_MAX_TOTAL', Math.max(1, Math.min(5, Math.floor(poolMax / 2))), 1, 100, problems)
  const searchPerUser = readInteger(env, 'WAM_SEARCH_MAX_PER_USER', Math.min(2, searchTotal), 1, 20, problems)
  if (searchPerUser > searchTotal) problems.push('WAM_SEARCH_MAX_PER_USER must not exceed WAM_SEARCH_MAX_TOTAL')
  if (poolMax > 1 && searchTotal >= poolMax) {
    problems.push('WAM_SEARCH_MAX_TOTAL must be smaller than WAM_DB_POOL_MAX, so ordinary requests always find a connection')
  }

  if (
    environment === undefined ||
    connectionString === undefined ||
    logLevel === undefined ||
    publicOrigin === undefined ||
    mfaEncryptionKey === undefined ||
    problems.length > 0
  ) {
    throw new ConfigError(problems)
  }
  return {
    environment,
    publicOrigin,
    http: { host, port },
    database: { connectionString, poolMax, statementTimeoutMs },
    sessions: { idleMinutes, absoluteHours },
    mfaEncryptionKey,
    logLevel,
    importEnabled,
    search: { perUser: searchPerUser, total: searchTotal }
  }
}

/**
 * Configuration for the migration CLI (`npm run db:migrate`). It reads a
 * separate URL because migrations run as the schema-owning role, which the
 * HTTP server must never use (see src/db/safety.ts).
 */
export function loadMigrationConfig(env: Env): MigrationConfig {
  const problems: string[] = []
  const environment = readEnum(env, 'WAM_ENV', ENVIRONMENTS, undefined, problems)
  const connectionString = readDatabaseUrl(env, 'WAM_MIGRATION_DATABASE_URL', problems)
  const lockTimeoutMs = readInteger(env, 'WAM_MIGRATION_LOCK_TIMEOUT_MS', 10_000, 100, 600_000, problems)

  if (environment === undefined || connectionString === undefined || problems.length > 0) {
    throw new ConfigError(problems)
  }
  // One connection, no statement timeout: a migration is a single
  // transaction that may legitimately run longer than a request. But its
  // LOCK TABLE statements wait at most lockTimeoutMs: a migration queued
  // behind an open transaction would otherwise hold its place in the lock
  // queue and stall every later query on those tables (finding NF-6). On
  // timeout the whole run rolls back and can simply be retried.
  return { environment, database: { connectionString, poolMax: 1, statementTimeoutMs: 0, lockTimeoutMs } }
}

/**
 * A log-safe description of a database URL: scheme, user, host and database,
 * never the password or query parameters.
 */
export function describeDatabaseTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString)
    const user = url.username === '' ? '' : `${decodeURIComponent(url.username)}@`
    return `${url.protocol}//${user}${decodeURIComponent(url.host)}${url.pathname}`
  } catch {
    return '(unparseable database URL)'
  }
}

function readString(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function readEnum<T extends string>(
  env: Env,
  name: string,
  allowed: readonly T[],
  fallback: T | undefined,
  problems: string[]
): T | undefined {
  const raw = readString(env, name)
  if (raw === undefined) {
    if (fallback === undefined) problems.push(`${name} is required (one of: ${allowed.join(', ')})`)
    return fallback
  }
  const match = allowed.find((value) => value === raw)
  if (match === undefined) problems.push(`${name} must be one of: ${allowed.join(', ')}`)
  return match
}

function readInteger(env: Env, name: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = readString(env, name)
  if (raw === undefined) return fallback
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    problems.push(`${name} must be a whole number from ${String(min)} to ${String(max)}`)
    return fallback
  }
  return value
}

function readOrigin(
  env: Env,
  name: string,
  environment: AppEnvironment | undefined,
  problems: string[]
): string | undefined {
  const raw = readString(env, name)
  if (raw === undefined) {
    problems.push(`${name} is required (the address users open, e.g. https://wam.example)`)
    return undefined
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    problems.push(`${name} is not a valid URL`)
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    problems.push(`${name} must start with https:// or http://`)
    return undefined
  }
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    problems.push(`${name} must be an origin only: scheme, host and optional port, no path`)
    return undefined
  }
  // Plain http cannot carry a Secure cookie; it is allowed for local
  // development and tests only.
  if (url.protocol === 'http:' && environment === 'production') {
    problems.push(`${name} must use https:// when WAM_ENV=production`)
    return undefined
  }
  return url.origin
}

/** 32 random bytes, base64-encoded. The value is never echoed in a message. */
function readKey(env: Env, name: string, problems: string[]): Buffer | undefined {
  const raw = readString(env, name)
  const generate = `generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  if (raw === undefined) {
    problems.push(`${name} is required (32 random bytes, base64; ${generate})`)
    return undefined
  }
  const key = /^[A-Za-z0-9+/]{43}=$/.test(raw) ? Buffer.from(raw, 'base64') : null
  if (key?.length !== 32) {
    problems.push(`${name} must be exactly 32 bytes, base64-encoded (44 characters ending in "="; ${generate})`)
    return undefined
  }
  return key
}

function readDatabaseUrl(env: Env, name: string, problems: string[]): string | undefined {
  const raw = readString(env, name)
  if (raw === undefined) {
    problems.push(`${name} is required (postgresql://USER:PASSWORD@HOST:PORT/DATABASE)`)
    return undefined
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // Deliberately not including the value: it contains a password.
    problems.push(`${name} is not a valid URL`)
    return undefined
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    problems.push(`${name} must start with postgresql:// or postgres://`)
    return undefined
  }
  if (url.pathname.length <= 1) {
    problems.push(`${name} must name a database (…/DATABASE at the end)`)
    return undefined
  }
  return raw
}
