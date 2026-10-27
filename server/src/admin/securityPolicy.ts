import { sql, type Kysely } from 'kysely'
import { AppError } from '../appError.js'
import { recordAudit, type AuditContext } from '../audit/audit.js'
import type { Database, MfaRequiredFor } from '../db/connection.js'
import { auditActor, type Actor } from './rules.js'

// The security policy (docs/security/identity-and-access.md §3.2.1;
// decision O-07). Owner only (route access). Its single setting decides who
// beyond the owner and administrators must use a second factor; no value
// makes it optional for them (database CHECK). A change takes effect at the
// next request of every session (src/http/authorization.ts).

export interface SecurityPolicy {
  readonly mfaRequiredFor: MfaRequiredFor
  readonly updatedAt: Date
  readonly version: number
}

export async function getSecurityPolicy(db: Kysely<Database>): Promise<SecurityPolicy> {
  const row = await db.selectFrom('security_policy').select(['mfa_required_for', 'updated_at', 'version']).executeTakeFirstOrThrow()
  return { mfaRequiredFor: row.mfa_required_for, updatedAt: row.updated_at, version: row.version }
}

export async function updateSecurityPolicy(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  input: { readonly version: number; readonly mfaRequiredFor: MfaRequiredFor }
): Promise<SecurityPolicy> {
  const current = await trx.selectFrom('security_policy').select(['mfa_required_for', 'version']).forUpdate().executeTakeFirstOrThrow()
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT', { currentVersion: current.version })
  if (current.mfa_required_for === input.mfaRequiredFor) return getSecurityPolicy(trx)
  await trx
    .updateTable('security_policy')
    .set({
      mfa_required_for: input.mfaRequiredFor,
      updated_by: actor.userId,
      updated_at: sql<Date>`now()`,
      version: sql<number>`version + 1`
    })
    .execute()
  await recordAudit(trx, context, {
    action: 'security_policy.updated',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'security_policy', id: 'mfa_required_for' },
    details: { changed: { mfaRequiredFor: { before: current.mfa_required_for, after: input.mfaRequiredFor } } }
  })
  return getSecurityPolicy(trx)
}
