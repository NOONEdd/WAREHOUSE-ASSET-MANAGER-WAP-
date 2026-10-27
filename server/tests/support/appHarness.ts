import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { expect } from 'vitest'
import { buildApp } from '../../src/app.js'
import { hashPassword } from '../../src/auth/passwords.js'
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
  close(): Promise<void>
}

export async function createHarness(): Promise<Harness> {
  const tdb = await createTestDatabase()
  const ownerDb = connect(tdb.urls.owner)
  const { error } = await createMigrator(ownerDb).migrateToLatest()
  expect(error).toBeUndefined()
  const appDb = connect(tdb.urls.app)
  const superDb = connect(tdb.urls.superuser)
  const app = buildApp({ db: appDb, logger: false, publicOrigin: ORIGIN, sessions: SESSIONS })
  await app.ready()
  return {
    tdb,
    app,
    appDb,
    ownerDb,
    superDb,
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

export async function assignSystemProfile(h: Harness, userId: number, profileId: number): Promise<void> {
  await h.ownerDb.insertInto('user_system_profiles').values({ user_id: userId, profile_id: profileId, granted_by: null }).execute()
}

export function sessionCookieFrom(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  const match = value === undefined ? null : new RegExp(`^${COOKIE_NAME}=([^;]+)`).exec(value)
  if (match?.[1] === undefined) throw new Error(`no session cookie in response: ${String(value)}`)
  return `${COOKIE_NAME}=${match[1]}`
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

export async function login(
  h: Harness,
  username: string,
  password: string = GOOD_PASSWORD,
  extra: Partial<InjectOptions> = {}
): Promise<string> {
  const res = await call(h, { method: 'POST', url: '/api/auth/login', payload: { username, password }, ...extra })
  expect(res.statusCode, res.body).toBe(200)
  return sessionCookieFrom(res)
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
