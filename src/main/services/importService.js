import path from 'path'
import { dialog } from 'electron'
import { getDatabase } from '../database/connection'
import { assetRepository } from '../repositories/assetRepository'
import { transactionRepository } from '../repositories/transactionRepository'
import { lookupRepository } from '../repositories/lookupRepository'
import { auditService } from './auditService'
import { listSheetNames, parseWorksheet } from '../parsers/excelParser'
import { parseCsvFile } from '../parsers/csvParser'
import { isTextExtractable, parsePdfFile } from '../parsers/pdfParser'
import { autoMapHeaders } from '../utils/importFieldAliases'
import { normalizeDigits, normalizeForComparison, compactForComparison } from '../utils/digitUtils'
import { parseImportDate } from '../utils/importDateParser'
import {
  CANONICAL_FIELD_KEYS,
  REQUIRED_FIELD_KEYS,
  LOOKUP_FIELD_KIND,
  STRICT_LOOKUP_FIELD_KEYS,
  FIELD_LABEL_BY_KEY,
  PUBLIC_FIELD_SCHEMA
} from '../utils/assetImportSchema'

// Phase 9 — Import System (Excel + CSV + PDF), redesigned around one
// canonical Asset schema (assetImportSchema.js). Every field this module
// works with — required-ness, lookup-ness, the field list itself — comes
// from that one file rather than being hand-listed here, so Excel, CSV,
// and PDF imports (and the renderer's wizard, which receives the same
// list back over IPC as `fieldSchema` in parseFile's response) can never
// drift out of sync with each other. Mirrors assetService's shape
// deliberately: same requiredness rules, same lookup-resolution idea,
// same transaction-per-write-operation discipline — this is meant to feel
// like "the same rules as the Add Asset form, run 5,000 times," not a
// parallel set of business logic.

const REQUIRED_FIELDS = REQUIRED_FIELD_KEYS
const ACCEPTED_EXTENSIONS = ['xlsx', 'xls', 'csv', 'pdf']

// Precedence for the single badge shown per row — a row that's both a DB
// duplicate AND has, say, an unparseable date is still fundamentally a
// "duplicate" row for the wizard's purposes, so severity can only ever be
// upgraded (never silently downgraded back to warning) as more checks run.
const SEVERITY_RANK = { valid: 0, warning: 1, duplicate: 2, error: 3 }
function upgradeSeverity(current, candidate) {
  return SEVERITY_RANK[candidate] > SEVERITY_RANK[current] ? candidate : current
}

// -------------------------------------------------------------- file IO --

async function pickImportFile(parentWindow) {
  const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
    title: 'انتخاب فایل ورود اطلاعات',
    properties: ['openFile'],
    filters: [{ name: 'Excel / CSV / PDF', extensions: ACCEPTED_EXTENSIONS }]
  })
  if (canceled || !filePaths?.[0]) return { success: false, canceled: true }

  const filePath = filePaths[0]
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    return { success: false, error: 'نوع فایل پشتیبانی نمی‌شود. فقط Excel، CSV یا PDF.' }
  }
  return { success: true, path: filePath, fileName: path.basename(filePath), fileType: ext }
}

async function inspectFile(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    return { success: false, error: 'نوع فایل پشتیبانی نمی‌شود. فقط Excel، CSV یا PDF.' }
  }
  if (ext === 'csv') return { success: true, fileType: 'csv', sheets: [] }

  if (ext === 'pdf') {
    try {
      const hasText = await isTextExtractable(filePath)
      if (!hasText) {
        return {
          success: false,
          error:
            'این فایل PDF متن قابل استخراج ندارد و احتمالاً اسکن‌شده (تصویری) است. لطفاً از OCR استفاده کنید یا فایل را به‌صورت Excel یا CSV وارد کنید.'
        }
      }
      return { success: true, fileType: 'pdf', sheets: [] }
    } catch {
      return { success: false, error: 'فایل PDF قابل خواندن نیست. ممکن است خراب یا رمزگذاری‌شده باشد.' }
    }
  }

  try {
    const sheets = listSheetNames(filePath)
    return { success: true, fileType: ext, sheets }
  } catch {
    return { success: false, error: 'فایل اکسل قابل خواندن نیست. ممکن است خراب یا رمزگذاری‌شده باشد.' }
  }
}

async function parseFile(filePath, { fileType, sheetName } = {}) {
  let headers, rows

  try {
    if (fileType === 'csv') {
      ;({ headers, rows } = parseCsvFile(filePath))
    } else if (fileType === 'pdf') {
      ;({ headers, rows } = await parsePdfFile(filePath))
    } else {
      ;({ headers, rows } = parseWorksheet(filePath, sheetName))
    }
  } catch (err) {
    return { success: false, error: err.message || 'فایل قابل خواندن نیست.' }
  }

  if (rows.length === 0) {
    return { success: false, error: 'هیچ ردیف داده‌ای در فایل یافت نشد.' }
  }

  const { mapping, unmapped } = autoMapHeaders(headers)
  const mappedFieldKeys = new Set(Object.values(mapping))
  const missingRequiredFields = REQUIRED_FIELDS.filter((f) => !mappedFieldKeys.has(f))

  return {
    success: true,
    headers,
    rows,
    totalRows: rows.length,
    mapping,
    unmapped,
    missingRequiredFields,
    // The one canonical field list (assetImportSchema.js), sent to the
    // renderer here rather than it keeping its own hardcoded copy — see
    // that file's header comment. ColumnMappingStep always lists every
    // one of these regardless of what the file actually had, and
    // ImportPreviewStep uses it to render every field per row.
    fieldSchema: PUBLIC_FIELD_SCHEMA
  }
}

// ------------------------------------------------------- row shaping --

/**
 * Converts one raw grid row (array aligned to `headers`) into an object
 * keyed by canonical field name, using `mapping` (column index ->
 * fieldKey — see importFieldAliases.js's autoMapHeaders for why it's
 * index-keyed rather than header-text-keyed: two columns can share the
 * exact same header text in a real file, and only position is guaranteed
 * unique). Every string value is digit-normalized here, once, so every
 * downstream check (required-field, duplicate, lookup match) works
 * against a consistent Western-digit form regardless of what the source
 * file used (Persian ۰-۹, Arabic-Indic ٠-٩, or plain Western digits).
 *
 * Starts from an entry for EVERY canonical field, set to '' — not just
 * the ones this file happened to have a column for — so the shape of a
 * row is always the full 13-field schema, whether a value came from a
 * mapped column, a wizard default (applyDefaults, after this runs), or
 * neither. This is what lets the preview always show every field: there
 * is no "field wasn't found" case where the key is simply absent for the
 * renderer to special-case, only an empty string it already knows how to
 * render as "not found."
 */
function shapeRow(headers, rowArray, mapping) {
  const fields = Object.fromEntries(CANONICAL_FIELD_KEYS.map((key) => [key, '']))
  headers.forEach((header, i) => {
    const fieldKey = mapping[i]
    if (!fieldKey) return
    const raw = rowArray[i]
    fields[fieldKey] = raw instanceof Date ? raw : normalizeDigits(String(raw ?? '').trim())
  })
  return fields
}

/**
 * Fills in a single field using the wizard's per-field default, configured
 * in the Column Mapping step for a required field that has no matching
 * column in the file at all (e.g. the source file never tracked "Item
 * Type" as its own column). Two kinds, chosen per field by the person:
 *   'constant' - the same literal value on every row (fits a field like
 *                 Item Type, where "متفرقه" for the whole batch is
 *                 reasonable)
 *   'mirror'   - copy another field's value on this same row (fits a
 *                 field like Asset Name, where reusing Asset Code per row
 *                 is far more sensible than one identical name for every
 *                 asset)
 * Never overwrites a value that actually came from the file — a default
 * only ever fills a gap, it doesn't override real data.
 */
function applyFieldDefault(fields, fieldKey, defaultConfig) {
  if (fields[fieldKey]) return
  if (!defaultConfig) return
  if (defaultConfig.type === 'constant' && defaultConfig.value) {
    fields[fieldKey] = defaultConfig.value
  } else if (defaultConfig.type === 'mirror' && defaultConfig.sourceField) {
    const source = fields[defaultConfig.sourceField]
    if (source) fields[fieldKey] = source
  }
}

function applyDefaults(fields, defaults) {
  if (!defaults) return fields
  for (const fieldKey of Object.keys(defaults)) {
    applyFieldDefault(fields, fieldKey, defaults[fieldKey])
  }
  return fields
}

// --------------------------------------------------------- classification --

/**
 * Builds the in-memory lookup used to resolve a cell's text value (e.g.
 * "برق") against an existing lookup row, tolerant of whitespace/digit
 * differences the way importFieldAliases matches headers — a plain
 * lookupRepository.findByName is exact-match only, which is right for the
 * manual Add/Edit form but too strict for spreadsheet data entry.
 *
 * byCompactName is a fallback for a value that lost a Persian half-space
 * (ZWNJ) entirely during extraction rather than having it turn into a
 * space — the same real PDF-extraction quirk importFieldAliases.js's
 * COMPACT_ALIAS_INDEX exists for on headers (e.g. "آسیب‌دیده" — one of
 * the five real status values — extracted back as "آسیبدیده" with no
 * separator at all; normalizeForComparison's "ZWNJ -> space" rule can't
 * fix that, since there's no character left to convert). Built the same
 * collision-safe way as COMPACT_ALIAS_INDEX: if two different existing
 * rows would collapse to the same compact form, neither is registered,
 * so the fallback never guesses between them.
 */
function buildLookupIndex() {
  const index = {}
  for (const [fieldKey, kind] of Object.entries(LOOKUP_FIELD_KIND)) {
    const rows = lookupRepository.list(kind)
    // Base Data Lifecycle phase — a deactivated item type/workshop/
    // country/status isn't selectable for a new asset via the form
    // (AssetFormPage / ChangeStatusModal / assetService.resolveLookupId),
    // so it must not be importable either — otherwise import would be a
    // silent backdoor around that same rule. Applies to all four kinds
    // uniformly now that all four have an is_active column
    // (migrations/004-base-data-lifecycle.sql). For the three
    // non-strictLookup kinds this doesn't block anything — it just means
    // a name matching ONLY an inactive row is treated the same as "no
    // match yet", so the existing auto-create-if-missing behavior below
    // creates a fresh active row instead of silently reusing the retired
    // one, consistent with how createLookup itself now behaves.
    const usable = rows.filter((r) => r.is_active)
    const byName = new Map(usable.map((r) => [normalizeForComparison(r.name), r]))
    const byCompactName = new Map()
    for (const r of usable) {
      const compact = compactForComparison(r.name)
      byCompactName.set(compact, byCompactName.has(compact) ? null : r)
    }
    index[fieldKey] = { kind, byName, byCompactName }
  }
  return index
}

/**
 * Resolves (and, if genuinely new AND the field allows it, creates) a
 * lookup value for one field on one row. Returns null for an empty
 * value, otherwise one of:
 *   { id, name, created: false }                      - matched existing
 *   { id, name, created: true }                        - newly created (persist: true)
 *   { id: null, name, created: true, pending: true }    - would be created on commit (persist: false)
 *   { id: null, name, created: false, invalid: true }   - STRICT_LOOKUP_FIELD_KEYS field, no match (see below)
 *
 * Two independent reasons a value might not get auto-created:
 *
 * `strict` (from STRICT_LOOKUP_FIELD_KEYS, currently just `status`) — a
 * fixed enum, not reference data an import should be able to grow. An
 * unrecognized status must be rejected as invalid, the same way a
 * missing required field is, rather than quietly inventing a seventh
 * workflow state nothing else in the app recognizes.
 *
 * `persist` — even for a field that's allowed to grow, actually writing
 * the new row to the database only happens when this is true. The
 * preview step (buildPreview) calls with persist: false specifically so
 * that looking at a preview never leaves data behind if the person backs
 * out without confirming; commitImport calls with persist: true, and
 * only from inside its db.transaction(), so a canceled/failed commit
 * rolls the new lookup rows back along with everything else. Either way
 * the in-memory `byName`/`byCompactName` maps are updated immediately, so
 * multiple rows in the same file referencing the same new value all
 * resolve to one consistent result instead of racing to create it twice.
 */
function resolveLookupValue(lookupIndex, fieldKey, rawValue, { persist }) {
  const value = (rawValue || '').trim()
  if (!value) return null

  const { kind, byName, byCompactName } = lookupIndex[fieldKey]
  const normalized = normalizeForComparison(value)
  const compact = compactForComparison(value)
  const existing = byName.get(normalized) || byCompactName.get(compact)
  if (existing) {
    // Already resolved earlier in this same call — whether that
    // resolution was a real create, a pending (not-yet-persisted)
    // marker, or a pre-existing row, a later row referencing the same
    // value just reuses it and is never itself flagged as "new."
    return { id: existing.id, name: existing.name, created: false }
  }

  if (STRICT_LOOKUP_FIELD_KEYS.has(fieldKey)) {
    return { id: null, name: value, created: false, invalid: true }
  }

  if (!persist) {
    const pending = { id: null, name: value, pending: true }
    byName.set(normalized, pending)
    byCompactName.set(compact, pending)
    return { ...pending, created: true }
  }

  const created = lookupRepository.create(kind, value)
  byName.set(normalized, created)
  byCompactName.set(compact, created)
  return { id: created.id, name: created.name, created: true }
}

/**
 * Validates and classifies every row. Two independent things this can do
 * to the database, both controlled by `persistLookups` (default false,
 * i.e. side-effect-free):
 *   - resolveLookupValue may create a new assetType/country/workshop row
 *     (never `status` — see STRICT_LOOKUP_FIELD_KEYS)
 * `persistLookups: true` is passed ONLY by commitImport, from inside its
 * db.transaction() — so a canceled or merely-previewed-and-abandoned
 * import can never leave orphaned lookup rows behind. buildPreview always
 * uses the default (false): looking at a preview must never write
 * anything, no matter how the person leaves the wizard afterward.
 * Returns one result per row plus summary counts.
 */
function classifyRows(headers, rows, mapping, defaults = {}, { persistLookups = false } = {}) {
  const lookupIndex = buildLookupIndex()
  const existing = assetRepository.findAllCodesAndSerials()
  const existingByCode = new Map(existing.map((r) => [r.asset_code, r]))
  const existingBySerial = new Map(existing.map((r) => [r.serial_number, r]))
  const seenCodesInFile = new Map() // assetCode -> first rowNumber that used it
  const seenSerialsInFile = new Map()

  const results = rows.map((rowArray, idx) => {
    const rowNumber = idx + 1
    const fields = shapeRow(headers, rowArray, mapping)
    applyDefaults(fields, defaults)
    const messages = []
    let severity = 'valid' // valid < warning < duplicate < error, highest wins for the badge

    const missing = REQUIRED_FIELDS.filter((f) => !fields[f])
    if (missing.length) {
      return {
        rowNumber,
        fields,
        severity: 'error',
        messages: [
          `فیلدهای الزامی خالی است: ${missing.map((f) => FIELD_LABEL_BY_KEY[f]).join('، ')}`
        ],
        duplicateOf: null
      }
    }

    // In-file duplicate check first — this is always an ERROR (can't
    // insert two rows claiming the same UNIQUE code/serial in one batch),
    // separate from a DB duplicate (which is user-resolvable).
    if (seenCodesInFile.has(fields.assetCode)) {
      return {
        rowNumber,
        fields,
        severity: 'error',
        messages: [`کد دارایی «${fields.assetCode}» در ردیف ${seenCodesInFile.get(fields.assetCode)} این فایل نیز تکرار شده است`],
        duplicateOf: null
      }
    }
    if (seenSerialsInFile.has(fields.serialNumber)) {
      return {
        rowNumber,
        fields,
        severity: 'error',
        messages: [`شماره سریال «${fields.serialNumber}» در ردیف ${seenSerialsInFile.get(fields.serialNumber)} این فایل نیز تکرار شده است`],
        duplicateOf: null
      }
    }
    seenCodesInFile.set(fields.assetCode, rowNumber)
    seenSerialsInFile.set(fields.serialNumber, rowNumber)

    // DB duplicate check
    const dupByCode = existingByCode.get(fields.assetCode)
    const dupBySerial = existingBySerial.get(fields.serialNumber)
    const duplicateOf = dupByCode || dupBySerial || null
    if (duplicateOf) {
      severity = upgradeSeverity(severity, 'duplicate')
      messages.push(
        dupByCode
          ? `کد دارایی «${fields.assetCode}» قبلاً ثبت شده است`
          : `شماره سریال «${fields.serialNumber}» قبلاً ثبت شده است`
      )
    }

    // Lookup resolution (asset type, status required; country, workshop
    // optional). persist: persistLookups controls whether a genuinely
    // new assetType/country/workshop value is actually written now, or
    // just resolved to a pending marker for the preview to show without
    // touching the database (see resolveLookupValue and this function's
    // own doc comment). `status` can never create a new row regardless —
    // STRICT_LOOKUP_FIELD_KEYS — an unrecognized status is an ERROR.
    const resolvedLookups = {}
    for (const fieldKey of Object.keys(LOOKUP_FIELD_KIND)) {
      const resolved = resolveLookupValue(lookupIndex, fieldKey, fields[fieldKey], { persist: persistLookups })
      resolvedLookups[fieldKey] = resolved
      if (resolved?.created) {
        severity = upgradeSeverity(severity, 'warning')
        messages.push(`مقدار جدید «${resolved.name}» به فهرست ${FIELD_LABEL_BY_KEY[fieldKey]} اضافه شد`)
      }
      if (resolved?.invalid) {
        severity = upgradeSeverity(severity, 'error')
        const validNames = Array.from(lookupIndex[fieldKey].byName.values())
          .map((v) => v.name)
          .sort()
        messages.push(
          `مقدار «${resolved.name}» برای ${FIELD_LABEL_BY_KEY[fieldKey]} نامعتبر است. مقادیر مجاز: ${validNames.join('، ')}`
        )
      }
    }

    // Dates — optional; unparseable is a WARNING (row still imports, date left blank)
    const entryDateIso = fields.warehouseEntryDate ? parseImportDate(fields.warehouseEntryDate) : null
    const exitDateIso = fields.warehouseExitDate ? parseImportDate(fields.warehouseExitDate) : null
    if (fields.warehouseEntryDate && !entryDateIso) {
      severity = upgradeSeverity(severity, 'warning')
      messages.push('تاریخ ورود قابل تشخیص نبود و خالی ثبت می‌شود')
    }
    if (fields.warehouseExitDate && !exitDateIso) {
      severity = upgradeSeverity(severity, 'warning')
      messages.push('تاریخ خروج قابل تشخیص نبود و خالی ثبت می‌شود')
    }

    return {
      rowNumber,
      fields,
      severity,
      messages,
      duplicateOf: duplicateOf ? { id: duplicateOf.id } : null,
      resolved: {
        // Keys here are the DB-repository field names (see
        // assetRepository / commitImport's dbFields below), which is why
        // "assetType" (the canonical import field) resolves into
        // "itemTypeId" here — the same appKey mapping assetImportSchema.js
        // documents for the renderer form's own field names.
        itemTypeId: resolvedLookups.assetType?.id ?? null,
        statusId: resolvedLookups.status?.id ?? null,
        countryId: resolvedLookups.country?.id ?? null,
        workshopId: resolvedLookups.workshop?.id ?? null,
        entryDateIso,
        exitDateIso
      }
    }
  })

  const summary = results.reduce(
    (acc, r) => {
      acc.total++
      acc[r.severity]++
      return acc
    },
    { total: 0, valid: 0, warning: 0, duplicate: 0, error: 0 }
  )

  return { results, summary }
}

function buildPreview({ headers, rows, mapping, defaults }) {
  // persistLookups defaults to false — looking at a preview must never
  // write anything to the database, no matter how the person leaves the
  // wizard afterward (back, cancel, close the app). See classifyRows.
  return { success: true, ...classifyRows(headers, rows, mapping, defaults) }
}

// -------------------------------------------------------------- commit --

/**
 * Commits an import. duplicatePolicy is a single choice applied to every
 * DUPLICATE-classified row (never per-row — with potentially hundreds of
 * duplicates in a 5,000-row file, asking one-by-one isn't practical):
 *   'skip'   - leave existing rows untouched, don't import the dupes
 *   'update' - overwrite the existing asset's fields with the file's data
 *   'cancel' - abort the whole import if ANY duplicates were found
 * ERROR rows are always excluded and never block the rest of the batch.
 *
 * Everything with a real, permanent side effect — classification (which,
 * with persistLookups: true, may create new assetType/country/workshop
 * rows) AND the asset inserts/updates/transactions/audit entries — runs
 * inside ONE db.transaction(). Canceling due to duplicatePolicy: 'cancel'
 * throws from inside that transaction rather than returning early, so
 * better-sqlite3 rolls back everything that happened in this call,
 * including any lookup rows classification just created — a canceled
 * import leaves the database exactly as it was before, not "no assets
 * but a few new orphaned lookup values." Any other failure partway
 * through (a constraint violation, a bug) rolls back the same way.
 */
function commitImport({ headers, rows, mapping, duplicatePolicy, defaults }, currentUser) {
  const db = getDatabase()
  let outcome = null
  let canceledSummary = null

  const run = db.transaction(() => {
    const { results, summary } = classifyRows(headers, rows, mapping, defaults, { persistLookups: true })

    if (summary.duplicate > 0 && duplicatePolicy === 'cancel') {
      canceledSummary = summary
      throw new Error('IMPORT_CANCELED_DUE_TO_DUPLICATES')
    }

    const toInsert = []
    const toUpdate = []
    const skipped = []
    const errors = []

    for (const r of results) {
      if (r.severity === 'error') {
        errors.push({ rowNumber: r.rowNumber, messages: r.messages })
        continue
      }
      // Maps the 13 canonical import fields onto assetRepository's
      // DB-shaped field names (same names assetService/the DB schema
      // use) — the one place the import system's own vocabulary
      // (assetImportSchema.js) meets the app's existing internal one.
      // Lookup fields (assetType, country, workshop, status) and both
      // dates go through r.resolved (already-resolved IDs / ISO strings
      // from classifyRows above); every other field is copied straight
      // from r.fields.
      const dbFields = {
        assetCode: r.fields.assetCode,
        assetName: r.fields.assetName,
        itemTypeId: r.resolved.itemTypeId,
        model: r.fields.model || null,
        serialNumber: r.fields.serialNumber,
        countryId: r.resolved.countryId,
        workshopId: r.resolved.workshopId,
        warehouseEntryDate: r.resolved.entryDateIso,
        warehouseExitDate: r.resolved.exitDateIso,
        deliveredBy: r.fields.deliveredBy || null,
        receivedBy: r.fields.receivedBy || null,
        statusId: r.resolved.statusId,
        notes: r.fields.description || null
      }

      if (r.severity === 'duplicate') {
        if (duplicatePolicy === 'update') {
          toUpdate.push({ id: r.duplicateOf.id, fields: dbFields, rowNumber: r.rowNumber })
        } else {
          skipped.push(r.rowNumber)
        }
        continue
      }

      toInsert.push({ fields: dbFields, rowNumber: r.rowNumber, statusId: r.resolved.statusId })
    }

    // Transaction-ledger and audit entries are collected into arrays and
    // written via bulkInsert/recordAuditBulk (each one prepared statement
    // reused across every row) rather than one insert per row — with
    // potentially 5,000+ rows in a single commit, re-preparing these two
    // INSERTs per row was the last unbatched part of the import path
    // (assetRepository.bulkCreate/bulkUpdate already did this). Same
    // values as before, just collected first and written in two calls.
    const insertedIds = assetRepository.bulkCreate(toInsert.map((r) => r.fields))
    const transactionEntries = []
    const auditEntries = []
    insertedIds.forEach((assetId, i) => {
      const row = toInsert[i]
      transactionEntries.push({
        assetId,
        previousStatusId: null,
        newStatusId: row.statusId,
        transactionDate: row.fields.warehouseEntryDate,
        deliveredBy: row.fields.deliveredBy,
        receivedBy: row.fields.receivedBy,
        notes: 'ثبت از طریق ورود اطلاعات (Import)',
        performedByUserId: currentUser.id
      })
      auditEntries.push({
        user: currentUser,
        action: 'IMPORT',
        entityType: 'Asset',
        entityId: assetId,
        changes: { assetCode: row.fields.assetCode, assetName: row.fields.assetName }
      })
    })
    if (transactionEntries.length) transactionRepository.bulkInsert(transactionEntries)

    if (toUpdate.length) {
      assetRepository.bulkUpdate(toUpdate.map((r) => ({ id: r.id, fields: r.fields })))
      for (const row of toUpdate) {
        auditEntries.push({
          user: currentUser,
          action: 'IMPORT_UPDATE',
          entityType: 'Asset',
          entityId: row.id,
          changes: { assetCode: row.fields.assetCode, assetName: row.fields.assetName }
        })
      }
    }
    if (auditEntries.length) auditService.recordAuditBulk(auditEntries)

    outcome = {
      success: true,
      summary: {
        total: summary.total,
        imported: toInsert.length,
        updated: toUpdate.length,
        skipped: skipped.length,
        duplicates: summary.duplicate,
        warnings: summary.warning,
        errors: errors.length
      },
      errorDetails: errors
    }
  })

  try {
    run()
  } catch (err) {
    if (err.message === 'IMPORT_CANCELED_DUE_TO_DUPLICATES') {
      return {
        success: false,
        canceled: true,
        error: `${canceledSummary.duplicate} ردیف تکراری یافت شد. ورود اطلاعات لغو شد.`
      }
    }
    throw err
  }

  return outcome
}

export const importService = {
  pickImportFile,
  inspectFile,
  parseFile,
  buildPreview,
  commitImport
}
