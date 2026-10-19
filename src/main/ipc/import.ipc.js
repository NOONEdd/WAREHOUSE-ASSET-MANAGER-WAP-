import { ipcMain, BrowserWindow } from 'electron'
import { importService } from '../services/importService'
import { authService } from '../services/authService'
import { autoBackupService } from '../services/autoBackupService'

function requireUser() {
  const user = authService.getCurrentUser()
  if (!user) throw new Error('ابتدا وارد حساب کاربری شوید')
  return user
}

export function registerImportHandlers() {
  // Security Hardening phase — none of these four were gated before
  // (import:commit already was). Opens the native file picker only —
  // parseFile/inspectFile are separate calls, same "pick, then act"
  // split as backup:pickFile.
  ipcMain.handle('import:pickFile', (event) => {
    requireUser()
    return importService.pickImportFile(BrowserWindow.fromWebContents(event.sender))
  })

  ipcMain.handle('import:inspectFile', async (_event, filePath) => {
    try {
      requireUser()
      return await importService.inspectFile(filePath)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('import:parseFile', async (_event, filePath, options) => {
    try {
      requireUser()
      return await importService.parseFile(filePath, options)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('import:buildPreview', (_event, payload) => {
    try {
      requireUser()
      return importService.buildPreview(payload)
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('import:commit', async (_event, payload) => {
    try {
      const user = requireUser()
      const result = importService.commitImport(payload, user)
      // commitImport can return success:false without throwing (e.g. the
      // "canceled due to duplicates" path) — nothing was actually written
      // to the database in that case, so an auto-backup would be a no-op
      // at best and a misleading "we just backed something up" signal at
      // worst. Only a genuine commit warrants one.
      if (!result.success) return result
      const backupWarning = await autoBackupService.triggerAutoBackup(user)
      return backupWarning ? { ...result, backupWarning } : result
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}
