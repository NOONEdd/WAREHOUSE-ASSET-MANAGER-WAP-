import { argon2Sync, randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sha256 } from '../../src/auth/secrets.js'
import { issueSetupCode } from '../../src/auth/setupCodes.js'
import { LOGIN_LIMITS } from '../../src/auth/throttle.js'
import {
  assignWarehouseProfile,
  auditRows,
  call,
  COOKIE_NAME,
  createHarness,
  GOOD_PASSWORD,
  insertProfile,
  insertUser,
  insertWarehouse,
  login,
  sessionCookieFrom,
  type Harness
} from '../support/appHarness.js'

// Authentication and session behavior (docs/security/identity-and-access.md
// §3–§4) through the real HTTP API, against PostgreSQL, as wam_app.

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.close()
})

const me = (cookie?: string) => call(h, { method: 'GET', url: '/api/me', ...(cookie === undefined ? {} : { cookie }) })

describe('login', () => {
  it('signs in with the right password and sets an HttpOnly, SameSite=Strict session cookie', async () => {
    const id = await insertUser(h, { username: 'login.ok', displayName: 'نام نمایشی' })
    const res = await call(h, { method: 'POST', url: '/api/auth/login', payload: { username: 'Login.OK ', password: GOOD_PASSWORD } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ user: { id, username: 'login.ok', displayName: 'نام نمایشی', isOwner: false } })
    expect(res.headers['set-cookie']).toMatch(new RegExp(`^${COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict$`))
    expect((await me(sessionCookieFrom(res))).statusCode).toBe(200)
  })

  it('stores only the hash of the session token', async () => {
    const cookie = await login(h, 'login.ok')
    const token = cookie.split('=')[1] ?? ''
    const rows = await h.ownerDb.selectFrom('sessions').select('token_hash').execute()
    expect(rows.some((r) => r.token_hash.equals(sha256(token)))).toBe(true)
    expect(rows.some((r) => r.token_hash.toString('utf8').includes(token))).toBe(false)
  })

  it('answers wrong password, unknown user, disabled user and not-yet-activated user identically', async () => {
    await insertUser(h, { username: 'login.disabled', status: 'disabled' })
    await insertUser(h, { username: 'login.pending', password: null })
    const attempts = [
      { username: 'login.ok', password: 'wrong-password-but-long' },
      { username: 'nobody.here', password: GOOD_PASSWORD },
      { username: 'login.disabled', password: GOOD_PASSWORD },
      { username: 'login.pending', password: GOOD_PASSWORD }
    ]
    const bodies = new Set<string>()
    for (const payload of attempts) {
      const res = await call(h, { method: 'POST', url: '/api/auth/login', payload, remoteAddress: '10.9.9.9' })
      expect(res.statusCode).toBe(401)
      expect(res.headers['set-cookie']).toBeUndefined()
      bodies.add(JSON.stringify({ ...res.json<{ error: Record<string, unknown> }>().error, requestId: null }))
    }
    expect([...bodies]).toEqual([JSON.stringify({ code: 'INVALID_CREDENTIALS', message: 'Incorrect username or password', requestId: null })])
  })

  it('audits successes and failures, naming only known accounts', async () => {
    const failed = await auditRows(h, 'auth.login.failed')
    expect(failed.map((r) => r.details.reason)).toEqual(expect.arrayContaining(['wrong_password', 'unknown_user', 'disabled', 'not_activated']))
    const unknown = failed.find((r) => r.details.reason === 'unknown_user')
    expect(unknown?.target_id).toBeNull()
    expect(JSON.stringify(failed)).not.toContain('nobody.here')
    expect((await auditRows(h, 'auth.login.succeeded')).length).toBeGreaterThanOrEqual(2)
  })

  it('ends the session already present in the browser when someone logs in again (ASVS V7.2.4)', async () => {
    const first = await login(h, 'login.ok')
    const second = await login(h, 'login.ok', GOOD_PASSWORD, { headers: { cookie: first } })
    expect(second).not.toBe(first)
    expect((await me(first)).statusCode).toBe(401)
    expect((await me(second)).statusCode).toBe(200)
  })

  it('upgrades a hash made with weaker parameters at the next login', async () => {
    const id = await insertUser(h, { username: 'login.rehash', password: null })
    // A real hash made with older, weaker parameters — as if the parameters had been raised since.
    const salt = randomBytes(16)
    const raw = argon2Sync('argon2id', { message: GOOD_PASSWORD, nonce: salt, memory: 8192, passes: 1, parallelism: 1, tagLength: 32 })
    const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '')
    const weakHash = `$argon2id$v=19$m=8192,t=1,p=1$${b64(salt)}$${b64(Buffer.from(raw))}`
    await sql`UPDATE wam.users SET password_hash = ${weakHash} WHERE id = ${id}`.execute(h.ownerDb)

    await login(h, 'login.rehash')
    const { password_hash: upgraded } = await h.ownerDb.selectFrom('users').select('password_hash').where('id', '=', id).executeTakeFirstOrThrow()
    expect(upgraded).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    await login(h, 'login.rehash') // and the upgraded hash still verifies
  })
})

describe('throttling (ASVS V6.1.1, V6.3.1)', () => {
  it(`refuses even the right password after ${String(LOGIN_LIMITS.perUsernameAndAddress)} failures from one address, without blocking other addresses`, async () => {
    await insertUser(h, { username: 'throttle.me' })
    for (let i = 0; i < LOGIN_LIMITS.perUsernameAndAddress; i += 1) {
      const res = await call(h, { method: 'POST', url: '/api/auth/login', payload: { username: 'throttle.me', password: 'not-the-password!' }, remoteAddress: '10.1.1.1' })
      expect(res.statusCode).toBe(401)
    }
    const blocked = await call(h, { method: 'POST', url: '/api/auth/login', payload: { username: 'throttle.me', password: GOOD_PASSWORD }, remoteAddress: '10.1.1.1' })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toMatchObject({ error: { code: 'TOO_MANY_REQUESTS' } })
    // The owner of the account can still sign in from elsewhere: no malicious permanent lockout.
    await login(h, 'throttle.me', GOOD_PASSWORD, { remoteAddress: '10.2.2.2' })
    expect((await auditRows(h, 'auth.login.throttled')).length).toBeGreaterThanOrEqual(1)
  })

  it('lets the window slide: old failures stop counting', async () => {
    await sql`UPDATE wam.auth_failures SET occurred_at = now() - interval '16 minutes' WHERE username_key = 'throttle.me'`.execute(h.superDb)
    await login(h, 'throttle.me', GOOD_PASSWORD, { remoteAddress: '10.1.1.1' })
  })
})

describe('sessions (ASVS V7)', () => {
  it('rejects requests without a session, with a forged token, or with a tossed duplicate cookie', async () => {
    expect((await me()).statusCode).toBe(401)
    expect((await me(`${COOKIE_NAME}=${'A'.repeat(43)}`)).statusCode).toBe(401)
    const real = await login(h, 'login.ok')
    expect((await me(`${real}; ${COOKIE_NAME}=${'B'.repeat(43)}`)).statusCode).toBe(401)
  })

  it('logout ends the session on the server, not just in the browser', async () => {
    const cookie = await login(h, 'login.ok')
    const res = await call(h, { method: 'POST', url: '/api/auth/logout', cookie })
    expect(res.statusCode).toBe(204)
    expect(res.headers['set-cookie']).toMatch(new RegExp(`^${COOKIE_NAME}=; Max-Age=0;`))
    expect((await me(cookie)).statusCode).toBe(401)
  })

  it('expires after the idle timeout', async () => {
    const cookie = await login(h, 'login.ok')
    const token = cookie.split('=')[1] ?? ''
    await sql`UPDATE wam.sessions SET last_seen_at = now() - interval '31 minutes' WHERE token_hash = ${sha256(token)}`.execute(h.superDb)
    expect((await me(cookie)).statusCode).toBe(401)
  })

  it('expires at the absolute lifetime even when active', async () => {
    const cookie = await login(h, 'login.ok')
    const token = cookie.split('=')[1] ?? ''
    await sql`UPDATE wam.sessions SET created_at = now() - interval '13 hours', expires_at = now() - interval '1 hour'
              WHERE token_hash = ${sha256(token)}`.execute(h.superDb)
    expect((await me(cookie)).statusCode).toBe(401)
  })

  it('ends every session when the account is disabled (ASVS V7.4.2)', async () => {
    const id = await insertUser(h, { username: 'to.disable' })
    const cookie = await login(h, 'to.disable')
    await sql`UPDATE wam.users SET status = 'disabled' WHERE id = ${id}`.execute(h.ownerDb)
    expect((await me(cookie)).statusCode).toBe(401)
  })

  it('keeps at most 5 sessions per user, ending the oldest', async () => {
    await insertUser(h, { username: 'many.sessions' })
    const cookies: string[] = []
    for (let i = 0; i < 6; i += 1) cookies.push(await login(h, 'many.sessions'))
    expect((await me(cookies[0])).statusCode).toBe(401)
    for (const cookie of cookies.slice(1)) expect((await me(cookie)).statusCode).toBe(200)
  })

  it('lists the user’s own sessions and ends the others after re-authentication (ASVS V7.5.2)', async () => {
    const id = await insertUser(h, { username: 'session.owner' })
    const a = await login(h, 'session.owner')
    const b = await login(h, 'session.owner')
    const list = await call(h, { method: 'GET', url: '/api/me/sessions', cookie: a })
    expect(list.statusCode).toBe(200)
    const sessions = list.json<{ sessions: { current: boolean }[] }>().sessions
    expect(sessions).toHaveLength(2)
    expect(sessions.filter((s) => s.current)).toHaveLength(1)

    const wrong = await call(h, { method: 'POST', url: '/api/me/sessions/end-others', cookie: a, payload: { currentPassword: 'not-my-password' } })
    expect(wrong.statusCode).toBe(400)
    expect((await me(b)).statusCode).toBe(200)

    const ok = await call(h, { method: 'POST', url: '/api/me/sessions/end-others', cookie: a, payload: { currentPassword: GOOD_PASSWORD } })
    expect(ok.json()).toEqual({ ended: 1 })
    expect((await me(b)).statusCode).toBe(401)
    expect((await me(a)).statusCode).toBe(200)
    expect((await auditRows(h, 'session.ended_others')).some((r) => r.actor_user_id === id)).toBe(true)
  })
})

describe('password change (ASVS V6.2.2, V6.2.3, V7.4.3)', () => {
  it('requires the current password, applies the policy, and ends the other sessions', async () => {
    await insertUser(h, { username: 'pw.change' })
    const current = await login(h, 'pw.change')
    const other = await login(h, 'pw.change')
    const change = (currentPassword: string, newPassword: string) =>
      call(h, { method: 'POST', url: '/api/auth/change-password', cookie: current, payload: { currentPassword, newPassword } })

    expect((await change('wrong-current-password', 'a brand new passphrase')).json()).toMatchObject({
      error: { code: 'CURRENT_PASSWORD_INCORRECT' }
    })
    const weak = await change(GOOD_PASSWORD, 'short')
    expect(weak.statusCode).toBe(400)
    expect(weak.json()).toMatchObject({ error: { code: 'PASSWORD_POLICY', details: { problems: ['too_short'] } } })
    expect((await change(GOOD_PASSWORD, 'my-warehouse-password-2026')).json()).toMatchObject({
      error: { details: { problems: ['contains_context_word'] } }
    })

    expect((await change(GOOD_PASSWORD, 'a brand new passphrase')).statusCode).toBe(204)
    expect((await me(current)).statusCode).toBe(200)
    expect((await me(other)).statusCode).toBe(401)
    expect((await call(h, { method: 'POST', url: '/api/auth/login', payload: { username: 'pw.change', password: GOOD_PASSWORD } })).statusCode).toBe(401)
    await login(h, 'pw.change', 'a brand new passphrase')
  })
})

describe('setup codes (ASVS V6.4.1)', () => {
  async function codeFor(userId: number): Promise<string> {
    return issueSetupCode(h.appDb, userId, null)
  }
  const setup = (username: string, setupCode: string, newPassword: string, remoteAddress = '10.5.5.5') =>
    call(h, { method: 'POST', url: '/api/auth/setup-password', payload: { username, setupCode, newPassword }, remoteAddress })

  it('lets a new user choose their own password once, then the code is spent', async () => {
    const id = await insertUser(h, { username: 'new.starter', password: null })
    const code = await codeFor(id)
    expect((await setup('new.starter', code.toLowerCase(), 'my own long passphrase')).statusCode).toBe(204)
    await login(h, 'new.starter', 'my own long passphrase')
    expect((await setup('new.starter', code, 'another long passphrase')).json()).toMatchObject({ error: { code: 'INVALID_SETUP_CODE' } })
    expect(await h.ownerDb.selectFrom('password_setup_codes').select('user_id').where('user_id', '=', id).executeTakeFirst()).toBeUndefined()
  })

  it('does not spend the code when the chosen password is rejected', async () => {
    const id = await insertUser(h, { username: 'picky.starter', password: null })
    const code = await codeFor(id)
    expect((await setup('picky.starter', code, 'too short')).json()).toMatchObject({ error: { code: 'PASSWORD_POLICY' } })
    expect((await setup('picky.starter', code, 'a fine long passphrase')).statusCode).toBe(204)
  })

  it('rejects wrong, expired, other users’ and disabled users’ codes alike', async () => {
    const a = await insertUser(h, { username: 'code.a', password: null })
    const b = await insertUser(h, { username: 'code.b', password: null })
    const off = await insertUser(h, { username: 'code.off', password: null, status: 'disabled' })
    const codeA = await codeFor(a)
    await codeFor(b)
    const codeOff = await codeFor(off)
    const expired = await insertUser(h, { username: 'code.expired', password: null })
    const codeExpired = await codeFor(expired)
    await sql`UPDATE wam.password_setup_codes SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
              WHERE user_id = ${expired}`.execute(h.superDb)

    for (const [username, code] of [
      ['code.b', codeA],
      ['code.a', 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH'],
      ['code.off', codeOff],
      ['code.expired', codeExpired],
      ['no.such.user', codeA]
    ] as const) {
      expect((await setup(username, code, 'a fine long passphrase', '10.6.6.6')).json()).toMatchObject({ error: { code: 'INVALID_SETUP_CODE' } })
    }
  })

  it('ends all existing sessions of the user when a setup completes', async () => {
    const id = await insertUser(h, { username: 'reset.me' })
    const cookie = await login(h, 'reset.me')
    const code = await codeFor(id)
    expect((await setup('reset.me', code, 'fresh long passphrase')).statusCode).toBe(204)
    expect((await me(cookie)).statusCode).toBe(401)
  })

  it('throttles guessing by address', async () => {
    for (let i = 0; i < 20; i += 1) await setup('code.a', 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH', 'a fine long passphrase', '10.7.7.7')
    expect((await setup('code.a', 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH', 'a fine long passphrase', '10.7.7.7')).statusCode).toBe(429)
  })
})

describe('GET /api/me', () => {
  it('lists only the warehouses and permissions the user was explicitly given', async () => {
    const id = await insertUser(h, { username: 'scoped.clerk' })
    const a = await insertWarehouse(h, 'SYN-ME-A')
    await insertWarehouse(h, 'SYN-ME-B')
    const clerk = await insertProfile(h, 'Me test clerk', 'warehouse', ['asset.view', 'asset.create'])
    await assignWarehouseProfile(h, id, a, clerk)
    const res = await me(await login(h, 'scoped.clerk'))
    expect(res.json()).toMatchObject({
      user: { username: 'scoped.clerk', isOwner: false, jobTitle: null },
      systemPermissions: [],
      warehouses: [{ id: a, code: 'SYN-ME-A', permissions: ['asset.create', 'asset.view'] }]
    })
  })

  it('stops granting a permission as soon as its profile is deactivated', async () => {
    const cookie = await login(h, 'scoped.clerk')
    await sql`UPDATE wam.permission_profiles SET is_active = false WHERE name = 'Me test clerk'`.execute(h.ownerDb)
    expect((await me(cookie)).json()).toMatchObject({ warehouses: [] })
  })
})

describe('secrets never reach the audit trail', () => {
  it('contains no password, setup code or session token used in this file', async () => {
    const all = JSON.stringify(await auditRows(h))
    for (const secret of [GOOD_PASSWORD, 'a brand new passphrase', 'my own long passphrase', 'fresh long passphrase', 'wrong-current-password']) {
      expect(all).not.toContain(secret)
    }
    const codes = await h.ownerDb.selectFrom('password_setup_codes').select('code_hash').execute()
    expect(codes.length).toBeGreaterThan(0)
    expect(all).not.toMatch(/[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}/)
    expect(all).not.toMatch(/[A-Za-z0-9_-]{43}/)
  })
})
