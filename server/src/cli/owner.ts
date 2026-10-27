import { userInfo } from 'node:os'
import { sql, type Kysely } from 'kysely'
import { recordAudit, type AuditContext } from '../audit/audit.js'
import { checkUsername } from '../auth/passwordPolicy.js'
import { revokeUserSessions } from '../auth/sessions.js'
import { issueSetupCode, SETUP_CODE_TTL_HOURS } from '../auth/setupCodes.js'
import { clearLoginFailures } from '../auth/throttle.js'
import { ConfigError, describeDatabaseTarget, loadMigrationConfig, type Env } from '../config.js'
import { createDatabase, createPool, type Database } from '../db/connection.js'
import { readMigrationState } from '../db/migrator.js'
import { checkMigrationRole } from '../db/safety.js'
import type { CliIo } from './migrate.js'

// The owner CLI (docs/security/identity-and-access.md §1). The only way to
// create, recover or transfer the owner account. It runs with the migration
// credentials (WAM_MIGRATION_DATABASE_URL, role wam_owner) because the web
// server's own role cannot write users.is_owner at all — so a compromised
// web server cannot make itself the owner. Every command is audited.
//
//   status                                         read-only
//   bootstrap --username U --display-name "N"      first owner; refused if an owner exists
//   recover --yes                                  new setup code for the owner; ends the owner's sessions
//   transfer --to U --yes                          makes user U the owner
//   end-all-sessions --yes                         signs everyone out (incident response)

export const OWNER_USAGE = [
  'usage: npm run owner -- status',
  '       npm run owner -- bootstrap --username <name> --display-name "<full name>"',
  '       npm run owner -- recover --yes',
  '       npm run owner -- transfer --to <username> --yes',
  '       npm run owner -- end-all-sessions --yes'
].join('\n')

interface Parsed {
  readonly command: string
  readonly values: ReadonlyMap<string, string>
  readonly yes: boolean
}

const VALUE_FLAGS = new Set(['--username', '--display-name', '--to'])

function parse(args: readonly string[]): Parsed | null {
  const [command, ...rest] = args
  if (command === undefined) return null
  const values = new Map<string, string>()
  let yes = false
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] ?? ''
    if (flag === '--yes') yes = true
    else if (VALUE_FLAGS.has(flag) && rest[i + 1] !== undefined && !values.has(flag)) {
      values.set(flag, rest[i + 1] ?? '')
      i += 1
    } else return null
  }
  return { command, values, yes }
}

const EXPECTED: Readonly<Record<string, { readonly values: readonly string[]; readonly yes: boolean }>> = {
  status: { values: [], yes: false },
  bootstrap: { values: ['--username', '--display-name'], yes: false },
  recover: { values: [], yes: true },
  transfer: { values: ['--to'], yes: true },
  'end-all-sessions': { values: [], yes: true }
}

function osUser(): string {
  try {
    return userInfo().username
  } catch {
    return 'unknown'
  }
}

const CLI_CONTEXT: AuditContext = { requestId: null, sourceIp: null }

function printSetupCode(io: CliIo, username: string, code: string): void {
  io.out('')
  io.out(`One-time setup code for "${username}":`)
  io.out('')
  io.out(`    ${code}`)
  io.out('')
  io.out(`It works once and expires in ${String(SETUP_CODE_TTL_HOURS)} hours. Hand it over in person or by phone,`)
  io.out('never by e-mail or chat. It is shown only now; the database keeps only a hash of it.')
  io.out('On the sign-in page choose "Set password with a setup code".')
}

export async function runOwnerCli(args: readonly string[], env: Env, io: CliIo): Promise<number> {
  const parsed = parse(args)
  const expected = parsed === null ? undefined : EXPECTED[parsed.command]
  if (
    parsed === null ||
    expected === undefined ||
    parsed.values.size !== expected.values.length ||
    !expected.values.every((flag) => parsed.values.has(flag))
  ) {
    io.err(OWNER_USAGE)
    return 2
  }
  if (expected.yes && !parsed.yes) {
    io.err(`"${parsed.command}" changes the owner's access; re-run with --yes to confirm.`)
    return 2
  }

  let config
  try {
    config = loadMigrationConfig(env)
  } catch (err) {
    if (err instanceof ConfigError) {
      io.err(err.message)
      return 2
    }
    throw err
  }

  const db = createDatabase(
    createPool(config.database, (e) => {
      io.err(`database connection error: ${e.message}`)
    })
  )
  try {
    io.out(`Target: ${describeDatabaseTarget(config.database.connectionString)} (WAM_ENV=${config.environment})`)
    const problems = await checkMigrationRole(db)
    const state = await readMigrationState(db)
    if (state.pending.length > 0 || state.unknown.length > 0) problems.push('the database schema does not match this code; run the migrations first')
    if (problems.length > 0) {
      for (const p of problems) io.err(`Refusing: ${p}`)
      return 1
    }
    switch (parsed.command) {
      case 'status':
        return await status(db, io)
      case 'bootstrap':
        return await bootstrap(db, io, parsed.values.get('--username') ?? '', parsed.values.get('--display-name') ?? '')
      case 'recover':
        return await recover(db, io)
      case 'transfer':
        return await transfer(db, io, parsed.values.get('--to') ?? '')
      default:
        return await endAllSessions(db, io)
    }
  } finally {
    await db.destroy()
  }
}

async function status(db: Kysely<Database>, io: CliIo): Promise<number> {
  const owner = await db.selectFrom('users').select('username').where('is_owner', '=', true).executeTakeFirst()
  const users = await db
    .selectFrom('users')
    .select([sql<number>`count(*) FILTER (WHERE status = 'active')::int`.as('active'), sql<number>`count(*)::int`.as('total')])
    .executeTakeFirstOrThrow()
  const sessions = await db
    .selectFrom('sessions')
    .select(sql<number>`count(*)::int`.as('live'))
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .executeTakeFirstOrThrow()
  io.out(`Owner: ${owner === undefined ? '(none — run "bootstrap")' : owner.username}`)
  io.out(`Users: ${String(users.active)} active of ${String(users.total)}`)
  io.out(`Unexpired sessions: ${String(sessions.live)}`)
  return 0
}

async function bootstrap(db: Kysely<Database>, io: CliIo, usernameInput: string, displayNameInput: string): Promise<number> {
  const username = usernameInput.trim().toLowerCase()
  const displayName = displayNameInput.trim()
  const usernameProblem = checkUsername(username)
  if (usernameProblem !== null) {
    io.err(
      usernameProblem === 'reserved'
        ? `Refusing: "${username}" is a reserved name; choose a personal username.`
        : 'Refusing: usernames are 3–64 characters: lower-case letters, digits, ".", "_" or "-", starting with a letter or digit.'
    )
    return 2
  }
  if (displayName.length < 1 || displayName.length > 200) {
    io.err('Refusing: the display name must be 1–200 characters.')
    return 2
  }
  return db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('users').select('username').where('is_owner', '=', true).executeTakeFirst()
    if (existing !== undefined) {
      io.err(`Refusing: an owner already exists ("${existing.username}"). Use "recover" or "transfer" instead.`)
      return 1
    }
    const taken = await trx.selectFrom('users').select('id').where('username', '=', username).executeTakeFirst()
    if (taken !== undefined) {
      io.err(`Refusing: the username "${username}" is already in use; use "transfer --to ${username}" to make that user the owner.`)
      return 1
    }
    // The privileged write that only this role can make (see migration 0002).
    const { rows } = await sql<{ id: number }>`
      INSERT INTO wam.users (username, display_name, is_owner) VALUES (${username}, ${displayName}, true) RETURNING id`.execute(trx)
    const id = rows[0]?.id
    if (id === undefined) throw new Error('owner insert returned no id')
    const code = await issueSetupCode(trx, id, null)
    await recordAudit(trx, CLI_CONTEXT, {
      action: 'owner.bootstrapped',
      outcome: 'success',
      actor: null,
      target: { type: 'user', id },
      details: { via: 'owner-cli', osUser: osUser(), username }
    })
    io.out(`Owner account "${username}" created. It has no password yet.`)
    printSetupCode(io, username, code)
    return 0
  })
}

async function recover(db: Kysely<Database>, io: CliIo): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const owner = await trx.selectFrom('users').select(['id', 'username']).where('is_owner', '=', true).executeTakeFirst()
    if (owner === undefined) {
      io.err('Refusing: there is no owner yet; run "bootstrap".')
      return 1
    }
    await trx
      .updateTable('users')
      .set({ password_hash: null, updated_at: sql<Date>`now()` })
      .where('id', '=', owner.id)
      .execute()
    const code = await issueSetupCode(trx, owner.id, null)
    const sessionsEnded = await revokeUserSessions(trx, owner.id, 'owner_recovery')
    const throttlingCleared = await clearLoginFailures(trx, owner.username)
    await recordAudit(trx, CLI_CONTEXT, {
      action: 'owner.recovery_code_issued',
      outcome: 'success',
      actor: null,
      target: { type: 'user', id: owner.id },
      details: { via: 'owner-cli', osUser: osUser(), sessionsEnded, throttlingCleared }
    })
    io.out(`The owner's password was cleared and ${String(sessionsEnded)} session(s) ended.`)
    printSetupCode(io, owner.username, code)
    return 0
  })
}

async function transfer(db: Kysely<Database>, io: CliIo, toInput: string): Promise<number> {
  const to = toInput.trim().toLowerCase()
  return db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom('users').select(['id', 'username']).where('is_owner', '=', true).executeTakeFirst()
    const target = await trx.selectFrom('users').select(['id', 'username', 'status', 'is_owner']).where('username', '=', to).executeTakeFirst()
    if (target === undefined) {
      io.err(`Refusing: there is no user "${to}".`)
      return 1
    }
    if (target.is_owner) {
      io.err(`Refusing: "${to}" is already the owner.`)
      return 1
    }
    if (target.status !== 'active') {
      io.err(`Refusing: "${to}" is disabled; enable the account first.`)
      return 1
    }
    // Old owner first: the partial unique index allows only one owner at a time.
    if (current !== undefined) {
      await sql`UPDATE wam.users SET is_owner = false, updated_at = now(), version = version + 1 WHERE id = ${current.id}`.execute(trx)
      await revokeUserSessions(trx, current.id, 'owner_cli')
    }
    await sql`UPDATE wam.users SET is_owner = true, updated_at = now(), version = version + 1 WHERE id = ${target.id}`.execute(trx)
    await recordAudit(trx, CLI_CONTEXT, {
      action: 'owner.transferred',
      outcome: 'success',
      actor: null,
      target: { type: 'user', id: target.id },
      details: {
        via: 'owner-cli',
        osUser: osUser(),
        from: current === undefined ? null : { id: current.id, username: current.username },
        to: { id: target.id, username: target.username }
      }
    })
    io.out(`"${target.username}" is now the owner${current === undefined ? '' : `; "${current.username}" is an ordinary user and was signed out`}.`)
    return 0
  })
}

async function endAllSessions(db: Kysely<Database>, io: CliIo): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('sessions')
      .set({ revoked_at: sql<Date>`now()`, revoked_reason: 'owner_cli' })
      .where('revoked_at', 'is', null)
      .executeTakeFirst()
    const ended = Number(result.numUpdatedRows)
    await recordAudit(trx, CLI_CONTEXT, {
      action: 'session.ended_all',
      outcome: 'success',
      actor: null,
      details: { via: 'owner-cli', osUser: osUser(), ended }
    })
    io.out(`${String(ended)} session(s) ended. Everyone must sign in again.`)
    return 0
  })
}
