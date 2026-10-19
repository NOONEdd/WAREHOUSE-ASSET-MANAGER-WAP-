import { ipcMain, BrowserWindow } from 'electron'
import { backupService } from '../services/backupService'
import { authService } from '../services/authService'

function requireUser() {
  const user = authService.getCurrentUser()
  if (!user) throw new Error('ابتدا وارد حساب کاربری شوید')
  return user
}

export function registerBackupHandlers() {
  // Security Hardening phase — reveals the full list of backups
  // (filenames, timestamps, sizes) with no auth check before this.
  ipcMain.handle('backup:list', () => {
    requireUser()
    return backupService.listBackups()
  })

  ipcMain.handle('backup:create', async () => {
    try {
      return await backupService.createBackup(requireUser())
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // Restoring a backup already shown in the list: the renderer sends only
  // a fileName, resolved here against listBackups() rather than trusting
  // a renderer-supplied path.
  ipcMain.handle('backup:restoreByFileName', async (event, fileName) => {
    try {
      const user = requireUser()
      const target = backupService.listBackups().find((b) => b.fileName === fileName)
      if (!target) return { success: false, error: 'فایل پشتیبان یافت نشد' }
      return await backupService.restoreFromFile(target.path, user, BrowserWindow.fromWebContents(event.sender))
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // Opens the native file picker only — no restore yet, so the renderer
  // can show a confirmation naming the specific chosen file first.
  // Security Hardening phase: gated even though picking a file alone
  // exposes no company data, for the same "keep the whole backup/restore
  // workflow behind login" consistency as every other channel here.
  ipcMain.handle('backup:pickFile', (event) => {
    requireUser()
    return backupService.pickBackupFile(BrowserWindow.fromWebContents(event.sender))
  })

  // The one place a renderer-supplied path is trusted for restore — only
  // because it always originates from backup:pickFile's native dialog,
  // never from arbitrary renderer input.
  ipcMain.handle('backup:restoreFromPath', async (event, filePath) => {
    try {
      return await backupService.restoreFromFile(filePath, requireUser(), BrowserWindow.fromWebContents(event.sender))
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('backup:downloadCopy', async (event, fileName) => {
    try {
      requireUser()
      const target = backupService.listBackups().find((b) => b.fileName === fileName)
      if (!target) return { success: false, error: 'فایل پشتیبان یافت نشد' }
      return await backupService.downloadBackupCopy(target.path, BrowserWindow.fromWebContents(event.sender))
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // Security Hardening phase — reveals the backup folder's filesystem
  // path; previously deliberately left open ("read-only, same as
  // backup:list") but backup:list is now gated too, so this should match.
  ipcMain.handle('backup:getDirInfo', () => {
    requireUser()
    return backupService.getBackupDirInfo()
  })

  ipcMain.handle('backup:pickDir', async (event) => {
    try {
      requireUser()
      return await backupService.pickBackupDir(BrowserWindow.fromWebContents(event.sender))
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('backup:resetDir', () => {
    try {
      requireUser()
      return backupService.resetBackupDir()
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}
