import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { listAuditEvents, type AuditFilter } from '../../admin/auditQuery.js'
import {
  createJobTitle,
  createProfile,
  deleteProfile,
  listJobTitles,
  listProfiles,
  updateJobTitle,
  updateProfile
} from '../../admin/profiles.js'
import { actorFrom } from '../../admin/rules.js'
import { createWarehouse, listWarehouses, updateWarehouse, WAREHOUSE_CODE_PATTERN } from '../../admin/warehouses.js'
import type { PermissionScope } from '../../access/permissions.js'
import type { Database } from '../../db/connection.js'
import { routeIntegerParam } from '../authorization.js'
import { sendIdempotent } from '../idempotency.js'
import { auditContext } from '../requestContext.js'
import {
  auditEventsResponseSchema,
  auditQuerySchema,
  descriptionText,
  idParams,
  jobTitleSchema,
  nameText,
  profileSchema,
  version,
  warehouseSchema
} from './schemas.js'

// Permission profiles, the permission catalogue, job titles, warehouses and
// the audit trail. Escalation rules A1 and A5 apply inside the profile
// services; changes need an Idempotency-Key (decision D-05).

const READ_ACCESS_DATA = { access: { kind: 'system', anyOf: ['user.view', 'user.manage', 'profile.manage'] } } as const
const MANAGE_PROFILES = { access: { kind: 'system', anyOf: ['profile.manage'] } } as const
const READ_JOB_TITLES = { access: { kind: 'system', anyOf: ['user.view', 'user.manage', 'job_title.manage'] } } as const
const MANAGE_JOB_TITLES = { access: { kind: 'system', anyOf: ['job_title.manage'] } } as const
const READ_WAREHOUSES = { access: { kind: 'system', anyOf: ['warehouse.manage', 'user.view', 'user.manage'] } } as const
const MANAGE_WAREHOUSES = { access: { kind: 'system', anyOf: ['warehouse.manage'] } } as const
const READ_ALL_AUDIT = { access: { kind: 'system', anyOf: ['audit.view_all'] } } as const
const READ_WAREHOUSE_AUDIT = { access: { kind: 'warehouse', permission: 'audit.view', param: 'warehouseId' } } as const

const permissionList = { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 100 } as const

export function registerAdminCatalogRoutes(app: FastifyInstance, options: { readonly db: Kysely<Database> }): void {
  const { db } = options

  // --- permission catalogue ---------------------------------------------------
  app.get(
    '/api/admin/permissions',
    {
      config: READ_ACCESS_DATA,
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              permissions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { code: { type: 'string' }, scope: { type: 'string' }, description: { type: 'string' } },
                  required: ['code', 'scope', 'description'],
                  additionalProperties: false
                }
              }
            },
            required: ['permissions'],
            additionalProperties: false
          }
        }
      }
    },
    async () => ({ permissions: await db.selectFrom('permissions').select(['code', 'scope', 'description']).orderBy('scope').orderBy('code').execute() })
  )

  // --- profiles -------------------------------------------------------------
  app.get(
    '/api/admin/profiles',
    {
      config: READ_ACCESS_DATA,
      schema: {
        querystring: {
          type: 'object',
          properties: { scope: { type: 'string', enum: ['system', 'warehouse'] } },
          additionalProperties: false
        },
        response: {
          200: { type: 'object', properties: { profiles: { type: 'array', items: profileSchema } }, required: ['profiles'], additionalProperties: false }
        }
      }
    },
    async (request) => ({ profiles: await listProfiles(db, (request.query as { scope?: PermissionScope }).scope) })
  )

  app.post(
    '/api/admin/profiles',
    {
      config: MANAGE_PROFILES,
      schema: {
        body: {
          type: 'object',
          properties: {
            name: nameText,
            description: descriptionText,
            scope: { type: 'string', enum: ['system', 'warehouse'] },
            permissions: permissionList
          },
          required: ['name', 'scope', 'permissions'],
          additionalProperties: false
        },
        response: { 201: profileSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const body = request.body as { name: string; description?: string; scope: PermissionScope; permissions: string[] }
        const profile = await createProfile(trx, auditContext(request), actorFrom(request), { ...body, description: body.description ?? '' })
        return { status: 201, body: profile }
      })
  )

  app.patch(
    '/api/admin/profiles/:id',
    {
      config: MANAGE_PROFILES,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: { version, name: nameText, description: descriptionText, isActive: { type: 'boolean' }, permissions: permissionList },
          required: ['version'],
          additionalProperties: false
        },
        response: { 200: profileSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const { id } = request.params as { id: number }
        const body = request.body as { version: number; name?: string; description?: string; isActive?: boolean; permissions?: string[] }
        return { status: 200, body: await updateProfile(trx, auditContext(request), actorFrom(request), id, body) }
      })
  )

  app.delete(
    '/api/admin/profiles/:id',
    {
      config: MANAGE_PROFILES,
      schema: {
        params: idParams,
        querystring: { type: 'object', properties: { version }, required: ['version'], additionalProperties: false }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const { id } = request.params as { id: number }
        await deleteProfile(trx, auditContext(request), actorFrom(request), id, (request.query as { version: number }).version)
        return { status: 204, body: null }
      })
  )

  // --- job titles -------------------------------------------------------------
  app.get(
    '/api/admin/job-titles',
    {
      config: READ_JOB_TITLES,
      schema: {
        response: {
          200: { type: 'object', properties: { jobTitles: { type: 'array', items: jobTitleSchema } }, required: ['jobTitles'], additionalProperties: false }
        }
      }
    },
    async () => ({ jobTitles: await listJobTitles(db) })
  )

  app.post(
    '/api/admin/job-titles',
    {
      config: MANAGE_JOB_TITLES,
      schema: {
        body: {
          type: 'object',
          properties: { name: nameText, description: descriptionText },
          required: ['name'],
          additionalProperties: false
        },
        response: { 201: jobTitleSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const body = request.body as { name: string; description?: string }
        const row = await createJobTitle(trx, auditContext(request), actorFrom(request), { name: body.name, description: body.description ?? '' })
        return { status: 201, body: row }
      })
  )

  app.patch(
    '/api/admin/job-titles/:id',
    {
      config: MANAGE_JOB_TITLES,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: { version, name: nameText, description: descriptionText, isActive: { type: 'boolean' } },
          required: ['version'],
          additionalProperties: false
        },
        response: { 200: jobTitleSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const { id } = request.params as { id: number }
        const body = request.body as { version: number; name?: string; description?: string; isActive?: boolean }
        return { status: 200, body: await updateJobTitle(trx, auditContext(request), actorFrom(request), id, body) }
      })
  )

  // --- warehouses -------------------------------------------------------------
  app.get(
    '/api/admin/warehouses',
    {
      config: READ_WAREHOUSES,
      schema: {
        response: {
          200: { type: 'object', properties: { warehouses: { type: 'array', items: warehouseSchema } }, required: ['warehouses'], additionalProperties: false }
        }
      }
    },
    async () => ({ warehouses: await listWarehouses(db) })
  )

  app.post(
    '/api/admin/warehouses',
    {
      config: MANAGE_WAREHOUSES,
      schema: {
        body: {
          type: 'object',
          properties: { code: { type: 'string', pattern: WAREHOUSE_CODE_PATTERN }, name: { type: 'string', minLength: 1, maxLength: 200 } },
          required: ['code', 'name'],
          additionalProperties: false
        },
        response: { 201: warehouseSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const body = request.body as { code: string; name: string }
        return { status: 201, body: await createWarehouse(trx, auditContext(request), actorFrom(request), body) }
      })
  )

  app.patch(
    '/api/admin/warehouses/:id',
    {
      config: MANAGE_WAREHOUSES,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: { version, name: { type: 'string', minLength: 1, maxLength: 200 }, isActive: { type: 'boolean' } },
          required: ['version'],
          additionalProperties: false
        },
        response: { 200: warehouseSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const { id } = request.params as { id: number }
        const body = request.body as { version: number; name?: string; isActive?: boolean }
        return { status: 200, body: await updateWarehouse(trx, auditContext(request), actorFrom(request), id, body) }
      })
  )

  // --- audit trail --------------------------------------------------------------
  app.get(
    '/api/admin/audit-events',
    { config: READ_ALL_AUDIT, schema: { querystring: auditQuerySchema, response: { 200: auditEventsResponseSchema } } },
    async (request) => listAuditEvents(db, request.query as AuditFilter)
  )

  // Warehouse-scoped: only that warehouse's events; any other warehouse,
  // or one that does not exist, is 404 (authorization.ts).
  app.get(
    '/api/warehouses/:warehouseId/audit-events',
    {
      config: READ_WAREHOUSE_AUDIT,
      schema: {
        params: {
          type: 'object',
          properties: { warehouseId: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } },
          required: ['warehouseId'],
          additionalProperties: false
        },
        querystring: auditQuerySchema,
        response: { 200: auditEventsResponseSchema }
      }
    },
    async (request) => {
      const warehouseId = routeIntegerParam(request, 'warehouseId') ?? -1
      return listAuditEvents(db, { ...(request.query as AuditFilter), warehouseId })
    }
  )
}
