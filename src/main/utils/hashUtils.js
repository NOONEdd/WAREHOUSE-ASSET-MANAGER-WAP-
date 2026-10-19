import bcrypt from 'bcryptjs'
import { randomInt } from 'crypto'

const SALT_ROUNDS = 12

function hash(plainPassword) {
  return bcrypt.hashSync(plainPassword, SALT_ROUNDS)
}

function compare(plainPassword, passwordHash) {
  return bcrypt.compareSync(plainPassword, passwordHash)
}

// Audit finding (IMPORTANT): this used Math.random(), which is not a
// cryptographically secure source — fine for a UI shuffle, not for a
// credential. Used exactly once, for the bootstrap admin account's
// initial password (authService.bootstrapAdminIfNeeded). crypto.randomInt
// is Node's own built-in CSPRNG, so this is a same-behavior swap, not a
// new dependency.
function generateRandomPassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let out = ''
  for (let i = 0; i < length; i++) {
    out += chars[randomInt(chars.length)]
  }
  return out
}

export { hash, compare, generateRandomPassword }
