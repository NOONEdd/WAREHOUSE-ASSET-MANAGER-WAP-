import type { FastifyRequest } from 'fastify'
import type { Access } from '../access/access.js'
import { AppError } from '../appError.js'
import type { AuditActor } from '../audit/audit.js'
import { authOf } from '../http/authorization.js'

// The escalation rules A1–A6 (docs/security/identity-and-access.md §2.3),
// applied by the admin services on top of the route-level permission check.
// The owner is exempt from all of them; for everyone else they hold even
// with every permission in the catalogue.

export interface Actor {
  readonly userId: number
  readonly username: string
  readonly access: Access
}

export function actorFrom(request: FastifyRequest): Actor {
  const { session, access } = authOf(request)
  return { userId: session.userId, username: session.username, access }
}

export function auditActor(actor: Actor): AuditActor {
  return { id: actor.userId, username: actor.username }
}

export interface ManagedUser {
  readonly id: number
  readonly isOwner: boolean
  /** Holds at least one system profile (active or not). */
  readonly isAdministrator: boolean
}

/** A2, A3, A4: may `actor` change anything about `target`? */
export function assertMayManageUser(actor: Actor, target: ManagedUser): void {
  if (actor.access.isOwner) return
  if (target.isOwner) throw new AppError('FORBIDDEN', { rule: 'A3', reason: 'only the owner manages the owner account' })
  if (target.id === actor.userId) throw new AppError('FORBIDDEN', { rule: 'A4', reason: 'you cannot change your own account here' })
  if (target.isAdministrator) throw new AppError('FORBIDDEN', { rule: 'A2', reason: 'only the owner manages administrators' })
}

/** A1: system profiles appoint administrators; only the owner touches them. */
export function assertMayManageSystemProfiles(actor: Actor): void {
  if (!actor.access.isOwner) throw new AppError('FORBIDDEN', { rule: 'A1', reason: 'only the owner manages administrator profiles' })
}
