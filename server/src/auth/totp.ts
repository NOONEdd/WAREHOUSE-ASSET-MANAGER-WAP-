import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Time-based one-time passwords, RFC 6238 with the parameters every
// authenticator app supports: HMAC-SHA-1, 6 digits, 30-second steps
// (docs/security/identity-and-access.md §3.2.2; ASVS 5.0.0 V6.5). Pure
// functions: the caller supplies the time (always the server's clock,
// V6.5.8) and the last step already used (single use, V6.5.1).

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
/** Steps accepted either side of the server's current step (decision E-13). */
export const TOTP_TOLERANCE_STEPS = 1
/** 160 bits, the size RFC 4226 recommends. */
export const TOTP_SECRET_BYTES = 20

export const TOTP_CODE_PATTERN = /^\d{6}$/

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? ''
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31] ?? ''
  return out
}

export function newTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES)
}

/** RFC 4226 HOTP value for one counter, as a zero-padded string of `digits` digits. */
export function hotp(secret: Uint8Array, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', secret).update(message).digest()
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f
  const binary = mac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** digits).padStart(digits, '0')
}

export function totpStep(unixSeconds: number): number {
  return Math.floor(unixSeconds / TOTP_PERIOD_SECONDS)
}

/** The code an authenticator app shows at `unixSeconds`. */
export function totpCode(secret: Uint8Array, unixSeconds: number, digits: number = TOTP_DIGITS): string {
  return hotp(secret, totpStep(unixSeconds), digits)
}

/**
 * The step `code` belongs to, if it is valid at `unixSeconds` within the
 * tolerance and later than `lastUsedStep`; otherwise null. Every candidate
 * step is compared in constant time, and all of them are always checked.
 */
export function verifyTotp(secret: Uint8Array, code: string, unixSeconds: number, lastUsedStep: number): number | null {
  if (!TOTP_CODE_PATTERN.test(code)) return null
  const given = Buffer.from(code, 'utf8')
  const current = totpStep(unixSeconds)
  let accepted: number | null = null
  for (let step = current - TOTP_TOLERANCE_STEPS; step <= current + TOTP_TOLERANCE_STEPS; step += 1) {
    const matches = timingSafeEqual(given, Buffer.from(hotp(secret, step), 'utf8'))
    if (matches && step > lastUsedStep && accepted === null) accepted = step
  }
  return accepted
}

/** The `otpauth://` link an authenticator app reads from a QR code. */
export function otpauthUri(secret: Uint8Array, accountName: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
