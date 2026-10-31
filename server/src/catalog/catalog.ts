import { sql, type Kysely } from 'kysely'
import { auditActor, type Actor } from '../admin/rules.js'
import { AppError } from '../appError.js'
import { mapAssetDbErrors } from '../assets/dbErrors.js'
import { recordAudit, type AuditContext } from '../audit/audit.js'
import type { Database } from '../db/connection.js'

// The global catalogue (decision PD-10; migration 0005): asset statuses, item types, workshops and
// countries. Anyone signed in may read it; changes need catalog.manage (PD-06). Entries are
// deactivated, never deleted. Active names are unique by the catalogue-name key, enforced by the
// database; the five system statuses cannot be renamed, recoded or deactivated (database).

export const CATALOG_KINDS = ['statuses', 'item-types', 'workshops', 'countries'] as const
export type CatalogKind = (typeof CATALOG_KINDS)[number]

const TABLES = {
  statuses: 'asset_statuses',
  'item-types': 'item_types',
  workshops: 'workshops',
  countries: 'countries'
} as const satisfies Record<CatalogKind, keyof Database>

export interface CatalogEntry {
  readonly id: number
  readonly name: string
  readonly isActive: boolean
  readonly version: number
  /** Statuses only. */
  readonly code?: string | null
  readonly isSystem?: boolean
  readonly sortOrder?: number
  /** Countries only. */
  readonly isoCode?: string | null
}

interface Row {
  id: number
  name: string
  is_active: boolean
  version: number
  code?: string | null
  is_system?: boolean
  sort_order?: number
  iso_code?: string | null
}

function toEntry(kind: CatalogKind, row: Row): CatalogEntry {
  const base = { id: row.id, name: row.name, isActive: row.is_active, version: row.version }
  if (kind === 'statuses') return { ...base, code: row.code ?? null, isSystem: row.is_system ?? false, sortOrder: row.sort_order ?? 0 }
  if (kind === 'countries') return { ...base, isoCode: row.iso_code ?? null }
  return base
}

function table(kind: CatalogKind) {
  return sql.table(`wam.${TABLES[kind]}`)
}

export async function listCatalog(db: Kysely<Database>, kind: CatalogKind, includeInactive: boolean): Promise<CatalogEntry[]> {
  const order = kind === 'statuses' ? sql`sort_order, id` : sql`id`
  const { rows } = await sql<Row>`
    SELECT * FROM ${table(kind)} WHERE ${includeInactive ? sql`true` : sql`is_active`} ORDER BY ${order}`.execute(db)
  return rows.map((row) => toEntry(kind, row))
}

async function findEntry(db: Kysely<Database>, kind: CatalogKind, id: number): Promise<Row | undefined> {
  const { rows } = await sql<Row>`SELECT * FROM ${table(kind)} WHERE id = ${id} FOR UPDATE`.execute(db)
  return rows[0]
}

export interface CatalogInput {
  readonly name: string
  readonly sortOrder?: number | undefined
  readonly isoCode?: string | null | undefined
}

export async function createCatalogEntry(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  kind: CatalogKind,
  input: CatalogInput
): Promise<CatalogEntry> {
  const name = input.name.trim()
  const row = await mapAssetDbErrors(async () => {
    if (kind === 'statuses') {
      const { rows } = await sql<Row>`
        INSERT INTO wam.asset_statuses (name, sort_order) VALUES (${name}, ${input.sortOrder ?? 100}) RETURNING *`.execute(trx)
      return rows[0]
    }
    if (kind === 'countries') {
      const { rows } = await sql<Row>`
        INSERT INTO wam.countries (name, iso_code) VALUES (${name}, ${input.isoCode ?? null}) RETURNING *`.execute(trx)
      return rows[0]
    }
    const { rows } = await sql<Row>`INSERT INTO ${table(kind)} (name) VALUES (${name}) RETURNING *`.execute(trx)
    return rows[0]
  })
  if (row === undefined) throw new Error('insert returned no row')
  await recordAudit(trx, context, {
    action: 'catalog.created',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: TABLES[kind], id: row.id },
    details: { kind, name, ...(input.isoCode == null ? {} : { isoCode: input.isoCode }) }
  })
  return toEntry(kind, row)
}

export interface CatalogUpdate {
  readonly version: number
  readonly name?: string | undefined
  readonly isActive?: boolean | undefined
  readonly sortOrder?: number | undefined
  readonly isoCode?: string | null | undefined
}

export async function updateCatalogEntry(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  kind: CatalogKind,
  id: number,
  input: CatalogUpdate
): Promise<CatalogEntry> {
  const current = await findEntry(trx, kind, id)
  if (current === undefined) throw new AppError('NOT_FOUND')
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT', { currentVersion: current.version })
  const after = {
    name: input.name?.trim() ?? current.name,
    isActive: input.isActive ?? current.is_active,
    ...(kind === 'statuses' ? { sortOrder: input.sortOrder ?? current.sort_order ?? 0 } : {}),
    ...(kind === 'countries' ? { isoCode: input.isoCode === undefined ? (current.iso_code ?? null) : input.isoCode } : {})
  }
  const before: Record<string, unknown> = {
    name: current.name,
    isActive: current.is_active,
    sortOrder: current.sort_order,
    isoCode: current.iso_code ?? null
  }
  const changed = Object.fromEntries(
    Object.entries(after)
      .filter(([k, v]) => before[k] !== v)
      .map(([k, v]) => [k, { before: before[k], after: v }])
  )
  if (Object.keys(changed).length === 0) return toEntry(kind, current)
  const row = await mapAssetDbErrors(async () => {
    const extra =
      kind === 'statuses'
        ? sql`, sort_order = ${after.sortOrder ?? 0}`
        : kind === 'countries'
          ? sql`, iso_code = ${after.isoCode ?? null}`
          : sql``
    const { rows } = await sql<Row>`
      UPDATE ${table(kind)}
         SET name = ${after.name}, is_active = ${after.isActive}, updated_at = now(), version = version + 1 ${extra}
       WHERE id = ${id} AND version = ${input.version}
       RETURNING *`.execute(trx)
    return rows[0]
  })
  if (row === undefined) throw new AppError('VERSION_CONFLICT')
  await recordAudit(trx, context, {
    action: 'catalog.updated',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: TABLES[kind], id },
    details: { kind, changed }
  })
  return toEntry(kind, row)
}
