import { getDatabase } from '../database/connection'

function findByUsername(username) {
  return getDatabase()
    .prepare(
      `SELECT u.*, r.name as role_name FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.username = ? AND u.is_active = 1`
    )
    .get(username)
}

function findById(id) {
  return getDatabase()
    .prepare(
      `SELECT u.*, r.name as role_name FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`
    )
    .get(id)
}

function count() {
  return getDatabase().prepare('SELECT COUNT(*) as n FROM users').get().n
}

// needsPasswordSetup defaults to false so every existing/other caller
// (there is currently only one: bootstrapAdminIfNeeded) is unaffected
// unless it explicitly opts in — see schema.sql's needs_password_setup
// comment for why that default matters.
function create({ username, passwordHash, fullName, roleId, needsPasswordSetup = false }) {
  const info = getDatabase()
    .prepare(
      `INSERT INTO users (username, password_hash, full_name, role_id, needs_password_setup)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(username, passwordHash, fullName, roleId, needsPasswordSetup ? 1 : 0)
  return findById(info.lastInsertRowid)
}

function updateLastLogin(id) {
  getDatabase()
    .prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`)
    .run(id)
}

function getRoleIdByName(roleName) {
  return getDatabase().prepare('SELECT id FROM roles WHERE name = ?').get(roleName)?.id
}

// First-Run Security phase — the one row (if any) still waiting on
// first-run setup. In practice there is at most one: only
// bootstrapAdminIfNeeded ever sets this flag, and only once (it never
// runs again once any user exists). Joined with roles, same as
// findByUsername/findById, so authService.completeFirstRunSetup can
// build a full session (including role) straight from this row without
// a second lookup.
function getFirstRunPendingUser() {
  return getDatabase()
    .prepare(
      `SELECT u.*, r.name as role_name FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.needs_password_setup = 1 LIMIT 1`
    )
    .get()
}

// Used by authService.changePassword — an already-authenticated user
// changing their own password. Does not touch needs_password_setup: a
// currently-logged-in session already implies setup was completed (or
// never applied to this row), so there is nothing left to clear.
function updatePasswordHash(id, passwordHash) {
  getDatabase().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id)
}

// Used only by authService.completeFirstRunSetup — sets the real,
// person-chosen password AND clears the flag in one statement, so the
// two can never end up out of sync (e.g. a crash between two separate
// UPDATEs leaving the real password set but the row still flagged as
// pending, which would incorrectly force setup again on next launch).
function completeFirstRunSetup(id, passwordHash) {
  getDatabase()
    .prepare('UPDATE users SET password_hash = ?, needs_password_setup = 0 WHERE id = ?')
    .run(passwordHash, id)
}

export const userRepository = {
  findByUsername,
  findById,
  count,
  create,
  updateLastLogin,
  getRoleIdByName,
  getFirstRunPendingUser,
  updatePasswordHash,
  completeFirstRunSetup
}
