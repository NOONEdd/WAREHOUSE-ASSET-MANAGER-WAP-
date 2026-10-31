import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './connection.js'

// The request context the asset schema reads (docs/architecture/asset-schema-proposal.md §5.2), set with
// set_config(…, true) inside the request's own transaction, so it ends with that transaction and never
// carries over to the next user of a pooled connection. The database trusts these values (proposal
// §5.1): the warehouse scope must be exactly what the route's permission check allowed, and the actor
// the signed-in user. Without a scope, asset, person and import tables show and accept nothing.

export interface DataContext {
  /** Warehouses this request may touch; normally exactly the route's warehouse. */
  readonly warehouseIds: readonly number[]
  /** The signed-in user; required by the database for every change. */
  readonly actorUserId: number | null
  readonly requestId: string | null
  /** Optional reason, copied into history rows. */
  readonly reason?: string | null
}

function scopeText(ids: readonly number[]): string {
  for (const id of ids) if (!Number.isSafeInteger(id) || id < 1) throw new Error('invalid warehouse id in data context')
  return ids.join(',')
}

export async function setDataContext(trx: Kysely<Database>, context: DataContext): Promise<void> {
  await sql`SELECT set_config('wam.warehouse_scope', ${scopeText(context.warehouseIds)}, true),
                   set_config('wam.actor_user_id', ${context.actorUserId === null ? '' : String(context.actorUserId)}, true),
                   set_config('wam.request_id', ${context.requestId ?? ''}, true),
                   set_config('wam.change_reason', ${context.reason ?? ''}, true),
                   set_config('wam.import_row_id', '', true)`.execute(trx)
}

/** During an import commit: the row whose asset operation comes next (empty for none). */
export async function setImportRow(trx: Kysely<Database>, rowId: string | null): Promise<void> {
  await sql`SELECT set_config('wam.import_row_id', ${rowId ?? ''}, true)`.execute(trx)
}

/** The reason copied into the history rows of the next asset changes in this transaction. */
export async function setChangeReason(trx: Kysely<Database>, reason: string | null): Promise<void> {
  await sql`SELECT set_config('wam.change_reason', ${reason ?? ''}, true)`.execute(trx)
}

/** Runs `fn` in a new transaction with the context set (reads; writes use the idempotent transaction). */
export function inDataContext<T>(db: Kysely<Database>, context: DataContext, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await setDataContext(trx, context)
    return fn(trx)
  })
}
