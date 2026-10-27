import { randomUUID } from 'node:crypto'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appointAdministrator,
  assignWarehouseProfile,
  auditRows,
  call,
  createHarness,
  enrollMfa,
  insertProfile,
  insertUser,
  insertWarehouse,
  login,
  type Harness
} from '../support/appHarness.js'

// The owner's admin API (decision O-09) and its safeguards
// (docs/security/identity-and-access.md §2.3, rules A1–A6). Every denial
// test is paired with a success by the owner, so a denial cannot pass just
// because the operation is broken for everyone.

let h: Harness
const ids = {} as Record<string, number>
const cookies = {} as Record<string, string>

const ADMIN_PERMISSIONS = ['user.view', 'user.manage', 'profile.manage', 'job_title.manage', 'warehouse.manage', 'audit.view_all']

beforeAll(async () => {
  h = await createHarness()
  ids.owner = await insertUser(h, { username: 'the.owner', isOwner: true })
  ids.admin1 = await insertUser(h, { username: 'admin.one' })
  ids.admin2 = await insertUser(h, { username: 'admin.two' })
  ids.clerk = await insertUser(h, { username: 'clerk.a' })
  ids.auditorA = await insertUser(h, { username: 'auditor.a' })
  ids.plain = await insertUser(h, { username: 'plain.user' })
  ids.whA = await insertWarehouse(h, 'SYN-A')
  ids.whB = await insertWarehouse(h, 'SYN-B')
  ids.adminProfile = await insertProfile(h, 'Synthetic administrator', 'system', ADMIN_PERMISSIONS)
  ids.clerkProfile = await insertProfile(h, 'Synthetic clerk', 'warehouse', ['asset.view', 'asset.create'])
  ids.auditProfile = await insertProfile(h, 'Synthetic warehouse auditor', 'warehouse', ['audit.view'])
  await appointAdministrator(h, ids.admin1, ids.adminProfile)
  await appointAdministrator(h, ids.admin2, ids.adminProfile)
  await assignWarehouseProfile(h, ids.clerk, ids.whA, ids.clerkProfile)
  await assignWarehouseProfile(h, ids.auditorA, ids.whA, ids.auditProfile)
  for (const [name, username] of [
    ['owner', 'the.owner'],
    ['admin1', 'admin.one'],
    ['admin2', 'admin.two'],
    ['clerk', 'clerk.a'],
    ['auditorA', 'auditor.a'],
    ['plain', 'plain.user']
  ] as const) {
    cookies[name] = await login(h, username)
  }
})

afterAll(async () => {
  await h.close()
})

/** A state-changing admin call with a fresh Idempotency-Key unless one is given. */
function admin(
  who: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'GET',
  url: string,
  payload?: Record<string, unknown>,
  key: string = randomUUID()
): Promise<LightMyRequestResponse> {
  const cookie = cookies[who]
  if (cookie === undefined) throw new Error(`no cookie for ${who}`)
  return call(h, {
    method,
    url,
    cookie,
    ...(payload === undefined ? {} : { payload }),
    ...(method === 'GET' ? {} : { headers: { 'idempotency-key': key } })
  })
}

async function userVersion(id: number): Promise<number> {
  const row = await h.ownerDb.selectFrom('users').select('version').where('id', '=', id).executeTakeFirstOrThrow()
  return row.version
}

const expectRule = (res: LightMyRequestResponse, rule: string) => {
  expect(res.statusCode, res.body).toBe(403)
  expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN', details: { rule } } })
}

describe('route-level permissions', () => {
  it('refuses unauthenticated callers with 401 and callers without a system permission with 403', async () => {
    expect((await call(h, { method: 'GET', url: '/api/admin/users' })).statusCode).toBe(401)
    for (const who of ['plain', 'clerk', 'auditorA']) {
      expect((await admin(who, 'GET', '/api/admin/users')).statusCode).toBe(403)
      expect((await admin(who, 'POST', '/api/admin/users', { username: 'x.y.z', displayName: 'X' })).statusCode).toBe(403)
    }
    expect((await admin('admin1', 'GET', '/api/admin/users')).statusCode).toBe(200)
  })

  it('audits every denial', async () => {
    const denials = await auditRows(h, 'authz.denied')
    expect(denials.some((d) => d.actor_user_id === ids.plain)).toBe(true)
  })
})

describe('user lifecycle through the admin API', () => {
  it('creates a user without a password, issues a one-time code, and the user activates the account', async () => {
    const created = await admin('admin1', 'POST', '/api/admin/users', { username: 'new.keeper', displayName: 'انباردار جدید' })
    expect(created.statusCode, created.body).toBe(201)
    const user = created.json<{ id: number; hasPassword: boolean; access: unknown }>()
    expect(user).toMatchObject({ hasPassword: false, access: { systemProfiles: [], warehouseAssignments: [] } })
    expect(Object.keys(created.json<object>()).some((k) => /password_hash|hash/i.test(k))).toBe(false)
    ids.newKeeper = user.id

    const code = await admin('admin1', 'POST', `/api/admin/users/${String(user.id)}/setup-code`)
    expect(code.statusCode).toBe(200)
    const { setupCode } = code.json<{ setupCode: string }>()
    expect(
      (await call(h, { method: 'POST', url: '/api/auth/setup-password', payload: { username: 'new.keeper', setupCode, newPassword: 'keeper chosen passphrase' } }))
        .statusCode
    ).toBe(204)
    cookies.newKeeper = await login(h, 'new.keeper', 'keeper chosen passphrase')
  })

  it('refuses a taken or reserved username', async () => {
    expect((await admin('admin1', 'POST', '/api/admin/users', { username: 'new.keeper', displayName: 'X' })).json()).toMatchObject({
      error: { code: 'USERNAME_TAKEN' }
    })
    expect((await admin('admin1', 'POST', '/api/admin/users', { username: 'admin', displayName: 'X' })).json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { reason: 'reserved' } }
    })
  })

  it('rejects fields the endpoint does not accept (mass assignment)', async () => {
    const res = await admin('admin1', 'POST', '/api/admin/users', { username: 'mass.assign', displayName: 'X', isOwner: true })
    expect(res.statusCode).toBe(400)
    const patch = await admin('admin1', 'PATCH', `/api/admin/users/${String(ids.newKeeper)}`, { version: 1, isOwner: true })
    expect(patch.statusCode).toBe(400)
    expect(await h.ownerDb.selectFrom('users').select('id').where('username', '=', 'mass.assign').executeTakeFirst()).toBeUndefined()
  })

  it('gives warehouse access only through explicit assignments, effective immediately', async () => {
    const id = ids.newKeeper ?? 0
    const res = await admin('admin1', 'PUT', `/api/admin/users/${String(id)}/access`, {
      version: await userVersion(id),
      systemProfileIds: [],
      warehouseAssignments: [{ warehouseId: ids.whA, profileId: ids.clerkProfile }]
    })
    expect(res.statusCode, res.body).toBe(200)
    const me = await call(h, { method: 'GET', url: '/api/me', cookie: cookies.newKeeper })
    expect(me.json<{ warehouses: { code: string }[] }>().warehouses.map((w) => w.code)).toEqual(['SYN-A'])
  })

  it('disabling a user ends their sessions at once; enabling restores sign-in', async () => {
    const id = ids.newKeeper ?? 0
    const disabled = await admin('admin1', 'PATCH', `/api/admin/users/${String(id)}`, { version: await userVersion(id), status: 'disabled' })
    expect(disabled.statusCode).toBe(200)
    expect((await call(h, { method: 'GET', url: '/api/me', cookie: cookies.newKeeper })).statusCode).toBe(401)
    expect((await auditRows(h, 'user.disabled')).at(-1)?.details).toMatchObject({ sessionsEnded: 1 })
    await admin('admin1', 'PATCH', `/api/admin/users/${String(id)}`, { version: await userVersion(id), status: 'active' })
    cookies.newKeeper = await login(h, 'new.keeper', 'keeper chosen passphrase')
  })

  it('rejects an edit based on an outdated version (two administrators at once)', async () => {
    const id = ids.newKeeper ?? 0
    const seen = await userVersion(id)
    expect((await admin('admin1', 'PATCH', `/api/admin/users/${String(id)}`, { version: seen, displayName: 'First edit' })).statusCode).toBe(200)
    const late = await admin('admin2', 'PATCH', `/api/admin/users/${String(id)}`, { version: seen, displayName: 'Second edit' })
    expect(late.statusCode).toBe(409)
    expect(late.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT', details: { currentVersion: seen + 1 } } })
  })

  it('replays a retried create instead of creating twice (online-only retry, D-05)', async () => {
    const key = randomUUID()
    const first = await admin('admin1', 'POST', '/api/admin/users', { username: 'retry.target', displayName: 'Retry' }, key)
    const again = await admin('admin1', 'POST', '/api/admin/users', { username: 'retry.target', displayName: 'Retry' }, key)
    expect([first.statusCode, again.statusCode]).toEqual([201, 201])
    expect(again.headers['idempotency-replayed']).toBe('true')
    expect(again.json()).toEqual(first.json())
    const created = (await auditRows(h, 'user.created')).filter((e) => (e.details.after as { username?: string }).username === 'retry.target')
    expect(created).toHaveLength(1)
  })

  it('requires an Idempotency-Key for changes', async () => {
    const res = await call(h, { method: 'POST', url: '/api/admin/users', cookie: cookies.admin1, payload: { username: 'no.key', displayName: 'X' } })
    expect(res.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } })
  })
})

describe('escalation rules (identity-and-access §2.3)', () => {
  it('A1: only the owner creates or assigns administrator (system) profiles', async () => {
    expectRule(await admin('admin1', 'POST', '/api/admin/profiles', { name: 'Shadow admin', scope: 'system', permissions: ['user.manage'] }), 'A1')
    expectRule(
      await admin('admin1', 'PUT', `/api/admin/users/${String(ids.plain)}/access`, {
        version: await userVersion(ids.plain ?? 0),
        systemProfileIds: [ids.adminProfile],
        warehouseAssignments: []
      }),
      'A1'
    )
    expectRule(await admin('admin1', 'PATCH', `/api/admin/profiles/${String(ids.adminProfile)}`, { version: 1, permissions: ['user.view'] }), 'A1')

    // The owner can do all three — the appointment only for a user who already has an authenticator (O-12).
    expect((await admin('owner', 'POST', '/api/admin/profiles', { name: 'Read-only admin', scope: 'system', permissions: ['user.view'] })).statusCode).toBe(201)
    const notEnrolled = await admin('owner', 'PUT', `/api/admin/users/${String(ids.plain)}/access`, {
      version: await userVersion(ids.plain ?? 0),
      systemProfileIds: [ids.adminProfile],
      warehouseAssignments: []
    })
    expect(notEnrolled.statusCode).toBe(409)
    expect(notEnrolled.json()).toMatchObject({ error: { code: 'ADMIN_MFA_REQUIRED', details: { rule: 'O-12' } } })
    const appointee = await insertUser(h, { username: 'appointee' })
    await enrollMfa(h, appointee)
    expect(
      (
        await admin('owner', 'PUT', `/api/admin/users/${String(appointee)}/access`, {
          version: await userVersion(appointee),
          systemProfileIds: [ids.adminProfile],
          warehouseAssignments: []
        })
      ).statusCode
    ).toBe(200)
    // …and take it away again.
    await admin('owner', 'PUT', `/api/admin/users/${String(appointee)}/access`, {
      version: await userVersion(appointee),
      systemProfileIds: [],
      warehouseAssignments: []
    })
  })

  it('A2: administrators cannot act on each other; the owner can', async () => {
    const target = String(ids.admin2)
    expectRule(await admin('admin1', 'PATCH', `/api/admin/users/${target}`, { version: await userVersion(ids.admin2 ?? 0), status: 'disabled' }), 'A2')
    expectRule(await admin('admin1', 'POST', `/api/admin/users/${target}/setup-code`), 'A2')
    expectRule(await admin('admin1', 'POST', `/api/admin/users/${target}/end-sessions`), 'A2')
    expectRule(
      await admin('admin1', 'PUT', `/api/admin/users/${target}/access`, {
        version: await userVersion(ids.admin2 ?? 0),
        systemProfileIds: [ids.adminProfile],
        warehouseAssignments: [{ warehouseId: ids.whB, profileId: ids.clerkProfile }]
      }),
      'A2'
    )
    expect((await admin('owner', 'POST', `/api/admin/users/${target}/end-sessions`)).json()).toEqual({ ended: 1 })
    cookies.admin2 = await login(h, 'admin.two')
  })

  it('A3: nobody but the owner touches the owner account, and the owner cannot be disabled at all', async () => {
    const owner = String(ids.owner)
    expectRule(await admin('admin1', 'PATCH', `/api/admin/users/${owner}`, { version: await userVersion(ids.owner ?? 0), displayName: 'Hijacked' }), 'A3')
    expectRule(await admin('admin1', 'POST', `/api/admin/users/${owner}/setup-code`), 'A3')
    const selfDisable = await admin('owner', 'PATCH', `/api/admin/users/${owner}`, { version: await userVersion(ids.owner ?? 0), status: 'disabled' })
    expect(selfDisable.statusCode).toBe(403)
    expect((await call(h, { method: 'GET', url: '/api/me', cookie: cookies.owner })).statusCode).toBe(200)
  })

  it('A4: nobody changes their own access or status (no self-escalation)', async () => {
    const self = String(ids.admin1)
    expectRule(
      await admin('admin1', 'PUT', `/api/admin/users/${self}/access`, {
        version: await userVersion(ids.admin1 ?? 0),
        systemProfileIds: [ids.adminProfile],
        warehouseAssignments: [{ warehouseId: ids.whA, profileId: ids.clerkProfile }]
      }),
      'A4'
    )
    expectRule(await admin('admin1', 'POST', `/api/admin/users/${self}/setup-code`), 'A4')
  })

  it('A5: a profile manager cannot edit a profile assigned to themselves', async () => {
    await assignWarehouseProfile(h, ids.admin1 ?? 0, ids.whA ?? 0, ids.auditProfile ?? 0)
    const profile = (await h.ownerDb.selectFrom('permission_profiles').select('version').where('id', '=', ids.auditProfile ?? 0).executeTakeFirstOrThrow()).version
    expectRule(
      await admin('admin1', 'PATCH', `/api/admin/profiles/${String(ids.auditProfile)}`, { version: profile, permissions: ['audit.view', 'asset.retire'] }),
      'A5'
    )
    // A profile they do not hold: allowed, and it takes effect for its holders at once.
    const clerkVersion = (await h.ownerDb.selectFrom('permission_profiles').select('version').where('id', '=', ids.clerkProfile ?? 0).executeTakeFirstOrThrow()).version
    const edited = await admin('admin1', 'PATCH', `/api/admin/profiles/${String(ids.clerkProfile)}`, {
      version: clerkVersion,
      permissions: ['asset.view', 'asset.create', 'asset.edit']
    })
    expect(edited.statusCode, edited.body).toBe(200)
    const me = await call(h, { method: 'GET', url: '/api/me', cookie: cookies.clerk })
    expect(me.json<{ warehouses: { permissions: string[] }[] }>().warehouses[0]?.permissions).toEqual(['asset.create', 'asset.edit', 'asset.view'])
    expect((await auditRows(h, 'profile.updated')).at(-1)?.details).toMatchObject({ permissionsAdded: ['asset.edit'], permissionsRemoved: [] })
  })

  it('A6: assignments must use active profiles of the right scope in existing warehouses', async () => {
    const inactive = await insertProfile(h, 'Retired profile', 'warehouse', ['asset.view'])
    await h.ownerDb.updateTable('permission_profiles').set({ is_active: false }).where('id', '=', inactive).execute()
    for (const body of [
      { systemProfileIds: [], warehouseAssignments: [{ warehouseId: ids.whA, profileId: inactive }] },
      { systemProfileIds: [], warehouseAssignments: [{ warehouseId: ids.whA, profileId: ids.adminProfile }] },
      { systemProfileIds: [ids.clerkProfile], warehouseAssignments: [] },
      { systemProfileIds: [], warehouseAssignments: [{ warehouseId: 999_999, profileId: ids.clerkProfile }] }
    ]) {
      const res = await admin('owner', 'PUT', `/api/admin/users/${String(ids.plain)}/access`, { version: await userVersion(ids.plain ?? 0), ...body })
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
    }
  })

  it('refuses to delete a profile still assigned', async () => {
    const v = (await h.ownerDb.selectFrom('permission_profiles').select('version').where('id', '=', ids.clerkProfile ?? 0).executeTakeFirstOrThrow()).version
    const res = await admin('owner', 'DELETE', `/api/admin/profiles/${String(ids.clerkProfile)}?version=${String(v)}`)
    expect(res.json()).toMatchObject({ error: { code: 'PROFILE_IN_USE' } })
  })
})

describe('warehouses and job titles', () => {
  it('creates warehouses and job titles; the system warehouse UNASSIGNED is protected', async () => {
    const wh = await admin('admin1', 'POST', '/api/admin/warehouses', { code: 'SYN-C', name: 'Synthetic C' })
    expect(wh.statusCode).toBe(201)
    expect((await admin('admin1', 'POST', '/api/admin/warehouses', { code: 'SYN-C', name: 'Again' })).json()).toMatchObject({ error: { code: 'CODE_TAKEN' } })
    const unassigned = await h.ownerDb.selectFrom('warehouses').select(['id', 'version']).where('code', '=', 'UNASSIGNED').executeTakeFirstOrThrow()
    expect((await admin('owner', 'PATCH', `/api/admin/warehouses/${String(unassigned.id)}`, { version: unassigned.version, isActive: false })).statusCode).toBe(403)
    expect((await admin('admin1', 'PATCH', `/api/admin/warehouses/${String(ids.whA)}`, { version: 1, code: 'RENAMED' })).statusCode).toBe(400)

    const title = await admin('admin1', 'POST', '/api/admin/job-titles', { name: 'Warehouse keeper' })
    expect(title.statusCode).toBe(201)
    expect((await admin('admin1', 'POST', '/api/admin/job-titles', { name: 'warehouse KEEPER' })).json()).toMatchObject({ error: { code: 'NAME_TAKEN' } })
  })

  it('a job title grants nothing by itself', async () => {
    const title = (await h.ownerDb.selectFrom('job_titles').select('id').where('name', '=', 'Warehouse keeper').executeTakeFirstOrThrow()).id
    const id = ids.plain ?? 0
    expect((await admin('admin1', 'PATCH', `/api/admin/users/${String(id)}`, { version: await userVersion(id), jobTitleId: title })).statusCode).toBe(200)
    const me = await call(h, { method: 'GET', url: '/api/me', cookie: cookies.plain })
    expect(me.json()).toMatchObject({ user: { jobTitle: 'Warehouse keeper' }, systemPermissions: [], warehouses: [] })
  })
})

describe('audit trail access and warehouse isolation', () => {
  it('lets a warehouse auditor read their warehouse’s events only; any other warehouse is 404', async () => {
    const own = await admin('auditorA', 'GET', `/api/warehouses/${String(ids.whA)}/audit-events`)
    expect(own.statusCode).toBe(200)
    const events = own.json<{ events: { warehouseId: number; action: string }[] }>().events
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.warehouseId === ids.whA)).toBe(true)
    expect(events.some((e) => e.action === 'user.access_changed')).toBe(true)

    const other = await admin('auditorA', 'GET', `/api/warehouses/${String(ids.whB)}/audit-events`)
    const missing = await admin('auditorA', 'GET', '/api/warehouses/999999/audit-events')
    expect([other.statusCode, missing.statusCode]).toEqual([404, 404])
    // Identical apart from the request id: existence of warehouse B is not revealed.
    const strip = (r: LightMyRequestResponse) => JSON.stringify({ ...r.json<{ error: object }>().error, requestId: null })
    expect(strip(other)).toBe(strip(missing))
  })

  it('does not let a clerk of warehouse A read A’s audit events without audit.view', async () => {
    expect((await admin('clerk', 'GET', `/api/warehouses/${String(ids.whA)}/audit-events`)).statusCode).toBe(404)
  })

  it('lets the owner read any warehouse’s events', async () => {
    expect((await admin('owner', 'GET', `/api/warehouses/${String(ids.whB)}/audit-events`)).statusCode).toBe(200)
  })

  it('restricts the full audit trail to audit.view_all and pages through it newest first', async () => {
    expect((await admin('auditorA', 'GET', '/api/admin/audit-events')).statusCode).toBe(403)
    const first = await admin('admin1', 'GET', '/api/admin/audit-events?limit=5')
    expect(first.statusCode).toBe(200)
    const page1 = first.json<{ events: { id: string }[]; nextBefore: string | null }>()
    expect(page1.events).toHaveLength(5)
    const second = await admin('admin1', 'GET', `/api/admin/audit-events?limit=5&before=${page1.nextBefore ?? ''}`)
    const page2 = second.json<{ events: { id: string }[] }>()
    expect(BigInt(page2.events[0]?.id ?? '0')).toBeLessThan(BigInt(page1.events.at(-1)?.id ?? '0'))
  })

  it('records access changes with before/after values, per affected warehouse', async () => {
    const changes = (await auditRows(h, 'user.access_changed')).filter((e) => e.target_id === String(ids.newKeeper))
    expect(changes.some((e) => e.warehouse_id === ids.whA && JSON.stringify(e.details.after) === JSON.stringify([ids.clerkProfile]))).toBe(true)
  })
})
