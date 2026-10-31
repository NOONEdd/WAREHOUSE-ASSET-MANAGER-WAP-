import { sql, type Kysely, type RawBuilder } from 'kysely'
import { auditActor, type Actor } from '../admin/rules.js'
import { AppError } from '../appError.js'
import { recordAudit, type AuditContext } from '../audit/audit.js'
import type { Database } from '../db/connection.js'
import { setChangeReason } from '../db/dataContext.js'
import { planFieldChanges, type IncomingCell } from '../imports/fieldChanges.js'
import { mapAssetDbErrors } from './dbErrors.js'
import { isBlankIdentifier } from './matchKey.js'
import { assertSelectablePerson } from './persons.js'

// Assets of one warehouse (migration 0006): list, count, read, history, create, edit, change status.
// Every function runs inside a transaction whose data context (warehouse scope, actor, request ID) is
// set to the route's warehouse, after the route's permission check; every query also names the
// warehouse explicitly. Identifiers are stored exactly as written. The database stamps attribution and
// versions, writes the history and refuses writes in an inactive warehouse. Transfers and retirement
// are Phase 1B-5 and not offered here.

export type Party = { readonly userId: number } | { readonly personId: number }

export interface Asset {
  readonly id: number
  readonly warehouseId: number
  readonly assetCode: string
  readonly name: string
  readonly itemTypeId: number
  readonly model: string | null
  readonly serialNumber: string | null
  readonly countryId: number | null
  readonly workshopId: number | null
  readonly statusId: number
  readonly entryDate: string | null
  readonly exitDate: string | null
  readonly deliveredBy: Party | null
  readonly receivedBy: Party | null
  readonly notes: string | null
  readonly origin: 'manual' | 'import'
  readonly originImportRowId: number | null
  readonly createdAt: string
  readonly createdBy: number
  readonly updatedAt: string
  readonly updatedBy: number
  readonly version: number
}

interface Row {
  id: string
  warehouse_id: number
  asset_code: string
  name: string
  item_type_id: number
  model: string | null
  serial_number: string | null
  country_id: number | null
  workshop_id: number | null
  status_id: number
  entry_date: string | null
  exit_date: string | null
  delivered_by_user_id: number | null
  delivered_by_person_id: string | null
  received_by_user_id: number | null
  received_by_person_id: string | null
  notes: string | null
  origin: 'manual' | 'import'
  origin_import_row_id: string | null
  created_at: Date
  created_by: number
  updated_at: Date
  updated_by: number
  version: number
}

const COLUMNS = sql.raw(`id, warehouse_id, asset_code, name, item_type_id, model, serial_number, country_id, workshop_id,
  status_id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, to_char(exit_date, 'YYYY-MM-DD') AS exit_date,
  delivered_by_user_id, delivered_by_person_id, received_by_user_id, received_by_person_id, notes, origin,
  origin_import_row_id, created_at, created_by, updated_at, updated_by, version`)

function party(userId: number | null, personId: string | null): Party | null {
  if (userId !== null) return { userId }
  if (personId !== null) return { personId: Number(personId) }
  return null
}

function toAsset(row: Row): Asset {
  return {
    id: Number(row.id),
    warehouseId: row.warehouse_id,
    assetCode: row.asset_code,
    name: row.name,
    itemTypeId: row.item_type_id,
    model: row.model,
    serialNumber: row.serial_number,
    countryId: row.country_id,
    workshopId: row.workshop_id,
    statusId: row.status_id,
    entryDate: row.entry_date,
    exitDate: row.exit_date,
    deliveredBy: party(row.delivered_by_user_id, row.delivered_by_person_id),
    receivedBy: party(row.received_by_user_id, row.received_by_person_id),
    notes: row.notes,
    origin: row.origin,
    originImportRowId: row.origin_import_row_id === null ? null : Number(row.origin_import_row_id),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    version: row.version
  }
}

// --- reading ---------------------------------------------------------------------------------------

export interface AssetFilter {
  /** Matches the start of the code or serial match key, or any part of the name (catalogue-name key). */
  readonly q?: string | undefined
  readonly statusId?: number | undefined
  readonly itemTypeId?: number | undefined
}

function whereClause(warehouseId: number, filter: AssetFilter): RawBuilder<unknown> {
  const conditions: RawBuilder<unknown>[] = [sql`warehouse_id = ${warehouseId}`, sql`retired_at IS NULL`]
  if (filter.statusId !== undefined) conditions.push(sql`status_id = ${filter.statusId}`)
  if (filter.itemTypeId !== undefined) conditions.push(sql`item_type_id = ${filter.itemTypeId}`)
  const q = filter.q?.trim() ?? ''
  if (q !== '') {
    conditions.push(sql`(
      (wam.match_key(${q}) <> '' AND (starts_with(asset_code_key, wam.match_key(${q}))
                                      OR starts_with(serial_number_key, wam.match_key(${q}))))
      OR strpos(name_key, wam.name_key(${q})) > 0)`)
  }
  return sql.join(conditions, sql` AND `)
}

export async function listAssets(
  trx: Kysely<Database>,
  warehouseId: number,
  filter: AssetFilter & { readonly after?: number | undefined; readonly limit: number }
): Promise<{ assets: Asset[]; nextAfter: number | null }> {
  const { rows } = await sql<Row>`
    SELECT ${COLUMNS} FROM wam.assets
     WHERE ${whereClause(warehouseId, filter)} AND id > ${filter.after ?? 0}
     ORDER BY id LIMIT ${filter.limit}`.execute(trx)
  const assets = rows.map(toAsset)
  return { assets, nextAfter: assets.length === filter.limit ? (assets.at(-1)?.id ?? null) : null }
}

export async function countAssets(trx: Kysely<Database>, warehouseId: number, filter: AssetFilter): Promise<number> {
  const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM wam.assets WHERE ${whereClause(warehouseId, filter)}`.execute(trx)
  return Number(rows[0]?.n ?? 0)
}

async function findAsset(trx: Kysely<Database>, warehouseId: number, assetId: number, lock: boolean): Promise<Row> {
  const { rows } = await sql<Row>`
    SELECT ${COLUMNS} FROM wam.assets WHERE id = ${assetId} AND warehouse_id = ${warehouseId} AND retired_at IS NULL
    ${lock ? sql`FOR UPDATE` : sql``}`.execute(trx)
  const row = rows[0]
  if (row === undefined) throw new AppError('NOT_FOUND')
  return row
}

export async function getAsset(trx: Kysely<Database>, warehouseId: number, assetId: number): Promise<Asset> {
  return toAsset(await findAsset(trx, warehouseId, assetId, false))
}

/** Several assets of one warehouse in one query, by id; ids that are not found are absent from the map. */
export async function getAssets(trx: Kysely<Database>, warehouseId: number, assetIds: readonly number[]): Promise<Map<number, Asset>> {
  if (assetIds.length === 0) return new Map()
  const { rows } = await sql<Row>`
    SELECT ${COLUMNS} FROM wam.assets
     WHERE id = ANY (${assetIds.map(String)}::bigint[]) AND warehouse_id = ${warehouseId} AND retired_at IS NULL`.execute(trx)
  return new Map(rows.map((row) => [Number(row.id), toAsset(row)]))
}

export interface AssetHistory {
  readonly statusChanges: readonly {
    readonly fromStatusId: number | null
    readonly toStatusId: number
    readonly changedAt: string
    readonly changedBy: number
    readonly reason: string | null
    readonly deliveredBy: Party | null
    readonly receivedBy: Party | null
    readonly importRowId: number | null
  }[]
  readonly moves: readonly {
    readonly fromWarehouseId: number | null
    readonly toWarehouseId: number
    readonly changedAt: string
    readonly changedBy: number
    readonly reason: string | null
  }[]
}

/** The asset's history as row-level security lets this warehouse see it (PD-08). */
export async function getAssetHistory(trx: Kysely<Database>, warehouseId: number, assetId: number): Promise<AssetHistory> {
  await findAsset(trx, warehouseId, assetId, false)
  const status = await trx
    .selectFrom('asset_status_history')
    .selectAll()
    .where('asset_id', '=', String(assetId))
    .orderBy('id')
    .execute()
  const moves = await trx
    .selectFrom('asset_warehouse_history')
    .selectAll()
    .where('asset_id', '=', String(assetId))
    .orderBy('id')
    .execute()
  return {
    statusChanges: status.map((r) => ({
      fromStatusId: r.from_status_id,
      toStatusId: r.to_status_id,
      changedAt: r.changed_at.toISOString(),
      changedBy: r.changed_by,
      reason: r.reason,
      deliveredBy: party(r.delivered_by_user_id, r.delivered_by_person_id),
      receivedBy: party(r.received_by_user_id, r.received_by_person_id),
      importRowId: r.import_row_id === null ? null : Number(r.import_row_id)
    })),
    moves: moves.map((r) => ({
      fromWarehouseId: r.from_warehouse_id,
      toWarehouseId: r.to_warehouse_id,
      changedAt: r.changed_at.toISOString(),
      changedBy: r.changed_by,
      reason: r.reason
    }))
  }
}

/** Assets of this warehouse whose code or serial match key equals this asset's: reported, never merged. */
export async function suspectedDuplicates(trx: Kysely<Database>, warehouseId: number, assetId: number): Promise<{ id: number; assetCode: string }[]> {
  const { rows } = await sql<{ id: string; asset_code: string }>`
    SELECT o.id, o.asset_code FROM wam.assets a JOIN wam.assets o
        ON o.warehouse_id = a.warehouse_id AND o.id <> a.id AND o.retired_at IS NULL
       AND (o.asset_code_key = a.asset_code_key OR (a.serial_number_key IS NOT NULL AND o.serial_number_key = a.serial_number_key))
     WHERE a.id = ${assetId} AND a.warehouse_id = ${warehouseId}
     ORDER BY o.id LIMIT 20`.execute(trx)
  return rows.map((r) => ({ id: Number(r.id), assetCode: r.asset_code }))
}

// --- writing ---------------------------------------------------------------------------------------

/** The editable fields; status changes have their own operation. */
export interface AssetFields {
  readonly assetCode: string
  readonly name: string
  readonly itemTypeId: number
  readonly model: string | null
  readonly serialNumber: string | null
  readonly countryId: number | null
  readonly workshopId: number | null
  readonly entryDate: string | null
  readonly exitDate: string | null
  readonly deliveredBy: Party | null
  readonly receivedBy: Party | null
  readonly notes: string | null
}

export type FieldName = keyof AssetFields
const FIELD_NAMES: readonly FieldName[] = [
  'assetCode', 'name', 'itemTypeId', 'model', 'serialNumber', 'countryId', 'workshopId', 'entryDate', 'exitDate',
  'deliveredBy', 'receivedBy', 'notes'
]
const REQUIRED: ReadonlySet<FieldName> = new Set(['assetCode', 'name', 'itemTypeId'])
export type FieldValue = AssetFields[FieldName]

export function fieldsOf(asset: Asset): Record<FieldName, FieldValue> {
  return Object.fromEntries(FIELD_NAMES.map((f) => [f, asset[f]])) as Record<FieldName, FieldValue>
}

export function sameValue(a: FieldValue, b: FieldValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The column values that store `field` (a party is two columns). */
export function columnsFor(field: FieldName, value: FieldValue): Record<string, unknown> {
  if (field === 'deliveredBy' || field === 'receivedBy') {
    const p = value as Party | null
    const prefix = field === 'deliveredBy' ? 'delivered_by' : 'received_by'
    return {
      [`${prefix}_user_id`]: p !== null && 'userId' in p ? p.userId : null,
      [`${prefix}_person_id`]: p !== null && 'personId' in p ? String(p.personId) : null
    }
  }
  return { [field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]: value }
}

async function checkFields(trx: Kysely<Database>, warehouseId: number, fields: Partial<Record<FieldName, FieldValue>>): Promise<void> {
  if (typeof fields.assetCode === 'string' && isBlankIdentifier(fields.assetCode)) {
    throw new AppError('VALIDATION_FAILED', { field: 'assetCode', reason: 'blank' })
  }
  if (typeof fields.serialNumber === 'string' && isBlankIdentifier(fields.serialNumber)) {
    throw new AppError('VALIDATION_FAILED', { field: 'serialNumber', reason: 'blank' })
  }
  for (const role of ['deliveredBy', 'receivedBy'] as const) {
    const p = fields[role] as Party | null | undefined
    if (p != null && 'personId' in p) await assertSelectablePerson(trx, warehouseId, p.personId)
  }
}

function trimText(fields: Partial<Record<FieldName, FieldValue>>): Partial<Record<FieldName, FieldValue>> {
  // Human-readable texts lose surrounding whitespace; identifiers (code, serial) are kept exactly.
  const out = { ...fields }
  for (const f of ['name', 'model', 'notes'] as const) {
    const v = out[f]
    if (typeof v === 'string') out[f] = v.trim() === '' && f !== 'name' ? null : v.trim()
  }
  return out
}

/**
 * The one statement that changes an asset: only at the version the caller saw (optimistic concurrency).
 * Callers lock the row first; this check is the independent second layer (tested on its own).
 */
export async function updateAssetAtVersion(
  trx: Kysely<Database>,
  warehouseId: number,
  assetId: number,
  version: number,
  set: Record<string, unknown>
): Promise<void> {
  const assignments = sql.join(
    Object.entries(set).map(([column, value]) => sql`${sql.ref(column)} = ${value}`),
    sql`, `
  )
  const result = await mapAssetDbErrors(() =>
    sql`UPDATE wam.assets SET ${assignments} WHERE id = ${assetId} AND warehouse_id = ${warehouseId} AND version = ${version}`.execute(trx)
  )
  if (result.numAffectedRows === 0n) throw new AppError('VERSION_CONFLICT')
}

export async function createAsset(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  warehouseId: number,
  input: AssetFields & { readonly statusId: number }
): Promise<{ asset: Asset; suspectedDuplicates: { id: number; assetCode: string }[] }> {
  const fields = trimText(input) as AssetFields & { statusId: number }
  await checkFields(trx, warehouseId, fields)
  const values: Record<string, unknown> = { warehouse_id: warehouseId, status_id: input.statusId, origin: 'manual' }
  for (const f of FIELD_NAMES) Object.assign(values, columnsFor(f, fields[f]))
  const id = await mapAssetDbErrors(async () => {
    const row = await trx
      .insertInto('assets')
      .values(values as never)
      .returning('id')
      .executeTakeFirstOrThrow()
    return Number(row.id)
  })
  const asset = await getAsset(trx, warehouseId, id)
  await recordAudit(trx, context, {
    action: 'asset.created',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'asset', id },
    warehouseId,
    details: { origin: 'manual', fields: { ...fieldsOf(asset), statusId: asset.statusId } }
  })
  return { asset, suspectedDuplicates: await suspectedDuplicates(trx, warehouseId, id) }
}

/** `changes`: a field with a value sets it, a field with null clears it, an absent field is unchanged. */
export async function editAsset(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  warehouseId: number,
  assetId: number,
  input: { readonly version: number; readonly changes: Partial<Record<FieldName, FieldValue>> }
): Promise<{ asset: Asset; suspectedDuplicates: { id: number; assetCode: string }[] }> {
  const current = toAsset(await findAsset(trx, warehouseId, assetId, true))
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT', { currentVersion: current.version })
  const changes = trimText(input.changes)
  const incoming: Partial<Record<FieldName, IncomingCell<FieldValue>>> = {}
  for (const [field, value] of Object.entries(changes) as [FieldName, FieldValue | undefined][]) {
    if (value === undefined) continue
    if (value === null && REQUIRED.has(field)) throw new AppError('VALIDATION_FAILED', { field, reason: 'required' })
    incoming[field] = value === null ? { kind: 'clear' } : { kind: 'set', value }
  }
  const planned = planFieldChanges(fieldsOf(current), incoming, sameValue)
  if (planned.length === 0) return { asset: current, suspectedDuplicates: [] }
  const after = Object.fromEntries(planned.map((c) => [c.field, c.after])) as Partial<Record<FieldName, FieldValue>>
  await checkFields(trx, warehouseId, after)
  const set: Record<string, unknown> = {}
  for (const c of planned) Object.assign(set, columnsFor(c.field, c.after))
  await updateAssetAtVersion(trx, warehouseId, assetId, input.version, set)
  const asset = await getAsset(trx, warehouseId, assetId)
  await recordAudit(trx, context, {
    action: 'asset.updated',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'asset', id: assetId },
    warehouseId,
    details: { changed: Object.fromEntries(planned.map((c) => [c.field, { before: c.before, after: c.after }])) }
  })
  const codeOrSerial = planned.some((c) => c.field === 'assetCode' || c.field === 'serialNumber')
  return { asset, suspectedDuplicates: codeOrSerial ? await suspectedDuplicates(trx, warehouseId, assetId) : [] }
}

export async function changeAssetStatus(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  warehouseId: number,
  assetId: number,
  input: {
    readonly version: number
    readonly statusId: number
    readonly reason?: string | null | undefined
    readonly deliveredBy?: Party | null | undefined
    readonly receivedBy?: Party | null | undefined
  }
): Promise<Asset> {
  const current = toAsset(await findAsset(trx, warehouseId, assetId, true))
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT', { currentVersion: current.version })
  if (current.statusId === input.statusId) throw new AppError('VALIDATION_FAILED', { field: 'statusId', reason: 'unchanged' })
  const parties: Partial<Record<FieldName, FieldValue>> = {}
  if (input.deliveredBy !== undefined) parties.deliveredBy = input.deliveredBy
  if (input.receivedBy !== undefined) parties.receivedBy = input.receivedBy
  await checkFields(trx, warehouseId, parties)
  const set: Record<string, unknown> = { status_id: input.statusId }
  for (const [f, v] of Object.entries(parties) as [FieldName, FieldValue][]) Object.assign(set, columnsFor(f, v))
  const reason = input.reason?.trim() ?? ''
  await setChangeReason(trx, reason === '' ? null : reason)
  await updateAssetAtVersion(trx, warehouseId, assetId, input.version, set)
  await setChangeReason(trx, null)
  const asset = await getAsset(trx, warehouseId, assetId)
  await recordAudit(trx, context, {
    action: 'asset.status_changed',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'asset', id: assetId },
    warehouseId,
    details: {
      fromStatusId: current.statusId,
      toStatusId: asset.statusId,
      ...(reason === '' ? {} : { reason }),
      ...(input.deliveredBy === undefined ? {} : { deliveredBy: { before: current.deliveredBy, after: asset.deliveredBy } }),
      ...(input.receivedBy === undefined ? {} : { receivedBy: { before: current.receivedBy, after: asset.receivedBy } })
    }
  })
  return asset
}
