import { ipcMain } from 'electron'
import { assetService } from '../services/assetService'
import { authService } from '../services/authService'
import { autoBackupService } from '../services/autoBackupService'

function requireUser() {
  const user = authService.getCurrentUser()
  if (!user) throw new Error('ابتدا وارد حساب کاربری شوید')
  return user
}

// Folded onto an already-successful response as `backupWarning` — never
// thrown, never turns a successful add/edit/delete into a reported
// failure. See autoBackupService.js: this only runs AFTER the caller's
// own db.transaction() has committed, so there's nothing to roll back
// here even if the backup itself fails.
async function withAutoBackup(user, result) {
  const backupWarning = await autoBackupService.triggerAutoBackup(user)
  return backupWarning ? { ...result, backupWarning } : result
}

export function registerAssetHandlers() {
  // Security Hardening phase — these four reads had no authentication
  // check at all (audit finding: HIGH). requireUser() throwing here
  // rejects the renderer's ipcRenderer.invoke() promise with the same
  // safe, non-technical message every other guarded channel already
  // uses — no response-shape change for the normal, logged-in case that
  // every existing caller already handles.
  ipcMain.handle('assets:list', (_event, filters) => {
    requireUser()
    return assetService.listAssets(filters)
  })
  ipcMain.handle('assets:get', (_event, id) => {
    requireUser()
    return assetService.getAsset(id)
  })
  ipcMain.handle('assets:dashboardStats', () => {
    requireUser()
    return assetService.getDashboardStats()
  })
  ipcMain.handle('assets:countByWorkshop', () => {
    requireUser()
    return assetService.getAssetCountByWorkshop()
  })
  ipcMain.handle('assets:countByItemType', () => {
    requireUser()
    return assetService.getAssetCountByItemType()
  })
  ipcMain.handle('assets:countByCountry', () => {
    requireUser()
    return assetService.getAssetCountByCountry()
  })
  ipcMain.handle('assets:recentActivity', (_event, limit) => {
    requireUser()
    return assetService.getRecentActivity(limit)
  })

  ipcMain.handle('assets:create', async (_event, input) => {
    try {
      const user = requireUser()
      const asset = assetService.createAsset(input, user)
      return await withAutoBackup(user, { success: true, asset })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('assets:update', async (_event, id, input) => {
    try {
      const user = requireUser()
      const asset = assetService.updateAsset(id, input, user)
      return await withAutoBackup(user, { success: true, asset })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('assets:delete', async (_event, id) => {
    try {
      const user = requireUser()
      assetService.deleteAsset(id, user)
      return await withAutoBackup(user, { success: true })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('assets:deleteBulk', async (_event, ids) => {
    try {
      const user = requireUser()
      const result = assetService.deleteAssetsBulk(ids, user)
      return await withAutoBackup(user, { success: true, ...result })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('assets:changeStatus', async (_event, id, statusChange) => {
    try {
      const user = requireUser()
      const asset = assetService.changeAssetStatus(id, statusChange, user)
      return await withAutoBackup(user, { success: true, asset })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('assets:changeStatusBulk', async (_event, ids, statusChange) => {
    try {
      const user = requireUser()
      const result = assetService.changeAssetStatusBulk(ids, statusChange, user)
      return await withAutoBackup(user, { success: true, ...result })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}
