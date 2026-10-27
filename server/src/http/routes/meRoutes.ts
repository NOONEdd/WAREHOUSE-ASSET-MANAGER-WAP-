import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { SYSTEM_PERMISSIONS, WAREHOUSE_PERMISSIONS } from '../../access/permissions.js'
import { AppError } from '../../appError.js'
import { recordAudit } from '../../audit/audit.js'
import { verifyPassword } from '../../auth/passwords.js'
import { listUserSessions, revokeUserSessions, type SessionSettings } from '../../auth/sessions.js'
import { isLoginThrottled, recordFailure } from '../../auth/throttle.js'
import type { Database } from '../../db/connection.js'
import { authOf } from '../authorization.js'
import { actorOf, auditContext } from '../requestContext.js'

// The signed-in user's own view: who they are, what they may do where (the
// UI uses this to decide what to show — the server still checks every
// request), and their sessions (ASVS 5.0.0 V7.5.2).

const AUTHENTICATED = { access: { kind: 'authenticated' } } as const

const meSchema = {
  type: 'object',
  properties: {
    user: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        username: { type: 'string' },
        displayName: { type: 'string' },
        isOwner: { type: 'boolean' },
        jobTitle: { type: ['string', 'null'] }
      },
      required: ['id', 'username', 'displayName', 'isOwner', 'jobTitle'],
      additionalProperties: false
    },
    systemPermissions: { type: 'array', items: { type: 'string' } },
    warehouses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          code: { type: 'string' },
          name: { type: 'string' },
          isActive: { type: 'boolean' },
          permissions: { type: 'array', items: { type: 'string' } }
        },
        required: ['id', 'code', 'name', 'isActive', 'permissions'],
        additionalProperties: false
      }
    }
  },
  required: ['user', 'systemPermissions', 'warehouses'],
  additionalProperties: false
} as const

const sessionsSchema = {
  type: 'object',
  properties: {
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          current: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          lastSeenAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          sourceIp: { type: ['string', 'null'] },
          userAgent: { type: ['string', 'null'] }
        },
        required: ['id', 'current', 'createdAt', 'lastSeenAt', 'expiresAt', 'sourceIp', 'userAgent'],
        additionalProperties: false
      }
    }
  },
  required: ['sessions'],
  additionalProperties: false
} as const

export function registerMeRoutes(app: FastifyInstance, options: { readonly db: Kysely<Database>; readonly sessions: SessionSettings }): void {
  const { db } = options

  app.get('/api/me', { config: AUTHENTICATED, schema: { response: { 200: meSchema } } }, async (request) => {
    const { session, access } = authOf(request)
    const user = await db
      .selectFrom('users as u')
      .leftJoin('job_titles as j', 'j.id', 'u.job_title_id')
      .select(['u.id', 'u.username', 'u.display_name', 'u.is_owner', 'j.name as job_title'])
      .where('u.id', '=', session.userId)
      .executeTakeFirstOrThrow()

    const allWarehousePermissions = Object.keys(WAREHOUSE_PERMISSIONS)
    const visibleIds = [...access.warehouses.keys()]
    const warehouses =
      access.isOwner || visibleIds.length > 0
        ? await db
            .selectFrom('warehouses')
            .select(['id', 'code', 'name', 'is_active'])
            .$if(!access.isOwner, (q) => q.where('id', 'in', visibleIds))
            .orderBy('code')
            .execute()
        : []
    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        isOwner: user.is_owner,
        jobTitle: user.job_title
      },
      systemPermissions: access.isOwner ? Object.keys(SYSTEM_PERMISSIONS) : [...access.system].sort(),
      warehouses: warehouses.map((w) => ({
        id: w.id,
        code: w.code,
        name: w.name,
        isActive: w.is_active,
        permissions: access.isOwner ? allWarehousePermissions : [...(access.warehouses.get(w.id) ?? [])].sort()
      }))
    }
  })

  app.get('/api/me/sessions', { config: AUTHENTICATED, schema: { response: { 200: sessionsSchema } } }, async (request) => {
    const { session } = authOf(request)
    const rows = await listUserSessions(db, session.userId, options.sessions)
    return { sessions: rows.map((row) => ({ ...row, current: row.id === session.sessionId })) }
  })

  app.post(
    '/api/me/sessions/end-others',
    {
      config: AUTHENTICATED,
      schema: {
        body: {
          type: 'object',
          properties: { currentPassword: { type: 'string', minLength: 1, maxLength: 1024 } },
          required: ['currentPassword'],
          additionalProperties: false
        },
        response: {
          200: { type: 'object', properties: { ended: { type: 'integer' } }, required: ['ended'], additionalProperties: false }
        }
      }
    },
    async (request) => {
      const { currentPassword } = request.body as { currentPassword: string }
      const { session } = authOf(request)
      // ASVS V7.5.2: re-authenticate before ending sessions.
      if (await isLoginThrottled(db, session.username, request.ip)) throw new AppError('TOO_MANY_REQUESTS')
      const { password_hash: hash } = await db
        .selectFrom('users')
        .select('password_hash')
        .where('id', '=', session.userId)
        .executeTakeFirstOrThrow()
      if (hash === null || !(await verifyPassword(currentPassword, hash))) {
        await recordFailure(db, 'login', session.username, request.ip)
        throw new AppError('CURRENT_PASSWORD_INCORRECT')
      }
      const ended = await db.transaction().execute(async (trx) => {
        const count = await revokeUserSessions(trx, session.userId, 'user_revoked', session.sessionId)
        await recordAudit(trx, auditContext(request), {
          action: 'session.ended_others',
          outcome: 'success',
          actor: actorOf(request),
          target: { type: 'user', id: session.userId },
          details: { ended: count }
        })
        return count
      })
      return { ended }
    }
  )
}
