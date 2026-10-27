import { argon2, randomBytes, timingSafeEqual, type Argon2Parameters } from 'node:crypto'

// Password hashing with Argon2id through Node's built-in crypto.argon2 (no
// native add-on). Parameters: OWASP Password Storage Cheat Sheet minimum —
// 19 MiB memory, 2 passes, parallelism 1 (ASVS 5.0.0 V11.4.2). They are
// stored in every hash in the standard PHC string format, so they can be
// raised later: needsRehash() reports hashes made with older parameters,
// and login upgrades them.
//
//   $argon2id$v=19$m=19456,t=2,p=1$<salt, base64>$<hash, base64>

export const ARGON2_PARAMETERS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const
const SALT_BYTES = 16

const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{16,})\$([A-Za-z0-9+/]{16,})$/

function derive(password: string, parameters: Omit<Argon2Parameters, 'message'>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { ...parameters, message: password }, (err, key) => {
      if (err === null) resolve(Buffer.from(key))
      else reject(err)
    })
  })
}

const b64 = (buffer: Buffer): string => buffer.toString('base64').replace(/=+$/, '')

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await derive(password, { ...ARGON2_PARAMETERS, nonce: salt })
  const { memory, passes, parallelism } = ARGON2_PARAMETERS
  return `$argon2id$v=19$m=${String(memory)},t=${String(passes)},p=${String(parallelism)}$${b64(salt)}$${b64(hash)}`
}

interface ParsedHash {
  readonly memory: number
  readonly passes: number
  readonly parallelism: number
  readonly salt: Buffer
  readonly hash: Buffer
}

function parse(encoded: string): ParsedHash | null {
  const m = PHC.exec(encoded)
  if (m === null) return null
  const [, memory, passes, parallelism, salt, hash] = m
  if (memory === undefined || passes === undefined || parallelism === undefined || salt === undefined || hash === undefined) {
    return null
  }
  return {
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
    salt: Buffer.from(salt, 'base64'),
    hash: Buffer.from(hash, 'base64')
  }
}

/** False for a wrong password and for any malformed stored hash. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parse(encoded)
  if (parsed === null || parsed.hash.length < 16) return false
  const candidate = await derive(password, {
    memory: parsed.memory,
    passes: parsed.passes,
    parallelism: parsed.parallelism,
    tagLength: parsed.hash.length,
    nonce: parsed.salt
  })
  return timingSafeEqual(candidate, parsed.hash)
}

export function needsRehash(encoded: string): boolean {
  const parsed = parse(encoded)
  return (
    parsed === null ||
    parsed.memory !== ARGON2_PARAMETERS.memory ||
    parsed.passes !== ARGON2_PARAMETERS.passes ||
    parsed.parallelism !== ARGON2_PARAMETERS.parallelism ||
    parsed.hash.length !== ARGON2_PARAMETERS.tagLength
  )
}

let dummyHash: Promise<string> | undefined

/**
 * Does the same Argon2id work as a real verification, for logins whose
 * account does not exist or cannot log in, so the response time does not
 * reveal which usernames exist.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64'))
  await verifyPassword(password, await dummyHash)
  return false
}
