import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  checkPassword,
  checkUsername,
  commonPasswordCount,
  CONTEXT_WORDS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH
} from '../../src/auth/passwordPolicy.js'

const ok = { username: 'k.rahimi' }

describe('password policy (docs/security/identity-and-access.md §3)', () => {
  it('accepts a long passphrase of any composition', () => {
    expect(checkPassword('lunar kettle forty eight orbit', ok)).toEqual([])
    expect(checkPassword('only lowercase letters here', ok)).toEqual([]) // no composition rules (V6.2.5)
  })

  it(`requires ${String(PASSWORD_MIN_LENGTH)}–${String(PASSWORD_MAX_LENGTH)} characters, counted as code points`, () => {
    expect(checkPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1), ok)).toContain('too_short')
    expect(checkPassword('q7#x'.repeat(4), ok)).toEqual([]) // 16
    expect(checkPassword('x'.repeat(PASSWORD_MAX_LENGTH + 1), ok)).toContain('too_long')
    expect(checkPassword('z9'.repeat(32), ok)).toEqual([]) // 64 characters are allowed (V6.2.9)
    // 15 Persian letters: 15 code points (30 UTF-16 bytes) — accepted.
    expect(checkPassword('کبوترسفیدپرواز', ok)).toEqual(['too_short']) // 14
    expect(checkPassword('کبوترسفیدپروازی', ok)).toEqual([]) // 15
  })

  it('rejects passwords from the bundled common-password list, ignoring case', () => {
    expect(checkPassword('123456789987654321', ok)).toContain('common_password')
    expect(checkPassword('1QAZ2WSX3EDC4RFV', ok)).toContain('common_password')
  })

  it('bundles at least the 3,000 common passwords ASVS V6.2.4 requires, matching its recorded checksum', () => {
    expect(commonPasswordCount()).toBe(11_146)
    const file = readFileSync(new URL('../../data/common-passwords.txt', import.meta.url))
    expect(createHash('sha256').update(file).digest('hex')).toBe('81ccfb5b7ff310a7f83156992c0ff1cc575494011ebde5b21679614812a7dc8e')
  })

  it('rejects passwords containing the username', () => {
    expect(checkPassword('my-name-is-K.Rahimi-ok', ok)).toContain('contains_username')
  })

  it.each(CONTEXT_WORDS)('rejects passwords containing the context word "%s"', (word) => {
    expect(checkPassword(`Blue-${word.toUpperCase()}-river-77`, ok)).toContain('contains_context_word')
  })
})

describe('usernames', () => {
  it.each(['k.rahimi', 'ali_7', 'staff-03', 'abc'])('accepts %s', (name) => {
    expect(checkUsername(name)).toBeNull()
  })

  it.each(['ab', 'Ali', '-ali', 'ali rahimi', 'علی', 'a'.repeat(65), 'ali@site'])('rejects the format of %s', (name) => {
    expect(checkUsername(name)).toBe('invalid_format')
  })

  it.each(['admin', 'administrator', 'root', 'sa', 'system', 'owner', 'test', 'guest'])(
    'refuses the well-known default account name %s (ASVS V6.3.2)',
    (name) => {
      expect(checkUsername(name)).toBe(name.length < 3 ? 'invalid_format' : 'reserved')
    }
  )
})
