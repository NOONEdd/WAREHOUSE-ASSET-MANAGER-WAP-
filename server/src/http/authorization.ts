import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { hasSystemPermission, hasWarehousePermission, loadAccess, type Access } from '../access/access.js'
import type { SystemPermission, WarehousePermission } from '../access/permissions.js'
import { AppError } from '../appError.js'
import { findActiveSession, revokeSession, type ActiveSession, type SessionSettings } from '../auth/sessions.js'
import type { Database } from '../db/connection.js'
import { readCookie, type CookieSettings } from './cookies.js'
import { actorOf, auditDenial } from './requestContext.js'

// Server-side authorization for every route (docs/security/identity-and-access.md
// §2.4, §2.6; ASVS 5.0.0 V8.2.1, V8.3.1). Each route declares in its config
// who may call it; the check runs before the handler. A route without a
// declaration makes registration throw, so the server cannot start with an
// unguarded route.

export type RouteAccess =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'owner' }
  /** Any one of the listed system permissions. */
  | { readonly kind: 'system'; readonly anyOf: readonly SystemPermission[] }
  /** The permission in the warehouse whose id is the route parameter `param`. */
  | { readonly kind: 'warehouse'; readonly permission: WarehousePermission; readonly param: string }

export interface AuthContext {
  readonly session: ActiveSession
  readonly access: Access
}

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess
  }
  interface FastifyRequest {
    auth: AuthContext | null
  }
}

export interface AuthorizationOptions {
  readonly db: Kysely<Database>
  readonly sessions: SessionSettings
  readonly cookie: CookieSettings
}

/** Must be registered before any route. */
export function registerAuthorization(app: FastifyInstance, options: AuthorizationOptions): void {
  app.decorateRequest('auth', null)

  app.addHook('onRoute', (route) => {
    if (route.config?.access === undefined) {
      throw new Error(`route ${String(route.method)} ${route.url} has no access declaration (config.access)`)
    }
  })

  app.addHook('preHandler', async (request) => {
    const access = request.routeOptions.config.access
    // Unreachable for registered routes (onRoute above); the not-found
    // handler has no declaration and needs no session.
    if (access === undefined || access.kind === 'public') return

    const token = readCookie(request.headers.cookie, options.cookie.name)
    const session = token === null ? null : await findActiveSession(options.db, token, options.sessions)
    if (session === null) throw new AppError('UNAUTHENTICATED')
    // identity-and-access §3.2.1: an account that needs a second factor never
    // acts through a session established without one — for example after
    // being appointed administrator, or after the policy changed. The
    // session ends here, once, and the user signs in again.
    if (session.mfaRequired && !session.mfaVerified) {
      await revokeSession(options.db, session.sessionId, 'mfa_required')
      await auditDenial(options.db, request, {
        action: 'session.ended_mfa_required',
        outcome: 'denied',
        actor: { id: session.userId, username: session.username },
        target: { type: 'session', id: session.sessionId }
      })
      throw new AppError('MFA_REQUIRED')
    }
    request.auth = { session, access: await loadAccess(options.db, session.userId, session.isOwner) }

    if (await isAllowed(options.db, request, request.auth.access, access)) return
    await auditDenial(options.db, request, {
      action: 'authz.denied',
      outcome: 'denied',
      actor: actorOf(request),
      details: { route: `${request.method} ${request.routeOptions.url ?? ''}`, required: describe(access) }
    })
    // Missing warehouse access looks exactly like a missing warehouse.
    throw new AppError(access.kind === 'warehouse' ? 'NOT_FOUND' : 'FORBIDDEN')
  })
}

async function isAllowed(db: Kysely<Database>, request: FastifyRequest, access: Access, rule: RouteAccess): Promise<boolean> {
  switch (rule.kind) {
    case 'public':
    case 'authenticated':
      return true
    case 'owner':
      return access.isOwner
    case 'system':
      return rule.anyOf.some((permission) => hasSystemPermission(access, permission))
    case 'warehouse': {
      const warehouseId = routeIntegerParam(request, rule.param)
      return warehouseId !== null && (await hasWarehousePermission(db, access, rule.permission, warehouseId))
    }
  }
}

function describe(rule: RouteAccess): string {
  switch (rule.kind) {
    case 'public':
    case 'authenticated':
    case 'owner':
      return rule.kind
    case 'system':
      return rule.anyOf.join('|')
    case 'warehouse':
      return `${rule.permission}@:${rule.param}`
  }
}

/** A positive 32-bit integer route parameter, or null. */
export function routeIntegerParam(request: FastifyRequest, name: string): number | null {
  const raw = (request.params as Record<string, unknown> | undefined)?.[name]
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) return null
  const value = Number(raw)
  return value <= 2_147_483_647 ? value : null
}

/** The authenticated context; only valid in routes whose access is not `public`. */
export function authOf(request: FastifyRequest): AuthContext {
  if (request.auth === null) throw new AppError('UNAUTHENTICATED')
  return request.auth
}
