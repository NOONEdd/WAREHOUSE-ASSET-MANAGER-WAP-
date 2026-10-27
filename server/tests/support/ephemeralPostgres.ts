import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'

// A private PostgreSQL cluster for one test run. It is created from nothing
// in a fresh temporary directory and deleted afterwards, so the tests can
// never touch a real database:
//
//   - it listens on NO TCP port, only on a Unix socket inside a 0700 directory
//     that only the current OS user can enter;
//   - every role has a random password generated for this run;
//   - it carries a random per-run token (setting wam.ephemeral_test_cluster);
//     assertEphemeralTestCluster() refuses any connection that does not
//     present it, so even a wrongly built URL cannot reach another server;
//   - nothing is read from the environment except PATH and, optionally,
//     WAM_TEST_PG_BINDIR (where the PostgreSQL programs are).
//
// It needs PostgreSQL's server programs (initdb, pg_ctl, postgres, psql) but
// no PostgreSQL service: on Debian/Ubuntu the packaged service may stay stopped.

const run = promisify(execFile)

export const SUPERUSER = 'wam_test_superuser'
/** Only names the socket file (.s.PGSQL.5432); there is no TCP listener. */
export const PORT = 5432
export const TOKEN_SETTING = 'wam.ephemeral_test_cluster'
export const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql')

export interface ClusterInfo {
  readonly bindir: string
  readonly socketDir: string
  readonly port: number
  readonly token: string
  readonly passwords: { readonly superuser: string; readonly owner: string; readonly app: string }
}

export interface EphemeralCluster extends ClusterInfo {
  /** Stops the cluster and deletes its directory. Safe to call more than once. */
  readonly stop: () => Promise<void>
}

export function assertNotRoot(uid: number | undefined = process.getuid?.()): void {
  if (uid === 0) {
    throw new Error('PostgreSQL refuses to run as root. Run the server tests as a normal (non-root) user.')
  }
}

const REQUIRED_PROGRAMS = ['initdb', 'pg_ctl', 'postgres', 'psql']

export function findPostgresBindir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.WAM_TEST_PG_BINDIR
  const candidates = explicit === undefined ? [...debianBindirs(), ...(env.PATH ?? '').split(delimiter)] : [explicit]
  const found = candidates.find((dir) => dir !== '' && REQUIRED_PROGRAMS.every((p) => existsSync(join(dir, p))))
  if (found !== undefined) return found
  throw new Error(
    explicit === undefined
      ? 'PostgreSQL server programs (initdb, pg_ctl, postgres, psql) were not found. Install PostgreSQL 16 or later ' +
          '(Debian/Ubuntu: sudo apt install postgresql) or set WAM_TEST_PG_BINDIR. See server/README.md.'
      : `WAM_TEST_PG_BINDIR=${explicit} does not contain ${REQUIRED_PROGRAMS.join(', ')}`
  )
}

/** Debian/Ubuntu install each major under /usr/lib/postgresql/<major>/bin; newest first. */
function debianBindirs(): string[] {
  const root = '/usr/lib/postgresql'
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(b) - Number(a))
    .map((major) => join(root, major, 'bin'))
}

/** Children get a minimal environment: no PG* variables, no locale surprises. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C', ...extra }
}

function secret(): string {
  return randomBytes(24).toString('hex')
}

export function connectionUrl(info: ClusterInfo, user: string, password: string, database: string): string {
  // The socket directory is the URL's host, percent-encoded. This form has
  // no "localhost" a parser could fall back to (see server/README.md).
  return `postgresql://${user}:${encodeURIComponent(password)}@${encodeURIComponent(info.socketDir)}:${String(info.port)}/${database}`
}

export async function runPsql(info: ClusterInfo, database: string, args: readonly string[]): Promise<void> {
  await run(
    join(info.bindir, 'psql'),
    ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', info.socketDir, '-p', String(info.port), '-U', SUPERUSER, '-d', database, ...args],
    { env: childEnv({ PGPASSWORD: info.passwords.superuser }) }
  )
}

/** Throws unless `connectionString` reaches the cluster that carries `expectedToken`. */
export async function assertEphemeralTestCluster(connectionString: string, expectedToken: string): Promise<void> {
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    const { rows } = await client.query<{ token: string | null }>('SELECT current_setting($1, true) AS token', [TOKEN_SETTING])
    if (rows[0]?.token !== expectedToken) {
      throw new Error('Refusing to use this database: it is not the throwaway cluster started by this test run.')
    }
  } finally {
    await client.end()
  }
}

export async function startEphemeralCluster(): Promise<EphemeralCluster> {
  assertNotRoot()
  const bindir = findPostgresBindir()
  const base = mkdtempSync(join(tmpdir(), 'wampg-'))
  const dataDir = join(base, 'data')
  const socketDir = join(base, 'sock')
  const logFile = join(base, 'postgres.log')
  const info: ClusterInfo = {
    bindir,
    socketDir,
    port: PORT,
    token: secret(),
    passwords: { superuser: secret(), owner: secret(), app: secret() }
  }

  let started = false
  const stop = async (): Promise<void> => {
    if (started) {
      started = false
      await run(join(bindir, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { env: childEnv() }).catch(
        () => undefined
      )
    }
    rmSync(base, { recursive: true, force: true })
  }

  try {
    // postgresql.conf quotes the path below, and Unix socket paths are
    // limited to about 100 bytes; refuse anything unusual rather than escape it.
    if (!/^[\w./-]+$/.test(socketDir) || Buffer.byteLength(join(socketDir, `.s.PGSQL.${String(PORT)}`)) > 100) {
      throw new Error(`the temporary directory path is unusable for a socket: ${socketDir}`)
    }
    mkdirSync(socketDir, { mode: 0o700 })

    const pwfile = join(base, 'pwfile')
    writeFileSync(pwfile, info.passwords.superuser, { mode: 0o600 })
    await run(
      join(bindir, 'initdb'),
      ['-D', dataDir, '-U', SUPERUSER, `--pwfile=${pwfile}`, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C', '--no-instructions'],
      { env: childEnv() }
    )
    rmSync(pwfile)

    appendFileSync(
      join(dataDir, 'postgresql.conf'),
      [
        '',
        '# --- WAM ephemeral test cluster (server/tests/support/ephemeralPostgres.ts) ---',
        "listen_addresses = ''",
        `unix_socket_directories = '${socketDir}'`,
        `port = ${String(PORT)}`,
        // Durability is irrelevant for a cluster deleted after the run.
        'fsync = off',
        'synchronous_commit = off',
        'full_page_writes = off',
        `${TOKEN_SETTING} = '${info.token}'`,
        ''
      ].join('\n')
    )
    await run(join(bindir, 'pg_ctl'), ['-D', dataDir, '-l', logFile, '-w', '-t', '60', 'start'], { env: childEnv() })
    started = true

    // The same role script an administrator runs on a real server.
    await runPsql(info, 'postgres', ['-f', join(SQL_DIR, 'create-roles.sql')])
    const client = new pg.Client({ connectionString: connectionUrl(info, SUPERUSER, info.passwords.superuser, 'postgres') })
    await client.connect()
    try {
      await client.query(`ALTER ROLE wam_owner PASSWORD ${client.escapeLiteral(info.passwords.owner)}`)
      await client.query(`ALTER ROLE wam_app PASSWORD ${client.escapeLiteral(info.passwords.app)}`)
    } finally {
      await client.end()
    }
    return { ...info, stop }
  } catch (err) {
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-2_000) : ''
    await stop()
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Could not start the throwaway PostgreSQL test cluster: ${message}${log === '' ? '' : `\n--- postgres.log (end) ---\n${log}`}`,
      { cause: err }
    )
  }
}
