import { getDatabase } from '../database/connection'

const TABLES = {
  itemTypes: 'item_types',
  workshops: 'workshops',
  countries: 'countries',
  statuses: 'asset_statuses'
}

// Which column on `assets` a given lookup kind is referenced by — used to
// check "is this value in use" before allowing a delete. Every one of
// these columns is already `REFERENCES ... ON DELETE RESTRICT` in
// schema.sql, so the database itself would refuse the DELETE regardless;
// checking first means a clear, specific Persian error instead of a raw
// SQLITE_CONSTRAINT surfacing to the person clicking the button.
const ASSET_COLUMN = {
  itemTypes: 'item_type_id',
  workshops: 'workshop_id',
  countries: 'country_id',
  statuses: 'status_id'
}

function list(kind) {
  const table = TABLES[kind]
  if (!table) throw new Error(`Unknown lookup kind: ${kind}`)
  return getDatabase().prepare(`SELECT * FROM ${table} ORDER BY name`).all()
}

function create(kind, name) {
  const table = TABLES[kind]
  if (!table) throw new Error(`Unknown lookup kind: ${kind}`)
  const info = getDatabase().prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name)
  return { id: info.lastInsertRowid, name }
}

function findByName(kind, name) {
  const table = TABLES[kind]
  return getDatabase().prepare(`SELECT * FROM ${table} WHERE name = ?`).get(name)
}

// Base Data Lifecycle phase — the ACTIVE row matching this name, if any.
// Unlike findByName above, this can never be ambiguous even once a name
// is shared by an active row and a retired (is_active = 0) one — see
// migrations/004-base-data-lifecycle.sql's partial unique index, which
// guarantees at most one active row per name. Used wherever "is this a
// valid, currently-selectable value" is the actual question (creating a
// new lookup, resolving a name typed/picked on an asset form) — plain
// findByName is still what duplicate-safe status code and anything that
// genuinely means "any row at all, active or not" should keep using.
function findActiveByName(kind, name) {
  const table = TABLES[kind]
  if (!table) throw new Error(`Unknown lookup kind: ${kind}`)
  return getDatabase().prepare(`SELECT * FROM ${table} WHERE name = ? AND is_active = 1`).get(name)
}

function findById(kind, id) {
  const table = TABLES[kind]
  if (!table) throw new Error(`Unknown lookup kind: ${kind}`)
  return getDatabase().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
}

// Counts ALL assets referencing this value, soft-deleted included — not
// `WHERE is_deleted = 0`. The foreign key itself doesn't care about the
// soft-delete flag (it's checking row existence, not visibility), so a
// soft-deleted asset still referencing this value would block the DELETE
// at the database level regardless of what this count says. Checking the
// same way the database will enforce it means the count and the actual
// outcome can never disagree.
function countUsage(kind, id) {
  const column = ASSET_COLUMN[kind]
  if (!column) throw new Error(`Unknown lookup kind: ${kind}`)
  return getDatabase().prepare(`SELECT COUNT(*) as n FROM assets WHERE ${column} = ?`).get(id).n
}

// Base Data Lifecycle phase — the OTHER half of countUsage's count: only
// assets still visible/active (is_deleted = 0). The gap between this and
// countUsage's total is exactly what distinguishes "genuinely still in
// use" (this is > 0 — must stay blocked) from "only historical/soft-
// deleted assets reference it" (this is 0 but countUsage isn't — safe to
// deactivate, even though a hard DELETE would still fail at the database
// level per countUsage's own comment).
function countActiveUsage(kind, id) {
  const column = ASSET_COLUMN[kind]
  if (!column) throw new Error(`Unknown lookup kind: ${kind}`)
  return getDatabase().prepare(`SELECT COUNT(*) as n FROM assets WHERE ${column} = ? AND is_deleted = 0`).get(id).n
}

function remove(kind, id) {
  const table = TABLES[kind]
  if (!table) throw new Error(`Unknown lookup kind: ${kind}`)
  getDatabase().prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
}

// Base Data Lifecycle phase — activate/deactivate for item_types/
// workshops/countries (asset_statuses keeps its own dedicated
// setStatusActive below, untouched — Manual Status Management is
// explicitly not being redesigned here). Generic across kinds at this
// repository layer the same way remove() above already is; which kinds
// this is actually reachable for is a service-layer decision
// (lookupService.js), not enforced here.
function setActive(kind, id, isActive) {
  const table = TABLES[kind]
  if (!table) throw new Error(`Unknown lookup kind: ${kind}`)
  getDatabase().prepare(`UPDATE ${table} SET is_active = ? WHERE id = ?`).run(isActive ? 1 : 0, id)
}

// --- Manual Status Management phase ---
// The four functions below are deliberately status-specific rather than
// generic across all lookup kinds: is_active and sort_order only exist
// on asset_statuses (see migrations/003-status-management-columns.sql) —
// item_types/workshops/countries have no such columns, so a generic
// "setActive(kind, id, ...)" would be misleading about what it actually
// supports.

function updateStatusName(id, name) {
  getDatabase().prepare('UPDATE asset_statuses SET name = ? WHERE id = ?').run(name, id)
}

function setStatusActive(id, isActive) {
  getDatabase().prepare('UPDATE asset_statuses SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id)
}

// Used once, right after creating a brand-new status — see
// lookupService.createStatus — to place it at the end of the
// administrator's current display order. Distinct from
// swapStatusSortOrder below, which only ever exchanges values between
// two already-ordered rows (the up/down-move UI action); a new row has
// no sort_order yet (NULL — see migrations/003's comment on why the
// column itself has no default), so it needs a plain single-row set.
function setStatusSortOrder(id, order) {
  getDatabase().prepare('UPDATE asset_statuses SET sort_order = ? WHERE id = ?').run(order, id)
}

// Swaps sort_order between two adjacent rows — the only reordering
// operation the UI actually needs (move up / move down one place), so
// there's no reason to support an arbitrary drag-to-position API that
// would need its own renumbering logic.
function swapStatusSortOrder(idA, idB) {
  const db = getDatabase()
  const a = db.prepare('SELECT sort_order FROM asset_statuses WHERE id = ?').get(idA)
  const b = db.prepare('SELECT sort_order FROM asset_statuses WHERE id = ?').get(idB)
  db.prepare('UPDATE asset_statuses SET sort_order = ? WHERE id = ?').run(b.sort_order, idA)
  db.prepare('UPDATE asset_statuses SET sort_order = ? WHERE id = ?').run(a.sort_order, idB)
}

// Every status ordered for display — sort_order first (the
// administrator's own chosen order), name as a tiebreaker for any rows
// that happen to share a sort_order (shouldn't normally occur, but a
// stable, deterministic order is better than relying on SQLite's
// unspecified row order for ties). Deliberately separate from the
// generic list('statuses') above (still plain `ORDER BY name`, used by
// countUsage-adjacent code paths that don't care about display order) —
// changing that shared function's ordering would be an unrelated,
// unrequested behavior change for its other callers.
function listStatusesOrdered() {
  return getDatabase().prepare('SELECT * FROM asset_statuses ORDER BY sort_order, name').all()
}

export const lookupRepository = {
  list,
  create,
  findByName,
  findActiveByName,
  findById,
  countUsage,
  countActiveUsage,
  remove,
  setActive,
  updateStatusName,
  setStatusActive,
  setStatusSortOrder,
  swapStatusSortOrder,
  listStatusesOrdered
}
