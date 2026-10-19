import { ipcMain } from 'electron'
import { authService } from '../services/authService'

function requireUser() {
  const user = authService.getCurrentUser()
  if (!user) throw new Error('ابتدا وارد حساب کاربری شوید')
  return user
}

// Security Hardening phase — these are the ONLY IPC channels in the
// entire app that intentionally have no authentication check, and that
// is deliberate, not an oversight:
//   - auth:login is how a session is created in the first place —
//     requiring a session to call it would make login impossible.
//   - auth:currentUser is what the renderer's own login gate
//     (AuthContext/RequireAuth) calls to find out whether anyone is
//     signed in; it returns null when nobody is, never company data.
//   - auth:logout only clears the in-memory session (authService.js) —
//     it touches no company data, and is a safe no-op if nobody was
//     logged in to begin with.
//   - auth:needsFirstRunSetup / auth:completeFirstRunSetup (First-Run
//     Security phase) — same reasoning as auth:login: by definition,
//     nobody CAN be logged in yet the very first time these matter, and
//     completeFirstRunSetup only ever succeeds while a row is actually
//     pending setup (authService.needsFirstRunSetup's own guard) — it
//     cannot be replayed afterward to reset an already-set-up account.
// Every other IPC channel in this app requires requireUser() to have
// succeeded first — see assets.ipc.js/lookup.ipc.js/etc. auth:changePassword
// below is one of those: it's an authenticated action, not part of the
// unauthenticated boundary above.
export function registerAuthHandlers() {
  ipcMain.handle('auth:login', (_event, username, password) => authService.login(username, password))
  ipcMain.handle('auth:logout', () => authService.logout())
  ipcMain.handle('auth:currentUser', () => authService.getCurrentUser())

  ipcMain.handle('auth:needsFirstRunSetup', () => authService.needsFirstRunSetup())

  ipcMain.handle('auth:completeFirstRunSetup', (_event, newPassword, confirmPassword) => {
    try {
      return authService.completeFirstRunSetup(newPassword, confirmPassword)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('auth:changePassword', (_event, payload) => {
    try {
      const user = requireUser()
      return authService.changePassword(payload, user)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}
