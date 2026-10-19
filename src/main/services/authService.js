import { userRepository } from '../repositories/userRepository'
import { hash, compare, generateRandomPassword } from '../utils/hashUtils'
import { validatePassword } from '../utils/validators'
import { auditService } from './auditService'

// Session lives only here, in the main process (Phase 2, Section 6) — the
// renderer never sees a password, only the result of asking "who is this."
let currentSession = null

function login(username, password) {
  const user = userRepository.findByUsername(username)
  if (!user || !compare(password, user.password_hash)) {
    return { success: false, error: 'نام کاربری یا رمز عبور اشتباه است' }
  }

  userRepository.updateLastLogin(user.id)
  currentSession = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role_name
  }

  auditService.recordAudit({
    user: currentSession,
    action: 'LOGIN',
    entityType: 'User',
    entityId: user.id
  })

  return { success: true, user: currentSession }
}

function logout() {
  if (currentSession) {
    auditService.recordAudit({
      user: currentSession,
      action: 'LOGOUT',
      entityType: 'User',
      entityId: currentSession.id
    })
  }
  currentSession = null
}

function getCurrentUser() {
  return currentSession
}

/**
 * First-Run Security phase. Runs once, only if the users table is empty.
 * Creates the Administrator account, but with NO usable password: the
 * value hashed here is a random string generated only to satisfy
 * password_hash's NOT NULL constraint, immediately discarded, and never
 * assigned to any variable that outlives this function — not returned,
 * not logged, not stored anywhere except as an unusable bcrypt hash
 * nobody (including this app) ever has the plaintext for again. The
 * account is flagged needs_password_setup so the renderer shows the
 * mandatory setup screen (App.jsx's routing) before login is reachable
 * at all — see completeFirstRunSetup below for the actual credential
 * the operator ends up using.
 */
function bootstrapAdminIfNeeded() {
  if (userRepository.count() > 0) return null

  const roleId = userRepository.getRoleIdByName('Administrator')
  const passwordHash = hash(generateRandomPassword())

  const admin = userRepository.create({
    username: 'admin',
    passwordHash,
    fullName: 'Administrator',
    roleId,
    needsPasswordSetup: true
  })

  auditService.recordAudit({
    user: { id: admin.id, username: 'admin' },
    action: 'CREATE',
    entityType: 'User',
    entityId: admin.id,
    changes: { note: 'Initial administrator account created on first run; password setup pending' }
  })

  return { username: 'admin', needsPasswordSetup: true }
}

/**
 * Whether the app should show the mandatory first-run setup screen
 * instead of the normal login screen. False for every existing install
 * that already had a real admin password before this phase shipped
 * (migrations/005's DEFAULT 0 — see that file's comment), so upgrading
 * an already-running installation never locks anyone out or forces
 * setup again.
 */
function needsFirstRunSetup() {
  return Boolean(userRepository.getFirstRunPendingUser())
}

/**
 * The only way the bootstrap admin account ever gets a real, usable
 * password. Deliberately requires NO current-password proof (there is
 * none to prove — see bootstrapAdminIfNeeded) but is only reachable at
 * all while needs_password_setup is still set on some row, so it cannot
 * be replayed later to silently reset an already-set-up account; once
 * completeFirstRunSetup succeeds once, this same call fails forever
 * after (row no longer matches getFirstRunPendingUser). This is
 * intentionally the ONLY password-recovery-shaped path in the app right
 * now — see Phase 1 scope notes: a real "forgot password" flow needs its
 * own explicit design (proof of local/OS-level access, not just app-UI
 * access) and is deliberately not built here.
 *
 * Signs the operator in immediately on success (same session shape as
 * login()) — they just proved they're the person setting this machine
 * up by choosing the credential themselves, so there's no separate
 * "now go log in with what you just typed" step to add friction.
 */
function completeFirstRunSetup(newPassword, confirmPassword) {
  const pending = userRepository.getFirstRunPendingUser()
  if (!pending) {
    throw new Error('راه‌اندازی اولیه قبلاً انجام شده است')
  }
  if (newPassword !== confirmPassword) {
    throw new Error('رمز عبور و تکرار آن یکسان نیستند')
  }
  const policyError = validatePassword(newPassword, pending.username)
  if (policyError) throw new Error(policyError)

  userRepository.completeFirstRunSetup(pending.id, hash(newPassword))
  userRepository.updateLastLogin(pending.id)

  currentSession = {
    id: pending.id,
    username: pending.username,
    fullName: pending.full_name,
    role: pending.role_name
  }

  auditService.recordAudit({
    user: currentSession,
    action: 'PASSWORD_SET',
    entityType: 'User',
    entityId: pending.id,
    changes: { note: 'Administrator password set during first-run setup' }
  })

  return { success: true, user: currentSession }
}

/**
 * Regular, already-authenticated password change (Settings → Security).
 * Requires the CURRENT session's own current password — never trusts a
 * password/id passed up from the renderer for anything but the strings
 * being changed. Every failure path (wrong current password, policy
 * violation, mismatched confirmation) throws BEFORE any write, so a
 * failed attempt never touches the database.
 */
function changePassword({ currentPassword, newPassword, confirmPassword }, currentUser) {
  const user = userRepository.findById(currentUser.id)
  if (!user || !compare(currentPassword, user.password_hash)) {
    throw new Error('رمز عبور فعلی نادرست است')
  }
  if (newPassword !== confirmPassword) {
    throw new Error('رمز عبور جدید و تکرار آن یکسان نیستند')
  }
  const policyError = validatePassword(newPassword, user.username)
  if (policyError) throw new Error(policyError)

  userRepository.updatePasswordHash(user.id, hash(newPassword))

  auditService.recordAudit({
    user: currentSession,
    action: 'PASSWORD_CHANGED',
    entityType: 'User',
    entityId: user.id
  })

  return { success: true }
}

export const authService = {
  login,
  logout,
  getCurrentUser,
  bootstrapAdminIfNeeded,
  needsFirstRunSetup,
  completeFirstRunSetup,
  changePassword
}
