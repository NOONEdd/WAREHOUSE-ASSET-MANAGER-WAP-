import { getDatabase } from '../database/connection'

/**
 * Insert-only by design — the schema's triggers (Phase 3) physically block
 * UPDATE/DELETE on this table, so there's no updateEntry/deleteEntry here
 * to accidentally call.
 */
function insert({ userId, username, action, entityType, entityId, changes }) {
  getDatabase()
    .prepare(
      `INSERT INTO audit_log (user_id, username_snapshot, action, entity_type, entity_id, changes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, username, action, entityType, entityId ?? null, changes ? JSON.stringify(changes) : null)
}

/**
 * Bulk counterpart to insert (Phase 5 — Performance): one prepared
 * statement reused across every entry instead of re-preparing per call,
 * matching assetRepository.bulkCreate/bulkUpdate's established pattern.
 * Used by importService.commitImport, which otherwise writes one audit
 * entry per imported/updated row — up to 5,000+ individual prepare()
 * calls in a single commit. Must be called inside a caller-owned
 * db.transaction(), same as insert() and every other write in this file.
 */
function bulkInsert(entries) {
  const stmt = getDatabase().prepare(
    `INSERT INTO audit_log (user_id, username_snapshot, action, entity_type, entity_id, changes)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  for (const { userId, username, action, entityType, entityId, changes } of entries) {
    stmt.run(userId, username, action, entityType, entityId ?? null, changes ? JSON.stringify(changes) : null)
  }
}

function list({ userId, action, entityType, from, to, limit = 100, offset = 0 } = {}) {
  const clauses = []
  const params = []

  if (userId) {
    clauses.push('user_id = ?')
    params.push(userId)
  }
  if (action) {
    clauses.push('action = ?')
    params.push(action)
  }
  if (entityType) {
    clauses.push('entity_type = ?')
    params.push(entityType)
  }
  if (from) {
    clauses.push('occurred_at >= ?')
    params.push(from)
  }
  if (to) {
    // Reliability + UX phase (3.1) — `to` arrives as a bare ISO date
    // (JalaliDatePicker's value/onChange contract, "YYYY-MM-DD") while
    // occurred_at is a full datetime. Comparing the bare date directly
    // would exclude every event on that day after midnight — padding to
    // the end of the day makes "to: امروز" actually include today's
    // events, matching what a person picking a date range expects.
    clauses.push('occurred_at <= ?')
    params.push(`${to} 23:59:59`)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const db = getDatabase()

  const rows = db
    // Reliability + UX phase (3.1) — id DESC tiebreaker, same reasoning
    // as assetRepository.list: occurred_at has only second-level
    // resolution, and a bulk operation (e.g. deleteLookupsBulk,
    // importService.commitImport) can write many audit rows inside one
    // transaction, realistically sharing the same timestamp. Without a
    // tiebreaker, OFFSET-based paging over rows tied on occurred_at is
    // non-deterministic — the same "page 2" request could return
    // different rows on different calls, or skip/duplicate a row across
    // pages entirely.
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)

  // Same COUNT-with-identical-WHERE approach as assetRepository.list —
  // reusing `where`/`params` guarantees this always matches exactly what
  // the paginated query above considers, so total/page count can never
  // drift out of sync with the actual filtered result set.
  const total = db.prepare(`SELECT COUNT(*) as n FROM audit_log ${where}`).get(...params).n

  return {
    rows: rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : null })),
    total
  }
}

export const auditLogRepository = { insert, bulkInsert, list }
