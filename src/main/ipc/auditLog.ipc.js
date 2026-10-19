import { ipcMain } from 'electron'
import { auditService } from '../services/auditService'
import { authService } from '../services/authService'

// Same requireUser() guard used throughout every other *.ipc.js file —
// reused here rather than introducing a second auth mechanism.
function requireUser() {
  const user = authService.getCurrentUser()
  if (!user) throw new Error('ابتدا وارد حساب کاربری شوید')
  return user
}

export function registerAuditLogHandlers() {
  // Security Hardening phase — the audit trail is exactly the kind of
  // company data (who did what, when) that must never be readable
  // without logging in (audit finding: HIGH).
  ipcMain.handle('auditLog:list', (_event, filters) => {
    requireUser()
    return auditService.listAuditLog(filters)
  })
}
