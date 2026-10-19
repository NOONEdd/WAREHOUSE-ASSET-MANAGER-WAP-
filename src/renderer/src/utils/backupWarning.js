import { message } from 'antd'

/**
 * Automatic Backup phase — every IPC response for an add/edit/delete/
 * import/status-change call may carry an optional `backupWarning` string
 * alongside its normal success payload (see autoBackupService.js on the
 * main side). It's never an error: the real operation already succeeded
 * by the time this could exist, so it's surfaced as its own toast
 * alongside — never instead of — the normal success message, and never
 * used to treat the operation itself as failed.
 */
export function notifyBackupWarning(result) {
  if (result?.backupWarning) {
    message.warning(result.backupWarning)
  }
}
