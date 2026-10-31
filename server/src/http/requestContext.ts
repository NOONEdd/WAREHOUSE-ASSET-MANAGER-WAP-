import type { FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { recordAudit, type AuditActor, type AuditContext, type AuditEvent } from '../audit/audit.js'
import type { Database } from '../db/connection.js'
import { safeErrorSummary } from '../logPrivacy.js'

// Small helpers shared by routes: the audit context and actor of a request.

/**
 * Records a refused request without letting an audit failure change the
 * outcome: the request is refused either way, and a failed write is logged
 * as an error (ASVS 5.0.0 V16.3.4). Changes are never audited this way —
 * their audit record is written in the change's own transaction.
 */
export async function auditDenial(db: Kysely<Database>, request: FastifyRequest, event: AuditEvent): Promise<void> {
  try {
    await recordAudit(db, auditContext(request), event)
  } catch (err) {
    request.log.error({ err: safeErrorSummary(err), action: event.action }, 'audit write failed for a refused request')
  }
}

export function auditContext(request: FastifyRequest): AuditContext {
  return { requestId: request.id, sourceIp: request.ip }
}

export function actorOf(request: FastifyRequest): AuditActor | null {
  const session = request.auth?.session
  return session === undefined ? null : { id: session.userId, username: session.username }
}

export function userAgentOf(request: FastifyRequest): string | null {
  const value = request.headers['user-agent']
  return typeof value === 'string' && value !== '' ? value : null
}
