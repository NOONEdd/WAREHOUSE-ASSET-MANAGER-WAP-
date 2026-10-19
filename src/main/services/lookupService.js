import { getDatabase } from '../database/connection'
import { lookupRepository } from '../repositories/lookupRepository'
import { assetRepository } from '../repositories/assetRepository'
import { transactionRepository } from '../repositories/transactionRepository'
import { auditService } from './auditService'

const KIND_LABELS = {
  itemTypes: 'نوع کالا',
  workshops: 'واحد/بخش',
  countries: 'کشور سازنده',
  statuses: 'وضعیت'
}

// Reliability + Audit Completeness phase — entityType string recorded
// against every generic lookup CRUD audit entry below, one per kind.
// 'statuses' is never looked up here — the generic audit calls below
// only ever run for DELETABLE_KINDS (itemTypes/workshops/countries);
// asset_statuses keeps recording its own AssetStatus entityType through
// its dedicated STATUS_* actions further down this file.
const KIND_TO_ENTITY_TYPE = {
  itemTypes: 'ItemType',
  workshops: 'Workshop',
  countries: 'Country'
}

// Deletable kinds through the generic path — asset_statuses has its own
// dedicated create/rename/activate/delete functions below (Manual Status
// Management phase) with rules the generic path here doesn't know about
// (system-status protection, active/inactive, display order), so it's
// deliberately excluded here rather than taught those rules.
const DELETABLE_KINDS = new Set(['itemTypes', 'workshops', 'countries'])

function getAllLookups() {
  return {
    itemTypes: lookupRepository.list('itemTypes'),
    workshops: lookupRepository.list('workshops'),
    countries: lookupRepository.list('countries'),
    statuses: lookupRepository.listStatusesOrdered()
  }
}

// "افزودن" in the generic base-data UI (item types/workshops/countries)
// must not double as a second, less-safe way to create a status —
// createStatus below is the real, supported path (audited, and only it
// knows to append a sort_order). Doesn't affect import's own
// auto-creation of new item types/workshops/countries — that calls
// lookupRepository.create directly, one layer below this guard, and
// never touches 'statuses' regardless (STRICT_LOOKUP_FIELD_KEYS).
//
// Base Data Lifecycle phase — the duplicate check only looks at ACTIVE
// rows now (findActiveByName, not findByName): a name matching a
// retired (is_active = 0) row must not block creating a fresh active
// one with that same name — that coexistence is exactly what
// migrations/004-base-data-lifecycle.sql's partial unique index exists
// to allow. The new row is a genuinely separate, distinct entity from
// the old retired one (a different id) — this deliberately does NOT
// reactivate the old row instead, since silently reviving a retired
// record under a "create" action could reattach meaning to historical
// soft-deleted assets that reference its id in ways nobody asked for;
// the simpler two-distinct-rows behavior was chosen over that.
function createLookup(kind, name, currentUser) {
  if (kind === 'statuses') {
    throw new Error('برای افزودن وضعیت جدید از بخش «وضعیت» در داده‌های پایه استفاده کنید')
  }
  const trimmed = name?.trim()
  if (!trimmed) throw new Error('نام نمی‌تواند خالی باشد')
  if (lookupRepository.findActiveByName(kind, trimmed)) {
    throw new Error('این مورد از قبل وجود دارد')
  }
  const created = lookupRepository.create(kind, trimmed)
  auditService.recordAudit({
    user: currentUser,
    action: 'CREATE',
    entityType: KIND_TO_ENTITY_TYPE[kind],
    entityId: created.id,
    changes: { name: trimmed }
  })
  return created
}

function assertDeletable(kind) {
  if (!DELETABLE_KINDS.has(kind)) {
    throw new Error('این نوع داده قابل حذف نیست')
  }
}

/**
 * Base Data Lifecycle phase. A hard DELETE is only actually possible when
 * NOTHING references the row (countUsage === 0) — the FK's own
 * ON DELETE RESTRICT doesn't care whether a referencing asset is
 * soft-deleted, so any remaining reference (historical included) would
 * fail the DELETE at the database level regardless of what this checks.
 * Three outcomes, decided in this order:
 *   - No references at all → hard delete.
 *   - Only soft-deleted assets reference it → deactivate instead. The
 *     historical assets keep this exact value forever (nothing about
 *     them is touched); the value just stops being offered for new or
 *     current selections (see assetService.resolveLookupId).
 *   - At least one ACTIVE asset still references it → blocked, same as
 *     before, just worded around "فعال" (active) specifically now —
 *     Section 14 of this phase: the error must never claim "still in
 *     use" when the only references left are historical ones.
 */
function deleteLookup(kind, id, currentUser) {
  assertDeletable(kind)
  const row = lookupRepository.findById(kind, id)
  if (!row) throw new Error('مورد یافت نشد؛ فهرست را تازه‌سازی کنید')

  const totalUsage = lookupRepository.countUsage(kind, id)
  if (totalUsage === 0) {
    lookupRepository.remove(kind, id)
    auditService.recordAudit({
      user: currentUser,
      action: 'DELETE',
      entityType: KIND_TO_ENTITY_TYPE[kind],
      entityId: id,
      changes: { name: row.name }
    })
    return { id, name: row.name, action: 'deleted' }
  }

  const activeUsage = lookupRepository.countActiveUsage(kind, id)
  if (activeUsage > 0) {
    throw new Error(`«${row.name}» توسط ${activeUsage} دارایی فعال استفاده می‌شود و قابل حذف نیست`)
  }

  lookupRepository.setActive(kind, id, false)
  auditService.recordAudit({
    user: currentUser,
    action: 'DEACTIVATED',
    entityType: KIND_TO_ENTITY_TYPE[kind],
    entityId: id,
    changes: { name: row.name, reason: 'referenced only by historical (soft-deleted) assets' }
  })
  return { id, name: row.name, action: 'deactivated', historicalUsage: totalUsage }
}

// Bulk delete — Base Data Lifecycle phase. Each selected row's fate is
// decided independently (same three outcomes as single-delete above)
// BEFORE anything is touched, so one row being actively in use only ever
// protects that one row — it can no longer block a different, genuinely
// safe-to-delete-or-deactivate row in the same selection the way the
// previous all-or-nothing version did. Still one transaction: either
// every row that's supposed to change (delete or deactivate) does, or
// (on some unexpected failure) none of them do — a blocked row was never
// going to change regardless, so it isn't part of that atomicity concern.
function deleteLookupsBulk(kind, ids, currentUser) {
  assertDeletable(kind)
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('هیچ موردی انتخاب نشده است')
  }

  const rows = ids.map((id) => {
    const row = lookupRepository.findById(kind, id)
    if (!row) throw new Error('یکی از موارد انتخاب‌شده دیگر وجود ندارد؛ فهرست را تازه‌سازی کنید')
    return row
  })

  const plan = rows.map((row) => {
    const totalUsage = lookupRepository.countUsage(kind, row.id)
    if (totalUsage === 0) return { row, action: 'deleted' }
    const activeUsage = lookupRepository.countActiveUsage(kind, row.id)
    if (activeUsage === 0) return { row, action: 'deactivated' }
    return { row, action: 'blocked', activeUsage }
  })

  const db = getDatabase()
  db.transaction(() => {
    for (const item of plan) {
      if (item.action === 'deleted') lookupRepository.remove(kind, item.row.id)
      else if (item.action === 'deactivated') lookupRepository.setActive(kind, item.row.id, false)
      // 'blocked' rows are left exactly as they were.
    }

    // One audit entry per row that actually changed — 'blocked' rows
    // never touched the database, so they get no entry. Written inside
    // the same transaction as the mutations above: if the transaction
    // rolls back for any reason, the audit trail rolls back with it
    // rather than recording changes that didn't actually happen.
    const entries = plan
      .filter((p) => p.action !== 'blocked')
      .map(({ row, action }) => ({
        user: currentUser,
        action: action === 'deleted' ? 'DELETE' : 'DEACTIVATED',
        entityType: KIND_TO_ENTITY_TYPE[kind],
        entityId: row.id,
        changes: { name: row.name }
      }))
    if (entries.length > 0) auditService.recordAuditBulk(entries)
  })()

  return {
    deletedCount: plan.filter((p) => p.action === 'deleted').length,
    deactivatedCount: plan.filter((p) => p.action === 'deactivated').length,
    blocked: plan
      .filter((p) => p.action === 'blocked')
      .map(({ row, activeUsage }) => ({ id: row.id, name: row.name, activeUsage }))
  }
}

// Base Data Lifecycle phase — "6. REACTIVATE": the explicit path back for
// a row deleteLookup only deactivated. Also doubles as a manual
// deactivate for a row that's currently unused-but-active, matching
// Status's own setStatusActive supporting both directions through one
// function. Kept generic across the three lifecycle-managed kinds at the
// service layer too (assertDeletable already restricts this to
// itemTypes/workshops/countries — 'statuses' keeps using its own
// dedicated setStatusActive, never this one).
function setLookupActive(kind, id, isActive, currentUser) {
  assertDeletable(kind)
  const row = lookupRepository.findById(kind, id)
  if (!row) throw new Error('مورد یافت نشد؛ فهرست را تازه‌سازی کنید')

  lookupRepository.setActive(kind, id, isActive)
  auditService.recordAudit({
    user: currentUser,
    action: isActive ? 'REACTIVATED' : 'DEACTIVATED',
    entityType: KIND_TO_ENTITY_TYPE[kind],
    entityId: id,
    changes: { name: row.name }
  })
  return { id, name: row.name, isActive }
}

// Manual Status Management phase — asset_statuses is no longer a fixed,
// code-hardcoded enum. These four ship with every install (schema.sql)
// and are permanently protected: never deletable, renamable, or
// deactivatable, through any path, by anyone — this is what "the current
// required statuses" means. Matched by exact name rather than id, since
// asset_statuses.name is UNIQUE and that's simpler than depending on id
// ordering never having drifted (it has, across this file's history —
// see git blame/prior phase summaries for the five- and six-name eras
// this set went through before settling here).
//
// Everything else in the table — an administrator's own "تعمیر" or
// "قرنطینه", or a pre-existing value like "مفقود" on a database that
// was created before this phase — is a "custom" status, fully
// manageable: rename, activate/deactivate, reorder, and delete-if-
// unused (or reassign-and-delete if still in use). Nothing about an
// existing database's data changes just because this code shipped — see
// migrations/003's comment.
const SYSTEM_STATUS_NAMES = new Set(['در انبار', 'صادر شده', 'مرجوع شده', 'آسیب‌دیده'])

function isSystemStatusRow(row) {
  return SYSTEM_STATUS_NAMES.has(row.name)
}

function assertNotSystemStatus(row, action) {
  if (!row) throw new Error('وضعیت یافت نشد؛ فهرست را تازه‌سازی کنید')
  if (isSystemStatusRow(row)) {
    throw new Error(`«${row.name}» یکی از وضعیت‌های سیستمی برنامه است و ${action} نیست`)
  }
}

// asset_transactions rows are permanently immutable — schema.sql has
// triggers that block UPDATE/DELETE on that table outright, by design
// (it's the audit trail of every status change an asset has ever had).
// That means if a status was EVER used in a real status change in the
// past — even one now long since superseded, with today's usage count
// showing 0 — some asset_transactions row still has a live foreign key
// pointing at it (previous_status_id or new_status_id), and the database
// will correctly refuse to actually delete the row: better a clear
// refusal here than letting a bad DELETE silently corrupt that history.
// Both deletion paths below hit this the same way and explain it the
// same way, rather than surfacing a raw SQLITE_CONSTRAINT error.
function rethrowIfHistoricalReference(err, statusName) {
  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    throw new Error(
      `«${statusName}» در سوابق تراکنش تاریخی دارایی‌ها ثبت شده و آن سوابق برای حفظ صحت تاریخچه قابل تغییر نیستند؛ ` +
        'بنابراین این وضعیت قابل حذف نیست، هرچند دارایی‌های فعال از آن خارج شده‌اند'
    )
  }
  throw err
}

// For Settings → داده‌های پایه → وضعیت: every status — active or not —
// in the administrator's own display order, each tagged with whether
// it's a protected system status and how many assets currently
// reference it. Letting the renderer see isSystem/usageCount up front
// means it can offer the right action per row (no rename/deactivate/
// delete buttons at all for a system status; plain "حذف" for an unused
// custom one; "غیرفعال‌سازی" or "انتقال و حذف" for one still in use)
// instead of an action call failing and the person having to guess why.
function listStatuses() {
  return lookupRepository.listStatusesOrdered().map((row) => ({
    id: row.id,
    name: row.name,
    isActive: Boolean(row.is_active),
    isSystem: isSystemStatusRow(row),
    sortOrder: row.sort_order,
    usageCount: lookupRepository.countUsage('statuses', row.id)
  }))
}

// The capability this whole phase is actually for: a new status that
// doesn't exist anywhere in source code, created by an administrator,
// available for selection the moment this returns — no source change,
// no new phase, no request to an AI developer. Starts active, appended
// after every existing status in display order.
function createStatus(name, currentUser) {
  const trimmed = name?.trim()
  if (!trimmed) throw new Error('نام وضعیت نمی‌تواند خالی باشد')
  if (lookupRepository.findByName('statuses', trimmed)) {
    throw new Error('این وضعیت از قبل وجود دارد')
  }

  const existing = lookupRepository.listStatusesOrdered()
  const nextSortOrder = existing.reduce((max, r) => Math.max(max, r.sort_order ?? 0), 0) + 1

  const created = lookupRepository.create('statuses', trimmed)
  lookupRepository.setStatusSortOrder(created.id, nextSortOrder)

  auditService.recordAudit({
    user: currentUser,
    action: 'STATUS_CREATED',
    entityType: 'AssetStatus',
    entityId: created.id,
    changes: { name: trimmed }
  })

  return { id: created.id, name: trimmed, isActive: true, isSystem: false, sortOrder: nextSortOrder, usageCount: 0 }
}

// "Edit a status name when safe" — never for a system status (their
// exact names are what statusColors/Dashboard cards key off of, and
// what SYSTEM_STATUS_NAMES itself matches by), always for a custom one
// as long as the new name isn't blank or already taken.
function renameStatus(id, newName, currentUser) {
  const row = lookupRepository.findById('statuses', id)
  assertNotSystemStatus(row, 'قابل ویرایش')

  const trimmed = newName?.trim()
  if (!trimmed) throw new Error('نام وضعیت نمی‌تواند خالی باشد')
  const clash = lookupRepository.findByName('statuses', trimmed)
  if (clash && clash.id !== row.id) {
    throw new Error('این نام قبلاً برای وضعیت دیگری استفاده شده است')
  }

  lookupRepository.updateStatusName(id, trimmed)
  auditService.recordAudit({
    user: currentUser,
    action: 'STATUS_RENAMED',
    entityType: 'AssetStatus',
    entityId: id,
    changes: { from: row.name, to: trimmed }
  })
  return { id, name: trimmed }
}

/**
 * The preferred, non-destructive way to retire a status per SYSTEM
 * STATUS SAFETY / STATUS DELETION SAFETY: never a physical DELETE for a
 * status that's ever been used. Deactivating removes it from every
 * "pick a status" control for NEW selections (AssetFormPage,
 * ChangeStatusModal, and import's strictLookup matching — see
 * importService.js's buildLookupIndex) while every existing asset and
 * every historical transaction that already reference it keep working
 * completely unchanged: nothing about status_id, previous_status_id, or
 * new_status_id on any existing row is touched. Reversible at any time
 * via the same function with isActive: true.
 */
function setStatusActive(id, isActive, currentUser) {
  const row = lookupRepository.findById('statuses', id)
  assertNotSystemStatus(row, isActive ? 'قابل تغییر' : 'قابل غیرفعال‌سازی')

  lookupRepository.setStatusActive(id, isActive)
  auditService.recordAudit({
    user: currentUser,
    action: isActive ? 'STATUS_ACTIVATED' : 'STATUS_DEACTIVATED',
    entityType: 'AssetStatus',
    entityId: id,
    changes: { name: row.name }
  })
  return { id, name: row.name, isActive }
}

// "Set display/order position" — move one place up or down by swapping
// sort_order with whichever neighbor is adjacent in the administrator's
// current order. Allowed for system statuses too (reordering doesn't
// rename, delete, or deactivate anything — it's purely which order the
// dropdowns list them in), unlike every other status-management action
// above. Not audited: purely cosmetic ordering, not a change to what any
// status actually is or does.
function moveStatus(id, direction) {
  const ordered = lookupRepository.listStatusesOrdered()
  const index = ordered.findIndex((r) => r.id === id)
  if (index === -1) throw new Error('وضعیت یافت نشد؛ فهرست را تازه‌سازی کنید')

  const neighborIndex = direction === 'up' ? index - 1 : index + 1
  if (neighborIndex < 0 || neighborIndex >= ordered.length) {
    return { id, moved: false } // already at the edge — nothing to do, not an error
  }

  lookupRepository.swapStatusSortOrder(id, ordered[neighborIndex].id)
  return { id, moved: true }
}

// Plain delete for a custom status nothing references — no data to
// move, so no reassignment target is needed. Refuses, rather than
// silently deactivating or migrating, when the status IS in use (same
// "name the count" shape as deleteLookup's existing in-use error) —
// setStatusActive (deactivate) is the preferred path for that case;
// migrateAndDeleteStatus is the less-preferred, still-available path for
// an administrator who specifically wants full removal instead.
function deleteStatus(id, currentUser) {
  const row = lookupRepository.findById('statuses', id)
  assertNotSystemStatus(row, 'قابل حذف')

  const usage = lookupRepository.countUsage('statuses', id)
  if (usage > 0) {
    throw new Error(
      `«${row.name}» توسط ${usage} دارایی استفاده می‌شود؛ به‌جای حذف، آن را غیرفعال کنید تا سوابق موجود سالم بمانند`
    )
  }

  try {
    lookupRepository.remove('statuses', id)
  } catch (err) {
    rethrowIfHistoricalReference(err, row.name)
  }

  auditService.recordAudit({
    user: currentUser,
    action: 'STATUS_DELETED',
    entityType: 'AssetStatus',
    entityId: id,
    changes: { name: row.name, reassignedTo: null, assetCount: 0 }
  })
  return { id, name: row.name }
}

/**
 * The explicit, less-preferred alternative to deactivating a status
 * that's still in use — kept available (not removed) for an
 * administrator who specifically wants full removal rather than a soft
 * disable, e.g. cleaning up a genuinely-unwanted legacy value. Moves
 * every asset currently on the status — soft-deleted included, see
 * assetRepository.findIdsByStatusId's comment for why — onto any other
 * currently ACTIVE status, then deletes the now-unused row. Both steps
 * run in one transaction: if the final delete turns out to be
 * impossible (see rethrowIfHistoricalReference above), better-sqlite3
 * rolls back the reassignment too, rather than leaving assets migrated
 * but the row stuck behind forever with a misleadingly-zero usage count.
 *
 * The target can be ANY active status — system or custom — as long as
 * it isn't the one being deleted; an inactive target would immediately
 * undo the point of retiring the source status (every reassigned asset
 * would land on something also unavailable for new selections).
 *
 * Reassigned assets get a transaction-ledger entry (not just a silent
 * status_id update) so the per-asset transaction history shown on
 * AssetDetailsPage — and the Transactions report — stay accurate.
 * previousStatusId is deliberately left null rather than set to the
 * status's id: asset_transactions rows are permanent (see
 * rethrowIfHistoricalReference above), so writing the soon-to-be-deleted
 * id into a NEW row would immediately pin that row in place and make
 * this function's own delete fail every time. The old status's name is
 * still fully preserved in `notes` — nothing is lost, it just isn't
 * stored as a live foreign key.
 */
function migrateAndDeleteStatus(id, targetStatusName, currentUser) {
  const row = lookupRepository.findById('statuses', id)
  assertNotSystemStatus(row, 'قابل حذف')

  const target = lookupRepository.findByName('statuses', targetStatusName)
  if (!target || !target.is_active) {
    throw new Error('وضعیت مقصد باید یکی از وضعیت‌های فعال برنامه باشد')
  }
  if (target.id === row.id) {
    throw new Error('وضعیت مقصد نمی‌تواند همان وضعیت در حال حذف باشد')
  }

  const affectedIds = assetRepository.findIdsByStatusId(row.id)

  const db = getDatabase()
  const run = db.transaction(() => {
    if (affectedIds.length > 0) {
      transactionRepository.bulkInsert(
        affectedIds.map((assetId) => ({
          assetId,
          previousStatusId: null,
          newStatusId: target.id,
          notes: `اصلاح داده پایه: انتقال از وضعیت حذف‌شده «${row.name}» به «${target.name}»`,
          performedByUserId: currentUser.id
        }))
      )
      assetRepository.reassignStatusBulk(row.id, target.id)
    }

    lookupRepository.remove('statuses', row.id)

    auditService.recordAudit({
      user: currentUser,
      action: 'STATUS_DELETED',
      entityType: 'AssetStatus',
      entityId: row.id,
      changes: { name: row.name, reassignedTo: target.name, assetCount: affectedIds.length }
    })
  })

  try {
    run()
  } catch (err) {
    rethrowIfHistoricalReference(err, row.name)
  }

  return { id: row.id, name: row.name, reassignedTo: target.name, assetCount: affectedIds.length }
}

export const lookupService = {
  getAllLookups,
  createLookup,
  deleteLookup,
  deleteLookupsBulk,
  setLookupActive,
  listStatuses,
  createStatus,
  renameStatus,
  setStatusActive,
  moveStatus,
  deleteStatus,
  migrateAndDeleteStatus
}
