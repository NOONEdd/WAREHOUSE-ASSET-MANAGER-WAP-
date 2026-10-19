import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, cleanupTestDb } from '../testHelpers/testDb'
import { hash } from '../../../src/main/utils/hashUtils'

let ctx
let authService

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

// authService keeps its session in a module-level variable
// (`currentSession`), so each test needs a genuinely fresh module
// instance — otherwise a login in one test would leak into the next.
// Same vi.resetModules() + vi.doMock() + dynamic re-import pattern
// already used in dashboardStats.test.js for the same reason.
beforeEach(async () => {
  vi.resetModules()
  ctx = createTestDb()
  vi.doMock('../../../src/main/database/connection', () => ({ getDatabase: () => ctx.db }))
  ;({ authService } = await import('../../../src/main/services/authService.js'))
})

afterEach(() => {
  cleanupTestDb(ctx)
})

function seedUser({ username = 'admin', password = 'Correct-Password-1', roleName = 'Administrator' } = {}) {
  const roleId = ctx.db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName).id
  const id = ctx.db
    .prepare(
      `INSERT INTO users (username, password_hash, full_name, role_id) VALUES (?, ?, 'Test User', ?)`
    )
    .run(username, hash(password), roleId).lastInsertRowid
  return { id, username, password }
}

describe('authService.login', () => {
  it('succeeds with the correct username and password, returning the session shape used everywhere else', () => {
    const seeded = seedUser()
    const result = authService.login(seeded.username, seeded.password)
    expect(result.success).toBe(true)
    expect(result.user).toEqual({ id: seeded.id, username: 'admin', fullName: 'Test User', role: 'Administrator' })
    expect(authService.getCurrentUser()).toEqual(result.user)
  })

  it('fails with a wrong password, without revealing whether the username itself was valid', () => {
    const seeded = seedUser()
    const result = authService.login(seeded.username, 'wrong-password')
    expect(result.success).toBe(false)
    expect(result.error).toBe('نام کاربری یا رمز عبور اشتباه است')
    expect(authService.getCurrentUser()).toBeNull()
  })

  it('fails for a username that does not exist, with the exact same generic error', () => {
    const result = authService.login('nobody', 'anything')
    expect(result.success).toBe(false)
    expect(result.error).toBe('نام کاربری یا رمز عبور اشتباه است')
    expect(authService.getCurrentUser()).toBeNull()
  })

  it('records a LOGIN audit entry on success, and none at all on failure', () => {
    const seeded = seedUser()
    authService.login(seeded.username, 'wrong-password')
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n).toBe(0)

    authService.login(seeded.username, seeded.password)
    const entry = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'LOGIN'").get()
    expect(entry).toBeDefined()
    expect(entry.entity_id).toBe(seeded.id)
  })

  it('updates last_login_at on success', () => {
    const seeded = seedUser()
    expect(ctx.db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(seeded.id).last_login_at).toBeNull()
    authService.login(seeded.username, seeded.password)
    expect(
      ctx.db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(seeded.id).last_login_at
    ).not.toBeNull()
  })
})

describe('authService.getCurrentUser / logout', () => {
  it('returns null before any login', () => {
    expect(authService.getCurrentUser()).toBeNull()
  })

  it('logout clears the session', () => {
    const seeded = seedUser()
    authService.login(seeded.username, seeded.password)
    expect(authService.getCurrentUser()).not.toBeNull()

    authService.logout()
    expect(authService.getCurrentUser()).toBeNull()
  })

  it('logout records a LOGOUT audit entry when a session existed', () => {
    const seeded = seedUser()
    authService.login(seeded.username, seeded.password)
    authService.logout()
    const entry = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'LOGOUT'").get()
    expect(entry).toBeDefined()
    expect(entry.entity_id).toBe(seeded.id)
  })

  it('logout with nobody logged in is a safe no-op — no audit entry, no error', () => {
    expect(() => authService.logout()).not.toThrow()
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n).toBe(0)
    expect(authService.getCurrentUser()).toBeNull()
  })
})

describe('authService.bootstrapAdminIfNeeded', () => {
  it('creates the admin account flagged as needing first-run password setup, with no usable password returned', () => {
    const result = authService.bootstrapAdminIfNeeded()
    expect(result.username).toBe('admin')
    expect(result.needsPasswordSetup).toBe(true)
    expect(result.password).toBeUndefined()
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM users').get().n).toBe(1)
    expect(ctx.db.prepare('SELECT needs_password_setup FROM users WHERE username = ?').get('admin').needs_password_setup).toBe(1)
  })

  it('the bootstrapped account cannot log in with anything until first-run setup is completed', () => {
    authService.bootstrapAdminIfNeeded()
    // There is no "real" password to guess — the hash behind this row was
    // generated from a value that was immediately discarded — so every
    // possible login attempt against it must fail identically to a wrong
    // password, never succeed and never throw a different kind of error.
    for (const guess of ['admin', 'password', '', 'Administrator1']) {
      const login = authService.login('admin', guess)
      expect(login.success).toBe(false)
    }
  })

  it('creates a real bcrypt hash for the placeholder password, never anything empty or predictable', () => {
    authService.bootstrapAdminIfNeeded()
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin')
    expect(row.password_hash.startsWith('$2')).toBe(true) // bcrypt hash format
  })

  it('does nothing and returns null when a user already exists', () => {
    seedUser()
    const result = authService.bootstrapAdminIfNeeded()
    expect(result).toBeNull()
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM users').get().n).toBe(1)
  })

  it('does not print or otherwise return the placeholder password from any call', () => {
    const result = authService.bootstrapAdminIfNeeded()
    // The only two keys this function's contract exposes — proves there is
    // no accidental extra field (e.g. a leftover `password`) leaking the
    // discarded value.
    expect(Object.keys(result).sort()).toEqual(['needsPasswordSetup', 'username'])
  })
})

describe('authService.needsFirstRunSetup', () => {
  it('is true immediately after a fresh bootstrap', () => {
    authService.bootstrapAdminIfNeeded()
    expect(authService.needsFirstRunSetup()).toBe(true)
  })

  it('is false when no bootstrap has happened and no users exist yet', () => {
    expect(authService.needsFirstRunSetup()).toBe(false)
  })

  it('is false for a database whose admin already has a real password (pre-existing install)', () => {
    seedUser() // simulates an account created before this phase shipped
    expect(authService.needsFirstRunSetup()).toBe(false)
  })

  it('becomes false again once first-run setup is completed', () => {
    authService.bootstrapAdminIfNeeded()
    authService.completeFirstRunSetup('My-Chosen-Password-1', 'My-Chosen-Password-1')
    expect(authService.needsFirstRunSetup()).toBe(false)
  })
})

describe('authService.completeFirstRunSetup', () => {
  it('sets a real password, clears the pending flag, and signs the operator in', () => {
    authService.bootstrapAdminIfNeeded()
    const result = authService.completeFirstRunSetup('My-Chosen-Password-1', 'My-Chosen-Password-1')
    expect(result.success).toBe(true)
    expect(result.user.username).toBe('admin')
    expect(result.user.role).toBe('Administrator')
    expect(authService.getCurrentUser()).toEqual(result.user)
    expect(
      ctx.db.prepare('SELECT needs_password_setup FROM users WHERE username = ?').get('admin').needs_password_setup
    ).toBe(0)
  })

  it('the chosen password actually works for a subsequent normal login', () => {
    authService.bootstrapAdminIfNeeded()
    authService.completeFirstRunSetup('My-Chosen-Password-1', 'My-Chosen-Password-1')
    authService.logout()
    const login = authService.login('admin', 'My-Chosen-Password-1')
    expect(login.success).toBe(true)
  })

  it('rejects mismatched confirmation without changing the database', () => {
    authService.bootstrapAdminIfNeeded()
    const before = ctx.db.prepare('SELECT password_hash FROM users').get().password_hash
    expect(() => authService.completeFirstRunSetup('My-Chosen-Password-1', 'Something-Else-2')).toThrow(
      /یکسان نیستند/
    )
    expect(ctx.db.prepare('SELECT password_hash FROM users').get().password_hash).toBe(before)
  })

  it('rejects a password shorter than 8 characters', () => {
    authService.bootstrapAdminIfNeeded()
    expect(() => authService.completeFirstRunSetup('short1', 'short1')).toThrow(/۸ کاراکتر/)
  })

  it('rejects a password identical to the username', () => {
    // 'admin' itself is only 5 characters, so it would fail the length
    // check before ever reaching the username-equality check — this
    // seeds a pending user with a longer username directly, so the
    // "identical to username" rule is what's actually being proven.
    const roleId = ctx.db.prepare("SELECT id FROM roles WHERE name = 'Administrator'").get().id
    ctx.db
      .prepare(
        `INSERT INTO users (username, password_hash, full_name, role_id, needs_password_setup)
         VALUES ('longer-admin', 'x', 'Admin', ?, 1)`
      )
      .run(roleId)
    expect(() => authService.completeFirstRunSetup('longer-admin', 'longer-admin')).toThrow(/نام کاربری/)
  })

  it('cannot be called again once setup has already completed — no replay to reset an active account', () => {
    authService.bootstrapAdminIfNeeded()
    authService.completeFirstRunSetup('My-Chosen-Password-1', 'My-Chosen-Password-1')
    expect(() => authService.completeFirstRunSetup('Second-Attempt-2', 'Second-Attempt-2')).toThrow(
      /قبلاً انجام شده/
    )
    // Proves the replay attempt didn't overwrite the real password either.
    authService.logout()
    expect(authService.login('admin', 'My-Chosen-Password-1').success).toBe(true)
  })

  it('throws when nothing is pending (no bootstrap ever ran)', () => {
    expect(() => authService.completeFirstRunSetup('Anything-Goes-1', 'Anything-Goes-1')).toThrow(
      /قبلاً انجام شده/
    )
  })
})

describe('authService.changePassword', () => {
  it('changes the password when the current password is correct', () => {
    const seeded = seedUser()
    authService.login(seeded.username, seeded.password)
    const result = authService.changePassword(
      { currentPassword: seeded.password, newPassword: 'New-Password-2', confirmPassword: 'New-Password-2' },
      authService.getCurrentUser()
    )
    expect(result.success).toBe(true)
  })

  it('the old password stops working and the new one works after a successful change', () => {
    const seeded = seedUser()
    authService.login(seeded.username, seeded.password)
    authService.changePassword(
      { currentPassword: seeded.password, newPassword: 'New-Password-2', confirmPassword: 'New-Password-2' },
      authService.getCurrentUser()
    )
    authService.logout()
    expect(authService.login(seeded.username, seeded.password).success).toBe(false)
    expect(authService.login(seeded.username, 'New-Password-2').success).toBe(true)
  })

  it('records a PASSWORD_CHANGED audit entry on success', () => {
    const seeded = seedUser()
    authService.login(seeded.username, seeded.password)
    authService.changePassword(
      { currentPassword: seeded.password, newPassword: 'New-Password-2', confirmPassword: 'New-Password-2' },
      authService.getCurrentUser()
    )
    const entry = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'PASSWORD_CHANGED'").get()
    expect(entry).toBeDefined()
    expect(entry.entity_id).toBe(seeded.id)
    // The audit trail must never carry either password value.
    expect(JSON.stringify(entry)).not.toContain(seeded.password)
    expect(JSON.stringify(entry)).not.toContain('New-Password-2')
  })

  it('rejects a wrong current password and does not touch the database', () => {
    const seeded = seedUser()
    authService.login(seeded.username, seeded.password)
    const before = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(seeded.id).password_hash
    expect(() =>
      authService.changePassword(
        { currentPassword: 'totally-wrong', newPassword: 'New-Password-2', confirmPassword: 'New-Password-2' },
        authService.getCurrentUser()
      )
    ).toThrow(/رمز عبور فعلی نادرست است/)
    expect(ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(seeded.id).password_hash).toBe(before)
  })

  it('rejects mismatched new-password confirmation and does not touch the database', () => {
    const seeded = seedUser()
    authService.login(seeded.username, seeded.password)
    const before = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(seeded.id).password_hash
    expect(() =>
      authService.changePassword(
        { currentPassword: seeded.password, newPassword: 'New-Password-2', confirmPassword: 'Different-3' },
        authService.getCurrentUser()
      )
    ).toThrow(/یکسان نیستند/)
    expect(ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(seeded.id).password_hash).toBe(before)
  })

  it('rejects a new password shorter than 8 characters and does not touch the database', () => {
    const seeded = seedUser()
    authService.login(seeded.username, seeded.password)
    const before = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(seeded.id).password_hash
    expect(() =>
      authService.changePassword(
        { currentPassword: seeded.password, newPassword: 'short1', confirmPassword: 'short1' },
        authService.getCurrentUser()
      )
    ).toThrow(/۸ کاراکتر/)
    expect(ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(seeded.id).password_hash).toBe(before)
  })

  it('rejects a new password identical to the username and does not touch the database', () => {
    const seeded = seedUser({ username: 'warehouse-admin' })
    authService.login(seeded.username, seeded.password)
    const before = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(seeded.id).password_hash
    expect(() =>
      authService.changePassword(
        { currentPassword: seeded.password, newPassword: 'warehouse-admin', confirmPassword: 'warehouse-admin' },
        authService.getCurrentUser()
      )
    ).toThrow(/نام کاربری/)
    expect(ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(seeded.id).password_hash).toBe(before)
  })
})
