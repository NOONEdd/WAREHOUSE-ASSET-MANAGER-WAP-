import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// Encryption at rest for authenticator (TOTP) secrets
// (docs/security/identity-and-access.md §3.2.2, §3.3; ASVS 5.0.0 V11.3.2,
// V11.3.3, V13.3.1). The server must be able to read these secrets back, so
// they cannot be hashed; they are sealed with AES-256-GCM under a key that
// lives outside the database. The associated data binds each sealed value
// to its purpose and user, so a value copied onto another row fails to open.

export interface SecretKey {
  readonly key: Buffer
  /** A fingerprint stored with each sealed value: detects a wrong key without trying it. */
  readonly id: string
}

const NONCE_BYTES = 12
const TAG_BYTES = 16

export function secretKeyFrom(key: Buffer): SecretKey {
  if (key.length !== 32) throw new Error('the MFA encryption key must be 32 bytes')
  const id = createHash('sha256').update('wam-mfa-key-id\n').update(key).digest('hex').slice(0, 16)
  return { key, id }
}

/** nonce (12) ‖ ciphertext ‖ tag (16) */
export function seal(key: SecretKey, plaintext: Buffer, associatedData: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(associatedData, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()])
}

/** Throws if the value was not sealed with this key and associated data, or was altered. */
export function open(key: SecretKey, sealed: Buffer, associatedData: string): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error('sealed value is too short')
  const nonce = sealed.subarray(0, NONCE_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key.key, nonce, { authTagLength: TAG_BYTES })
  decipher.setAAD(Buffer.from(associatedData, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()])
}

/** Associated data for a user's TOTP secret. */
export function totpSecretContext(userId: number): string {
  return `wam:totp-secret:v1:user:${String(userId)}`
}
