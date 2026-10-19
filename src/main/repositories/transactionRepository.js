import { getDatabase } from '../database/connection'

function listByAsset(assetId) {
  return getDatabase()
    .prepare(
      `SELECT t.*, ps.name as previous_status, ns.name as new_status, u.username as performed_by
       FROM asset_transactions t
       LEFT JOIN asset_statuses ps ON ps.id = t.previous_status_id
       JOIN asset_statuses ns ON ns.id = t.new_status_id
       JOIN users u ON u.id = t.performed_by_user_id
       WHERE t.asset_id = ?
       ORDER BY t.transaction_date DESC`
    )
    .all(assetId)
}

// Same shape as listByAsset, minus the asset filter and plus the asset's
// own code/name — needed so a cross-asset report row is identifiable.
function listAll({ limit = 200, offset = 0 } = {}) {
  return getDatabase()
    .prepare(
      `SELECT t.*, a.asset_code, a.asset_name,
              ps.name as previous_status, ns.name as new_status, u.username as performed_by
       FROM asset_transactions t
       JOIN assets a ON a.id = t.asset_id
       LEFT JOIN asset_statuses ps ON ps.id = t.previous_status_id
       JOIN asset_statuses ns ON ns.id = t.new_status_id
       JOIN users u ON u.id = t.performed_by_user_id
       ORDER BY t.transaction_date DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset)
}

/**
 * Bulk counterpart to insert (Phase 5 — Performance), same reused-
 * statement approach as assetRepository.bulkCreate/bulkUpdate and
 * auditLogRepository.bulkInsert. Used by importService.commitImport for
 * the transaction-ledger entry written per imported/updated row, so a
 * large import doesn't re-prepare this INSERT once per row. Must be
 * called inside a caller-owned db.transaction(), same as insert().
 */
function bulkInsert(entries) {
  const stmt = getDatabase().prepare(
    `INSERT INTO asset_transactions
      (asset_id, previous_status_id, new_status_id, transaction_date, delivered_by, received_by, notes, performed_by_user_id)
     VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?)`
  )
  for (const {
    assetId,
    previousStatusId,
    newStatusId,
    transactionDate,
    deliveredBy,
    receivedBy,
    notes,
    performedByUserId
  } of entries) {
    stmt.run(
      assetId,
      previousStatusId ?? null,
      newStatusId,
      transactionDate ?? null,
      deliveredBy ?? null,
      receivedBy ?? null,
      notes ?? null,
      performedByUserId
    )
  }
}

function insert({ assetId, previousStatusId, newStatusId, transactionDate, deliveredBy, receivedBy, notes, performedByUserId }) {
  getDatabase()
    .prepare(
      `INSERT INTO asset_transactions
        (asset_id, previous_status_id, new_status_id, transaction_date, delivered_by, received_by, notes, performed_by_user_id)
       VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?)`
    )
    .run(assetId, previousStatusId ?? null, newStatusId, transactionDate ?? null, deliveredBy ?? null, receivedBy ?? null, notes ?? null, performedByUserId)
}

export const transactionRepository = { listByAsset, listAll, insert, bulkInsert }
