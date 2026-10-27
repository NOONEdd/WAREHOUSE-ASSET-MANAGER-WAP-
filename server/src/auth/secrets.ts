import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// Random secrets and their stored form. Only SHA-256 hashes are stored: the
// secrets carry ≥ 128 bits of entropy, so a fast hash is sufficient
// (ASVS 5.0.0 V6.5.2, V7.2.3) and the database never holds a usable secret.

/** Session token: 256 bits, base64url, 43 characters. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Setup code: 160 bits as 32 base32 characters in groups of four
 * ("ABCD-EFGH-…"). RFC 4648 base32 has no 0, 1, 8 or 9, so a code read from
 * paper cannot confuse O/0 or I/1.
 */
export function newSetupCode(): string {
  const bytes = randomBytes(20)
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? ''
      bits -= 5
    }
  }
  return (out.match(/.{4}/g) ?? []).join('-')
}

/** Accepts the code as typed: any case, with or without dashes and spaces. */
export function normalizeSetupCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '')
  return /^[A-Z2-7]{32}$/.test(compact) ? (compact.match(/.{4}/g) ?? []).join('-') : null
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function sameHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
