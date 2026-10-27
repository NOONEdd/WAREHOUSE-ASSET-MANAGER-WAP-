import type { Kysely } from 'kysely'
import type { Database } from '../db/connection.js'

// Reading the audit trail, newest first, with keyset pagination (stable and
// index-backed at any depth, unlike OFFSET).

export interface AuditEventView {
  readonly id: string
  readonly occurredAt: Date
  readonly actor: { readonly id: number | null; readonly username: string | null }
  readonly action: string
  readonly outcome: string
  readonly target: { readonly type: string; readonly id: string } | null
  readonly warehouseId: number | null
  readonly requestId: string | null
  readonly sourceIp: string | null
  readonly details: Record<string, unknown>
}

export interface AuditFilter {
  /** Only events of this warehouse (warehouse-scoped readers always set it). */
  readonly warehouseId?: number | undefined
  readonly action?: string | undefined
  readonly actorUserId?: number | undefined
  readonly targetType?: string | undefined
  readonly targetId?: string | undefined
  /** Return events older than this id (from the previous page's `nextBefore`). */
  readonly before?: string | undefined
  readonly limit: number
}

export async function listAuditEvents(
  db: Kysely<Database>,
  filter: AuditFilter
): Promise<{ readonly events: AuditEventView[]; readonly nextBefore: string | null }> {
  const rows = await auditEventsQuery(db, filter).execute()
  const page = rows.slice(0, filter.limit)
  return {
    events: page.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      actor: { id: r.actor_user_id, username: r.actor_username },
      action: r.action,
      outcome: r.outcome,
      target: r.target_type === null || r.target_id === null ? null : { type: r.target_type, id: r.target_id },
      warehouseId: r.warehouse_id,
      requestId: r.request_id,
      sourceIp: r.source_ip,
      details: r.details
    })),
    nextBefore: rows.length > filter.limit ? (page.at(-1)?.id ?? null) : null
  }
}

/** One page (plus one row, to know whether more exist); exported so the performance check can EXPLAIN it. */
export function auditEventsQuery(db: Kysely<Database>, filter: AuditFilter) {
  return db
    .selectFrom('audit_events')
    .selectAll()
    .$if(filter.warehouseId !== undefined, (q) => q.where('warehouse_id', '=', filter.warehouseId ?? -1))
    .$if(filter.action !== undefined, (q) => q.where('action', '=', filter.action ?? ''))
    .$if(filter.actorUserId !== undefined, (q) => q.where('actor_user_id', '=', filter.actorUserId ?? -1))
    .$if(filter.targetType !== undefined, (q) => q.where('target_type', '=', filter.targetType ?? ''))
    .$if(filter.targetId !== undefined, (q) => q.where('target_id', '=', filter.targetId ?? ''))
    .$if(filter.before !== undefined, (q) => q.where('id', '<', filter.before ?? '0'))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
}
