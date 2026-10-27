import { describe, expect, it } from 'vitest'
import { recordAudit } from '../../src/audit/audit.js'
import { newSessionToken, newSetupCode, normalizeSetupCode, SESSION_TOKEN_PATTERN } from '../../src/auth/secrets.js'
import { createDatabase, createPool } from '../../src/db/connection.js'
import {
  challengeCookie,
  clearedChallengeCookie,
  clearedSessionCookie,
  cookieSettingsFor,
  readCookie,
  sessionCookie
} from '../../src/http/cookies.js'

describe('session tokens', () => {
  it('are 256-bit random base64url strings, unique per call', () => {
    const tokens = new Set(Array.from({ length: 200 }, newSessionToken))
    expect(tokens.size).toBe(200)
    for (const t of tokens) expect(t).toMatch(SESSION_TOKEN_PATTERN)
  })
})

describe('setup codes', () => {
  it('are 32 base32 characters (160 bits) in groups of four, without 0, 1, 8 or 9', () => {
    const codes = new Set(Array.from({ length: 200 }, newSetupCode))
    expect(codes.size).toBe(200)
    for (const c of codes) expect(c).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)
  })

  it('are accepted as typed: any case, any spacing', () => {
    const code = newSetupCode()
    expect(normalizeSetupCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code)
    expect(normalizeSetupCode(code.replace(/-/g, ''))).toBe(code)
  })

  it.each(['', 'ABCD', 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4560', 'A'.repeat(33)])('rejects malformed input %j', (input) => {
    expect(normalizeSetupCode(input)).toBeNull()
  })
})

describe('session cookie', () => {
  it('uses the __Host- prefix and Secure over https (ASVS V3.3.1–V3.3.4)', () => {
    const settings = cookieSettingsFor('https://wam.example')
    expect(settings).toEqual({ name: '__Host-wam_session', challengeName: '__Host-wam_mfa', secure: true })
    expect(sessionCookie(settings, 'TOKEN')).toBe('__Host-wam_session=TOKEN; Path=/; HttpOnly; SameSite=Strict; Secure')
    expect(clearedSessionCookie(settings)).toBe('__Host-wam_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict; Secure')
  })

  it('drops the prefix and Secure only for plain-http development origins', () => {
    const settings = cookieSettingsFor('http://127.0.0.1:3000')
    expect(sessionCookie(settings, 'TOKEN')).toBe('wam_session=TOKEN; Path=/; HttpOnly; SameSite=Strict')
    expect(challengeCookie(settings, 'TOKEN', 300)).toBe('wam_mfa=TOKEN; Max-Age=300; Path=/; HttpOnly; SameSite=Strict')
  })

  it('gives the second sign-in step its own short-lived __Host- cookie (identity-and-access §3.2.4)', () => {
    const settings = cookieSettingsFor('https://wam.example')
    expect(challengeCookie(settings, 'TOKEN', 300)).toBe('__Host-wam_mfa=TOKEN; Max-Age=300; Path=/; HttpOnly; SameSite=Strict; Secure')
    expect(clearedChallengeCookie(settings)).toBe('__Host-wam_mfa=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict; Secure')
  })

  it('reads its own cookie among others', () => {
    expect(readCookie('a=1; wam_session=abc; b=2', 'wam_session')).toBe('abc')
    expect(readCookie('wam_sessionx=abc', 'wam_session')).toBeNull()
    expect(readCookie(undefined, 'wam_session')).toBeNull()
    expect(readCookie('wam_session=', 'wam_session')).toBeNull()
  })

  it('refuses to choose when the cookie appears twice (cookie tossing)', () => {
    expect(readCookie('wam_session=mine; wam_session=planted', 'wam_session')).toBeNull()
  })
})

describe('audit details', () => {
  // Fails before any database access, so an unreachable database is fine.
  const db = createDatabase(createPool({ connectionString: 'postgresql://x:y@%2Fnonexistent:5432/none', poolMax: 1, statementTimeoutMs: 1000 }, () => undefined))
  const context = { requestId: null, sourceIp: null }

  it.each([
    { password: 'x' },
    { newPassword: 'x' },
    { nested: { setupCode: 'x' } },
    { list: [{ token: 'x' }] },
    { cookie: 'x' },
    { recoveryCodes: ['x'] },
    { nested: { recovery_code: 'x' } },
    { otpauthUri: 'otpauth://x' },
    { totpSecret: 'x' }
  ])('refuse to store secret-named fields: %j', async (details) => {
    await expect(recordAudit(db, context, { action: 'test.event', outcome: 'success', actor: null, details })).rejects.toThrow(
      /audit details must not contain/
    )
  })

  it('still allow counts, methods and business codes', async () => {
    // Passes the guard and only then fails at the (unreachable) database.
    await expect(
      recordAudit(db, context, {
        action: 'test.event',
        outcome: 'success',
        actor: null,
        details: { recoveryCodesRemaining: 3, method: 'password+totp', after: { code: 'SYN-A' } }
      })
    ).rejects.not.toThrow(/audit details must not contain/)
  })
})
