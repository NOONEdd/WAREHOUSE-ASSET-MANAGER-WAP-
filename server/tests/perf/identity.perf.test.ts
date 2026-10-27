import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import { CompiledQuery, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accessQuery } from '../../src/access/access.js'
import { auditEventsQuery } from '../../src/admin/auditQuery.js'
import { sha256 } from '../../src/auth/secrets.js'
import { sessionLookupQuery } from '../../src/auth/sessions.js'
import { cachedHash, createHarness, enrollMfa, GOOD_PASSWORD, ORIGIN, totpFor, type Harness } from '../support/appHarness.js'

// Measured, not claimed. Targets were fixed BEFORE the first run
// (docs/STATUS.md, "Performance"):
//   - authenticated reads: p95 ≤ 100 ms at 20 concurrent clients
//   - login: p95 ≤ 1,000 ms at 10 concurrent clients (Argon2id is deliberately costly)
//   - the per-request queries use indexes on the large tables (no sequential scans)
// Added with MFA (1B-2c), target fixed before its first run:
//   - second sign-in step (authenticator code): p95 ≤ 100 ms at 10 concurrent
//     clients — no slow hashing, one short write transaction
// Synthetic volume: 2,000 users, 50 warehouses, 30 profiles, 6,000 warehouse
// assignments, 5,000 sessions, 200,000 audit events, 10,000 recent failures,
// about 600 enrolled authenticators.

const TARGET_READ_P95_MS = 100
const TARGET_SECOND_STEP_P95_MS = 100
const TARGET_LOGIN_P95_MS = 1_000

let h: Harness
let base: string

interface Stats {
  readonly n: number
  readonly concurrency: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly perSecond: number
}

async function measure(n: number, concurrency: number, request: (i: number) => Promise<Response>): Promise<Stats> {
  const latencies: number[] = []
  let next = 0
  let failures = 0
  const started = performance.now()
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < n) {
        const i = next
        next += 1
        const t0 = performance.now()
        const res = await request(i)
        await res.arrayBuffer()
        latencies.push(performance.now() - t0)
        if (!res.ok) failures += 1
      }
    })
  )
  const elapsed = performance.now() - started
  expect(failures, 'every measured request must succeed').toBe(0)
  latencies.sort((a, b) => a - b)
  const at = (q: number) => Math.round((latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0) * 10) / 10
  return { n, concurrency, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1), perSecond: Math.round((n / elapsed) * 1000) }
}

const results: {
  login?: Stats
  secondStep?: Stats
  me?: Stats
  adminUsers?: Stats
  warehouseAudit?: Stats
  plans?: readonly string[]
} = {}

beforeAll(async () => {
  h = await createHarness()
  const hash = await cachedHash(GOOD_PASSWORD)
  const o = h.ownerDb
  await sql`INSERT INTO wam.warehouses (code, name) SELECT 'PERF-' || lpad(i::text, 3, '0'), 'Synthetic ' || i FROM generate_series(1, 50) i`.execute(o)
  await sql`INSERT INTO wam.permission_profiles (name, scope) SELECT 'Perf profile ' || i, 'warehouse' FROM generate_series(1, 30) i`.execute(o)
  await sql`INSERT INTO wam.permission_profile_permissions (profile_id, scope, permission)
            SELECT p.id, 'warehouse', perm.code FROM wam.permission_profiles p
            JOIN wam.permissions perm ON perm.scope = 'warehouse' AND (abs(hashtext(p.name || perm.code)) % 2 = 0)`.execute(o)
  await sql`INSERT INTO wam.users (username, display_name, password_hash)
            SELECT 'perf.user' || i, 'کاربر آزمایشی ' || i, ${hash} FROM generate_series(1, 2000) i`.execute(o)
  await sql`INSERT INTO wam.user_warehouse_profiles (user_id, warehouse_id, profile_id)
            SELECT u.id, w.id, p.id
              FROM wam.users u
              CROSS JOIN LATERAL (VALUES (u.id % 50), ((u.id + 7) % 50), ((u.id + 19) % 50)) AS pick(n)
              JOIN wam.warehouses w ON w.code = 'PERF-' || lpad((pick.n + 1)::text, 3, '0')
              JOIN wam.permission_profiles p ON p.name = 'Perf profile ' || ((u.id % 30) + 1)`.execute(o)
  await sql`INSERT INTO wam.sessions (token_hash, user_id, expires_at, created_at)
            SELECT sha256(('synthetic-' || i)::bytea), (SELECT min(id) FROM wam.users) + (i % 2000), now() + interval '6 hours', now() - interval '1 hour'
              FROM generate_series(1, 5000) i`.execute(o)
  await sql`INSERT INTO wam.audit_events (action, outcome, warehouse_id, details)
            SELECT 'perf.synthetic_event', 'success', (SELECT min(id) FROM wam.warehouses) + (i % 51), '{}'::jsonb
              FROM generate_series(1, 200000) i`.execute(o)
  // Enrolled authenticators for the planner's statistics (never used to sign in: the sealed values are filler).
  await sql`INSERT INTO wam.user_mfa (user_id, totp_secret, totp_key_id)
            SELECT u.id, decode(md5(u.id::text) || md5('b' || u.id) || md5('c' || u.id), 'hex'), '0000000000000000'
              FROM wam.users u WHERE u.username SIMILAR TO 'perf.user1(5|6|7|8|9)[0-9][0-9]'`.execute(o)
  await sql`INSERT INTO wam.auth_failures (kind, username_key, source_ip)
            SELECT 'login', 'perf.user' || (i % 2000), ('10.' || (i % 250) || '.0.1')::inet FROM generate_series(1, 10000) i`.execute(o)
  await sql`ANALYZE`.execute(h.superDb)
  await h.app.listen({ host: '127.0.0.1', port: 0 })
  base = `http://127.0.0.1:${String((h.app.server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  console.log(`\nPERF RESULTS ${JSON.stringify(results, null, 2)}`)
  await h.close()
})

const postJson = (path: string, body: unknown, cookie?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-wam-csrf': '1', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body)
  })

function cookieNamed(res: Response, name: string): string {
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .find((c) => c.startsWith(`${name}=`) && c !== `${name}=`)
  if (cookie === undefined) throw new Error(`no ${name} cookie`)
  return cookie
}

/** The password step; returns the second-step cookie when the account needs one, else the session cookie. */
async function passwordStep(username: string): Promise<{ readonly status: number; readonly cookie: string }> {
  const res = await postJson('/api/auth/login', { username, password: GOOD_PASSWORD })
  expect([200, 202]).toContain(res.status)
  return { status: res.status, cookie: cookieNamed(res, res.status === 200 ? 'wam_session' : 'wam_mfa') }
}

/** A full sign-in, with the second step when the account needs one. */
async function loginCookie(username: string): Promise<string> {
  const first = await passwordStep(username)
  if (first.status === 200) return first.cookie
  const { id } = await h.ownerDb.selectFrom('users').select('id').where('username', '=', username).executeTakeFirstOrThrow()
  const res = await postJson('/api/auth/mfa/verify', { code: await totpFor(h, id) }, first.cookie)
  expect(res.status).toBe(200)
  return cookieNamed(res, 'wam_session')
}

describe('performance (synthetic volume)', () => {
  it(`login: p95 ≤ ${String(TARGET_LOGIN_P95_MS)} ms at 10 concurrent`, async () => {
    const stats = await measure(100, 10, (i) => postJson('/api/auth/login', { username: `perf.user${String(i + 1)}`, password: GOOD_PASSWORD }))
    results.login = stats
    expect(stats.p95).toBeLessThanOrEqual(TARGET_LOGIN_P95_MS)
  })

  it(`second sign-in step (authenticator code): p95 ≤ ${String(TARGET_SECOND_STEP_P95_MS)} ms at 10 concurrent`, async () => {
    const users = await h.ownerDb.selectFrom('users').select(['id', 'username']).where('username', 'like', 'perf.user10__').orderBy('id').limit(100).execute()
    expect(users).toHaveLength(100)
    const challenges: string[] = []
    const codes: string[] = []
    for (const user of users) {
      await enrollMfa(h, user.id)
      const step = await passwordStep(user.username)
      expect(step.status).toBe(202)
      challenges.push(step.cookie)
      codes.push(await totpFor(h, user.id))
    }
    const stats = await measure(100, 10, (i) => postJson('/api/auth/mfa/verify', { code: codes[i] ?? '' }, challenges[i] ?? ''))
    results.secondStep = stats
    expect(stats.p95).toBeLessThanOrEqual(TARGET_SECOND_STEP_P95_MS)
  })

  it(`authenticated read GET /api/me: p95 ≤ ${String(TARGET_READ_P95_MS)} ms at 20 concurrent`, async () => {
    const cookies = await Promise.all(Array.from({ length: 20 }, (_, i) => loginCookie(`perf.user${String(i + 200)}`)))
    const stats = await measure(2000, 20, (i) => fetch(`${base}/api/me`, { headers: { cookie: cookies[i % cookies.length] ?? '' } }))
    results.me = stats
    expect(stats.p95).toBeLessThanOrEqual(TARGET_READ_P95_MS)
  })

  it(`admin list and audit page: p95 ≤ ${String(TARGET_READ_P95_MS)} ms at 20 concurrent`, async () => {
    const ownerId = (await h.ownerDb.selectFrom('users').select('id').where('username', '=', 'perf.user1').executeTakeFirstOrThrow()).id
    await sql`UPDATE wam.users SET is_owner = true WHERE id = ${ownerId}`.execute(h.ownerDb)
    await enrollMfa(h, ownerId)
    const cookie = await loginCookie('perf.user1')
    const warehouseId = (await h.ownerDb.selectFrom('warehouses').select('id').where('code', '=', 'PERF-010').executeTakeFirstOrThrow()).id
    const adminUsers = await measure(1000, 20, (i) => fetch(`${base}/api/admin/users?limit=50&search=perf.user${String(i % 9)}`, { headers: { cookie } }))
    const warehouseAudit = await measure(1000, 20, () => fetch(`${base}/api/warehouses/${String(warehouseId)}/audit-events?limit=50`, { headers: { cookie } }))
    results.adminUsers = adminUsers
    results.warehouseAudit = warehouseAudit
    expect(adminUsers.p95).toBeLessThanOrEqual(TARGET_READ_P95_MS)
    expect(warehouseAudit.p95).toBeLessThanOrEqual(TARGET_READ_P95_MS)
  })

  it('the per-request queries use indexes on the large tables', async () => {
    const userId = (await h.ownerDb.selectFrom('users').select('id').where('username', '=', 'perf.user300').executeTakeFirstOrThrow()).id
    const warehouseId = (await h.ownerDb.selectFrom('warehouses').select('id').where('code', '=', 'PERF-010').executeTakeFirstOrThrow()).id
    const plans: Record<string, string[]> = {}
    interface PlanNode {
      readonly 'Node Type': string
      readonly 'Relation Name'?: string
      readonly 'Index Name'?: string
      readonly Plans?: readonly PlanNode[]
    }
    const explain = async (name: string, compiled: { sql: string; parameters: readonly unknown[] }) => {
      const { rows } = await h.appDb.executeQuery<{ 'QUERY PLAN': readonly { Plan: PlanNode }[] }>(
        CompiledQuery.raw(`EXPLAIN (FORMAT JSON) ${compiled.sql}`, [...compiled.parameters])
      )
      const nodes: string[] = []
      const walk = (node: PlanNode) => {
        const relation = node['Relation Name'] === undefined ? '' : ` on ${node['Relation Name']}`
        const index = node['Index Name'] === undefined ? '' : ` using ${node['Index Name']}`
        nodes.push(`${node['Node Type']}${relation}${index}`)
        for (const child of node.Plans ?? []) walk(child)
      }
      const root = rows[0]?.['QUERY PLAN'][0]?.Plan
      if (root === undefined) throw new Error(`no plan for ${name}`)
      walk(root)
      plans[name] = nodes
    }
    await explain('session lookup', sessionLookupQuery(h.appDb, sha256('x'.repeat(43)), 30).compile())
    await explain('access', accessQuery(userId).compile(h.appDb))
    await explain('warehouse audit page', auditEventsQuery(h.appDb, { warehouseId, limit: 50 }).compile())
    results.plans = Object.entries(plans).map(([name, nodes]) => `${name}: ${nodes.join(' → ')}`)

    // Tables that grow with use. Deliberately not listed: user_system_profiles
    // (one row per administrator), permission_profiles and permissions (tens of
    // rows) — for tables that small a sequential scan is the planner's correct,
    // cheapest choice; their primary-key indexes are used once they grow.
    const large = ['sessions', 'audit_events', 'users', 'user_warehouse_profiles', 'user_mfa']
    for (const [name, nodes] of Object.entries(plans)) {
      for (const table of large) {
        expect(nodes.some((n) => n === `Seq Scan on ${table}`), `${name} must not scan ${table} sequentially: ${nodes.join(' → ')}`).toBe(false)
      }
    }
  })
})
