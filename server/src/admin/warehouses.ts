import { sql, type Kysely } from 'kysely'
import { AppError } from '../appError.js'
import { requiredName } from './names.js'
import { recordAudit, type AuditContext } from '../audit/audit.js'
import type { Database } from '../db/connection.js'
import { isUniqueViolation } from './dbErrors.js'
import { auditActor, type Actor } from './rules.js'

// Warehouses. The real list comes from the owner (decision D-02) and is
// entered here, never committed to the repository. The system warehouse
// UNASSIGNED cannot be renamed or deactivated. Codes cannot change once
// created (other records and printed labels will refer to them).

export interface Warehouse {
  readonly id: number
  readonly code: string
  readonly name: string
  readonly isSystem: boolean
  readonly isActive: boolean
  readonly version: number
}

const columns = ['id', 'code', 'name', 'is_system as isSystem', 'is_active as isActive', 'version'] as const

export const WAREHOUSE_CODE_PATTERN = '^[A-Z0-9][A-Z0-9_-]{1,31}$'

export async function listWarehouses(db: Kysely<Database>): Promise<Warehouse[]> {
  return db.selectFrom('warehouses').select(columns).orderBy('is_system', 'desc').orderBy('code').execute()
}

export async function createWarehouse(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  input: { readonly code: string; readonly name: string }
): Promise<Warehouse> {
  const name = requiredName(input.name, 'name')
  let row: Warehouse
  try {
    row = await trx
      .insertInto('warehouses')
      .values({ code: input.code.trim().toUpperCase(), name })
      .returning(columns)
      .executeTakeFirstOrThrow()
  } catch (err) {
    if (isUniqueViolation(err, 'warehouses_code_key')) throw new AppError('CODE_TAKEN')
    throw err
  }
  await recordAudit(trx, context, {
    action: 'warehouse.created',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'warehouse', id: row.id },
    warehouseId: row.id,
    details: { after: { code: row.code, name: row.name } }
  })
  return row
}

export async function updateWarehouse(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  id: number,
  input: { readonly version: number; readonly name?: string | undefined; readonly isActive?: boolean | undefined }
): Promise<Warehouse> {
  const name = input.name === undefined ? undefined : requiredName(input.name, 'name')
  const current = await trx.selectFrom('warehouses').select(columns).where('id', '=', id).forUpdate().executeTakeFirst()
  if (current === undefined) throw new AppError('NOT_FOUND')
  if (current.isSystem) throw new AppError('FORBIDDEN', { reason: 'the system warehouse UNASSIGNED cannot be changed' })
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT', { currentVersion: current.version })
  const after = { name: name ?? current.name, isActive: input.isActive ?? current.isActive }
  const changed = Object.fromEntries(
    (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== current[k]).map((k) => [k, { before: current[k], after: after[k] }])
  )
  if (Object.keys(changed).length === 0) return current
  const row = await trx
    .updateTable('warehouses')
    .set({ name: after.name, is_active: after.isActive, updated_at: sql<Date>`now()`, version: sql<number>`version + 1` })
    .where('id', '=', id)
    .returning(columns)
    .executeTakeFirstOrThrow()
  await recordAudit(trx, context, {
    action: 'warehouse.updated',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'warehouse', id },
    warehouseId: id,
    details: { changed }
  })
  return row
}
