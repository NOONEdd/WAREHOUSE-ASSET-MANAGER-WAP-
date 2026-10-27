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
}

export interface AppConfig {
  readonly environment: AppEnvironment
  readonly http: { readonly host: string; readonly port: number }
  readonly database: DatabaseConfig
  readonly logLevel: LogLevel
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

  if (environment === undefined || connectionString === undefined || logLevel === undefined || problems.length > 0) {
    throw new ConfigError(problems)
  }
  return {
    environment,
    http: { host, port },
    database: { connectionString, poolMax, statementTimeoutMs },
    logLevel
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

  if (environment === undefined || connectionString === undefined || problems.length > 0) {
    throw new ConfigError(problems)
  }
  // One connection, no statement timeout: a migration is a single
  // transaction that may legitimately run longer than a request.
  return { environment, database: { connectionString, poolMax: 1, statementTimeoutMs: 0 } }
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
