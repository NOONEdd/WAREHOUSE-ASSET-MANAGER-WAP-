import { ipcMain } from 'electron'
import { transactionService } from '../services/transactionService'
import { authService } from '../services/authService'

// Same requireUser() guard used throughout every other *.ipc.js file —
// reused here rather than introducing a second auth mechanism.
function requireUser() {
  const user = authService.getCurrentUser()
  if (!user) throw new Error('ابتدا وارد حساب کاربری شوید')
  return user
}

export function registerTransactionHandlers() {
  // Security Hardening phase — transaction history is company data
  // (who delivered/received what, when) and had no auth check at all
  // (audit finding: HIGH).
  ipcMain.handle('transactions:listByAsset', (_event, assetId) => {
    requireUser()
    return transactionService.listByAsset(assetId)
  })
  ipcMain.handle('transactions:listAll', (_event, params) => {
    requireUser()
    return transactionService.listAll(params)
  })
}
