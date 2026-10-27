import { readFileSync } from 'node:fs'

// Password and username rules: docs/security/identity-and-access.md §3.
// Passwords are compared exactly as typed (no trimming, no normalization;
// ASVS 5.0.0 V6.2.8); only the common-password and context-word checks are
// case-insensitive, which makes them stricter, not weaker.

export const PASSWORD_MIN_LENGTH = 15
export const PASSWORD_MAX_LENGTH = 128

/** ASVS V6.1.2 / V6.2.11: organization, product and role words. */
export const CONTEXT_WORDS: readonly string[] = [
  'warehouse',
  'asset',
  'anbar',
  'farabar',
  'zarin',
  'sanat',
  'password',
  'admin',
  'owner'
]

export type PasswordProblem = 'too_short' | 'too_long' | 'common_password' | 'contains_username' | 'contains_context_word'

let common: ReadonlySet<string> | undefined

/** The bundled list (server/data/common-passwords.txt), loaded on first use. */
function commonPasswords(): ReadonlySet<string> {
  common ??= new Set(
    readFileSync(new URL('../../data/common-passwords.txt', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
  )
  return common
}

export function commonPasswordCount(): number {
  return commonPasswords().size
}

/**
 * Length in Unicode code points — how NIST SP 800-63B counts password
 * characters — so a Persian letter counts once and a zero-width non-joiner
 * (common in Persian text) also counts once.
 */
function codePointLength(value: string): number {
  let count = 0
  for (const _codePoint of value) count += 1
  return count
}

/** Empty when the password is acceptable. */
export function checkPassword(password: string, context: { readonly username: string }): PasswordProblem[] {
  const problems: PasswordProblem[] = []
  const length = codePointLength(password)
  if (length < PASSWORD_MIN_LENGTH) problems.push('too_short')
  if (length > PASSWORD_MAX_LENGTH) problems.push('too_long')
  const lower = password.toLowerCase()
  if (commonPasswords().has(lower)) problems.push('common_password')
  if (context.username.length >= 3 && lower.includes(context.username.toLowerCase())) problems.push('contains_username')
  if (CONTEXT_WORDS.some((word) => lower.includes(word))) problems.push('contains_context_word')
  return problems
}

// --- usernames ---------------------------------------------------------------

export const USERNAME_PATTERN = '^[a-z0-9][a-z0-9._-]{2,63}$'
const USERNAME_REGEX = new RegExp(USERNAME_PATTERN)

/** ASVS V6.3.2: well-known default account names are never created. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'root',
  'sa',
  'system',
  'superuser',
  'owner',
  'test',
  'guest',
  'wam'
])

export type UsernameProblem = 'invalid_format' | 'reserved'

export function checkUsername(username: string): UsernameProblem | null {
  if (!USERNAME_REGEX.test(username)) return 'invalid_format'
  if (RESERVED_USERNAMES.has(username)) return 'reserved'
  return null
}
