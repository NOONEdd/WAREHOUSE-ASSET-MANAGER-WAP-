import { ipcMain } from 'electron'
import { savedFilterService } from '../services/savedFilterService'
import { authService } from '../services/authService'

// Same requireUser() guard used throughout every other *.ipc.js file.
// Saved filters aren't sensitive company data on their own, but every
// other IPC channel in this app requires a session regardless — there's
// no reason for this one to be the exception.
function requireUser() {
  const user = authService.getCurrentUser()
  if (!user) throw new Error('ابتدا وارد حساب کاربری شوید')
  return user
}

export function registerSavedFilterHandlers() {
  ipcMain.handle('savedFilters:list', () => {
    requireUser()
    return savedFilterService.list()
  })

  ipcMain.handle('savedFilters:create', (_event, name, filters) => {
    try {
      requireUser()
      return { success: true, item: savedFilterService.create(name, filters) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('savedFilters:delete', (_event, id) => {
    try {
      requireUser()
      return { success: true, ...savedFilterService.remove(id) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}
