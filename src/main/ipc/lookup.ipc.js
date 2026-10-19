import { ipcMain } from 'electron'
import { lookupService } from '../services/lookupService'
import { authService } from '../services/authService'
import { autoBackupService } from '../services/autoBackupService'

function requireUser() {
  const user = authService.getCurrentUser()
  if (!user) throw new Error('ابتدا وارد حساب کاربری شوید')
  return user
}

export function registerLookupHandlers() {
  // Security Hardening phase — reveals all base-data (item types,
  // workshops, countries, statuses) with no auth check before this.
  ipcMain.handle('lookups:getAll', () => {
    requireUser()
    return lookupService.getAllLookups()
  })
  ipcMain.handle('lookups:create', async (_event, kind, name) => {
    try {
      const user = requireUser()
      const item = lookupService.createLookup(kind, name, user)
      const backupWarning = await autoBackupService.triggerAutoBackup(user)
      return { success: true, item, ...(backupWarning ? { backupWarning } : {}) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
  ipcMain.handle('lookups:delete', async (_event, kind, id) => {
    try {
      const user = requireUser()
      const result = lookupService.deleteLookup(kind, id, user)
      const backupWarning = await autoBackupService.triggerAutoBackup(user)
      return { success: true, ...result, ...(backupWarning ? { backupWarning } : {}) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
  ipcMain.handle('lookups:deleteBulk', async (_event, kind, ids) => {
    try {
      const user = requireUser()
      const result = lookupService.deleteLookupsBulk(kind, ids, user)
      const backupWarning = await autoBackupService.triggerAutoBackup(user)
      return { success: true, ...result, ...(backupWarning ? { backupWarning } : {}) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // Base Data Lifecycle phase — the explicit reactivate path (and its
  // own manual-deactivate direction), for item types/workshops/
  // countries only; asset_statuses keeps using lookups:setStatusActive
  // above, untouched.
  ipcMain.handle('lookups:setActive', async (_event, kind, id, isActive) => {
    try {
      const user = requireUser()
      const result = lookupService.setLookupActive(kind, id, isActive, user)
      const backupWarning = await autoBackupService.triggerAutoBackup(user)
      return { success: true, ...result, ...(backupWarning ? { backupWarning } : {}) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // Manual Status Management — kept as their own dedicated channels
  // rather than going through the generic lookups:create/delete/
  // deleteBulk above, since asset_statuses needs system-status
  // protection, active/inactive, and display order — rules the generic
  // path for the other three kinds doesn't know about.
  ipcMain.handle('lookups:listStatuses', () => {
    requireUser()
    return lookupService.listStatuses()
  })

  ipcMain.handle('lookups:createStatus', async (_event, name) => {
    try {
      const user = requireUser()
      const result = lookupService.createStatus(name, user)
      const backupWarning = await autoBackupService.triggerAutoBackup(user)
      return { success: true, status: result, ...(backupWarning ? { backupWarning } : {}) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('lookups:renameStatus', async (_event, id, newName) => {
    try {
      const user = requireUser()
      const result = lookupService.renameStatus(id, newName, user)
      const backupWarning = await autoBackupService.triggerAutoBackup(user)
      return { success: true, ...result, ...(backupWarning ? { backupWarning } : {}) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('lookups:setStatusActive', async (_event, id, isActive) => {
    try {
      const user = requireUser()
      const result = lookupService.setStatusActive(id, isActive, user)
      const backupWarning = await autoBackupService.triggerAutoBackup(user)
      return { success: true, ...result, ...(backupWarning ? { backupWarning } : {}) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // Security Hardening phase — now requires login like every other
  // status-management channel; still no auto-backup/audit trigger,
  // since reordering is purely cosmetic and changes no auditable data
  // (see lookupService.moveStatus's own comment) — that part is
  // unchanged from before this phase.
  ipcMain.handle('lookups:moveStatus', (_event, id, direction) => {
    try {
      requireUser()
      return { success: true, ...lookupService.moveStatus(id, direction) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('lookups:deleteStatus', async (_event, id) => {
    try {
      const user = requireUser()
      const result = lookupService.deleteStatus(id, user)
      const backupWarning = await autoBackupService.triggerAutoBackup(user)
      return { success: true, ...result, ...(backupWarning ? { backupWarning } : {}) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('lookups:migrateAndDeleteStatus', async (_event, id, targetStatusName) => {
    try {
      const user = requireUser()
      const result = lookupService.migrateAndDeleteStatus(id, targetStatusName, user)
      const backupWarning = await autoBackupService.triggerAutoBackup(user)
      return { success: true, ...result, ...(backupWarning ? { backupWarning } : {}) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}
