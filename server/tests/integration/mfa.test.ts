import { randomBytes, randomUUID } from 'node:crypto'
import type { LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { MFA_MAX_FAILED_ATTEMPTS, RECOVERY_CODE_COUNT } from '../../src/auth/mfa.js'
import { runMaintenance } from '../../src/maintenance.js'
import { totpCode } from '../../src/auth/totp.js'
import {
  assignSystemProfile,
  auditRows,
  call,
  CHALLENGE_COOKIE_NAME,
  COOKIE_NAME,
  cookieFrom,
  createHarness,
  enrollMfa,
  GOOD_PASSWORD,
  insertProfile,
  insertUser,
  login,
  ORIGIN,
  sessionCookieFrom,
  SESSIONS,
  totpFor,
  type Harness
} from '../support/appHarness.js'
import { base32Decode } from '../support/base32.js'

// Multi-factor authentication (decision O-07; docs/security/identity-and-access.md
// §3.2) through the real HTTP API, against PostgreSQL, as wam_app: who must
// use it, the second sign-in step, single use, the failure lock and its
// recovery paths, enforcement on every request, self-service changes,
// administrator resets and the owner-only policy.

let h: Harness
const ids = {} as Record<'owner' | 'admin' | 'adminProfile', number>
let ownerCookie = ''
let adminCookie = ''
/** Every authenticator secret and recovery code handed out here, for the audit scan at the end. */
const issuedSecrets: string[] = []

const ADMIN_PERMISSIONS = ['user.view', 'user.manage', 'profile.manage', 'job_title.manage', 'warehouse.manage', 'audit.view_all']

beforeAll(async () => {
  h = await createHarness()
  ids.owner = await insertUser(h, { username: 'mfa.owner', isOwner: true })
  ids.admin = await insertUser(h, { username: 'mfa.admin' })
  ids.adminProfile = await insertProfile(h, 'MFA test administrator', 'system', ADMIN_PERMISSIONS)
  await assignSystemProfile(h, ids.admin, ids.adminProfile)
  ownerCookie = await login(h, 'mfa.owner')
  adminCookie = await login(h, 'mfa.admin')
})

afterAll(async () => {
  await h.close()
})

const now = () => Math.floor(Date.now() / 1000)

function passwordStep(username: string, password: string = GOOD_PASSWORD): Promise<LightMyRequestResponse> {
  return call(h, { method: 'POST', url: '/api/auth/login', payload: { username, password } })
}

async function challengeFor(username: string, expectedNext: 'mfa_verify' | 'mfa_enroll'): Promise<string> {
  const res = await passwordStep(username)
  expect(res.statusCode, res.body).toBe(202)
  expect(res.json()).toEqual({ next: expectedNext, expiresInSeconds: expectedNext === 'mfa_verify' ? 300 : 600 })
  return cookieFrom(res, CHALLENGE_COOKIE_NAME)
}

const verify = (challenge: string, code: string) => call(h, { method: 'POST', url: '/api/auth/mfa/verify', cookie: challenge, payload: { code } })
const me = (cookie: string) => call(h, { method: 'GET', url: '/api/me', cookie })
const errorCode = (res: LightMyRequestResponse) => res.json<{ error: { code: string } }>().error.code

/** Signs a not-yet-enrolled user in through enrolment; returns the session, the secret and the recovery codes. */
async function enrollAtSignIn(username: string): Promise<{ cookie: string; secret: Buffer; recoveryCodes: string[] }> {
  const challenge = await challengeFor(username, 'mfa_enroll')
  const started = await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/start', cookie: challenge })
  expect(started.statusCode, started.body).toBe(200)
  const { secret } = started.json<{ secret: string }>()
  issuedSecrets.push(secret)
  const raw = base32Decode(secret)
  const confirmed = await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/confirm', cookie: challenge, payload: { code: totpCode(raw, now()) } })
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  const { recoveryCodes } = confirmed.json<{ recoveryCodes: string[] }>()
  issuedSecrets.push(...recoveryCodes)
  return { cookie: sessionCookieFrom(confirmed), secret: raw, recoveryCodes }
}

async function setPolicy(mfaRequiredFor: 'privileged' | 'all_users'): Promise<void> {
  const current = await call(h, { method: 'GET', url: '/api/admin/security-policy', cookie: ownerCookie })
  expect(current.statusCode, current.body).toBe(200)
  const res = await call(h, {
    method: 'PUT',
    url: '/api/admin/security-policy',
    cookie: ownerCookie,
    headers: { 'idempotency-key': randomUUID() },
    payload: { version: current.json<{ version: number }>().version, mfaRequiredFor }
  })
  expect(res.statusCode, res.body).toBe(200)
}

async function failedAttempts(userId: number): Promise<number> {
  const row = await h.ownerDb.selectFrom('user_mfa').select('failed_attempts').where('user_id', '=', userId).executeTakeFirstOrThrow()
  return row.failed_attempts
}

describe('who must use a second factor (§3.2.1)', () => {
  it('an ordinary user without an authenticator signs in with the password alone under the default policy', async () => {
    await insertUser(h, { username: 'plain.staff' })
    const res = await passwordStep('plain.staff')
    expect(res.statusCode).toBe(200)
    expect((await me(sessionCookieFrom(res))).statusCode).toBe(200)
  })

  it('the owner without an authenticator gets no session — only the enrolment step', async () => {
    // One owner exists; simulate its first sign-in by removing its authenticator, then restore one.
    await h.ownerDb.deleteFrom('user_mfa').where('user_id', '=', ids.owner).execute()
    try {
      const res = await passwordStep('mfa.owner')
      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({ next: 'mfa_enroll', expiresInSeconds: 600 })
      expect(() => sessionCookieFrom(res)).toThrow()
    } finally {
      await enrollMfa(h, ids.owner)
    }
  })

  it('an administrator without an authenticator gets no session — only the enrolment step', async () => {
    const id = await insertUser(h, { username: 'fresh.admin' })
    await assignSystemProfile(h, id, ids.adminProfile)
    const res = await passwordStep('fresh.admin')
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ next: 'mfa_enroll', expiresInSeconds: 600 })
    expect(() => sessionCookieFrom(res)).toThrow()
    // The second-step token is not a session token.
    expect((await me(cookieFrom(res, CHALLENGE_COOKIE_NAME).replace(CHALLENGE_COOKIE_NAME, COOKIE_NAME))).statusCode).toBe(401)
  })

  it('anyone with an authenticator must use it, even when the policy does not require it', async () => {
    const id = await insertUser(h, { username: 'volunteer.staff' })
    await enrollMfa(h, id)
    await challengeFor('volunteer.staff', 'mfa_verify')
  })

  it('under the all_users policy every user without an authenticator must enrol before getting a session', async () => {
    await insertUser(h, { username: 'policy.staff' })
    await setPolicy('all_users')
    try {
      await challengeFor('policy.staff', 'mfa_enroll')
    } finally {
      await setPolicy('privileged')
    }
    expect((await passwordStep('policy.staff')).statusCode).toBe(200)
  })

  it('a missing policy row counts as all_users (fail closed)', async () => {
    await insertUser(h, { username: 'failclosed.staff' })
    const saved = await h.superDb.selectFrom('security_policy').selectAll().executeTakeFirstOrThrow()
    await sql`DELETE FROM wam.security_policy`.execute(h.superDb)
    try {
      await challengeFor('failclosed.staff', 'mfa_enroll')
    } finally {
      await sql`INSERT INTO wam.security_policy (id, mfa_required_for, version) VALUES (true, ${saved.mfa_required_for}, ${saved.version})`.execute(h.superDb)
    }
  })
})

describe('enrolment at sign-in (§3.2.4)', () => {
  it('activates only after a code from the app proves the setup, then returns recovery codes and a second-factor session', async () => {
    const id = await insertUser(h, { username: 'enrol.admin' })
    await assignSystemProfile(h, id, ids.adminProfile)
    const challenge = await challengeFor('enrol.admin', 'mfa_enroll')
    const started = await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/start', cookie: challenge })
    expect(started.statusCode).toBe(200)
    const body = started.json<{ secret: string; otpauthUri: string; expiresInMinutes: number }>()
    issuedSecrets.push(body.secret)
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(body.otpauthUri).toBe(`otpauth://totp/WAM:enrol.admin?secret=${body.secret}&issuer=WAM&algorithm=SHA1&digits=6&period=30`)
    expect(body.expiresInMinutes).toBe(10)
    // Nothing is active yet.
    expect(await h.ownerDb.selectFrom('user_mfa').select('user_id').where('user_id', '=', id).executeTakeFirst()).toBeUndefined()

    const secret = base32Decode(body.secret)
    const wrong = await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/confirm', cookie: challenge, payload: { code: totpCode(randomBytes(20), now()) } })
    expect(wrong.statusCode).toBe(400)
    expect(errorCode(wrong)).toBe('INVALID_MFA_CODE')
    expect(wrong.headers['set-cookie']).toBeUndefined()

    const confirmed = await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/confirm', cookie: challenge, payload: { code: totpCode(secret, now()) } })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const { recoveryCodes, user } = confirmed.json<{ recoveryCodes: string[]; user: { username: string } }>()
    issuedSecrets.push(...recoveryCodes)
    expect(user.username).toBe('enrol.admin')
    expect(recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT)
    for (const c of recoveryCodes) expect(c).toMatch(/^([A-Z2-7]{4}-){5}[A-Z2-7]{4}$/)
    // The second-step cookie is cleared; the session works and is marked as established with a second factor.
    expect(confirmed.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${CHALLENGE_COOKIE_NAME}=; Max-Age=0`))]))
    const cookie = sessionCookieFrom(confirmed)
    expect((await me(cookie)).statusCode).toBe(200)
    const sessions = await h.ownerDb.selectFrom('sessions').select('mfa_verified').where('user_id', '=', id).execute()
    expect(sessions).toEqual([{ mfa_verified: true }])
    // Stored only sealed and hashed.
    const stored = await h.ownerDb.selectFrom('user_mfa').select('totp_secret').where('user_id', '=', id).executeTakeFirstOrThrow()
    expect(stored.totp_secret.includes(secret)).toBe(false)
    const hashes = await h.ownerDb.selectFrom('mfa_recovery_codes').select('code_hash').where('user_id', '=', id).execute()
    expect(hashes).toHaveLength(RECOVERY_CODE_COUNT)
    // The challenge is used up.
    expect((await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/confirm', cookie: challenge, payload: { code: '000000' } })).statusCode).toBe(401)
    expect((await auditRows(h, 'auth.login.succeeded')).filter((e) => e.target_id === String(id)).map((e) => e.details.method)).toEqual(['password+totp'])
  })

  it('refuses a confirmation after the pending enrolment expired', async () => {
    const id = await insertUser(h, { username: 'slow.admin' })
    await assignSystemProfile(h, id, ids.adminProfile)
    const challenge = await challengeFor('slow.admin', 'mfa_enroll')
    const started = await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/start', cookie: challenge })
    const secret = base32Decode(started.json<{ secret: string }>().secret)
    await sql`UPDATE wam.mfa_enrollments SET created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'
              WHERE user_id = ${id}`.execute(h.superDb)
    const res = await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/confirm', cookie: challenge, payload: { code: totpCode(secret, now()) } })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('MFA_ENROLLMENT_EXPIRED')
  })

  it('never overwrites an existing authenticator from the sign-in path', async () => {
    const id = await insertUser(h, { username: 'raced.admin' })
    await assignSystemProfile(h, id, ids.adminProfile)
    const challenge = await challengeFor('raced.admin', 'mfa_enroll')
    const started = await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/start', cookie: challenge })
    const secret = base32Decode(started.json<{ secret: string }>().secret)
    const existing = await enrollMfa(h, id)
    const res = await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/confirm', cookie: challenge, payload: { code: totpCode(secret, now()) } })
    expect(res.statusCode).toBe(409)
    expect(errorCode(res)).toBe('MFA_ALREADY_ENROLLED')
    expect((await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/start', cookie: challenge })).statusCode).toBe(409)
    // The original authenticator still works.
    expect(existing).toHaveLength(20)
    expect((await verify(await challengeFor('raced.admin', 'mfa_verify'), await totpFor(h, id))).statusCode).toBe(200)
  })
})

describe('the second step (§3.2.2–§3.2.4)', () => {
  it('needs a live challenge of the right kind', async () => {
    const id = await insertUser(h, { username: 'challenge.staff' })
    await enrollMfa(h, id)
    expect((await call(h, { method: 'POST', url: '/api/auth/mfa/verify', payload: { code: '123456' } })).statusCode).toBe(401)
    expect((await verify(`${CHALLENGE_COOKIE_NAME}=${'A'.repeat(43)}`, await totpFor(h, id))).statusCode).toBe(401)
    const challenge = await challengeFor('challenge.staff', 'mfa_verify')
    // A verification challenge cannot start an enrolment.
    expect((await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/start', cookie: challenge })).statusCode).toBe(401)
    // An expired challenge is refused even with the right code.
    await sql`UPDATE wam.login_challenges SET created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes'
              WHERE user_id = ${id}`.execute(h.superDb)
    expect((await verify(challenge, await totpFor(h, id))).statusCode).toBe(401)
  })

  it('refuses a challenge whose user was disabled meanwhile', async () => {
    const id = await insertUser(h, { username: 'disabled.between' })
    await enrollMfa(h, id)
    const challenge = await challengeFor('disabled.between', 'mfa_verify')
    await sql`UPDATE wam.users SET status = 'disabled' WHERE id = ${id}`.execute(h.ownerDb)
    expect((await verify(challenge, await totpFor(h, id))).statusCode).toBe(401)
  })

  it('creates the session with a correct code, and never accepts the same code twice (ASVS V6.5.1)', async () => {
    const id = await insertUser(h, { username: 'once.staff' })
    await enrollMfa(h, id)
    const code = await totpFor(h, id)
    const first = await verify(await challengeFor('once.staff', 'mfa_verify'), code)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ user: { username: 'once.staff' }, recoveryCodesRemaining: 0 })
    expect((await me(sessionCookieFrom(first))).statusCode).toBe(200)
    const replay = await verify(await challengeFor('once.staff', 'mfa_verify'), code)
    expect(replay.statusCode).toBe(400)
    expect(errorCode(replay)).toBe('INVALID_MFA_CODE')
  })

  it('accepts one code exactly once even when submitted twice at the same moment', async () => {
    const id = await insertUser(h, { username: 'double.click' })
    await enrollMfa(h, id)
    const challenge = await challengeFor('double.click', 'mfa_verify')
    const code = await totpFor(h, id)
    const results = await Promise.all([verify(challenge, code), verify(challenge, code)])
    // The loser finds either the code (400) or the challenge (401) already used up.
    const statuses = results.map((r) => r.statusCode)
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect(statuses.filter((s) => s !== 200).every((s) => s === 400 || s === 401)).toBe(true)
    expect(await h.ownerDb.selectFrom('sessions').select('id').where('user_id', '=', id).execute()).toHaveLength(1)
  })

  it('completes at most one sign-in per challenge, even with another valid code', async () => {
    const id = await insertUser(h, { username: 'reuse.challenge' })
    await enrollMfa(h, id)
    const challenge = await challengeFor('reuse.challenge', 'mfa_verify')
    expect((await verify(challenge, await totpFor(h, id))).statusCode).toBe(200)
    // The next step's code is valid for this user, but the challenge is used up.
    const again = await verify(challenge, await totpFor(h, id, { offsetSeconds: 30, keepSingleUse: true }))
    expect(again.statusCode).toBe(401)
    expect(await h.ownerDb.selectFrom('sessions').select('id').where('user_id', '=', id).execute()).toHaveLength(1)
  })

  it('refuses even the right code once the account is locked, on a challenge opened before the lock', async () => {
    const id = await insertUser(h, { username: 'locked.meanwhile' })
    await enrollMfa(h, id)
    const cookie = await login(h, 'locked.meanwhile')
    // Opened after that sign-in: a new challenge replaces the user's previous one.
    const challenge = await challengeFor('locked.meanwhile', 'mfa_verify')
    // The lock is reached elsewhere meanwhile (here: wrong codes in self-service re-authentication).
    for (let i = 0; i < MFA_MAX_FAILED_ATTEMPTS; i += 1) {
      const res = await call(h, { method: 'POST', url: '/api/me/mfa/recovery-codes', cookie, payload: { currentPassword: GOOD_PASSWORD, code: '000000' } })
      expect(res.statusCode).toBe(i === MFA_MAX_FAILED_ATTEMPTS - 1 ? 423 : 400)
    }
    const res = await verify(challenge, await totpFor(h, id, { offsetSeconds: 30 }))
    expect(res.statusCode).toBe(423)
    expect(errorCode(res)).toBe('MFA_LOCKED')
    const selfService = await call(h, { method: 'POST', url: '/api/me/mfa/recovery-codes', cookie, payload: { currentPassword: GOOD_PASSWORD, code: await totpFor(h, id) } })
    expect(selfService.statusCode).toBe(423)
  })

  it('accepts each recovery code once, and reports how many remain', async () => {
    const { recoveryCodes } = await (async () => {
      const id = await insertUser(h, { username: 'recovery.admin' })
      await assignSystemProfile(h, id, ids.adminProfile)
      return enrollAtSignIn('recovery.admin')
    })()
    const code = recoveryCodes[0] ?? ''
    const used = await verify(await challengeFor('recovery.admin', 'mfa_verify'), code.toLowerCase().replace(/-/g, ' '))
    expect(used.statusCode).toBe(200)
    expect(used.json()).toMatchObject({ recoveryCodesRemaining: RECOVERY_CODE_COUNT - 1 })
    const again = await verify(await challengeFor('recovery.admin', 'mfa_verify'), code)
    expect(again.statusCode).toBe(400)
    const success = await auditRows(h, 'auth.login.succeeded')
    expect(success.at(-1)?.details).toMatchObject({ method: 'password+recovery_code', recoveryCodesRemaining: RECOVERY_CODE_COUNT - 1 })
  })

  it('locks second-factor sign-in after 10 consecutive wrong codes; a correct code before that resets the count (§3.2.5)', async () => {
    const id = await insertUser(h, { username: 'guessed.staff' })
    await enrollMfa(h, id)
    const challenge = await challengeFor('guessed.staff', 'mfa_verify')
    const correct = await totpFor(h, id)
    const wrong = correct === '000000' ? '111111' : '000000'
    for (let i = 0; i < MFA_MAX_FAILED_ATTEMPTS - 1; i += 1) expect((await verify(challenge, wrong)).statusCode).toBe(400)
    expect(await failedAttempts(id)).toBe(MFA_MAX_FAILED_ATTEMPTS - 1)
    expect((await verify(challenge, correct)).statusCode).toBe(200)
    expect(await failedAttempts(id)).toBe(0)

    const next = await challengeFor('guessed.staff', 'mfa_verify')
    for (let i = 0; i < MFA_MAX_FAILED_ATTEMPTS - 1; i += 1) expect((await verify(next, wrong)).statusCode).toBe(400)
    const locking = await verify(next, wrong)
    expect(locking.statusCode).toBe(423)
    expect(errorCode(locking)).toBe('MFA_LOCKED')
    expect((await auditRows(h, 'auth.mfa.locked')).filter((e) => e.target_id === String(id))).toHaveLength(1)
    // Locked: the right code no longer helps, and the password step stops before any challenge.
    const blocked = await passwordStep('guessed.staff')
    expect(blocked.statusCode).toBe(423)
    expect(blocked.headers['set-cookie']).toBeUndefined()
    expect(await failedAttempts(id)).toBe(MFA_MAX_FAILED_ATTEMPTS)
  })

  it('is unlocked by a password reset, which still does not bypass the second factor (ASVS V6.4.3)', async () => {
    const id = await insertUser(h, { username: 'unlocked.staff' })
    await enrollMfa(h, id)
    await sql`UPDATE wam.user_mfa SET failed_attempts = ${MFA_MAX_FAILED_ATTEMPTS} WHERE user_id = ${id}`.execute(h.ownerDb)
    expect((await passwordStep('unlocked.staff')).statusCode).toBe(423)
    const reset = await call(h, { method: 'POST', url: `/api/admin/users/${String(id)}/setup-code`, cookie: adminCookie })
    expect(reset.statusCode, reset.body).toBe(200)
    const newPassword = 'fresh-Unlock-passphrase-71'
    const setup = await call(h, {
      method: 'POST',
      url: '/api/auth/setup-password',
      payload: { username: 'unlocked.staff', setupCode: reset.json<{ setupCode: string }>().setupCode, newPassword }
    })
    expect(setup.statusCode, setup.body).toBe(204)
    expect(await failedAttempts(id)).toBe(0)
    // New password, same authenticator: the second step is still required.
    const res = await passwordStep('unlocked.staff', newPassword)
    expect(res.statusCode).toBe(202)
    expect((await verify(cookieFrom(res, CHALLENGE_COOKIE_NAME), await totpFor(h, id))).statusCode).toBe(200)
  })

  it('treats a wrong encryption key as a server error, never as the user’s failure', async () => {
    const id = await insertUser(h, { username: 'wrongkey.staff' })
    await enrollMfa(h, id)
    const other = buildApp({ db: h.appDb, logger: false, publicOrigin: ORIGIN, sessions: SESSIONS, mfaEncryptionKey: randomBytes(32) })
    await other.ready()
    try {
      const step = await other.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: ORIGIN, 'x-wam-csrf': '1' },
        payload: { username: 'wrongkey.staff', password: GOOD_PASSWORD }
      })
      expect(step.statusCode).toBe(202)
      const res = await other.inject({
        method: 'POST',
        url: '/api/auth/mfa/verify',
        headers: { origin: ORIGIN, 'x-wam-csrf': '1', cookie: cookieFrom(step, CHALLENGE_COOKIE_NAME) },
        payload: { code: await totpFor(h, id) }
      })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(await failedAttempts(id)).toBe(0)
    } finally {
      await other.close()
    }
  })
})

describe('enforcement on every request (§3.2.1)', () => {
  it('ends a password-only session as soon as its user is appointed administrator', async () => {
    const id = await insertUser(h, { username: 'promoted.staff' })
    const cookie = await login(h, 'promoted.staff')
    expect((await me(cookie)).statusCode).toBe(200)
    await assignSystemProfile(h, id, ids.adminProfile)
    const res = await call(h, { method: 'GET', url: '/api/admin/users', cookie })
    expect(res.statusCode).toBe(401)
    expect(errorCode(res)).toBe('MFA_REQUIRED')
    const session = await h.ownerDb.selectFrom('sessions').select('revoked_reason').where('user_id', '=', id).executeTakeFirstOrThrow()
    expect(session.revoked_reason).toBe('mfa_required')
    expect((await auditRows(h, 'session.ended_mfa_required')).filter((e) => e.actor_user_id === id)).toHaveLength(1)
    // Ended once: afterwards it is simply not a session any more.
    expect(errorCode(await me(cookie))).toBe('UNAUTHENTICATED')
    await challengeFor('promoted.staff', 'mfa_enroll')
  })

  it('ends password-only sessions when the owner switches the policy to all_users, and keeps second-factor ones', async () => {
    await insertUser(h, { username: 'rollout.staff' })
    const cookie = await login(h, 'rollout.staff')
    await setPolicy('all_users')
    try {
      expect(errorCode(await me(cookie))).toBe('MFA_REQUIRED')
      expect((await me(ownerCookie)).statusCode).toBe(200)
      expect((await me(adminCookie)).statusCode).toBe(200)
    } finally {
      await setPolicy('privileged')
    }
  })
})

describe('the security policy (owner only)', () => {
  it('is readable and changeable by the owner only, versioned and audited', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const res = await call(h, {
        method,
        url: '/api/admin/security-policy',
        cookie: adminCookie,
        headers: { 'idempotency-key': randomUUID() },
        ...(method === 'PUT' ? { payload: { version: 1, mfaRequiredFor: 'all_users' } } : {})
      })
      expect(res.statusCode).toBe(403)
    }
    const current = await call(h, { method: 'GET', url: '/api/admin/security-policy', cookie: ownerCookie })
    const stale = await call(h, {
      method: 'PUT',
      url: '/api/admin/security-policy',
      cookie: ownerCookie,
      headers: { 'idempotency-key': randomUUID() },
      payload: { version: current.json<{ version: number }>().version + 50, mfaRequiredFor: 'all_users' }
    })
    expect(stale.statusCode).toBe(409)
    const events = await auditRows(h, 'security_policy.updated')
    expect(events.length).toBeGreaterThan(0)
    expect(events.at(-1)).toMatchObject({ actor_user_id: ids.owner, details: { changed: { mfaRequiredFor: { before: 'all_users', after: 'privileged' } } } })
  })

  it.each(['none', 'optional', 'administrators'])('accepts no value that would weaken it: %j', async (value) => {
    const res = await call(h, {
      method: 'PUT',
      url: '/api/admin/security-policy',
      cookie: ownerCookie,
      headers: { 'idempotency-key': randomUUID() },
      payload: { version: 1, mfaRequiredFor: value }
    })
    expect(res.statusCode).toBe(400)
    // The database refuses it too, whoever writes.
    await expect(sql`UPDATE wam.security_policy SET mfa_required_for = ${value}`.execute(h.ownerDb)).rejects.toThrow(/security_policy_mfa_required_for/)
  })
})

describe('self-service (§3.2.4; ASVS V7.5.1)', () => {
  it('lets an ordinary user enrol after re-entering the password, and ends their other sessions', async () => {
    const id = await insertUser(h, { username: 'selfserve.staff' })
    const cookie = await login(h, 'selfserve.staff')
    const other = await login(h, 'selfserve.staff')
    const wrongPassword = await call(h, { method: 'POST', url: '/api/me/mfa/enroll/start', cookie, payload: { currentPassword: 'not-the-password-at-all' } })
    expect(errorCode(wrongPassword)).toBe('CURRENT_PASSWORD_INCORRECT')
    const started = await call(h, { method: 'POST', url: '/api/me/mfa/enroll/start', cookie, payload: { currentPassword: GOOD_PASSWORD } })
    expect(started.statusCode, started.body).toBe(200)
    const secret = started.json<{ secret: string }>().secret
    issuedSecrets.push(secret)
    const confirmed = await call(h, { method: 'POST', url: '/api/me/mfa/enroll/confirm', cookie, payload: { code: totpCode(base32Decode(secret), now()) } })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    issuedSecrets.push(...confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes)
    // This session continues (it proved the new factor); the other one ended.
    expect((await me(cookie)).statusCode).toBe(200)
    expect((await me(other)).statusCode).toBe(401)
    expect((await call(h, { method: 'GET', url: '/api/me/mfa', cookie })).json()).toMatchObject({
      enrolled: true,
      required: false,
      locked: false,
      recoveryCodesRemaining: RECOVERY_CODE_COUNT
    })
    await challengeFor('selfserve.staff', 'mfa_verify')
    expect((await auditRows(h, 'auth.mfa.enrolled')).filter((e) => e.target_id === String(id)).at(-1)?.details).toMatchObject({ otherSessionsEnded: 1 })
  })

  it('replacing the authenticator needs the current one; the old one stops working', async () => {
    const id = await insertUser(h, { username: 'newphone.staff' })
    const oldSecret = await enrollMfa(h, id)
    const cookie = await login(h, 'newphone.staff')
    const noCode = await call(h, { method: 'POST', url: '/api/me/mfa/enroll/start', cookie, payload: { currentPassword: GOOD_PASSWORD } })
    expect(noCode.statusCode).toBe(400)
    const wrongCode = await call(h, { method: 'POST', url: '/api/me/mfa/enroll/start', cookie, payload: { currentPassword: GOOD_PASSWORD, code: '999999' } })
    expect(errorCode(wrongCode)).toBe('INVALID_MFA_CODE')
    const started = await call(h, {
      method: 'POST',
      url: '/api/me/mfa/enroll/start',
      cookie,
      payload: { currentPassword: GOOD_PASSWORD, code: await totpFor(h, id) }
    })
    expect(started.statusCode, started.body).toBe(200)
    const newSecret = base32Decode(started.json<{ secret: string }>().secret)
    const confirmed = await call(h, { method: 'POST', url: '/api/me/mfa/enroll/confirm', cookie, payload: { code: totpCode(newSecret, now()) } })
    expect(confirmed.statusCode).toBe(200)
    expect((await auditRows(h, 'auth.mfa.replaced')).filter((e) => e.target_id === String(id))).toHaveLength(1)
    await sql`UPDATE wam.user_mfa SET totp_last_step = 0 WHERE user_id = ${id}`.execute(h.ownerDb)
    expect((await verify(await challengeFor('newphone.staff', 'mfa_verify'), totpCode(oldSecret, now()))).statusCode).toBe(400)
    expect((await verify(await challengeFor('newphone.staff', 'mfa_verify'), totpCode(newSecret, now()))).statusCode).toBe(200)
  })

  it('regenerating recovery codes invalidates the earlier ones', async () => {
    const id = await insertUser(h, { username: 'regen.admin' })
    await assignSystemProfile(h, id, ids.adminProfile)
    const { cookie, recoveryCodes: before } = await enrollAtSignIn('regen.admin')
    const res = await call(h, {
      method: 'POST',
      url: '/api/me/mfa/recovery-codes',
      cookie,
      payload: { currentPassword: GOOD_PASSWORD, code: await totpFor(h, id) }
    })
    expect(res.statusCode, res.body).toBe(200)
    const after = res.json<{ recoveryCodes: string[] }>().recoveryCodes
    issuedSecrets.push(...after)
    expect(after.filter((c) => before.includes(c))).toEqual([])
    expect((await verify(await challengeFor('regen.admin', 'mfa_verify'), before[0] ?? '')).statusCode).toBe(400)
    expect((await verify(await challengeFor('regen.admin', 'mfa_verify'), after[0] ?? '')).statusCode).toBe(200)
  })

  it('an ordinary user may remove MFA (with password and code); the owner and administrators may not', async () => {
    const id = await insertUser(h, { username: 'optout.staff' })
    await enrollMfa(h, id)
    const cookie = await login(h, 'optout.staff')
    const removed = await call(h, { method: 'POST', url: '/api/me/mfa/disable', cookie, payload: { currentPassword: GOOD_PASSWORD, code: await totpFor(h, id) } })
    expect(removed.statusCode, removed.body).toBe(204)
    expect((await passwordStep('optout.staff')).statusCode).toBe(200)

    for (const [privileged, userId] of [
      [ownerCookie, ids.owner],
      [adminCookie, ids.admin]
    ] as const) {
      const res = await call(h, {
        method: 'POST',
        url: '/api/me/mfa/disable',
        cookie: privileged,
        payload: { currentPassword: GOOD_PASSWORD, code: await totpFor(h, userId) }
      })
      expect(res.statusCode).toBe(403)
      expect(await h.ownerDb.selectFrom('user_mfa').select('user_id').where('user_id', '=', userId).executeTakeFirst()).toBeDefined()
    }
  })
})

describe('administrator reset of a lost authenticator (§3.2.4; ASVS V6.4.4)', () => {
  it('removes the authenticator and resets the password in one step; only the new setup code lets the user back in', async () => {
    const id = await insertUser(h, { username: 'lostphone.staff' })
    await enrollMfa(h, id)
    const cookie = await login(h, 'lostphone.staff')
    const res = await call(h, { method: 'POST', url: `/api/admin/users/${String(id)}/reset-mfa`, cookie: adminCookie })
    expect(res.statusCode, res.body).toBe(200)
    const { setupCode } = res.json<{ setupCode: string; expiresInHours: number }>()
    expect(await h.ownerDb.selectFrom('user_mfa').select('user_id').where('user_id', '=', id).executeTakeFirst()).toBeUndefined()
    expect(await h.ownerDb.selectFrom('mfa_recovery_codes').select('user_id').where('user_id', '=', id).executeTakeFirst()).toBeUndefined()
    expect((await me(cookie)).statusCode).toBe(401)
    // The old password alone is useless now.
    expect((await passwordStep('lostphone.staff')).statusCode).toBe(401)
    const newPassword = 'replacement-Phone-passphrase-5'
    expect((await call(h, { method: 'POST', url: '/api/auth/setup-password', payload: { username: 'lostphone.staff', setupCode, newPassword } })).statusCode).toBe(204)
    expect((await passwordStep('lostphone.staff', newPassword)).statusCode).toBe(200)
    expect((await auditRows(h, 'user.mfa_reset')).at(-1)).toMatchObject({ actor_user_id: ids.admin, target_id: String(id), details: { hadAuthenticator: true, sessionsEnded: 1 } })
  })

  it('follows the escalation rules: not your own (A4), not an administrator (A2), not the owner (A3) — the owner may reset an administrator', async () => {
    const otherAdmin = await insertUser(h, { username: 'other.admin' })
    await assignSystemProfile(h, otherAdmin, ids.adminProfile)
    await enrollMfa(h, otherAdmin)
    for (const target of [ids.admin, otherAdmin, ids.owner]) {
      const res = await call(h, { method: 'POST', url: `/api/admin/users/${String(target)}/reset-mfa`, cookie: adminCookie })
      expect(res.statusCode).toBe(403)
    }
    expect(await h.ownerDb.selectFrom('user_mfa').select('user_id').where('user_id', 'in', [ids.admin, otherAdmin, ids.owner]).execute()).toHaveLength(3)
    const byOwner = await call(h, { method: 'POST', url: `/api/admin/users/${String(otherAdmin)}/reset-mfa`, cookie: ownerCookie })
    expect(byOwner.statusCode).toBe(200)
  })

  it('shows in the user list who has an authenticator', async () => {
    const res = await call(h, { method: 'GET', url: '/api/admin/users?search=mfa.', cookie: ownerCookie })
    const users = res.json<{ users: { username: string; mfaEnrolled: boolean }[] }>().users
    expect(users.find((u) => u.username === 'mfa.owner')?.mfaEnrolled).toBe(true)
    expect(users.find((u) => u.username === 'mfa.admin')?.mfaEnrolled).toBe(true)
  })
})

describe('database safeguards', () => {
  it('lets the server role advance counters but never rewrite a secret or the policy row', async () => {
    await expect(sql`UPDATE wam.user_mfa SET totp_secret = totp_secret`.execute(h.appDb)).rejects.toThrow(/permission denied/)
    await expect(sql`UPDATE wam.user_mfa SET totp_key_id = totp_key_id`.execute(h.appDb)).rejects.toThrow(/permission denied/)
    await expect(sql`DELETE FROM wam.security_policy`.execute(h.appDb)).rejects.toThrow(/permission denied/)
    await expect(sql`INSERT INTO wam.security_policy (id) VALUES (false)`.execute(h.appDb)).rejects.toThrow(/permission denied/)
    await expect(sql`UPDATE wam.user_mfa SET failed_attempts = failed_attempts`.execute(h.appDb)).resolves.toBeDefined()
  })

  it('never stores an authenticator secret, code or recovery code in the audit trail', async () => {
    const all = JSON.stringify(await auditRows(h))
    expect(issuedSecrets.length).toBeGreaterThan(20)
    for (const secret of issuedSecrets) expect(all).not.toContain(secret)
    expect(all).not.toMatch(/otpauth:/)
  })
})

describe('second-step and enrolment records are cleaned up', () => {
  it('maintenance removes expired challenges and pending enrolments', async () => {
    const id = await insertUser(h, { username: 'cleanup.admin' })
    await assignSystemProfile(h, id, ids.adminProfile)
    const challenge = await challengeFor('cleanup.admin', 'mfa_enroll')
    await call(h, { method: 'POST', url: '/api/auth/mfa/enroll/start', cookie: challenge })
    await sql`UPDATE wam.login_challenges SET created_at = now() - interval '1 hour', expires_at = now() - interval '30 minutes' WHERE user_id = ${id}`.execute(h.superDb)
    await sql`UPDATE wam.mfa_enrollments SET created_at = now() - interval '1 hour', expires_at = now() - interval '30 minutes' WHERE user_id = ${id}`.execute(h.superDb)
    const result = await runMaintenance(h.appDb)
    expect(result.loginChallenges).toBeGreaterThanOrEqual(1)
    expect(result.mfaEnrollments).toBeGreaterThanOrEqual(1)
    expect(await h.ownerDb.selectFrom('login_challenges').select('id').where('user_id', '=', id).execute()).toEqual([])
  })

  it('a setup code issued by an administrator invalidates a half-finished sign-in', async () => {
    const id = await insertUser(h, { username: 'halfway.staff' })
    await enrollMfa(h, id)
    const challenge = await challengeFor('halfway.staff', 'mfa_verify')
    const reset = await call(h, { method: 'POST', url: `/api/admin/users/${String(id)}/setup-code`, cookie: adminCookie })
    expect(reset.statusCode).toBe(200)
    expect((await verify(challenge, await totpFor(h, id))).statusCode).toBe(401)
  })
})
