import { sql, type Kysely } from 'kysely'
import { auditActor, type Actor } from '../admin/rules.js'
import { AppError } from '../appError.js'
import { columnsFor, fieldsOf, getAssets, sameValue, updateAssetAtVersion, type Asset, type FieldName, type FieldValue } from '../assets/assets.js'
import { assetDbError } from '../assets/dbErrors.js'
import { isBlankIdentifier } from '../assets/matchKey.js'
import { recordAudit, recordAuditEvents, type AuditContext, type AuditEvent } from '../audit/audit.js'
import type { Database, ImportBatchState, ImportRowOutcome } from '../db/connection.js'
import { setImportRow } from '../db/dataContext.js'
import { planFieldChanges, type IncomingCell } from './fieldChanges.js'

// Staged import (decision O-16; migration 0007; proposal §6): stage → preview → commit, or cancel.
// Everything runs inside a transaction whose data context is the batch's warehouse.
//
// What this module does NOT do yet, by design: parse files. No parser is integrated in Phase 1B-3
// (ExcelJS stays under O-13 and gates G-2…G-9; real spreadsheets under O-14), so rows arrive already
// parsed and mapped to internal field identifiers — the header mapping is the field contract of O-14
// stage 2. A blank cell is absent; this module also drops values that are only whitespace, so a blank
// never erases. Clearing a field through an import needs an explicit marker, which the field contract
// defines; until then an import can set values but never clear them. Dates are ISO (YYYY-MM-DD) here;
// Jalali input is converted by the field contract. The routes using this module are registered only
// when WAM_IMPORT_ENABLED is set (default: off).

export const IMPORT_FIELDS = [
  'asset_code', 'name', 'item_type', 'status', 'model', 'serial_number', 'country', 'workshop', 'entry_date', 'exit_date', 'notes'
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

export interface ParsedRow {
  readonly sheetName: string | null
  readonly rowNumber: number
  /** Keyed by internal field identifier, never by a header from the file. */
  readonly cells: Partial<Record<ImportField, string>>
}

/** Issues name a code and an internal field identifier — never a cell value or a header (schema check). */
export interface ImportIssue {
  readonly code: string
  readonly column?: ImportField
}

const TEXT_LIMITS: Partial<Record<ImportField, number>> = { asset_code: 100, name: 300, model: 200, serial_number: 100, notes: 2000 }
const FIELD_OF: Record<ImportField, FieldName | 'statusId'> = {
  asset_code: 'assetCode',
  name: 'name',
  item_type: 'itemTypeId',
  status: 'statusId',
  model: 'model',
  serial_number: 'serialNumber',
  country: 'countryId',
  workshop: 'workshopId',
  entry_date: 'entryDate',
  exit_date: 'exitDate',
  notes: 'notes'
}

function cleanCells(cells: Partial<Record<string, string>>): Partial<Record<ImportField, string>> {
  const out: Partial<Record<ImportField, string>> = {}
  for (const field of IMPORT_FIELDS) {
    const value = cells[field]
    if (typeof value === 'string' && value.trim() !== '') out[field] = value
  }
  return out
}

// --- batches ---------------------------------------------------------------------------------------

export interface BatchSummary {
  readonly id: number
  readonly state: ImportBatchState
  readonly fileFormat: 'xlsx' | 'csv'
  readonly fileName: string | null
  readonly rowCount: number | null
  readonly createdAt: string
  readonly createdBy: number
  readonly closedAt: string | null
  readonly version: number
}

interface BatchRow {
  id: string
  state: ImportBatchState
  file_format: 'xlsx' | 'csv'
  file_name: string | null
  row_count: number | null
  created_at: Date
  created_by: number
  closed_at: Date | null
  version: number
}

function toBatch(row: BatchRow): BatchSummary {
  return {
    id: Number(row.id),
    state: row.state,
    fileFormat: row.file_format,
    fileName: row.file_name,
    rowCount: row.row_count,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    closedAt: row.closed_at?.toISOString() ?? null,
    version: row.version
  }
}

const BATCH_COLUMNS = sql.raw('id, state, file_format, file_name, row_count, created_at, created_by, closed_at, version')

async function findBatch(trx: Kysely<Database>, warehouseId: number, batchId: number): Promise<BatchRow> {
  const { rows } = await sql<BatchRow>`
    SELECT ${BATCH_COLUMNS} FROM wam.import_batches WHERE id = ${batchId} AND warehouse_id = ${warehouseId}`.execute(trx)
  const row = rows[0]
  if (row === undefined) throw new AppError('NOT_FOUND')
  return row
}

export async function listBatches(trx: Kysely<Database>, warehouseId: number): Promise<BatchSummary[]> {
  const { rows } = await sql<BatchRow>`
    SELECT ${BATCH_COLUMNS} FROM wam.import_batches WHERE warehouse_id = ${warehouseId} ORDER BY id DESC LIMIT 100`.execute(trx)
  return rows.map(toBatch)
}

export interface StagedRow {
  readonly id: number
  readonly sheetName: string | null
  readonly rowNumber: number
  readonly cells: Record<string, string>
  readonly outcome: ImportRowOutcome
  readonly issues: readonly ImportIssue[]
  readonly matchedAssetId: number | null
  readonly appliedAt: string | null
}

/** A batch and one page of its rows (a batch may hold up to 50,000), in staging order. */
export async function getBatch(
  trx: Kysely<Database>,
  warehouseId: number,
  batchId: number,
  page: { readonly after?: number; readonly limit: number }
): Promise<{ batch: BatchSummary; rows: StagedRow[]; nextAfter: number | null }> {
  const batch = toBatch(await findBatch(trx, warehouseId, batchId))
  const rows = await trx
    .selectFrom('import_rows')
    .select(['id', 'sheet_name', 'row_number', 'cells', 'outcome', 'issues', 'matched_asset_id', 'applied_at'])
    .where('batch_id', '=', String(batchId))
    .where('warehouse_id', '=', warehouseId)
    .where('id', '>', String(page.after ?? 0))
    .orderBy('id')
    .limit(page.limit + 1)
    .execute()
  const more = rows.length > page.limit
  const shown = more ? rows.slice(0, page.limit) : rows
  return {
    batch,
    nextAfter: more ? Number(shown[shown.length - 1]?.id) : null,
    rows: shown.map((r) => ({
      id: Number(r.id),
      sheetName: r.sheet_name,
      rowNumber: r.row_number,
      cells: r.cells,
      outcome: r.outcome,
      issues: r.issues as ImportIssue[],
      matchedAssetId: r.matched_asset_id === null ? null : Number(r.matched_asset_id),
      appliedAt: r.applied_at?.toISOString() ?? null
    }))
  }
}

export interface UploadedFile {
  readonly name: string
  readonly sha256: Buffer
  readonly sizeBytes: number
  readonly format: 'xlsx' | 'csv'
}

/** Records an uploaded file (its bytes are never stored). Audited by hash and size, never by name. */
export async function createBatch(trx: Kysely<Database>, context: AuditContext, actor: Actor, warehouseId: number, file: UploadedFile): Promise<number> {
  try {
    const row = await trx
      .insertInto('import_batches')
      .values({ warehouse_id: warehouseId, file_name: file.name, file_sha256: file.sha256, file_size_bytes: file.sizeBytes, file_format: file.format })
      .returning('id')
      .executeTakeFirstOrThrow()
    await recordAudit(trx, context, {
      action: 'import.uploaded',
      outcome: 'success',
      actor: auditActor(actor),
      target: { type: 'import_batch', id: row.id },
      warehouseId,
      details: { sha256: file.sha256.toString('hex'), sizeBytes: file.sizeBytes, format: file.format }
    })
    return Number(row.id)
  } catch (err) {
    throw assetDbError(err) ?? err
  }
}

// --- evaluation ------------------------------------------------------------------------------------

interface Evaluation {
  readonly outcome: ImportRowOutcome
  readonly issues: ImportIssue[]
  readonly matchedAssetId: number | null
  readonly matchedVersion: number | null
  /** The matched asset as it is now (update and unchanged rows). */
  readonly current?: Asset
  /** For create: every field; for update: only the changing fields. */
  readonly values: Partial<Record<FieldName | 'statusId', FieldValue>>
}

interface Lookups {
  readonly byField: Record<'item_type' | 'status' | 'country' | 'workshop', Map<string, number>>
  readonly keyOf: Map<string, string>
}

async function loadLookups(trx: Kysely<Database>, rows: readonly { cells: Partial<Record<ImportField, string>> }[]): Promise<Lookups> {
  const values = [...new Set(rows.flatMap((r) => [r.cells.item_type, r.cells.status, r.cells.country, r.cells.workshop]).filter((v) => v !== undefined))]
  const keyRows = (await sql<{ v: string; k: string }>`SELECT v, wam.name_key(v) AS k FROM unnest(${values}::text[]) AS v`.execute(trx)).rows
  const entries = async (query: ReturnType<typeof sql<{ id: number; k: string }>>) => new Map((await query.execute(trx)).rows.map((r) => [r.k, r.id]))
  return {
    keyOf: new Map(keyRows.map((r) => [r.v, r.k])),
    byField: {
      item_type: await entries(sql`SELECT id, wam.name_key(name) AS k FROM wam.item_types WHERE is_active`),
      status: await entries(sql`SELECT id, wam.name_key(name) AS k FROM wam.asset_statuses WHERE is_active
                               UNION SELECT id, wam.name_key(code) FROM wam.asset_statuses WHERE is_active AND code IS NOT NULL`),
      country: await entries(sql`SELECT id, wam.name_key(name) AS k FROM wam.countries WHERE is_active
                                UNION SELECT id, wam.name_key(iso_code) FROM wam.countries WHERE is_active AND iso_code IS NOT NULL`),
      workshop: await entries(sql`SELECT id, wam.name_key(name) AS k FROM wam.workshops WHERE is_active`)
    }
  }
}

interface StoredRow {
  id: string
  sheet_name: string | null
  row_number: number
  cells: Partial<Record<ImportField, string>>
  outcome: ImportRowOutcome
  matched_asset_id: string | null
  matched_asset_version: number | null
}

function isDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value)
}

/** Validates and matches every row of a batch against the warehouse as it is now. */
async function evaluate(trx: Kysely<Database>, warehouseId: number, rows: readonly StoredRow[]): Promise<Map<string, Evaluation>> {
  const lookups = await loadLookups(trx, rows)
  const codes = rows.map((r) => r.cells.asset_code).filter((v) => v !== undefined)
  const serials = rows.map((r) => r.cells.serial_number).filter((v) => v !== undefined)
  const keyRows = (
    await sql<{ v: string; k: string }>`SELECT v, wam.match_key(v) AS k FROM unnest(${[...codes, ...serials]}::text[]) AS v`.execute(trx)
  ).rows
  const matchKey = new Map(keyRows.map((r) => [r.v, r.k]))
  const existing = codes.length === 0 ? [] : (await sql<{ id: string; asset_code: string }>`
    SELECT id, asset_code FROM wam.assets WHERE warehouse_id = ${warehouseId} AND retired_at IS NULL AND asset_code = ANY (${codes})`.execute(trx)).rows
  const exact = new Map(existing.map((r) => [r.asset_code, Number(r.id)]))
  const matchedAssets = await getAssets(trx, warehouseId, [...exact.values()])
  const keys = [...new Set(keyRows.map((r) => r.k))]
  const lookalikes = keys.length === 0 ? [] : (await sql<{ asset_code: string; code_key: string; serial_key: string | null }>`
    SELECT asset_code, asset_code_key AS code_key, serial_number_key AS serial_key FROM wam.assets
     WHERE warehouse_id = ${warehouseId} AND retired_at IS NULL
       AND (asset_code_key = ANY (${keys}) OR serial_number_key = ANY (${keys}))`.execute(trx)).rows
  const takenCodeKeys = new Map(lookalikes.map((r) => [r.code_key, r.asset_code]))
  const takenSerialKeys = new Set(lookalikes.map((r) => r.serial_key).filter((k) => k !== null))
  const inFile = new Map<string, number>()
  for (const r of rows) {
    const k = r.cells.asset_code === undefined ? undefined : matchKey.get(r.cells.asset_code)
    if (k !== undefined && k !== '') inFile.set(k, (inFile.get(k) ?? 0) + 1)
  }

  const result = new Map<string, Evaluation>()
  for (const row of rows) {
    const issues: ImportIssue[] = []
    const values: Partial<Record<FieldName | 'statusId', FieldValue>> = {}
    for (const field of IMPORT_FIELDS) {
      const raw = row.cells[field]
      if (raw === undefined) continue
      const limit = TEXT_LIMITS[field]
      if (limit !== undefined && raw.length > limit) issues.push({ code: 'too_long', column: field })
      if ((field === 'asset_code' || field === 'serial_number') && isBlankIdentifier(raw)) issues.push({ code: 'blank_identifier', column: field })
      if (field === 'entry_date' || field === 'exit_date') {
        if (!isDate(raw)) issues.push({ code: 'invalid_date', column: field })
        values[FIELD_OF[field]] = raw
      } else if (field === 'item_type' || field === 'status' || field === 'country' || field === 'workshop') {
        const id = lookups.byField[field].get(lookups.keyOf.get(raw) ?? '')
        if (id === undefined) issues.push({ code: 'unknown_value', column: field })
        else values[FIELD_OF[field]] = id
      } else {
        values[FIELD_OF[field]] = field === 'asset_code' || field === 'serial_number' ? raw : raw.trim()
      }
    }
    const entry = values.entryDate
    const exit = values.exitDate
    if (typeof entry === 'string' && typeof exit === 'string' && exit < entry) issues.push({ code: 'dates_out_of_order', column: 'exit_date' })
    const code = row.cells.asset_code
    const matched = code === undefined ? undefined : exact.get(code)
    if (code === undefined) issues.push({ code: 'missing_required', column: 'asset_code' })
    if (matched === undefined) {
      for (const required of ['name', 'item_type', 'status'] as const) {
        if (row.cells[required] === undefined) issues.push({ code: 'missing_required', column: required })
      }
    }
    if (issues.length > 0) {
      result.set(row.id, { outcome: 'invalid', issues, matchedAssetId: null, matchedVersion: null, values: {} })
      continue
    }
    const codeKey = matchKey.get(code ?? '') ?? ''
    if ((inFile.get(codeKey) ?? 0) > 1) {
      result.set(row.id, { outcome: 'suspected_duplicate', issues: [{ code: 'duplicate_in_file', column: 'asset_code' }], matchedAssetId: null, matchedVersion: null, values: {} })
      continue
    }
    if (matched === undefined) {
      const serialKey = row.cells.serial_number === undefined ? undefined : matchKey.get(row.cells.serial_number)
      if (takenCodeKeys.has(codeKey) || (serialKey !== undefined && takenSerialKeys.has(serialKey))) {
        const column = takenCodeKeys.has(codeKey) ? 'asset_code' : 'serial_number'
        result.set(row.id, { outcome: 'suspected_duplicate', issues: [{ code: 'similar_asset_exists', column }], matchedAssetId: null, matchedVersion: null, values: {} })
      } else {
        result.set(row.id, { outcome: 'create', issues: [], matchedAssetId: null, matchedVersion: null, values })
      }
      continue
    }
    const current = matchedAssets.get(matched)
    if (current === undefined) throw new AppError('IMPORT_STALE', { rowNumber: row.row_number })
    const incoming: Partial<Record<FieldName | 'statusId', IncomingCell<FieldValue>>> = {}
    for (const [field, value] of Object.entries(values) as [FieldName | 'statusId', FieldValue][]) incoming[field] = { kind: 'set', value }
    const planned = planFieldChanges({ ...fieldsOf(current), statusId: current.statusId }, incoming, sameValue)
    result.set(row.id, {
      outcome: planned.length === 0 ? 'unchanged' : 'update',
      issues: [],
      matchedAssetId: matched,
      matchedVersion: current.version,
      current,
      values: Object.fromEntries(planned.map((c) => [c.field, c.after]))
    })
  }
  return result
}

async function storedRows(trx: Kysely<Database>, warehouseId: number, batchId: number): Promise<StoredRow[]> {
  const { rows } = await sql<StoredRow>`
    SELECT id, sheet_name, row_number, cells, outcome, matched_asset_id, matched_asset_version FROM wam.import_rows
     WHERE batch_id = ${batchId} AND warehouse_id = ${warehouseId} ORDER BY id`.execute(trx)
  return rows
}

export type OutcomeCounts = Record<ImportRowOutcome, number>

function countOutcomes(evaluations: Iterable<Evaluation>): OutcomeCounts {
  const counts: OutcomeCounts = { create: 0, update: 0, unchanged: 0, suspected_duplicate: 0, invalid: 0 }
  for (const e of evaluations) counts[e.outcome] += 1
  return counts
}

// --- staging, preview, commit, cancel ----------------------------------------------------------------

const STAGE_CHUNK = 500

/**
 * Decision O-17: one import batch holds at most this many non-blank data rows, valid or invalid. A constant,
 * not a setting. Larger files are split into separate batches by the user; the server never splits one, and
 * each batch is previewed and committed (atomically) on its own — there is no whole-file atomicity.
 */
export const MAX_IMPORT_BATCH_ROWS = 5_000

/**
 * A row is blank when none of its cells holds anything under the blank-cell rule of this module (a cell that
 * is missing, empty, or only whitespace as String.prototype.trim() defines it is absent; see cleanCells).
 * Blank rows are not staged and do not count toward MAX_IMPORT_BATCH_ROWS. A header row never reaches this
 * module: rows arrive already keyed by internal field identifiers (the field contract of O-14 stage 2), so it
 * is excluded by construction.
 */
export function isBlankRow(row: ParsedRow): boolean {
  return Object.keys(cleanCells(row.cells)).length === 0
}

/** Non-blank rows staged in a batch (a row staged before O-17 with no cells is not counted). */
async function stagedDataRows(trx: Kysely<Database>, warehouseId: number, batchId: number): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT count(*) AS n FROM wam.import_rows
     WHERE batch_id = ${batchId} AND warehouse_id = ${warehouseId} AND cells <> '{}'::jsonb`.execute(trx)
  return Number(rows[0]?.n ?? 0)
}

/**
 * Preview and commit check the limit again, independently of staging, against the rows actually stored: a
 * batch staged before O-17, or rows added outside stageRows, can never be previewed or committed above the
 * limit. The batch's own row count must also agree with the stored rows.
 */
async function assertBatchWithinLimit(trx: Kysely<Database>, warehouseId: number, batch: BatchRow): Promise<void> {
  const staged = await stagedDataRows(trx, warehouseId, Number(batch.id))
  const recorded = batch.row_count ?? 0
  if (staged > MAX_IMPORT_BATCH_ROWS || recorded > MAX_IMPORT_BATCH_ROWS) {
    throw new AppError('IMPORT_TOO_LARGE', { limit: MAX_IMPORT_BATCH_ROWS, rows: Math.max(staged, recorded) })
  }
  if (staged !== recorded) throw new AppError('IMPORT_STATE', { reason: 'staged rows do not match the batch' })
}

export interface StagingResult {
  /** Non-blank rows staged by this call. */
  readonly staged: number
  /** Blank rows skipped by this call. */
  readonly blank: number
  /** Non-blank rows in the batch after this call. */
  readonly total: number
}

/**
 * Stages parsed rows while the batch is uploading (the database refuses any other state). Blank rows are
 * skipped; every other row is staged and counted, valid or not. The batch row is locked first, so concurrent
 * calls for one batch are serialized and cannot both pass the limit; a call that would take the batch above
 * MAX_IMPORT_BATCH_ROWS is refused before anything is written.
 */
export async function stageRows(trx: Kysely<Database>, warehouseId: number, batchId: number, rows: readonly ParsedRow[]): Promise<StagingResult> {
  const dataRows = rows.filter((row) => !isBlankRow(row))
  try {
    const { rows: locked } = await sql<{ state: ImportBatchState }>`
      SELECT state FROM wam.import_batches WHERE id = ${batchId} AND warehouse_id = ${warehouseId} FOR UPDATE`.execute(trx)
    const batch = locked[0]
    if (batch === undefined) throw new AppError('NOT_FOUND')
    if (batch.state !== 'uploaded') throw new AppError('IMPORT_STATE', { state: batch.state })
    const total = (await stagedDataRows(trx, warehouseId, batchId)) + dataRows.length
    if (total > MAX_IMPORT_BATCH_ROWS) throw new AppError('IMPORT_TOO_LARGE', { limit: MAX_IMPORT_BATCH_ROWS, rows: total })
    for (let start = 0; start < dataRows.length; start += STAGE_CHUNK) {
      await trx
        .insertInto('import_rows')
        .values(
          dataRows.slice(start, start + STAGE_CHUNK).map((row) => ({
            batch_id: String(batchId),
            warehouse_id: warehouseId,
            sheet_name: row.sheetName,
            row_number: row.rowNumber,
            cells: JSON.stringify(cleanCells(row.cells)),
            outcome: 'invalid' as const,
            issues: JSON.stringify([{ code: 'not_previewed' }])
          }))
        )
        .execute()
    }
    await sql`UPDATE wam.import_batches SET row_count = ${total} WHERE id = ${batchId} AND warehouse_id = ${warehouseId}`.execute(trx)
    return { staged: dataRows.length, blank: rows.length - dataRows.length, total }
  } catch (err) {
    if ((err as { code?: unknown }).code === '55000') throw new AppError('IMPORT_STATE')
    throw assetDbError(err) ?? err
  }
}

async function transition(
  trx: Kysely<Database>,
  warehouseId: number,
  batchId: number,
  version: number,
  from: readonly ImportBatchState[],
  to: ImportBatchState
): Promise<BatchRow> {
  const current = await findBatch(trx, warehouseId, batchId)
  if (!from.includes(current.state)) throw new AppError('IMPORT_STATE', { state: current.state })
  if (current.version !== version) throw new AppError('VERSION_CONFLICT', { currentVersion: current.version })
  try {
    const result = await sql`
      UPDATE wam.import_batches SET state = ${to} WHERE id = ${batchId} AND warehouse_id = ${warehouseId} AND version = ${version}`.execute(trx)
    if (result.numAffectedRows === 0n) throw new AppError('VERSION_CONFLICT')
  } catch (err) {
    if ((err as { code?: unknown }).code === '55000') throw new AppError('IMPORT_STATE')
    throw assetDbError(err) ?? err
  }
  return current
}

/** Re-validates every row against the warehouse as it is now and marks the batch previewed. */
export async function previewBatch(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  warehouseId: number,
  batchId: number,
  version: number
): Promise<{ batch: BatchSummary; counts: OutcomeCounts }> {
  await assertBatchWithinLimit(trx, warehouseId, await transition(trx, warehouseId, batchId, version, ['uploaded', 'previewed'], 'previewed'))
  const rows = await storedRows(trx, warehouseId, batchId)
  const evaluations = await evaluate(trx, warehouseId, rows)
  // One statement per chunk of rows; the rows guard still checks every row.
  for (let start = 0; start < rows.length; start += STAGE_CHUNK) {
    const chunk = rows.slice(start, start + STAGE_CHUNK).flatMap((row) => {
      const e = evaluations.get(row.id)
      return e === undefined ? [] : [{ id: row.id, e }]
    })
    await sql`
      UPDATE wam.import_rows AS r
         SET outcome = v.outcome, issues = v.issues, matched_asset_id = v.matched_asset_id, matched_asset_version = v.matched_asset_version
        FROM unnest(${chunk.map((c) => c.id)}::bigint[], ${chunk.map((c) => c.e.outcome)}::text[],
                    ${chunk.map((c) => JSON.stringify(c.e.issues))}::jsonb[],
                    ${chunk.map((c) => (c.e.matchedAssetId === null ? null : String(c.e.matchedAssetId)))}::bigint[],
                    ${chunk.map((c) => c.e.matchedVersion)}::integer[])
             AS v (id, outcome, issues, matched_asset_id, matched_asset_version)
       WHERE r.id = v.id AND r.batch_id = ${batchId}`.execute(trx)
  }
  const counts = countOutcomes(evaluations.values())
  await recordAudit(trx, context, {
    action: 'import.previewed',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'import_batch', id: batchId },
    warehouseId,
    details: { counts }
  })
  return { batch: toBatch(await findBatch(trx, warehouseId, batchId)), counts }
}

/**
 * The commit protocol (proposal §6.2), in the caller's single transaction: committing → lock matched
 * assets in id order → re-validate (refuse if anything changed since the preview) → one asset statement
 * per row with wam.import_row_id set (the database marks the row applied) → committed. Any error rolls
 * back assets, row markers, batch state and audit events together.
 */
export async function commitBatch(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  warehouseId: number,
  batchId: number,
  version: number
): Promise<{ batch: BatchSummary; counts: OutcomeCounts }> {
  await assertBatchWithinLimit(trx, warehouseId, await transition(trx, warehouseId, batchId, version, ['previewed'], 'committing'))
  const rows = await storedRows(trx, warehouseId, batchId)
  const matchedIds = rows.map((r) => r.matched_asset_id).filter((id) => id !== null)
  if (matchedIds.length > 0) {
    await sql`SELECT id FROM wam.assets WHERE id = ANY (${matchedIds}::bigint[]) ORDER BY id FOR UPDATE`.execute(trx)
  }
  const evaluations = await evaluate(trx, warehouseId, rows)
  for (const row of rows) {
    const e = evaluations.get(row.id)
    const stillSame =
      e !== undefined &&
      e.outcome === row.outcome &&
      (e.matchedAssetId === null ? null : String(e.matchedAssetId)) === row.matched_asset_id &&
      e.matchedVersion === row.matched_asset_version
    if (!stillSame) throw new AppError('IMPORT_STALE', { rowNumber: row.row_number })
  }
  // Audit events are written after the asset statements, in the same transaction (a few statements in all).
  const events: AuditEvent[] = []
  for (const row of rows) {
    const e = evaluations.get(row.id)
    if (e === undefined || (e.outcome !== 'create' && e.outcome !== 'update')) continue
    await setImportRow(trx, row.id)
    try {
      if (e.outcome === 'create') {
        const values: Record<string, unknown> = { warehouse_id: warehouseId, origin: 'import', origin_import_row_id: row.id, status_id: e.values.statusId }
        for (const [field, value] of Object.entries(e.values) as [FieldName | 'statusId', FieldValue][]) {
          if (field !== 'statusId') Object.assign(values, columnsFor(field, value))
        }
        const created = await trx.insertInto('assets').values(values as never).returning('id').executeTakeFirstOrThrow()
        events.push({
          action: 'asset.created',
          outcome: 'success',
          actor: auditActor(actor),
          target: { type: 'asset', id: created.id },
          warehouseId,
          details: { origin: 'import', importRowId: Number(row.id), fields: e.values }
        })
      } else {
        const set: Record<string, unknown> = {}
        for (const [field, value] of Object.entries(e.values) as [FieldName | 'statusId', FieldValue][]) {
          Object.assign(set, field === 'statusId' ? { status_id: value } : columnsFor(field, value))
        }
        try {
          await updateAssetAtVersion(trx, warehouseId, e.matchedAssetId ?? -1, e.matchedVersion ?? -1, set)
        } catch (err) {
          if (err instanceof AppError && err.code === 'VERSION_CONFLICT') throw new AppError('IMPORT_STALE', { rowNumber: row.row_number })
          if (err instanceof AppError && err.code === 'CODE_TAKEN') throw new AppError('CODE_TAKEN', { rowNumber: row.row_number })
          throw err
        }
        const beforeFields: Record<string, unknown> = e.current === undefined ? {} : { ...fieldsOf(e.current), statusId: e.current.statusId }
        events.push({
          action: 'asset.updated',
          outcome: 'success',
          actor: auditActor(actor),
          target: { type: 'asset', id: e.matchedAssetId ?? -1 },
          warehouseId,
          details: {
            origin: 'import',
            importRowId: Number(row.id),
            changed: Object.fromEntries(Object.entries(e.values).map(([f, v]) => [f, { before: beforeFields[f], after: v }]))
          }
        })
      }
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (code === '23505') throw new AppError('CODE_TAKEN', { rowNumber: row.row_number })
      if (code === '23514' || code === '55000') throw assetDbError(err) ?? new AppError('IMPORT_STALE', { rowNumber: row.row_number })
      throw err
    }
  }
  await setImportRow(trx, null)
  await recordAuditEvents(trx, context, events)
  await sql`UPDATE wam.import_batches SET state = 'committed' WHERE id = ${batchId} AND warehouse_id = ${warehouseId}`.execute(trx)
  const counts = countOutcomes(evaluations.values())
  await recordAudit(trx, context, {
    action: 'import.committed',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'import_batch', id: batchId },
    warehouseId,
    details: { counts, rows: rows.length }
  })
  return { batch: toBatch(await findBatch(trx, warehouseId, batchId)), counts }
}

export async function cancelBatch(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  warehouseId: number,
  batchId: number,
  version: number
): Promise<BatchSummary> {
  await transition(trx, warehouseId, batchId, version, ['uploaded', 'previewed'], 'cancelled')
  await recordAudit(trx, context, {
    action: 'import.cancelled',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'import_batch', id: batchId },
    warehouseId
  })
  return toBatch(await findBatch(trx, warehouseId, batchId))
}

/**
 * The fixed-policy retention step (PD-09), as the server's role; it writes its own audit event. It is one
 * statement that clears every due batch (up to 50,000 rows each), so it gets its own statement timeout
 * instead of the request timeout (WAM_DB_STATEMENT_TIMEOUT_MS): a backlog that outgrew the request timeout
 * would otherwise fail, roll back and fail again every day.
 */
export async function runImportRetention(db: Kysely<Database>): Promise<{ expiredBatches: number; clearedBatches: number; clearedRows: number }> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL statement_timeout = '10min'`.execute(trx)
    const { rows } = await sql<{ expired_batches: number; cleared_batches: number; cleared_rows: number }>`
      SELECT * FROM wam.apply_import_retention()`.execute(trx)
    const r = rows[0]
    return { expiredBatches: r?.expired_batches ?? 0, clearedBatches: r?.cleared_batches ?? 0, clearedRows: r?.cleared_rows ?? 0 }
  })
}
