import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { newRecoveryCode, normalizeRecoveryCode } from '../../src/auth/mfa.js'
import { open, seal, secretKeyFrom, totpSecretContext } from '../../src/auth/secretBox.js'
import { base32Encode, hotp, otpauthUri, totpCode, totpStep, verifyTotp } from '../../src/auth/totp.js'
import { base32Decode } from '../support/base32.js'

// The building blocks of multi-factor authentication
// (docs/security/identity-and-access.md §3.2), checked against the
// published test vectors and at fixed times.

/** The RFC 4226 / RFC 6238 (SHA-1) test secret. */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii')

describe('HOTP and TOTP (RFC 4226, RFC 6238)', () => {
  it('match the RFC 4226 Appendix D HOTP values', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
    expect(expected.map((_, counter) => hotp(RFC_SECRET, counter))).toEqual(expected)
  })

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130']
  ])('match the RFC 6238 Appendix B SHA-1 value at T=%i', (time, code) => {
    expect(totpCode(RFC_SECRET, time, 8)).toBe(code)
    // Six digits, as the app shows them: the last six of the same value.
    expect(totpCode(RFC_SECRET, time)).toBe(code.slice(2))
  })
})

describe('verifyTotp', () => {
  const secret = randomBytes(20)
  const now = 30 * 40_000_000 + 10 // step 40_000_000, 10 s into it
  const step = totpStep(now)
  const codeAt = (offsetSteps: number) => hotp(secret, step + offsetSteps)

  it('accepts the current code and returns its step', () => {
    expect(verifyTotp(secret, codeAt(0), now, 0)).toBe(step)
  })

  it('tolerates exactly one step either side (decision E-13)', () => {
    expect(verifyTotp(secret, codeAt(-1), now, 0)).toBe(step - 1)
    expect(verifyTotp(secret, codeAt(1), now, 0)).toBe(step + 1)
    expect(verifyTotp(secret, codeAt(-2), now, 0)).toBeNull()
    expect(verifyTotp(secret, codeAt(2), now, 0)).toBeNull()
  })

  it('never accepts a step at or before the last one used (single use, ASVS V6.5.1)', () => {
    expect(verifyTotp(secret, codeAt(0), now, step)).toBeNull()
    expect(verifyTotp(secret, codeAt(-1), now, step)).toBeNull()
    expect(verifyTotp(secret, codeAt(1), now, step)).toBe(step + 1)
  })

  it('uses only the time it is given (the server clock, V6.5.8)', () => {
    expect(verifyTotp(secret, codeAt(0), now + 90, 0)).toBeNull()
  })

  it.each(['', '12345', '1234567', 'abcdef', '12 345'])('rejects malformed input %j', (input) => {
    expect(verifyTotp(secret, input, now, 0)).toBeNull()
  })

  it('rejects a code made with another secret', () => {
    expect(verifyTotp(randomBytes(20), codeAt(0), now, 0)).toBeNull()
  })
})

describe('base32 and otpauth links', () => {
  it.each([
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI']
  ])('encodes %j as RFC 4648 %s (no padding)', (input, expected) => {
    expect(base32Encode(Buffer.from(input, 'ascii'))).toBe(expected)
  })

  it('round-trips a 160-bit secret the way an authenticator app reads it', () => {
    const secret = randomBytes(20)
    expect(base32Encode(secret)).toMatch(/^[A-Z2-7]{32}$/)
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true)
  })

  it('builds the standard otpauth://totp link', () => {
    const uri = new URL(otpauthUri(RFC_SECRET, 'store.keeper', 'WAM'))
    expect(uri.protocol).toBe('otpauth:')
    expect(uri.host).toBe('totp')
    expect(decodeURIComponent(uri.pathname)).toBe('/WAM:store.keeper')
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: base32Encode(RFC_SECRET),
      issuer: 'WAM',
      algorithm: 'SHA1',
      digits: '6',
      period: '30'
    })
  })
})

describe('authenticator secrets at rest (AES-256-GCM)', () => {
  const key = secretKeyFrom(randomBytes(32))
  const secret = randomBytes(20)

  it('seals to nonce ‖ ciphertext ‖ tag and opens again', () => {
    const sealed = seal(key, secret, totpSecretContext(7))
    expect(sealed).toHaveLength(48)
    expect(sealed.includes(secret)).toBe(false)
    expect(open(key, sealed, totpSecretContext(7)).equals(secret)).toBe(true)
  })

  it('uses a fresh nonce every time', () => {
    expect(seal(key, secret, totpSecretContext(7)).equals(seal(key, secret, totpSecretContext(7)))).toBe(false)
  })

  it('refuses a value moved to another user (associated data)', () => {
    expect(() => open(key, seal(key, secret, totpSecretContext(7)), totpSecretContext(8))).toThrow()
  })

  it('refuses a tampered value', () => {
    const sealed = seal(key, secret, totpSecretContext(7))
    sealed[20] = (sealed[20] ?? 0) ^ 1
    expect(() => open(key, sealed, totpSecretContext(7))).toThrow()
  })

  it('refuses another key, and identifies keys by a stable fingerprint', () => {
    const other = secretKeyFrom(randomBytes(32))
    expect(() => open(other, seal(key, secret, totpSecretContext(7)), totpSecretContext(7))).toThrow()
    expect(key.id).toMatch(/^[0-9a-f]{16}$/)
    expect(key.id).not.toBe(other.id)
    expect(secretKeyFrom(Buffer.from(key.key)).id).toBe(key.id)
  })

  it('accepts only 32-byte keys', () => {
    expect(() => secretKeyFrom(randomBytes(31))).toThrow(/32 bytes/)
  })
})

describe('recovery codes', () => {
  it('are 24 base32 characters (120 bits) in groups of four, unique per call', () => {
    const codes = new Set(Array.from({ length: 200 }, newRecoveryCode))
    expect(codes.size).toBe(200)
    for (const c of codes) expect(c).toMatch(/^([A-Z2-7]{4}-){5}[A-Z2-7]{4}$/)
  })

  it('are accepted as typed: any case, any spacing', () => {
    const code = newRecoveryCode()
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code)
    expect(normalizeRecoveryCode(code.replace(/-/g, ''))).toBe(code)
  })

  it.each(['', '123456', 'ABCD-EFGH', 'A'.repeat(25), 'ABCD-EFGH-IJKL-MNOP-QRST-UVW1'])('rejects malformed input %j', (input) => {
    expect(normalizeRecoveryCode(input)).toBeNull()
  })
})
