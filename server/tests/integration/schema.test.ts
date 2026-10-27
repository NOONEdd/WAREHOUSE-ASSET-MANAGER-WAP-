import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_PERMISSIONS, WAREHOUSE_PERMISSIONS } from '../../src/access/permissions.js'
import { createHarness, insertProfile, insertUser, insertWarehouse, type Harness } from '../support/appHarness.js'

// Invariants the database itself enforces (migration 0002), tested as the
// role that would try to break them. These hold even if application code
// has a defect.

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.close()
})

const PERMISSION_DENIED = { code: '42501' }
const CHECK_VIOLATION = { code: '23514' }
const UNIQUE_VIOLATION = { code: '23505' }
const FK_VIOLATION = { code: '23503' }

describe('ownership', () => {
  it('allows at most one owner', async () => {
    await insertUser(h, { username: 'first.owner', isOwner: true })
    await expect(insertUser(h, { username: 'second.owner', isOwner: true })).rejects.toMatchObject(UNIQUE_VIOLATION)
  })

  it('never lets the owner be disabled — not even by the schema-owning role', async () => {
    await expect(sql`UPDATE wam.users SET status = 'disabled' WHERE is_owner`.execute(h.ownerDb)).rejects.toMatchObject(CHECK_VIOLATION)
  })

  it('gives the web server’s role no way to write is_owner', async () => {
    await expect(sql`UPDATE wam.users SET is_owner = true WHERE username = 'first.owner'`.execute(h.appDb)).rejects.toMatchObject(PERMISSION_DENIED)
    await expect(
      sql`INSERT INTO wam.users (username, display_name, is_owner) VALUES ('sneaky', 'Sneaky', true)`.execute(h.appDb)
    ).rejects.toMatchObject(PERMISSION_DENIED)
    // An ordinary insert by the same role works, so the denial above is specific.
    await sql`INSERT INTO wam.users (username, display_name) VALUES ('ordinary.user', 'Ordinary')`.execute(h.appDb)
  })

  it('gives the web server’s role no DELETE on users', async () => {
    await expect(sql`DELETE FROM wam.users WHERE username = 'ordinary.user'`.execute(h.appDb)).rejects.toMatchObject(PERMISSION_DENIED)
  })
})

describe('warehouses', () => {
  it('seeds exactly one system warehouse, UNASSIGNED, which cannot be deactivated', async () => {
    const rows = await h.ownerDb.selectFrom('warehouses').select(['code', 'is_active']).where('is_system', '=', true).execute()
    expect(rows).toEqual([{ code: 'UNASSIGNED', is_active: true }])
    await expect(sql`UPDATE wam.warehouses SET is_active = false WHERE code = 'UNASSIGNED'`.execute(h.ownerDb)).rejects.toMatchObject(
      CHECK_VIOLATION
    )
  })

  it('lets the server create ordinary warehouses but never system ones, and never delete', async () => {
    await sql`INSERT INTO wam.warehouses (code, name) VALUES ('SYN-A', 'Synthetic A')`.execute(h.appDb)
    await expect(
      sql`INSERT INTO wam.warehouses (code, name, is_system) VALUES ('SYN-B', 'Synthetic B', true)`.execute(h.appDb)
    ).rejects.toMatchObject(PERMISSION_DENIED)
    await expect(sql`DELETE FROM wam.warehouses WHERE code = 'SYN-A'`.execute(h.appDb)).rejects.toMatchObject(PERMISSION_DENIED)
  })

  it('enforces the code format and uniqueness', async () => {
    await expect(sql`INSERT INTO wam.warehouses (code, name) VALUES ('lower', 'x')`.execute(h.appDb)).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(sql`INSERT INTO wam.warehouses (code, name) VALUES ('SYN-A', 'x')`.execute(h.appDb)).rejects.toMatchObject(UNIQUE_VIOLATION)
  })
})

describe('permission catalogue and profiles', () => {
  it('matches the code catalogue exactly', async () => {
    const rows = await h.ownerDb.selectFrom('permissions').select(['code', 'scope', 'description']).orderBy('code').execute()
    const expected = [
      ...Object.entries(SYSTEM_PERMISSIONS).map(([code, description]) => ({ code, scope: 'system', description })),
      ...Object.entries(WAREHOUSE_PERMISSIONS).map(([code, description]) => ({ code, scope: 'warehouse', description }))
    ].sort((a, b) => (a.code < b.code ? -1 : 1))
    expect(rows).toEqual(expected)
  })

  it('is read-only for the web server', async () => {
    await expect(
      sql`INSERT INTO wam.permissions (code, scope, description) VALUES ('asset.delete', 'warehouse', 'x')`.execute(h.appDb)
    ).rejects.toMatchObject(PERMISSION_DENIED)
  })

  it('rejects a permission of the wrong scope inside a profile', async () => {
    const systemProfile = await insertProfile(h, 'Schema test system profile', 'system', ['user.view'])
    await expect(
      sql`INSERT INTO wam.permission_profile_permissions (profile_id, scope, permission) VALUES (${systemProfile}, 'system', 'asset.view')`.execute(
        h.appDb
      )
    ).rejects.toMatchObject(FK_VIOLATION)
    await expect(
      sql`INSERT INTO wam.permission_profile_permissions (profile_id, scope, permission) VALUES (${systemProfile}, 'warehouse', 'asset.view')`.execute(
        h.appDb
      )
    ).rejects.toMatchObject(FK_VIOLATION)
  })

  it('rejects assigning a system profile as a warehouse assignment, and vice versa', async () => {
    const user = await insertUser(h, { username: 'scope.test' })
    const warehouse = await insertWarehouse(h, 'SYN-SCOPE')
    const systemProfile = await insertProfile(h, 'Scope test admin', 'system', ['user.view'])
    const warehouseProfile = await insertProfile(h, 'Scope test clerk', 'warehouse', ['asset.view'])
    await expect(
      sql`INSERT INTO wam.user_warehouse_profiles (user_id, warehouse_id, profile_id) VALUES (${user}, ${warehouse}, ${systemProfile})`.execute(h.appDb)
    ).rejects.toMatchObject(FK_VIOLATION)
    await expect(
      sql`INSERT INTO wam.user_system_profiles (user_id, profile_id) VALUES (${user}, ${warehouseProfile})`.execute(h.appDb)
    ).rejects.toMatchObject(FK_VIOLATION)
  })

  it('makes profile names unique regardless of case', async () => {
    await insertProfile(h, 'Regional Supervisor', 'warehouse', [])
    await expect(insertProfile(h, 'regional supervisor', 'warehouse', [])).rejects.toMatchObject(UNIQUE_VIOLATION)
  })

  it('does not let a profile’s scope change after creation', async () => {
    const id = await insertProfile(h, 'Immutable scope', 'warehouse', ['asset.view'])
    await expect(sql`UPDATE wam.permission_profiles SET scope = 'system' WHERE id = ${id}`.execute(h.appDb)).rejects.toMatchObject(
      PERMISSION_DENIED
    )
  })
})

describe('audit trail', () => {
  beforeAll(async () => {
    await sql`INSERT INTO wam.audit_events (action, outcome, details) VALUES ('test.seeded', 'success', '{}')`.execute(h.appDb)
  })

  it('is append-only for the web server (no UPDATE, DELETE or TRUNCATE privilege)', async () => {
    for (const statement of ['UPDATE wam.audit_events SET outcome = $$denied$$', 'DELETE FROM wam.audit_events', 'TRUNCATE wam.audit_events']) {
      await expect(sql.raw(statement).execute(h.appDb), statement).rejects.toMatchObject(PERMISSION_DENIED)
    }
  })

  it('is append-only even for the role that owns the table (trigger)', async () => {
    for (const statement of ['UPDATE wam.audit_events SET outcome = $$denied$$', 'DELETE FROM wam.audit_events', 'TRUNCATE wam.audit_events']) {
      await expect(sql.raw(statement).execute(h.ownerDb), statement).rejects.toThrow(/append-only/)
    }
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM wam.audit_events WHERE action = 'test.seeded'`.execute(h.ownerDb)
    expect(rows[0]?.n).toBe(1)
  })

  it('validates action names and outcomes', async () => {
    await expect(sql`INSERT INTO wam.audit_events (action, outcome) VALUES ('Bad Action', 'success')`.execute(h.appDb)).rejects.toMatchObject(
      CHECK_VIOLATION
    )
    await expect(sql`INSERT INTO wam.audit_events (action, outcome) VALUES ('test.ok', 'maybe')`.execute(h.appDb)).rejects.toMatchObject(
      CHECK_VIOLATION
    )
  })
})

describe('sessions and secrets at rest', () => {
  it('store only 32-byte hashes, never longer values', async () => {
    const user = await insertUser(h, { username: 'hash.check' })
    await expect(
      sql`INSERT INTO wam.sessions (token_hash, user_id, expires_at) VALUES (${Buffer.from('a raw token, not a hash')}, ${user}, now() + interval '1 hour')`.execute(
        h.appDb
      )
    ).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(
      sql`INSERT INTO wam.password_setup_codes (user_id, code_hash, expires_at) VALUES (${user}, ${Buffer.from('ABCD-EFGH')}, now() + interval '1 hour')`.execute(
        h.appDb
      )
    ).rejects.toMatchObject(CHECK_VIOLATION)
  })

  it('accept only Argon2id password hashes', async () => {
    await expect(sql`UPDATE wam.users SET password_hash = 'plaintext' WHERE username = 'hash.check'`.execute(h.appDb)).rejects.toMatchObject(
      CHECK_VIOLATION
    )
  })
})
