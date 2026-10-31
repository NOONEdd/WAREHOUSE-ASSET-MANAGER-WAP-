import { sql, type Kysely } from 'kysely'
import { auditActor, type Actor } from '../admin/rules.js'
import { AppError } from '../appError.js'
import { recordAudit, type AuditContext } from '../audit/audit.js'
import type { Database } from '../db/connection.js'
import { mapAssetDbErrors } from './dbErrors.js'

// People without WAM accounts (decision PD-05, option C; migration 0006). Each belongs to the warehouse
// that registered them (row-level security). History and audit refer to them by id only: audit events
// here never contain a name, so erasing the name in this one row removes it everywhere. Erasure is
// one-way and needs person.erase (route check; the database checks it again against the actor).
// Every function runs inside a transaction whose data context is set to the warehouse.

export interface Person {
  readonly id: number
  readonly displayName: string | null
  readonly erased: boolean
  readonly version: number
}

interface Row {
  id: string
  display_name: string | null
  erased_at: Date | null
  version: number
}

function toPerson(row: Row): Person {
  return { id: Number(row.id), displayName: row.display_name, erased: row.erased_at !== null, version: row.version }
}

export interface PersonFilter {
  readonly q?: string | undefined
  readonly after?: number | undefined
  readonly limit: number
}

export async function listPersons(trx: Kysely<Database>, warehouseId: number, filter: PersonFilter): Promise<Person[]> {
  const q = filter.q?.trim() ?? ''
  const { rows } = await sql<Row>`
    SELECT id, display_name, erased_at, version FROM wam.persons
     WHERE warehouse_id = ${warehouseId}
       AND id > ${filter.after ?? 0}
       AND (${q} = '' OR strpos(display_name_key, wam.name_key(${q})) > 0)
     ORDER BY id
     LIMIT ${filter.limit}`.execute(trx)
  return rows.map(toPerson)
}

async function findPerson(trx: Kysely<Database>, warehouseId: number, personId: number): Promise<Row> {
  const { rows } = await sql<Row>`
    SELECT id, display_name, erased_at, version FROM wam.persons
     WHERE id = ${personId} AND warehouse_id = ${warehouseId} FOR UPDATE`.execute(trx)
  const row = rows[0]
  if (row === undefined) throw new AppError('NOT_FOUND')
  return row
}

export async function createPerson(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  warehouseId: number,
  displayName: string
): Promise<Person> {
  const row = await mapAssetDbErrors(async () => {
    const { rows } = await sql<Row>`
      INSERT INTO wam.persons (warehouse_id, display_name) VALUES (${warehouseId}, ${displayName.trim()})
      RETURNING id, display_name, erased_at, version`.execute(trx)
    return rows[0]
  })
  if (row === undefined) throw new Error('insert returned no row')
  await recordAudit(trx, context, {
    action: 'person.created',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'person', id: row.id },
    warehouseId
  })
  return toPerson(row)
}

export async function renamePerson(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  warehouseId: number,
  personId: number,
  input: { readonly version: number; readonly displayName: string }
): Promise<Person> {
  const current = await findPerson(trx, warehouseId, personId)
  if (current.erased_at !== null) throw new AppError('PERSON_ERASED')
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT', { currentVersion: current.version })
  const name = input.displayName.trim()
  if (name === current.display_name) return toPerson(current)
  const row = await mapAssetDbErrors(async () => {
    const { rows } = await sql<Row>`
      UPDATE wam.persons SET display_name = ${name} WHERE id = ${personId} AND version = ${input.version}
      RETURNING id, display_name, erased_at, version`.execute(trx)
    return rows[0]
  })
  if (row === undefined) throw new AppError('VERSION_CONFLICT')
  // The name itself is never written to the audit trail (PD-05).
  await recordAudit(trx, context, {
    action: 'person.renamed',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'person', id: personId },
    warehouseId,
    details: { changed: ['displayName'] }
  })
  return toPerson(row)
}

export async function erasePerson(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  warehouseId: number,
  personId: number,
  input: { readonly version: number }
): Promise<Person> {
  const current = await findPerson(trx, warehouseId, personId)
  if (current.erased_at !== null) throw new AppError('PERSON_ERASED')
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT', { currentVersion: current.version })
  let row: Row | undefined
  try {
    const { rows } = await sql<Row>`
      UPDATE wam.persons SET display_name = NULL, erased_at = now() WHERE id = ${personId} AND version = ${input.version}
      RETURNING id, display_name, erased_at, version`.execute(trx)
    row = rows[0]
  } catch (err) {
    // Second layer: the database refuses an actor without person.erase.
    if ((err as { code?: unknown }).code === '42501') throw new AppError('FORBIDDEN')
    throw err
  }
  if (row === undefined) throw new AppError('VERSION_CONFLICT')
  await recordAudit(trx, context, {
    action: 'person.erased',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'person', id: personId },
    warehouseId
  })
  return toPerson(row)
}

/** A person chosen for a handover must exist in this warehouse and not be erased. */
export async function assertSelectablePerson(trx: Kysely<Database>, warehouseId: number, personId: number): Promise<void> {
  const { rows } = await sql<{ erased: boolean }>`
    SELECT erased_at IS NOT NULL AS erased FROM wam.persons WHERE id = ${personId} AND warehouse_id = ${warehouseId}`.execute(trx)
  const row = rows[0]
  if (row === undefined) throw new AppError('VALIDATION_FAILED', { field: 'person', reason: 'unknown' })
  if (row.erased) throw new AppError('PERSON_ERASED')
}
