import { createHash, randomUUID } from 'node:crypto'
import type { LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadAccess } from '../../src/access/access.js'
import type { Actor } from '../../src/admin/rules.js'
import { erasePerson } from '../../src/assets/persons.js'
import { setDataContext } from '../../src/db/dataContext.js'
import {
  appointAdministrator,
  assignWarehouseProfile,
  call,
  createHarness,
  insertProfile,
  insertUser,
  insertWarehouse,
  login,
  type Harness
} from '../support/appHarness.js'

// Personal data of people without WAM accounts (decision PD-05; review findings S-2, S-3, S-5), over HTTP
// on a real database. Invented names only.
//
// S-2: erasing a person removes the name everywhere at once — including the responses that person create and
// rename stored for idempotent replay, and the request fingerprints (a SHA-256 of the request, hence of the
// name) stored with them (migration 0008).

let h: Harness
let whA: number
let whB: number
let whC: number
let eraserId: number
let itemType: number
let inStock: number
const cookies: Record<string, string> = {}

type Method = 'GET' | 'POST' | 'PATCH'

function api(who: string, method: Method, url: string, payload?: unknown, key: string = randomUUID()): Promise<LightMyRequestResponse> {
  return call(h, {
    method,
    url,
    cookie: cookies[who],
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    ...(method === 'GET' ? {} : { headers: { 'idempotency-key': key } })
  })
}

const personUrl = (w: number, rest = '') => `/api/warehouses/${String(w)}/persons${rest}`
const assetUrl = (w: number, rest = '') => `/api/warehouses/${String(w)}/assets${rest}`
const errorOf = (res: LightMyRequestResponse) => {
  const { error } = res.json<{ error: { code: string; message: string; details?: unknown; requestId: string } }>()
  return { status: res.statusCode, code: error.code, message: error.message, details: error.details }
}

/** What src/http/idempotency.ts stores as the request fingerprint (method, URL, canonical body). */
function fingerprintOf(method: string, url: string, body: Record<string, unknown>): Buffer {
  const canonical = `{${Object.keys(body)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(body[k])}`)
    .join(',')}}`
  return createHash('sha256').update(`${method}\n${url}\n${canonical}`).digest()
}

interface PersonBody {
  id: number
  displayName: string | null
  erased: boolean
  version: number
}

async function storedKeys(): Promise<{ key: string; text: string; fingerprint: Buffer }[]> {
  const { rows } = await sql<{ key: string; text: string | null; fingerprint: Buffer }>`
    SELECT key::text AS key, response_body::text AS text, fingerprint FROM wam.idempotency_keys ORDER BY key`.execute(h.ownerDb)
  return rows.map((r) => ({ key: r.key, text: r.text ?? '', fingerprint: r.fingerprint }))
}

async function eraser(): Promise<Actor> {
  return { userId: eraserId, username: 'person.eraser', access: await loadAccess(h.appDb, eraserId, false) }
}

beforeAll(async () => {
  h = await createHarness()
  whA = await insertWarehouse(h, 'SYN-PRIV-A')
  whB = await insertWarehouse(h, 'SYN-PRIV-B')
  whC = await insertWarehouse(h, 'SYN-PRIV-C')
  const perms = ['asset.view', 'asset.create', 'asset.edit', 'asset.change_status'] as const
  for (const [username, warehouse] of [['clerk.a', whA], ['clerk.b', whB], ['clerk.c', whC]] as const) {
    const id = await insertUser(h, { username })
    await assignWarehouseProfile(h, id, warehouse, await insertProfile(h, `Profile ${username}`, 'warehouse', perms))
  }
  eraserId = await insertUser(h, { username: 'person.eraser' })
  await appointAdministrator(h, eraserId, await insertProfile(h, 'Erasure', 'system', ['person.erase']))
  for (const u of ['clerk.a', 'clerk.b', 'clerk.c', 'person.eraser']) cookies[u] = await login(h, u)
  itemType = Number(
    (await sql<{ id: number }>`INSERT INTO wam.item_types (name) VALUES ('Synthetic privacy type') RETURNING id`.execute(h.ownerDb)).rows[0]?.id
  )
  inStock = Number((await sql<{ id: number }>`SELECT id FROM wam.asset_statuses WHERE code = 'in_stock'`.execute(h.ownerDb)).rows[0]?.id)
}, 120_000)

afterAll(async () => {
  await h.close()
})

describe('S-2: erasure tombstones every stored response that contains the name', () => {
  it('create → erase: the replayed create is an id-only tombstone; before erasure it replays unchanged', async () => {
    const name = 'Synthetic Parvaneh Alpha'
    const key = randomUUID()
    const created = await api('clerk.a', 'POST', personUrl(whA), { displayName: name }, key)
    expect(created.statusCode, created.body).toBe(201)
    const person = created.json<PersonBody>()
    // Idempotency semantics are unchanged until erasure: the identical response is replayed.
    const before = await api('clerk.a', 'POST', personUrl(whA), { displayName: name }, key)
    expect([before.statusCode, before.headers['idempotency-replayed'], before.json()]).toEqual([201, 'true', person])

    const erased = await api('person.eraser', 'POST', personUrl(whA, `/${String(person.id)}/erase`), { version: person.version })
    expect(erased.statusCode, erased.body).toBe(200)

    const replay = await api('clerk.a', 'POST', personUrl(whA), { displayName: name }, key)
    expect([replay.statusCode, replay.headers['idempotency-replayed']]).toEqual([201, 'true'])
    expect(replay.json()).toEqual({ id: person.id, displayName: null, erased: true, version: person.version })
    expect(replay.body).not.toContain('Parvaneh')
  })

  it('create → rename → rename → rename → erase: every prior key replays a tombstone, and no stored row keeps a name or its hash', async () => {
    const names = ['Synthetic Bahram Beta', 'Synthetic Bahram Gamma', 'Synthetic Bahram Delta', 'Synthetic Bahram Epsilon']
    const keys = names.map(() => randomUUID())
    const created = (await api('clerk.a', 'POST', personUrl(whA), { displayName: names[0] }, keys[0])).json<PersonBody>()
    const requests: { method: Method; url: string; body: Record<string, unknown>; key: string }[] = [
      { method: 'POST', url: personUrl(whA), body: { displayName: names[0] }, key: keys[0] ?? '' }
    ]
    let version = created.version
    for (let i = 1; i < names.length; i += 1) {
      const body = { version, displayName: names[i] }
      const renamed = await api('clerk.a', 'PATCH', personUrl(whA, `/${String(created.id)}`), body, keys[i])
      expect(renamed.statusCode, renamed.body).toBe(200)
      version = renamed.json<PersonBody>().version
      requests.push({ method: 'PATCH', url: personUrl(whA, `/${String(created.id)}`), body, key: keys[i] ?? '' })
    }
    // A second person whose stored responses must stay exactly as they are.
    const otherKey = randomUUID()
    const other = (await api('clerk.a', 'POST', personUrl(whA), { displayName: 'Synthetic Unrelated Zeta' }, otherKey)).json<PersonBody>()
    const otherBefore = (await storedKeys()).find((k) => k.key === otherKey)

    expect((await api('person.eraser', 'POST', personUrl(whA, `/${String(created.id)}/erase`), { version })).statusCode).toBe(200)

    for (const r of requests) {
      const replay = await api('clerk.a', r.method, r.url, r.body, r.key)
      expect([replay.statusCode, replay.headers['idempotency-replayed']], r.key).toEqual([r.method === 'POST' ? 201 : 200, 'true'])
      expect(replay.json<PersonBody>()).toMatchObject({ id: created.id, displayName: null, erased: true })
      expect(replay.body).not.toContain('Bahram')
    }
    const stored = await storedKeys()
    for (const row of stored) expect(row.text).not.toContain('Bahram')
    for (const r of requests) {
      const row = stored.find((k) => k.key === r.key)
      expect(row?.fingerprint.equals(Buffer.alloc(32)), r.key).toBe(true)
      // No stored fingerprint is the hash of any request that carried the name.
      const original = fingerprintOf(r.method, r.url, r.body)
      expect(stored.some((k) => k.fingerprint.equals(original))).toBe(false)
    }
    // The unrelated person's stored response and fingerprint are untouched, and it still replays its name.
    expect((await storedKeys()).find((k) => k.key === otherKey)).toEqual(otherBefore)
    const otherReplay = await api('clerk.a', 'POST', personUrl(whA), { displayName: 'Synthetic Unrelated Zeta' }, otherKey)
    expect(otherReplay.json()).toEqual(other)
    // Nowhere else either: the person row, the audit trail.
    const { rows } = await sql<{ name: string | null; audit: string }>`
      SELECT (SELECT display_name FROM wam.persons WHERE id = ${created.id}) AS name,
             (SELECT coalesce(string_agg(coalesce(details::text, ''), ' '), '') FROM wam.audit_events) AS audit`.execute(h.ownerDb)
    expect(rows[0]?.name).toBeNull()
    expect(rows[0]?.audit).not.toContain('Bahram')
  })

  it('keeps key reuse and conflict rules: a different request with a live key is refused; a fresh key works', async () => {
    const key = randomUUID()
    const created = (await api('clerk.a', 'POST', personUrl(whA), { displayName: 'Synthetic Reuse Eta' }, key)).json<PersonBody>()
    const conflict = await api('clerk.a', 'POST', personUrl(whA), { displayName: 'Synthetic Reuse Theta' }, key)
    expect(errorOf(conflict)).toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' })
    // Keys are per user: the same key from another user is a new request.
    expect((await api('clerk.c', 'POST', personUrl(whC), { displayName: 'Synthetic Reuse Iota' }, key)).statusCode).toBe(201)
    expect((await api('person.eraser', 'POST', personUrl(whA, `/${String(created.id)}/erase`), { version: created.version })).statusCode).toBe(200)
    // After erasure the original request can no longer be compared (its fingerprint was a hash of the name):
    // any request with that key replays the tombstone, and none creates anything.
    const afterwards = await api('clerk.a', 'POST', personUrl(whA), { displayName: 'Synthetic Reuse Kappa' }, key)
    expect([afterwards.statusCode, afterwards.headers['idempotency-replayed']]).toEqual([201, 'true'])
    expect(afterwards.json()).toEqual({ id: created.id, displayName: null, erased: true, version: created.version })
    const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM wam.persons WHERE display_name = 'Synthetic Reuse Kappa'`.execute(h.ownerDb)
    expect(rows[0]?.n).toBe('0')
    expect((await api('clerk.a', 'POST', personUrl(whA), { displayName: 'Synthetic Reuse Lambda' })).statusCode).toBe(201)
  })

  it('is one-way: the name cannot be set again by rename, erasure replay, or the schema owner', async () => {
    const created = (await api('clerk.a', 'POST', personUrl(whA), { displayName: 'Synthetic Oneway Mu' })).json<PersonBody>()
    const eraseKey = randomUUID()
    const erased = await api('person.eraser', 'POST', personUrl(whA, `/${String(created.id)}/erase`), { version: created.version }, eraseKey)
    const after = erased.json<PersonBody>()
    expect(after).toMatchObject({ displayName: null, erased: true })
    expect(errorOf(await api('clerk.a', 'PATCH', personUrl(whA, `/${String(created.id)}`), { version: after.version, displayName: 'Synthetic Back' })).code).toBe(
      'PERSON_ERASED'
    )
    expect(errorOf(await api('person.eraser', 'POST', personUrl(whA, `/${String(created.id)}/erase`), { version: after.version })).code).toBe(
      'PERSON_ERASED'
    )
    const replay = await api('person.eraser', 'POST', personUrl(whA, `/${String(created.id)}/erase`), { version: created.version }, eraseKey)
    expect([replay.statusCode, replay.json()]).toEqual([200, after])
    await expect(sql`UPDATE wam.persons SET display_name = 'Synthetic Back', erased_at = NULL WHERE id = ${created.id}`.execute(h.ownerDb)).rejects.toThrow()
  })

  it('makes a replay that overlaps the erasure wait for it, then return the tombstone', async () => {
    const name = 'Synthetic Concurrent Nu'
    const key = randomUUID()
    const created = (await api('clerk.a', 'POST', personUrl(whA), { displayName: name }, key)).json<PersonBody>()
    const actor = await eraser()
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let signalErased = (): void => undefined
    const erasedInTransaction = new Promise<void>((resolve) => {
      signalErased = resolve
    })
    const erasing = h.appDb.transaction().execute(async (trx) => {
      await setDataContext(trx, { warehouseIds: [whA], actorUserId: eraserId, requestId: randomUUID() })
      await erasePerson(trx, { requestId: null, sourceIp: null }, actor, whA, created.id, { version: created.version })
      signalErased()
      await gate // the erasure, its tombstone included, is not committed yet
    })
    await erasedInTransaction
    const replaying = api('clerk.a', 'POST', personUrl(whA), { displayName: name }, key)
    let waited = false
    for (let i = 0; i < 50 && !waited; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const { rows } = await sql<{ n: string }>`
        SELECT count(*) AS n FROM pg_stat_activity
         WHERE datname = current_database() AND usename = 'wam_app' AND wait_event_type = 'Lock'
           AND query LIKE '%idempotency_keys%'`.execute(h.superDb)
      waited = Number(rows[0]?.n) > 0
    }
    expect(waited).toBe(true)
    release()
    await erasing
    const replay = await replaying
    expect([replay.statusCode, replay.headers['idempotency-replayed']]).toEqual([201, 'true'])
    expect(replay.json()).toEqual({ id: created.id, displayName: null, erased: true, version: created.version })
    expect(replay.body).not.toContain('Concurrent')
  })
})

describe('S-3: handover parties reveal nothing beyond what the approved rule implies', () => {
  it('answers a person of another warehouse exactly like a person that does not exist', async () => {
    const asset = (
      await api('clerk.a', 'POST', assetUrl(whA), { assetCode: 'SYN-PRIV-0001', name: 'Synthetic', itemTypeId: itemType, statusId: inStock })
    ).json<{ asset: { id: number; version: number } }>().asset
    const personB = (await api('clerk.b', 'POST', personUrl(whB), { displayName: 'Synthetic Elsewhere Xi' })).json<PersonBody>()
    const attempt = (personId: number) =>
      api('clerk.a', 'PATCH', assetUrl(whA, `/${String(asset.id)}`), { version: asset.version, receivedBy: { personId } })
    const foreign = errorOf(await attempt(personB.id))
    const missing = errorOf(await attempt(2_000_000_000))
    expect(foreign).toEqual(missing)
    expect(foreign).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' })
    expect(JSON.stringify(foreign)).not.toContain('Elsewhere')
  })

  it('accepts any WAM user as a party (proposal §7) and refuses an unknown user id without naming the field or the user', async () => {
    const asset = (
      await api('clerk.a', 'POST', assetUrl(whA), { assetCode: 'SYN-PRIV-0002', name: 'Synthetic', itemTypeId: itemType, statusId: inStock })
    ).json<{ asset: { id: number; version: number } }>().asset
    const userB = Number((await sql<{ id: number }>`SELECT id FROM wam.users WHERE username = 'clerk.b'`.execute(h.ownerDb)).rows[0]?.id)
    const unknownUser = errorOf(
      await api('clerk.a', 'PATCH', assetUrl(whA, `/${String(asset.id)}`), { version: asset.version, receivedBy: { userId: 2_000_000_000 } })
    )
    const unknownDeliverer = errorOf(
      await api('clerk.a', 'PATCH', assetUrl(whA, `/${String(asset.id)}`), { version: asset.version, deliveredBy: { userId: 2_000_000_001 } })
    )
    // A generic unknown-reference answer: no field, no id, no account detail, and the same for either role.
    expect(unknownUser).toEqual({ status: 400, code: 'VALIDATION_FAILED', message: 'Request validation failed', details: { reason: 'unknown reference' } })
    expect(unknownDeliverer).toEqual(unknownUser)
    const ok = await api('clerk.a', 'PATCH', assetUrl(whA, `/${String(asset.id)}`), { version: asset.version, receivedBy: { userId: userB } })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json<{ asset: { receivedBy: unknown } }>().asset.receivedBy).toEqual({ userId: userB })
    expect(ok.body).not.toContain('clerk.b')
  })
})

describe('S-5: erasure stays available in an inactive warehouse (PD-07 with PD-05)', () => {
  it('erases a person while every ordinary person and asset write is refused', async () => {
    const person = (await api('clerk.c', 'POST', personUrl(whC), { displayName: 'Synthetic Inactive Omicron' })).json<PersonBody>()
    const asset = (
      await api('clerk.c', 'POST', assetUrl(whC), { assetCode: 'SYN-PRIV-INA', name: 'Synthetic', itemTypeId: itemType, statusId: inStock })
    ).json<{ asset: { id: number; version: number } }>().asset
    await sql`UPDATE wam.warehouses SET is_active = false WHERE id = ${whC}`.execute(h.ownerDb)
    for (const [method, url, payload] of [
      ['POST', personUrl(whC), { displayName: 'Synthetic New' }],
      ['PATCH', personUrl(whC, `/${String(person.id)}`), { version: person.version, displayName: 'Synthetic Renamed' }],
      ['POST', assetUrl(whC), { assetCode: 'SYN-PRIV-INA2', name: 'Synthetic', itemTypeId: itemType, statusId: inStock }],
      ['PATCH', assetUrl(whC, `/${String(asset.id)}`), { version: asset.version, notes: 'x' }]
    ] as const) {
      expect(errorOf(await api('clerk.c', method, url, payload)), url).toMatchObject({ status: 409, code: 'WAREHOUSE_INACTIVE' })
    }
    const erased = await api('person.eraser', 'POST', personUrl(whC, `/${String(person.id)}/erase`), { version: person.version })
    expect(erased.statusCode, erased.body).toBe(200)
    expect(erased.json()).toMatchObject({ id: person.id, displayName: null, erased: true })
    const { rows } = await sql<{ name: string | null }>`SELECT display_name AS name FROM wam.persons WHERE id = ${person.id}`.execute(h.ownerDb)
    expect(rows[0]?.name).toBeNull()
  })
})
