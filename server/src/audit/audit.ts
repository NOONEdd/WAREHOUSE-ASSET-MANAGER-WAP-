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
// From 1B-2c also recovery codes and otpauth links (authenticator secrets are
// covered by "secret"); counts such as "recoveryCodesRemaining" and business
// codes such as a warehouse "code" stay allowed.
const FORBIDDEN_KEY = /pass(word)?|secret|token|setup_?code|code_?hash|cookie|otpauth|recovery_?codes?$/i

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

function auditRow(context: AuditContext, event: AuditEvent) {
  const details = event.details ?? {}
  assertNoSecrets(details, 'details')
  return {
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
  }
}

export async function recordAudit(db: Kysely<Database>, context: AuditContext, event: AuditEvent): Promise<void> {
  await db.insertInto('audit_events').values(auditRow(context, event)).execute()
}

/** Several events of one request, in order, a few hundred per statement (an import commit writes one per row). */
export async function recordAuditEvents(db: Kysely<Database>, context: AuditContext, events: readonly AuditEvent[]): Promise<void> {
  const rows = events.map((event) => auditRow(context, event))
  for (let start = 0; start < rows.length; start += 500) {
    await db.insertInto('audit_events').values(rows.slice(start, start + 500)).execute()
  }
}
