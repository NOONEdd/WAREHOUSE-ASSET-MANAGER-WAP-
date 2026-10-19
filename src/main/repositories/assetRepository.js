import { getDatabase } from '../database/connection'

const LIST_SELECT = `
  SELECT a.*, it.name as item_type, w.name as workshop, c.name as country, s.name as status
  FROM assets a
  JOIN item_types it ON it.id = a.item_type_id
  LEFT JOIN workshops w ON w.id = a.workshop_id
  LEFT JOIN countries c ON c.id = a.country_id
  JOIN asset_statuses s ON s.id = a.status_id
`

function list({ search, statusId, workshopId, itemTypeId, countryId, from, to, limit = 50, offset = 0 } = {}) {
  const clauses = ['a.is_deleted = 0']
  const params = []

  if (search) {
    // CAST so a numeric id (e.g. 42) still matches via substring search,
    // same as the text fields below — Phase 11: id was missing here even
    // though it's shown to users as "شناسه دارایی".
    clauses.push(
      '(a.asset_code LIKE ? OR a.serial_number LIKE ? OR a.asset_name LIKE ? OR a.model LIKE ? OR CAST(a.id AS TEXT) LIKE ?)'
    )
    const like = `%${search}%`
    params.push(like, like, like, like, like)
  }
  if (statusId) {
    clauses.push('a.status_id = ?')
    params.push(statusId)
  }
  if (workshopId) {
    clauses.push('a.workshop_id = ?')
    params.push(workshopId)
  }
  if (itemTypeId) {
    clauses.push('a.item_type_id = ?')
    params.push(itemTypeId)
  }
  if (countryId) {
    clauses.push('a.country_id = ?')
    params.push(countryId)
  }
  if (from) {
    clauses.push('a.warehouse_entry_date >= ?')
    params.push(from)
  }
  if (to) {
    clauses.push('a.warehouse_entry_date <= ?')
    params.push(to)
  }

  const where = `WHERE ${clauses.join(' AND ')}`
  const db = getDatabase()

  const rows = db
    // Tiebreaker on id (Phase 6 QA finding): created_at has only
    // second-level resolution (schema.sql: DEFAULT (datetime('now'))),
    // and a bulk import commits hundreds or thousands of rows inside one
    // transaction — realistically all sharing the exact same created_at
    // second. ORDER BY created_at DESC alone has no deterministic
    // tiebreak for those ties, which is exactly the condition Phase 5's
    // pagination now depends on for a stable, gap-free walk through
    // LIMIT/OFFSET pages. id DESC (matching insertion/creation order,
    // consistent with the existing "newest first" intent) makes the
    // order fully deterministic regardless of how many rows share a
    // timestamp.
    .prepare(`${LIST_SELECT} ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)

  const total = db.prepare(`SELECT COUNT(*) as n FROM assets a ${where}`).get(...params).n

  return { rows, total }
}

function getById(id) {
  return getDatabase().prepare(`${LIST_SELECT} WHERE a.id = ? AND a.is_deleted = 0`).get(id)
}

function findByCodeOrSerial(assetCode, serialNumber) {
  return getDatabase()
    .prepare(
      'SELECT id, asset_code, serial_number FROM assets WHERE (asset_code = ? OR serial_number = ?) AND is_deleted = 0'
    )
    .get(assetCode, serialNumber)
}

/**
 * Bulk counterpart to findByCodeOrSerial, added for import (Phase 9):
 * checking 5,000+ rows one query at a time against the DB would make the
 * preview step visibly slow. Loaded once per import and matched in memory
 * instead. Filtered to active rows for the same reason findByCodeOrSerial
 * is above: asset_code and serial_number are only UNIQUE among active
 * assets (idx_assets_code_active / idx_assets_serial_active in
 * schema.sql), not across the whole table — a soft-deleted row's code or
 * serial number is free to be reused by a new or re-imported asset.
 */
function findAllCodesAndSerials() {
  return getDatabase().prepare('SELECT id, asset_code, serial_number FROM assets WHERE is_deleted = 0').all()
}

function create(fields) {
  const info = getDatabase()
    .prepare(
      `INSERT INTO assets
        (asset_code, asset_name, item_type_id, model, serial_number, country_id, workshop_id,
         warehouse_entry_date, warehouse_exit_date, delivered_by, received_by, status_id, notes)
       VALUES (@assetCode, @assetName, @itemTypeId, @model, @serialNumber, @countryId, @workshopId,
         @warehouseEntryDate, @warehouseExitDate, @deliveredBy, @receivedBy, @statusId, @notes)`
    )
    .run(fields)
  return info.lastInsertRowid
}

function update(id, fields) {
  getDatabase()
    .prepare(
      `UPDATE assets SET
        asset_code = @assetCode, asset_name = @assetName, item_type_id = @itemTypeId,
        model = @model, serial_number = @serialNumber, country_id = @countryId,
        workshop_id = @workshopId, warehouse_entry_date = @warehouseEntryDate,
        warehouse_exit_date = @warehouseExitDate, delivered_by = @deliveredBy,
        received_by = @receivedBy, status_id = @statusId, notes = @notes
       WHERE id = @id`
    )
    .run({ ...fields, id })
}

function softDelete(id, deletedByUserId) {
  getDatabase()
    .prepare(
      `UPDATE assets SET is_deleted = 1, deleted_at = datetime('now'), deleted_by = ?
       WHERE id = ?`
    )
    .run(deletedByUserId, id)
}

/**
 * Bulk insert for import (Phase 9): one prepared statement reused across
 * every row instead of re-preparing per call, so a 5,000-row commit stays
 * fast. Must be called inside a caller-owned db.transaction() — this
 * function has no transaction of its own, matching how assetService
 * already owns transaction boundaries rather than the repository layer.
 */
function bulkCreate(rowsFields) {
  const stmt = getDatabase().prepare(
    `INSERT INTO assets
      (asset_code, asset_name, item_type_id, model, serial_number, country_id, workshop_id,
       warehouse_entry_date, warehouse_exit_date, delivered_by, received_by, status_id, notes)
     VALUES (@assetCode, @assetName, @itemTypeId, @model, @serialNumber, @countryId, @workshopId,
       @warehouseEntryDate, @warehouseExitDate, @deliveredBy, @receivedBy, @statusId, @notes)`
  )
  return rowsFields.map((fields) => stmt.run(fields).lastInsertRowid)
}

/**
 * Bulk update counterpart, used by import's "update existing" duplicate
 * resolution. Same reused-statement approach as bulkCreate.
 */
function bulkUpdate(idsWithFields) {
  const stmt = getDatabase().prepare(
    `UPDATE assets SET
      asset_code = @assetCode, asset_name = @assetName, item_type_id = @itemTypeId,
      model = @model, serial_number = @serialNumber, country_id = @countryId,
      workshop_id = @workshopId, warehouse_entry_date = @warehouseEntryDate,
      warehouse_exit_date = @warehouseExitDate, delivered_by = @deliveredBy,
      received_by = @receivedBy, status_id = @statusId, notes = @notes
     WHERE id = @id`
  )
  for (const { id, fields } of idsWithFields) {
    stmt.run({ ...fields, id })
  }
}

/**
 * Status Cleanup phase — every asset currently pointing at a given
 * status, soft-deleted included. Used only by lookupService's legacy-
 * status migration: the FK on assets.status_id (ON DELETE RESTRICT)
 * doesn't care about is_deleted any more than lookupRepository.countUsage
 * does (see that function's comment) — a status can't be deleted while
 * ANY row still references it, visible or not — so every one of them
 * needs to move off the old status_id first, not just the ones a normal
 * filtered list would show.
 */
function findIdsByStatusId(statusId) {
  return getDatabase()
    .prepare('SELECT id FROM assets WHERE status_id = ?')
    .all(statusId)
    .map((r) => r.id)
}

/**
 * Bulk counterpart to update() for the same migration — one UPDATE for
 * every affected asset instead of one write per row, since a legacy
 * status being retired can be attached to a large number of assets.
 * Deliberately not scoped to is_deleted = 0, for the same reason
 * findIdsByStatusId above isn't: every referencing row must move off the
 * old status_id, or the DELETE of the old status row would still fail
 * the FK check on whatever was left behind.
 */
function reassignStatusBulk(fromStatusId, toStatusId) {
  return getDatabase()
    .prepare('UPDATE assets SET status_id = ? WHERE status_id = ?')
    .run(toStatusId, fromStatusId).changes
}

// Phase 4.2 — Dashboard's "recently added" section. Only LIMIT rows are
// ever fetched (never the whole table — see the module doc note this
// phase's plan called out), backed by idx_assets_created_at (migration
// 006) rather than a full-table sort.
function getRecentlyAdded(limit = 5) {
  return getDatabase()
    .prepare(`${LIST_SELECT} WHERE a.is_deleted = 0 ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
    .all(limit)
}

// Phase 4.2 — Dashboard's "recently modified" section. updated_at is
// kept current by the update_assets_timestamp trigger (schema.sql) on
// every UPDATE — updateAsset, changeAssetStatus/changeAssetStatusBulk,
// even softDelete (filtered out below same as every other query here).
//
// Deliberately NOT filtered to "updated_at strictly after created_at" to
// try to exclude freshly-created/never-edited rows: created_at/
// updated_at only have second-level resolution (datetime('now') —
// same caveat as assetRepository.list's id-tiebreaker comment), so an
// asset edited within the same wall-clock second it was created would
// have updated_at == created_at as strings and get wrongly excluded from
// this list despite genuinely having just been edited. Simpler and
// correct beats a heuristic that silently drops real edits: right after
// a bulk import this list and "recently added" may briefly show the
// same rows, which is an honest reflection of both columns' actual
// values, not a bug. Backed by idx_assets_updated_at (migration 006).
function getRecentlyModified(limit = 5) {
  return getDatabase()
    .prepare(`${LIST_SELECT} WHERE a.is_deleted = 0 ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`)
    .all(limit)
}

export const assetRepository = {
  list,
  getById,
  findByCodeOrSerial,
  findAllCodesAndSerials,
  create,
  update,
  softDelete,
  bulkCreate,
  bulkUpdate,
  findIdsByStatusId,
  reassignStatusBulk,
  getRecentlyAdded,
  getRecentlyModified
}
