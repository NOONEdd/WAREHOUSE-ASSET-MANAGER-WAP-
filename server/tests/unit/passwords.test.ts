import { describe, expect, it } from 'vitest'
import { ARGON2_PARAMETERS, hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from '../../src/auth/passwords.js'

describe('Argon2id password hashing', () => {
  it('produces a PHC-format Argon2id hash with the configured parameters and a random salt', async () => {
    const a = await hashPassword('correct horse battery staple')
    const b = await hashPassword('correct horse battery staple')
    const { memory, passes, parallelism } = ARGON2_PARAMETERS
    expect(a).toMatch(new RegExp(`^\\$argon2id\\$v=19\\$m=${String(memory)},t=${String(passes)},p=${String(parallelism)}\\$[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$`))
    expect(a).not.toBe(b) // different salts
    expect(needsRehash(a)).toBe(false)
  })

  it('verifies the right password and rejects others, exactly as typed', async () => {
    const hash = await hashPassword('Correct Horse Battery Staple')
    expect(await verifyPassword('Correct Horse Battery Staple', hash)).toBe(true)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(false) // no case folding (ASVS V6.2.8)
    expect(await verifyPassword('Correct Horse Battery Staple ', hash)).toBe(false) // no trimming
    expect(await verifyPassword('Correct Horse Battery Stapl', hash)).toBe(false) // no truncation
  })

  it('handles non-Latin passwords', async () => {
    const persian = 'گذرواژه‌ی بلند و امن من'
    const hash = await hashPassword(persian)
    expect(await verifyPassword(persian, hash)).toBe(true)
    expect(await verifyPassword(persian.normalize('NFD'), hash)).toBe(persian === persian.normalize('NFD'))
  })

  it('rejects any malformed or tampered stored hash instead of throwing', async () => {
    const hash = await hashPassword('correct horse battery staple')
    const tampered = hash.slice(0, -2) + (hash.endsWith('AA') ? 'BB' : 'AA')
    for (const bad of [tampered, '', 'plaintext', '$2b$12$abcdefghijklmnopqrstuuMdtsfXdzaW1kZjFmZvUC2bGhpr5zC', hash.replace('argon2id', 'argon2i')]) {
      expect(await verifyPassword('correct horse battery staple', bad)).toBe(false)
    }
  })

  it('reports hashes made with weaker parameters as needing a rehash', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g')).toBe(true)
    expect(needsRehash('not a hash')).toBe(true)
  })

  it('does real work for unknown users and always says no', async () => {
    expect(await verifyAgainstDummy('anything at all')).toBe(false)
  })
})
