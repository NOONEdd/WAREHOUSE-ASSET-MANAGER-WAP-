import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { actorFrom } from '../../admin/rules.js'
import { createUser, endUserSessions, getUser, issueUserSetupCode, listUsers, setUserAccess, updateUser } from '../../admin/users.js'
import { USERNAME_PATTERN } from '../../auth/passwordPolicy.js'
import type { Database } from '../../db/connection.js'
import { sendIdempotent } from '../idempotency.js'
import { auditContext } from '../requestContext.js'
import { idParams, positiveId, userDetailSchema, userListItemSchema, version } from './schemas.js'

// User administration for the owner's admin panel (decision O-09).
// Route-level permission first, then the escalation rules A1–A4 inside the
// services. Changes require an Idempotency-Key (decision D-05), except the
// setup-code endpoint, whose response is a secret that must never be stored
// (issuing again simply replaces the code).

const VIEW = { access: { kind: 'system', anyOf: ['user.view', 'user.manage'] } } as const
const MANAGE = { access: { kind: 'system', anyOf: ['user.manage'] } } as const

const displayName = { type: 'string', minLength: 1, maxLength: 200 } as const
const jobTitleId = { anyOf: [positiveId, { type: 'null' }] } as const

export function registerAdminUserRoutes(app: FastifyInstance, options: { readonly db: Kysely<Database> }): void {
  const { db } = options

  app.get(
    '/api/admin/users',
    {
      config: VIEW,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            search: { type: 'string', maxLength: 100 },
            after: { type: 'string', maxLength: 64 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
          },
          additionalProperties: false
        },
        response: {
          200: {
            type: 'object',
            properties: { users: { type: 'array', items: userListItemSchema }, nextAfter: { type: ['string', 'null'] } },
            required: ['users', 'nextAfter'],
            additionalProperties: false
          }
        }
      }
    },
    async (request) => {
      const query = request.query as { search?: string; after?: string; limit: number }
      return listUsers(db, query)
    }
  )

  app.get('/api/admin/users/:id', { config: VIEW, schema: { params: idParams, response: { 200: userDetailSchema } } }, async (request) =>
    getUser(db, (request.params as { id: number }).id)
  )

  app.post(
    '/api/admin/users',
    {
      config: MANAGE,
      schema: {
        body: {
          type: 'object',
          properties: { username: { type: 'string', pattern: USERNAME_PATTERN }, displayName, jobTitleId },
          required: ['username', 'displayName'],
          additionalProperties: false
        },
        response: { 201: userDetailSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const body = request.body as { username: string; displayName: string; jobTitleId?: number | null }
        const user = await createUser(trx, auditContext(request), actorFrom(request), { ...body, jobTitleId: body.jobTitleId ?? null })
        return { status: 201, body: user }
      })
  )

  app.patch(
    '/api/admin/users/:id',
    {
      config: MANAGE,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: { version, displayName, jobTitleId, status: { type: 'string', enum: ['active', 'disabled'] } },
          required: ['version'],
          additionalProperties: false
        },
        response: { 200: userDetailSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const { id } = request.params as { id: number }
        const body = request.body as { version: number; displayName?: string; jobTitleId?: number | null; status?: 'active' | 'disabled' }
        return { status: 200, body: await updateUser(trx, auditContext(request), actorFrom(request), id, body) }
      })
  )

  app.put(
    '/api/admin/users/:id/access',
    {
      config: MANAGE,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: {
            version,
            systemProfileIds: { type: 'array', items: positiveId, maxItems: 50 },
            warehouseAssignments: {
              type: 'array',
              maxItems: 2000,
              items: {
                type: 'object',
                properties: { warehouseId: positiveId, profileId: positiveId },
                required: ['warehouseId', 'profileId'],
                additionalProperties: false
              }
            }
          },
          required: ['version', 'systemProfileIds', 'warehouseAssignments'],
          additionalProperties: false
        },
        response: { 200: userDetailSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const { id } = request.params as { id: number }
        const body = request.body as {
          version: number
          systemProfileIds: number[]
          warehouseAssignments: { warehouseId: number; profileId: number }[]
        }
        return { status: 200, body: await setUserAccess(trx, auditContext(request), actorFrom(request), id, body) }
      })
  )

  app.post(
    '/api/admin/users/:id/setup-code',
    {
      config: MANAGE,
      schema: {
        params: idParams,
        response: {
          200: {
            type: 'object',
            properties: { setupCode: { type: 'string' }, expiresInHours: { type: 'integer' } },
            required: ['setupCode', 'expiresInHours'],
            additionalProperties: false
          }
        }
      }
    },
    async (request) => {
      const { id } = request.params as { id: number }
      return db.transaction().execute((trx) => issueUserSetupCode(trx, auditContext(request), actorFrom(request), id))
    }
  )

  app.post(
    '/api/admin/users/:id/end-sessions',
    {
      config: MANAGE,
      schema: {
        params: idParams,
        response: {
          200: { type: 'object', properties: { ended: { type: 'integer' } }, required: ['ended'], additionalProperties: false }
        }
      }
    },
    async (request) => {
      const { id } = request.params as { id: number }
      const ended = await db.transaction().execute((trx) => endUserSessions(trx, auditContext(request), actorFrom(request), id))
      return { ended }
    }
  )
}
