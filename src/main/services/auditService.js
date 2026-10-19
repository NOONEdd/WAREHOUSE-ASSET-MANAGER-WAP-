import { auditLogRepository } from '../repositories/auditLogRepository'

/**
 * The one function every write-path calls (Phase 2, Section 5). Takes the
 * CURRENT SESSION's user, never a value passed up from the renderer — see
 * authService — so audit attribution can't be spoofed from the UI side.
 */
function recordAudit({ user, action, entityType, entityId, changes }) {
  auditLogRepository.insert({
    userId: user?.id ?? null,
    username: user?.username ?? 'system',
    action,
    entityType,
    entityId,
    changes
  })
}

/**
 * Bulk counterpart to recordAudit (Phase 5 — Performance), for the one
 * caller that writes many audit entries in a single call: importService
 * .commitImport, which otherwise calls recordAudit once per imported/
 * updated row. Same "current session user per entry" shape as
 * recordAudit — every entry still carries its own `user`, so this isn't
 * a relaxation of recordAudit's spoofing protection, just a batched way
 * to write many of its entries at once via auditLogRepository.bulkInsert.
 */
function recordAuditBulk(entries) {
  auditLogRepository.bulkInsert(
    entries.map(({ user, action, entityType, entityId, changes }) => ({
      userId: user?.id ?? null,
      username: user?.username ?? 'system',
      action,
      entityType,
      entityId,
      changes
    }))
  )
}

function listAuditLog(filters) {
  return auditLogRepository.list(filters)
}

export const auditService = { recordAudit, recordAuditBulk, listAuditLog }
