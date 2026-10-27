import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MFA_MAX_FAILED_ATTEMPTS } from '../../src/auth/mfa.js'
import { runOwnerCli } from '../../src/cli/owner.js'
import {
  appointAdministrator,
  assignSystemProfileBypassingO12,
  auditRows,
  call,
  cookieFrom,
  createHarness,
  GOOD_PASSWORD,
  insertProfile,
  insertUser,
  login,
  totpFor,
  type Harness
} from '../support/appHarness.js'
import { createTestDatabase, migrationEnv } from '../support/testDatabase.js'

// The owner CLI (docs/security/identity-and-access.md §1): the only way to
// create, recover or move ownership.

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.close()
})

async function owner(args: string[], url = h.tdb.urls.owner): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await runOwnerCli(args, migrationEnv(url), { out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

function setupCodeIn(output: string): string {
  const match = /([A-Z2-7]{4}(?:-[A-Z2-7]{4}){7})/.exec(output)
  if (match?.[1] === undefined) throw new Error(`no setup code in output:\n${output}`)
  return match[1]
}

const setPassword = (username: string, setupCode: string, newPassword: string) =>
  call(h, { method: 'POST', url: '/api/auth/setup-password', payload: { username, setupCode, newPassword } })

describe('owner bootstrap', () => {
  it('refuses to run as the web server’s role or as a superuser', async () => {
    expect((await owner(['status'], h.tdb.urls.app)).err).toMatch(/migrations must run as wam_owner/)
    expect((await owner(['status'], h.tdb.urls.superuser)).err).toMatch(/is a superuser/)
  })

  it('refuses a reserved or malformed username', async () => {
    const reserved = await owner(['bootstrap', '--username', 'admin', '--display-name', 'X'])
    expect(reserved.code).toBe(2)
    expect(reserved.err).toMatch(/reserved/)
    expect((await owner(['bootstrap', '--username', 'A B', '--display-name', 'X'])).code).toBe(2)
  })

  it('creates the owner with no password and a one-time setup code that works exactly once', async () => {
    const result = await owner(['bootstrap', '--username', 'site.owner', '--display-name', 'مالک سامانه'])
    expect(result.code).toBe(0)
    const code = setupCodeIn(result.out)
    const row = await h.ownerDb.selectFrom('users').select(['is_owner', 'password_hash']).where('username', '=', 'site.owner').executeTakeFirstOrThrow()
    expect(row).toEqual({ is_owner: true, password_hash: null })

    // No password exists, so nothing can log in yet.
    expect((await call(h, { method: 'POST', url: '/api/auth/login', payload: { username: 'site.owner', password: GOOD_PASSWORD } })).statusCode).toBe(401)
    expect((await setPassword('site.owner', code, GOOD_PASSWORD)).statusCode).toBe(204)
    const cookie = await login(h, 'site.owner')
    expect((await call(h, { method: 'GET', url: '/api/me', cookie })).json()).toMatchObject({ user: { isOwner: true } })
    expect((await setPassword('site.owner', code, 'another long passphrase')).statusCode).toBe(400)

    const [event] = await auditRows(h, 'owner.bootstrapped')
    expect(event?.details).toMatchObject({ via: 'owner-cli', username: 'site.owner' })
    expect(typeof event?.details.osUser).toBe('string')
  })

  it('refuses a second bootstrap', async () => {
    const again = await owner(['bootstrap', '--username', 'other.owner', '--display-name', 'X'])
    expect(again.code).toBe(1)
    expect(again.err).toMatch(/an owner already exists \("site.owner"\)/)
  })

  it('refuses to work on a database whose migrations are not applied', async () => {
    const fresh = await createTestDatabase()
    try {
      expect((await owner(['status'], fresh.urls.owner)).err).toMatch(/schema does not match/)
    } finally {
      await fresh.drop()
    }
  })
})

describe('owner recovery', () => {
  it('requires --yes', async () => {
    const unconfirmed = await owner(['recover'])
    expect(unconfirmed.code).toBe(2)
    expect(unconfirmed.err).toMatch(/--yes/)
  })

  it('clears the password, ends the owner’s sessions, lifts throttling and issues a new code', async () => {
    const cookie = await login(h, 'site.owner')
    // An attacker hammering the owner's account from one address:
    for (let i = 0; i < 6; i += 1) {
      await call(h, { method: 'POST', url: '/api/auth/login', payload: { username: 'site.owner', password: 'guessing-attempt!!' }, remoteAddress: '10.66.0.1' })
    }
    const { rows: live } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM wam.sessions s JOIN wam.users u ON u.id = s.user_id
       WHERE u.is_owner AND s.revoked_at IS NULL`.execute(h.ownerDb)
    const liveBefore = live[0]?.n ?? 0
    expect(liveBefore).toBeGreaterThanOrEqual(1)
    const result = await owner(['recover', '--yes'])
    expect(result.code).toBe(0)
    expect((await call(h, { method: 'GET', url: '/api/me', cookie })).statusCode).toBe(401)
    expect((await call(h, { method: 'POST', url: '/api/auth/login', payload: { username: 'site.owner', password: GOOD_PASSWORD } })).statusCode).toBe(401)

    expect((await setPassword('site.owner', setupCodeIn(result.out), 'recovered long passphrase')).statusCode).toBe(204)
    await login(h, 'site.owner', 'recovered long passphrase', { remoteAddress: '10.66.0.1' })
    expect((await auditRows(h, 'owner.recovery_code_issued'))[0]?.details).toMatchObject({ sessionsEnded: liveBefore })
  })
})

describe('owner recovery and the second factor (identity-and-access §3.2.5)', () => {
  const ownerId = async () =>
    (await h.ownerDb.selectFrom('users').select('id').where('username', '=', 'site.owner').executeTakeFirstOrThrow()).id
  const passwordStep = (password: string) =>
    call(h, { method: 'POST', url: '/api/auth/login', payload: { username: 'site.owner', password } })

  it('"recover" lifts a second-factor lock and keeps the authenticator', async () => {
    const id = await ownerId()
    await sql`UPDATE wam.user_mfa SET failed_attempts = ${MFA_MAX_FAILED_ATTEMPTS} WHERE user_id = ${id}`.execute(h.ownerDb)
    expect((await passwordStep('recovered long passphrase')).statusCode).toBe(423)
    expect((await owner(['status'])).out).toMatch(/Owner authenticator: set up, LOCKED/)

    const result = await owner(['recover', '--yes'])
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/authenticator app was kept/)
    // Lifted by the recovery itself, not only once the new password is set.
    const after = await h.ownerDb.selectFrom('user_mfa').select('failed_attempts').where('user_id', '=', id).executeTakeFirstOrThrow()
    expect(after.failed_attempts).toBe(0)
    expect((await owner(['status'])).out).toMatch(/Owner authenticator: set up$/m)
    expect((await setPassword('site.owner', setupCodeIn(result.out), 'recovered long passphrase')).statusCode).toBe(204)
    // Same authenticator, lock gone: the second step works again.
    const step = await passwordStep('recovered long passphrase')
    expect(step.json()).toMatchObject({ next: 'mfa_verify' })
    const verified = await call(h, { method: 'POST', url: '/api/auth/mfa/verify', cookie: cookieFrom(step, 'wam_mfa'), payload: { code: await totpFor(h, id) } })
    expect(verified.statusCode).toBe(200)
    expect((await auditRows(h, 'owner.recovery_code_issued')).at(-1)?.details).toMatchObject({ mfaReset: false, authenticatorRemoved: false })
  })

  it('"recover --reset-mfa" also removes the authenticator; the owner enrols again after the new password', async () => {
    const id = await ownerId()
    const result = await owner(['recover', '--reset-mfa', '--yes'])
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/authenticator app was removed/)
    expect(await h.ownerDb.selectFrom('user_mfa').select('user_id').where('user_id', '=', id).executeTakeFirst()).toBeUndefined()
    expect((await owner(['status'])).out).toMatch(/Owner authenticator: not set up/)
    // Without the new setup code nothing works; with it, the owner must enrol before any session.
    expect((await passwordStep('recovered long passphrase')).statusCode).toBe(401)
    expect((await setPassword('site.owner', setupCodeIn(result.out), 'recovered long passphrase')).statusCode).toBe(204)
    expect((await passwordStep('recovered long passphrase')).json()).toMatchObject({ next: 'mfa_enroll' })
    expect((await auditRows(h, 'owner.recovery_code_issued')).at(-1)?.details).toMatchObject({ mfaReset: true, authenticatorRemoved: true })
  })

  it.each([[['status', '--reset-mfa']], [['end-all-sessions', '--reset-mfa', '--yes']], [['recover', '--reset-mfa']], [['recover', '--reset-mfa', '--reset-mfa', '--yes']]])(
    'accepts --reset-mfa only on a confirmed "recover": %j',
    async (args) => {
      expect((await owner(args)).code).toBe(2)
    }
  )
})

describe('ownership transfer', () => {
  it('moves ownership to an active user and signs the previous owner out', async () => {
    await insertUser(h, { username: 'successor' })
    const oldOwnerCookie = await login(h, 'site.owner', 'recovered long passphrase')
    expect(await owner(['transfer', '--to', 'successor'])).toMatchObject({ code: 2 })
    const result = await owner(['transfer', '--to', 'successor', '--yes'])
    expect(result.code).toBe(0)

    const owners = await h.ownerDb.selectFrom('users').select('username').where('is_owner', '=', true).execute()
    expect(owners).toEqual([{ username: 'successor' }])
    expect((await call(h, { method: 'GET', url: '/api/me', cookie: oldOwnerCookie })).statusCode).toBe(401)
    const cookie = await login(h, 'successor')
    expect((await call(h, { method: 'GET', url: '/api/me', cookie })).json()).toMatchObject({ user: { isOwner: true } })
    expect((await auditRows(h, 'owner.transferred'))[0]?.details).toMatchObject({ from: { username: 'site.owner' }, to: { username: 'successor' } })
  })

  it('leaves the new and the previous owner without administrator profiles (decision O-12), and owner recovery still works', async () => {
    const id = await insertUser(h, { username: 'admin.successor' })
    await appointAdministrator(h, id, await insertProfile(h, 'CLI test administrator', 'system', ['user.view']))
    const result = await owner(['transfer', '--to', 'admin.successor', '--yes'])
    expect(result.code).toBe(0)
    expect(await h.ownerDb.selectFrom('user_system_profiles').select('profile_id').where('user_id', '=', id).execute()).toEqual([])
    expect((await auditRows(h, 'owner.transferred')).at(-1)?.details).toMatchObject({ administratorProfilesRemoved: 1 })
    // The owner's separate recovery path is not blocked by O-12 — even with leftover administrator rows.
    await assignSystemProfileBypassingO12(h, id, await insertProfile(h, 'Leftover administrator', 'system', ['user.view']))
    const recovered = await owner(['recover', '--reset-mfa', '--yes'])
    expect(recovered.code, recovered.err).toBe(0)
    expect(await h.ownerDb.selectFrom('user_mfa').select('user_id').where('user_id', '=', id).executeTakeFirst()).toBeUndefined()
    // Hand ownership back so the following tests keep their owner.
    expect((await owner(['transfer', '--to', 'successor', '--yes'])).code).toBe(0)
  })

  it('refuses a disabled or unknown target', async () => {
    await insertUser(h, { username: 'gone.user', status: 'disabled' })
    expect((await owner(['transfer', '--to', 'gone.user', '--yes'])).err).toMatch(/disabled/)
    expect((await owner(['transfer', '--to', 'nobody', '--yes'])).err).toMatch(/no user "nobody"/)
  })
})

describe('end-all-sessions and status', () => {
  it('signs everyone out', async () => {
    const a = await login(h, 'successor')
    const result = await owner(['end-all-sessions', '--yes'])
    expect(result.code).toBe(0)
    expect((await call(h, { method: 'GET', url: '/api/me', cookie: a })).statusCode).toBe(401)
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM wam.sessions WHERE revoked_at IS NULL`.execute(h.ownerDb)
    expect(rows[0]?.n).toBe(0)
  })

  it('reports the owner without changing anything', async () => {
    const result = await owner(['status'])
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/Owner: successor/)
    expect(result.out).toMatch(/Owner authenticator: set up$/m)
    expect(result.out).toMatch(/MFA required for: the owner and administrators/)
  })

  it.each([[[]], [['frobnicate']], [['bootstrap', '--username', 'x']], [['status', '--yes', '--to']]])('rejects the usage %j', async (args) => {
    expect((await owner(args)).code).toBe(2)
  })
})
