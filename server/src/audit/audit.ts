import type { Kysely } from 'kysely'
import type { Database } from '../db/connection.js'

// The audit trail (docs/security/identity-and-access.md §7). Writes only:
// the table is append-only for every role. Pass the transaction (`trx`) of
// the change being audited, so the change and its record commit or roll
// back together.

export type AuditOutcome = 'success' | 'denied' | 'failure'

export interface AuditActor {
  readonly id: number
  readonly username: string
}

export interface AuditContext {
  readonly requestId: string | null
  readonly sourceIp: string | null
}

export interface AuditEvent {
  readonly action: string
  readonly outcome: AuditOutcome
  readonly actor: AuditActor | null
  readonly target?: { readonly type: string; readonly id: string | number } | undefined
  readonly warehouseId?: number | null | undefined
  readonly details?: Readonly<Record<string, unknown>> | undefined
}

// Never stored, at any depth: a defect that tried would fail loudly here
// instead of leaking a secret into a permanent record (ASVS V16.2.5).
const FORBIDDEN_KEY = /pass(word)?|secret|token|setup_?code|code_?hash|cookie/i

function assertNoSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertNoSecrets(item, `${path}[${String(i)}]`)
    })
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) throw new Error(`audit details must not contain "${path}.${key}"`)
      assertNoSecrets(inner, `${path}.${key}`)
    }
  }
}

export async function recordAudit(db: Kysely<Database>, context: AuditContext, event: AuditEvent): Promise<void> {
  const details = event.details ?? {}
  assertNoSecrets(details, 'details')
  await db
    .insertInto('audit_events')
    .values({
      action: event.action,
      outcome: event.outcome,
      actor_user_id: event.actor?.id ?? null,
      actor_username: event.actor?.username ?? null,
      target_type: event.target?.type ?? null,
      target_id: event.target === undefined ? null : String(event.target.id),
      warehouse_id: event.warehouseId ?? null,
      request_id: context.requestId,
      source_ip: context.sourceIp,
      details: JSON.stringify(details)
    })
    .execute()
}
