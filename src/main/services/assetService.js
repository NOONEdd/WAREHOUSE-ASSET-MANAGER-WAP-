import { assetRepository } from '../repositories/assetRepository'
import { transactionRepository } from '../repositories/transactionRepository'
import { lookupRepository } from '../repositories/lookupRepository'
import { getDatabase } from '../database/connection'
import { auditService } from './auditService'
import { checkDuplicateAssetCodeOrSerial, requireFields } from '../utils/validators'

/**
 * Repositories return raw SQL column names (snake_case); the renderer
 * should see a clean, stable API shape instead — this is the translation
 * boundary Phase 2 called for, so schema changes don't ripple into every
 * component that reads an asset.
 */
function toApiShape(row) {
  if (!row) return row
  return {
    id: row.id,
    assetCode: row.asset_code,
    assetName: row.asset_name,
    itemType: row.item_type,
    model: row.model,
    serialNumber: row.serial_number,
    country: row.country,
    workshop: row.workshop,
    entryDate: row.warehouse_entry_date,
    exitDate: row.warehouse_exit_date,
    deliveredBy: row.delivered_by,
    receivedBy: row.received_by,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function listAssets(filters) {
  const { rows, total } = assetRepository.list(filters)
  return { rows: rows.map(toApiShape), total }
}

function getAsset(id) {
  return toApiShape(assetRepository.getById(id))
}

function getDashboardStats() {
  const db = getDatabase()
  const total = db.prepare('SELECT COUNT(*) as n FROM assets WHERE is_deleted = 0').get().n
  const byStatus = db
    .prepare(
      `SELECT s.name as status, COUNT(a.id) as n
       FROM asset_statuses s
       LEFT JOIN assets a ON a.status_id = s.id AND a.is_deleted = 0
       GROUP BY s.id, s.name`
    )
    .all()

  return { total, byStatus }
}

// Dashboard's data-quality panel: how many active assets lack a unit, an
// entry date, or (while issued) a receiver. Each count uses the same SQL
// condition as listAssets({ quality }), so opening the matching list shows
// exactly that many rows.
function getDataQuality() {
  return assetRepository.countQualityIssues()
}

// Phase 4.2 — Dashboard's "recently added / recently modified" section.
// Sensible fixed limit (5-10 per the phase plan) rather than anything
// user-configurable — this is a glanceable dashboard widget, not a
// paginated list.
function getRecentActivity(limit = 5) {
  return {
    recentlyAdded: assetRepository.getRecentlyAdded(limit).map(toApiShape),
    recentlyModified: assetRepository.getRecentlyModified(limit).map(toApiShape)
  }
}

// Driven FROM assets (not workshops) and COALESCEd, unlike byStatus above —
// workshop_id is nullable (schema.sql), so a workshop-driven query would
// silently drop unassigned assets and the report's rows wouldn't sum to
// the true total. status_id is NOT NULL, so that risk doesn't apply there.
function getAssetCountByWorkshop() {
  const db = getDatabase()
  return db
    .prepare(
      `SELECT COALESCE(w.name, 'بدون واحد') as workshop, COUNT(a.id) as n
       FROM assets a
       LEFT JOIN workshops w ON w.id = a.workshop_id
       WHERE a.is_deleted = 0
       GROUP BY w.id
       ORDER BY n DESC`
    )
    .all()
}

// Driven FROM item_types (not assets), same shape as byStatus above —
// item_type_id is NOT NULL (schema.sql), so every asset is guaranteed to
// join to exactly one row here, same reasoning as byStatus, no COALESCE
// needed.
function getAssetCountByItemType() {
  const db = getDatabase()
  return db
    .prepare(
      `SELECT it.name as itemType, COUNT(a.id) as n
       FROM item_types it
       LEFT JOIN assets a ON a.item_type_id = it.id AND a.is_deleted = 0
       GROUP BY it.id, it.name
       ORDER BY n DESC`
    )
    .all()
}

// Driven FROM assets (not countries) and COALESCEd, same reasoning as
// byWorkshop above — country_id is nullable (schema.sql), so a
// countries-driven query would silently drop assets with no country set
// and the report's rows wouldn't sum to the true total.
function getAssetCountByCountry() {
  const db = getDatabase()
  return db
    .prepare(
      `SELECT COALESCE(c.name, 'بدون کشور') as country, COUNT(a.id) as n
       FROM assets a
       LEFT JOIN countries c ON c.id = a.country_id
       WHERE a.is_deleted = 0
       GROUP BY c.id
       ORDER BY n DESC`
    )
    .all()
}

// The frontend works with lookup NAMES (what the Select shows), the
// database with IDs — resolved here, once, rather than in every caller.
//
// Base Data Lifecycle phase — requires the row to be ACTIVE
// (findActiveByName, not findByName): an inactive item type/country/
// workshop/status must not be selectable for a create, an edit that
// actually changes this field, or a status change — enforced here, at
// the one shared point every one of those goes through, not only via
// the renderer's own filtered dropdowns (Section 4 of that phase:
// "this enforcement must exist in the backend... UI filtering alone is
// not sufficient"). Applies uniformly to all four kinds, status
// included — resolveLookupId is the single chokepoint for all of them,
// so leaving status out here while fixing the other three would leave
// this exact function asymmetric for no real reason; nothing about
// Status Management's own dedicated functions (create/rename/activate/
// delete/reorder) changes.
function resolveLookupId(kind, name, label) {
  if (!name) return null
  const row = lookupRepository.findActiveByName(kind, name)
  if (!row) throw new Error(`${label} انتخاب‌شده معتبر نیست یا غیرفعال است`)
  return row.id
}

function createAsset(input, currentUser) {
  const missing = requireFields(['assetCode', 'assetName', 'itemType', 'serialNumber', 'status'], input)
  if (missing) throw new Error(missing)

  const dupError = checkDuplicateAssetCodeOrSerial(input.assetCode, input.serialNumber)
  if (dupError) throw new Error(dupError)

  const itemTypeId = resolveLookupId('itemTypes', input.itemType, 'نوع کالای')
  const statusId = resolveLookupId('statuses', input.status, 'وضعیت')
  const workshopId = resolveLookupId('workshops', input.workshop, 'واحد')
  const countryId = resolveLookupId('countries', input.country, 'کشور')

  const db = getDatabase()
  const assetId = db.transaction(() => {
    const newId = assetRepository.create({
      assetCode: input.assetCode,
      assetName: input.assetName,
      itemTypeId,
      model: input.model || null,
      serialNumber: input.serialNumber,
      countryId,
      workshopId,
      warehouseEntryDate: input.entryDate || null,
      warehouseExitDate: input.exitDate || null,
      deliveredBy: input.deliveredBy || null,
      receivedBy: input.receivedBy || null,
      statusId,
      notes: input.notes || null
    })

    transactionRepository.insert({
      assetId: newId,
      previousStatusId: null,
      newStatusId: statusId,
      transactionDate: input.entryDate || null,
      deliveredBy: input.deliveredBy || null,
      receivedBy: input.receivedBy || null,
      notes: 'ثبت اولیه دارایی',
      performedByUserId: currentUser.id
    })

    auditService.recordAudit({
      user: currentUser,
      action: 'CREATE',
      entityType: 'Asset',
      entityId: newId,
      changes: { assetCode: input.assetCode, assetName: input.assetName, status: input.status }
    })

    return newId
  })()

  return toApiShape(assetRepository.getById(assetId))
}

function diffChanges(before, after, fields) {
  const changes = {}
  for (const f of fields) {
    if (before[f] !== after[f]) changes[f] = { old: before[f] ?? null, new: after[f] ?? null }
  }
  return Object.keys(changes).length ? changes : null
}

function updateAsset(id, input, currentUser) {
  const existing = assetRepository.getById(id)
  if (!existing) throw new Error('دارایی یافت نشد')

  const missing = requireFields(['assetCode', 'assetName', 'itemType', 'serialNumber', 'status'], input)
  if (missing) throw new Error(missing)

  const dupError = checkDuplicateAssetCodeOrSerial(input.assetCode, input.serialNumber, id)
  if (dupError) throw new Error(dupError)

  // Base Data Lifecycle phase — a field left unchanged reuses the
  // asset's EXISTING id directly rather than re-resolving its name
  // through resolveLookupId. This matters specifically for a historical
  // asset that already has an inactive item type/country/workshop/
  // status: without this, simply editing an unrelated field (notes, a
  // date) on such an asset would fail resolveLookupId's active-only
  // check for a value the person never touched — exactly what Section 5
  // of that phase requires NOT happen ("historical Assets must not lose
  // their historical lookup values"). Comparing by name (not id) is
  // deliberate too: it's what the form actually submits either way,
  // whether or not that name happens to currently be active.
  const existingApi = toApiShape(existing)
  const itemTypeId =
    input.itemType === existingApi.itemType
      ? existing.item_type_id
      : resolveLookupId('itemTypes', input.itemType, 'نوع کالای')
  const statusId =
    input.status === existingApi.status ? existing.status_id : resolveLookupId('statuses', input.status, 'وضعیت')
  const workshopId =
    input.workshop === existingApi.workshop
      ? existing.workshop_id
      : resolveLookupId('workshops', input.workshop, 'واحد')
  const countryId =
    input.country === existingApi.country ? existing.country_id : resolveLookupId('countries', input.country, 'کشور')

  const db = getDatabase()
  db.transaction(() => {
    assetRepository.update(id, {
      assetCode: input.assetCode,
      assetName: input.assetName,
      itemTypeId,
      model: input.model || null,
      serialNumber: input.serialNumber,
      countryId,
      workshopId,
      warehouseEntryDate: input.entryDate || null,
      warehouseExitDate: input.exitDate || null,
      deliveredBy: input.deliveredBy || null,
      receivedBy: input.receivedBy || null,
      statusId,
      notes: input.notes || null
    })

    // A status change through the edit form still belongs on the
    // lifecycle ledger, same as the dedicated "Change Status" action.
    if (existing.status_id !== statusId) {
      transactionRepository.insert({
        assetId: id,
        previousStatusId: existing.status_id,
        newStatusId: statusId,
        deliveredBy: input.deliveredBy || null,
        receivedBy: input.receivedBy || null,
        notes: 'تغییر وضعیت ضمن ویرایش',
        performedByUserId: currentUser.id
      })
    }

    const changes = diffChanges(toApiShape(existing), input, [
      'assetCode',
      'assetName',
      'itemType',
      'model',
      'serialNumber',
      'country',
      'workshop',
      'status',
      'notes'
    ])

    auditService.recordAudit({
      user: currentUser,
      action: 'UPDATE',
      entityType: 'Asset',
      entityId: id,
      changes
    })
  })()

  return toApiShape(assetRepository.getById(id))
}

function deleteAsset(id, currentUser) {
  const existing = assetRepository.getById(id)
  if (!existing) throw new Error('دارایی یافت نشد')

  const db = getDatabase()
  db.transaction(() => {
    assetRepository.softDelete(id, currentUser.id)
    auditService.recordAudit({
      user: currentUser,
      action: 'DELETE',
      entityType: 'Asset',
      entityId: id,
      changes: { assetCode: existing.asset_code, assetName: existing.asset_name }
    })
  })()
}

// Bulk delete — all-or-nothing, same shape as lookupService's bulk
// delete: every id is resolved BEFORE anything is touched, so a stale
// selection (something another user or window already deleted) fails
// the whole batch with a clear reason instead of silently deleting the
// rest and leaving the person to guess what happened to the others.
// Reuses the exact same softDelete() single-delete already uses — this
// is soft-delete N times inside one transaction, not a different
// deletion mechanism — so the existing "excluded from re-import
// duplicate checks" and "excluded from dashboard counts" behavior needs
// no changes to keep working here. One audit entry per asset, same
// action/shape single delete already records, so the audit log reads
// identically whether ten assets were deleted one at a time or as a
// batch.
function deleteAssetsBulk(ids, currentUser) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('هیچ دارایی‌ای انتخاب نشده است')
  }

  const existing = ids.map((id) => {
    const asset = assetRepository.getById(id)
    if (!asset) throw new Error('یکی از دارایی‌های انتخاب‌شده دیگر یافت نشد؛ فهرست را تازه‌سازی کنید')
    return asset
  })

  const db = getDatabase()
  db.transaction(() => {
    for (const asset of existing) {
      assetRepository.softDelete(asset.id, currentUser.id)
      auditService.recordAudit({
        user: currentUser,
        action: 'DELETE',
        entityType: 'Asset',
        entityId: asset.id,
        changes: { assetCode: asset.asset_code, assetName: asset.asset_name }
      })
    }
  })()

  return { count: existing.length }
}

function changeAssetStatus(id, { newStatus, deliveredBy, receivedBy, notes }, currentUser) {
  const existing = assetRepository.getById(id)
  if (!existing) throw new Error('دارایی یافت نشد')

  const newStatusId = resolveLookupId('statuses', newStatus, 'وضعیت')
  if (existing.status_id === newStatusId) {
    throw new Error('وضعیت جدید با وضعیت فعلی یکسان است')
  }

  const db = getDatabase()
  db.transaction(() => {
    assetRepository.update(id, {
      assetCode: existing.asset_code,
      assetName: existing.asset_name,
      itemTypeId: existing.item_type_id,
      model: existing.model,
      serialNumber: existing.serial_number,
      countryId: existing.country_id,
      workshopId: existing.workshop_id,
      warehouseEntryDate: existing.warehouse_entry_date,
      warehouseExitDate: existing.warehouse_exit_date,
      deliveredBy: deliveredBy || existing.delivered_by,
      receivedBy: receivedBy || existing.received_by,
      statusId: newStatusId,
      notes: existing.notes
    })

    transactionRepository.insert({
      assetId: id,
      previousStatusId: existing.status_id,
      newStatusId,
      deliveredBy: deliveredBy || null,
      receivedBy: receivedBy || null,
      notes: notes || null,
      performedByUserId: currentUser.id
    })

    auditService.recordAudit({
      user: currentUser,
      action: 'UPDATE',
      entityType: 'Asset',
      entityId: id,
      changes: { status: { old: existing.status, new: newStatus } }
    })
  })()

  return toApiShape(assetRepository.getById(id))
}

// Bulk status change (Phase 4 — High-Value Product Features) — same
// all-or-nothing resolution shape as deleteAssetsBulk above: every id is
// resolved and the target status validated BEFORE anything is touched,
// so a stale selection or an invalid/inactive status rejects the whole
// batch up front rather than partially applying and leaving the person
// to work out which ones went through. The one case that's NOT treated
// as a failure is an asset already sitting at the target status — that's
// a no-op, not an error, so it's silently skipped (no transaction-
// history or audit entry, same as how deleteLookupsBulk records nothing
// for a 'blocked' row it never touched) rather than rejecting a whole
// 50-asset batch because one of them happened to already match.
function changeAssetStatusBulk(ids, { newStatus, deliveredBy, receivedBy, notes }, currentUser) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('هیچ دارایی‌ای انتخاب نشده است')
  }

  // Backend-side validation, not renderer trust — the exact same
  // resolveLookupId chokepoint changeAssetStatus/createAsset/updateAsset
  // all go through, so an inactive or made-up status name is rejected
  // here regardless of what the UI's own (already-filtered) dropdown
  // would ever send.
  const newStatusId = resolveLookupId('statuses', newStatus, 'وضعیت')

  const existing = ids.map((id) => {
    const asset = assetRepository.getById(id)
    if (!asset) throw new Error('یکی از دارایی‌های انتخاب‌شده دیگر یافت نشد؛ فهرست را تازه‌سازی کنید')
    return asset
  })

  const toChange = existing.filter((asset) => asset.status_id !== newStatusId)

  const db = getDatabase()
  db.transaction(() => {
    for (const asset of toChange) {
      // Reuses the exact single-row update() every other write in this
      // file goes through — this is the same status-change mutation
      // changeAssetStatus performs, just looped inside one transaction,
      // not a separate/faster raw-SQL path. Every other field is
      // preserved unchanged, same as changeAssetStatus.
      assetRepository.update(asset.id, {
        assetCode: asset.asset_code,
        assetName: asset.asset_name,
        itemTypeId: asset.item_type_id,
        model: asset.model,
        serialNumber: asset.serial_number,
        countryId: asset.country_id,
        workshopId: asset.workshop_id,
        warehouseEntryDate: asset.warehouse_entry_date,
        warehouseExitDate: asset.warehouse_exit_date,
        deliveredBy: deliveredBy || asset.delivered_by,
        receivedBy: receivedBy || asset.received_by,
        statusId: newStatusId,
        notes: asset.notes
      })

      transactionRepository.insert({
        assetId: asset.id,
        previousStatusId: asset.status_id,
        newStatusId,
        deliveredBy: deliveredBy || null,
        receivedBy: receivedBy || null,
        notes: notes || null,
        performedByUserId: currentUser.id
      })

      auditService.recordAudit({
        user: currentUser,
        action: 'UPDATE',
        entityType: 'Asset',
        entityId: asset.id,
        changes: { status: { old: asset.status, new: newStatus } }
      })
    }
  })()

  return { changedCount: toChange.length, skippedCount: existing.length - toChange.length }
}

export const assetService = {
  getDataQuality,
  listAssets,
  getAsset,
  getDashboardStats,
  getAssetCountByWorkshop,
  getAssetCountByItemType,
  getAssetCountByCountry,
  getRecentActivity,
  createAsset,
  updateAsset,
  deleteAsset,
  deleteAssetsBulk,
  changeAssetStatus,
  changeAssetStatusBulk
}
