import { ipcMain, BrowserWindow } from 'electron'
import { exportService } from '../services/exportService'
import { authService } from '../services/authService'

// Same requireUser() guard used throughout every other *.ipc.js file —
// reused here rather than introducing a second auth mechanism.
function requireUser() {
  const user = authService.getCurrentUser()
  if (!user) throw new Error('ابتدا وارد حساب کاربری شوید')
  return user
}

export function registerExportHandlers() {
  // Security Hardening phase — export is the single clearest way company
  // data leaves the app as a file; the audit explicitly flagged all
  // three of these as having no auth check at all. Output
  // format/behavior for an authenticated call is unchanged — the guard
  // only rejects the unauthenticated case.
  ipcMain.handle('export:toExcel', (event, payload) => {
    const user = requireUser()
    return exportService.exportToExcel(payload, BrowserWindow.fromWebContents(event.sender), user)
  })
  ipcMain.handle('export:toPdf', (event, payload) => {
    const user = requireUser()
    return exportService.exportToPdf(payload, BrowserWindow.fromWebContents(event.sender), user)
  })
  ipcMain.handle('export:printLabels', (event, payload) => {
    const user = requireUser()
    return exportService.printLabels(payload, BrowserWindow.fromWebContents(event.sender), user)
  })
}
