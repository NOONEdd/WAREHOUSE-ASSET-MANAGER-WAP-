import { randomBytes } from 'node:crypto'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { expect } from 'vitest'
import { buildApp, type AppOptions } from '../../src/app.js'
import { hashPassword } from '../../src/auth/passwords.js'
import { open, seal, secretKeyFrom, totpSecretContext } from '../../src/auth/secretBox.js'
import { newTotpSecret, totpCode } from '../../src/auth/totp.js'
import { base32Decode } from './base32.js'
import type { Database } from '../../src/db/connection.js'
import { createMigrator } from '../../src/db/migrator.js'
import { connect, createTestDatabase, type TestDatabase } from './testDatabase.js'

// Helpers for tests that drive the HTTP API against a migrated throwaway
// database. The app connects as wam_app (the production runtime role);
// fixtures are inserted as wam_owner, which owns the tables.

export const ORIGIN = 'http://127.0.0.1:3000'
/** What a same-origin request from the WAM user interface carries. */
export const SAME_ORIGIN = { origin: ORIGIN, 'x-wam-csrf': '1' } as const
export const COOKIE_NAME = 'wam_session'
export const CHALLENGE_COOKIE_NAME = 'wam_mfa'
export const SESSIONS = { idleMinutes: 30, absoluteHours: 12 } as const

/** A password that satisfies the policy (15+ characters, not common, no context words). */
export const GOOD_PASSWORD = 'lunar-Kettle-48-orbit'

export interface Harness {
  readonly tdb: TestDatabase
  readonly app: FastifyInstance
  /** wam_app — what the server uses. */
  readonly appDb: Kysely<Database>
  /** wam_owner — for fixtures and inspecting state. */
  readonly ownerDb: Kysely<Database>
  /** superuser — for simulating time passing and failures. */
  readonly superDb: Kysely<Database>
  /** The app's MFA encryption key (random per harness). */
  readonly mfaKey: Buffer
  close(): Promise<void>
}

export interface HarnessOptions {
  readonly importEnabled?: boolean
  /** pino options for the app; default false (no logging). Log-privacy tests pass the server's own options. */
  readonly logger?: AppOptions['logger']
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const tdb = await createTestDatabase()
  const ownerDb = connect(tdb.urls.owner)
  const { error } = await createMigrator(ownerDb).migrateToLatest()
  expect(error).toBeUndefined()
  const appDb = connect(tdb.urls.app)
  const superDb = connect(tdb.urls.superuser)
  const mfaKey = randomBytes(32)
  const { logger = false, ...rest } = options
  const app = buildApp({ db: appDb, logger, publicOrigin: ORIGIN, sessions: SESSIONS, mfaEncryptionKey: mfaKey, ...rest })
  await app.ready()
  return {
    tdb,
    app,
    appDb,
    ownerDb,
    superDb,
    mfaKey,
    close: async () => {
      await app.close()
      await appDb.destroy()
      await ownerDb.destroy()
      await superDb.destroy()
      await tdb.drop()
    }
  }
}

const hashCache = new Map<string, Promise<string>>()

/** Argon2id hashing is deliberately slow; reuse hashes of the same password within a run. */
export function cachedHash(password: string): Promise<string> {
  let hash = hashCache.get(password)
  if (hash === undefined) {
    hash = hashPassword(password)
    hashCache.set(password, hash)
  }
  return hash
}

export interface UserFixture {
  readonly username: string
  readonly displayName?: string
  /** null: no password yet (not activated). Default: GOOD_PASSWORD. */
  readonly password?: string | null
  readonly status?: 'active' | 'disabled'
  readonly isOwner?: boolean
}

export async function insertUser(h: Harness, fixture: UserFixture): Promise<number> {
  const password = fixture.password === undefined ? GOOD_PASSWORD : fixture.password
  const hash = password === null ? null : await cachedHash(password)
  const { rows } = await sql<{ id: number }>`
    INSERT INTO wam.users (username, display_name, status, is_owner, password_hash)
    VALUES (${fixture.username}, ${fixture.displayName ?? fixture.username}, ${fixture.status ?? 'active'},
            ${fixture.isOwner ?? false}, ${hash})
    RETURNING id`.execute(h.ownerDb)
  const id = rows[0]?.id
  if (id === undefined) throw new Error('insert returned no id')
  return id
}

export async function insertWarehouse(h: Harness, code: string): Promise<number> {
  const row = await h.ownerDb
    .insertInto('warehouses')
    .values({ code, name: `Synthetic warehouse ${code}` })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

/** A profile with the given permissions; returns its id. */
export async function insertProfile(
  h: Harness,
  name: string,
  scope: 'system' | 'warehouse',
  permissions: readonly string[]
): Promise<number> {
  const { id } = await h.ownerDb.insertInto('permission_profiles').values({ name, scope }).returning('id').executeTakeFirstOrThrow()
  for (const permission of permissions) {
    await h.ownerDb.insertInto('permission_profile_permissions').values({ profile_id: id, scope, permission }).execute()
  }
  return id
}

export async function assignWarehouseProfile(h: Harness, userId: number, warehouseId: number, profileId: number): Promise<void> {
  await h.ownerDb.insertInto('user_warehouse_profiles').values({ user_id: userId, warehouse_id: warehouseId, profile_id: profileId, granted_by: null }).execute()
}

/** A raw assignment; the database refuses it (decision O-12) unless the user has an authenticator. */
export async function assignSystemProfile(h: Harness, userId: number, profileId: number): Promise<void> {
  await h.ownerDb.insertInto('user_system_profiles').values({ user_id: userId, profile_id: profileId, granted_by: null }).execute()
}

/** The O-12 order: an authenticator first (unless already enrolled), then the administrator profile. */
export async function appointAdministrator(h: Harness, userId: number, profileId: number): Promise<void> {
  const enrolled = await h.ownerDb.selectFrom('user_mfa').select('user_id').where('user_id', '=', userId).executeTakeFirst()
  if (enrolled === undefined) await enrollMfa(h, userId)
  await assignSystemProfile(h, userId, profileId)
}

/**
 * An administrator without an authenticator, as data written before decision
 * O-12 would be: only the superuser, with triggers switched off for its own
 * transaction, can create this state. Used to test the defenses behind O-12
 * (sign-in enrolment, per-request enforcement), never to model normal use.
 */
export async function assignSystemProfileBypassingO12(h: Harness, userId: number, profileId: number): Promise<void> {
  await h.superDb.transaction().execute(async (trx) => {
    await sql`SET LOCAL session_replication_role = replica`.execute(trx)
    await trx.insertInto('user_system_profiles').values({ user_id: userId, profile_id: profileId, granted_by: null }).execute()
  })
}

/** `name=value` of the cookie `name` set by the response (any of its Set-Cookie headers). */
export function cookieFrom(res: LightMyRequestResponse, name: string): string {
  const header = res.headers['set-cookie']
  const values = header === undefined ? [] : Array.isArray(header) ? header : [header]
  for (const value of values) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(value)
    if (match?.[1] !== undefined) return `${name}=${match[1]}`
  }
  throw new Error(`no ${name} cookie in response: ${JSON.stringify(values)}`)
}

export function sessionCookieFrom(res: LightMyRequestResponse): string {
  return cookieFrom(res, COOKIE_NAME)
}

/** Enrols an authenticator directly in the database; returns its raw secret. */
export async function enrollMfa(h: Harness, userId: number): Promise<Buffer> {
  const secret = newTotpSecret()
  const key = secretKeyFrom(h.mfaKey)
  await h.ownerDb
    .insertInto('user_mfa')
    .values({ user_id: userId, totp_secret: seal(key, secret, totpSecretContext(userId)), totp_key_id: key.id, totp_last_step: 0 })
    .execute()
  return secret
}

/**
 * The code the user's authenticator app shows now (plus `offsetSeconds`).
 * By default first clears the single-use marker, so that tests can sign the
 * same user in several times within one 30-second step.
 */
export async function totpFor(
  h: Harness,
  userId: number,
  options: { readonly offsetSeconds?: number; readonly keepSingleUse?: boolean } = {}
): Promise<string> {
  const row = await h.ownerDb.selectFrom('user_mfa').select('totp_secret').where('user_id', '=', userId).executeTakeFirstOrThrow()
  const secret = open(secretKeyFrom(h.mfaKey), row.totp_secret, totpSecretContext(userId))
  if (options.keepSingleUse !== true) await h.ownerDb.updateTable('user_mfa').set({ totp_last_step: 0 }).where('user_id', '=', userId).execute()
  return totpCode(secret, Math.floor(Date.now() / 1000) + (options.offsetSeconds ?? 0))
}

/** A same-origin request; pass `cookie` to send it as a signed-in user. */
export function call(h: Harness, options: InjectOptions & { readonly cookie?: string | undefined }): Promise<LightMyRequestResponse> {
  const { cookie, headers, ...rest } = options
  const safe = rest.method === undefined || ['GET', 'HEAD', 'OPTIONS'].includes(String(rest.method).toUpperCase())
  return h.app.inject({
    ...rest,
    headers: { ...(safe ? {} : SAME_ORIGIN), ...(cookie === undefined ? {} : { cookie }), ...headers }
  })
}

/**
 * Signs in through the real API, completing the second step when the
 * account needs one (verifying with the enrolled authenticator, or
 * enrolling one first). Returns the session cookie.
 */
export async function login(
  h: Harness,
  username: string,
  password: string = GOOD_PASSWORD,
  extra: Partial<InjectOptions> = {}
): Promise<string> {
  const res = await call(h, { method: 'POST', url: '/api/auth/login', payload: { username, password }, ...extra })
  if (res.statusCode === 200) return sessionCookieFrom(res)
  expect(res.statusCode, res.body).toBe(202)
  const challenge = cookieFrom(res, CHALLENGE_COOKIE_NAME)
  const { next } = res.json<{ next: string }>()
  const { id } = await h.ownerDb.selectFrom('users').select('id').where('username', '=', username.trim().toLowerCase()).executeTakeFirstOrThrow()
  if (next === 'mfa_verify') {
    const verified = await call(h, { method: 'POST', url: '/api/auth/mfa/verify', cookie: challenge, payload: { code: await totpFor(h, id) }, ...extra })
    expect(verified.statusCode, verified.body).toBe(200)
    return sessionCookieFrom(verified)
  }
  const started = await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/start', cookie: challenge, ...extra })
  expect(started.statusCode, started.body).toBe(200)
  const code = totpCode(base32Decode(started.json<{ secret: string }>().secret), Math.floor(Date.now() / 1000))
  const confirmed = await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/confirm', cookie: challenge, payload: { code }, ...extra })
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  return sessionCookieFrom(confirmed)
}

/** Audit rows, oldest first, optionally only one action. */
export async function auditRows(
  h: Harness,
  action?: string
): Promise<{ action: string; outcome: string; actor_user_id: number | null; target_type: string | null; target_id: string | null; warehouse_id: number | null; details: Record<string, unknown> }[]> {
  return h.ownerDb
    .selectFrom('audit_events')
    .select(['action', 'outcome', 'actor_user_id', 'target_type', 'target_id', 'warehouse_id', 'details'])
    .$if(action !== undefined, (q) => q.where('action', '=', action ?? ''))
    .orderBy('id')
    .execute()
}
