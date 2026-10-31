import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { actorFrom } from '../../admin/rules.js'
import { CATALOG_KINDS, createCatalogEntry, listCatalog, updateCatalogEntry, type CatalogInput, type CatalogKind, type CatalogUpdate } from '../../catalog/catalog.js'
import type { Database } from '../../db/connection.js'
import { routeIntegerParam } from '../authorization.js'
import { sendIdempotent } from '../idempotency.js'
import { auditContext } from '../requestContext.js'
import { nameText, version } from './schemas.js'

// The global catalogue (PD-10): readable by anyone signed in, changed only with catalog.manage (PD-06).

const READ = { access: { kind: 'authenticated' } } as const
const MANAGE = { access: { kind: 'system', anyOf: ['catalog.manage'] } } as const

const kindParam = { type: 'string', enum: CATALOG_KINDS } as const
const entrySchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    isActive: { type: 'boolean' },
    version: { type: 'integer' },
    code: { type: ['string', 'null'] },
    isSystem: { type: 'boolean' },
    sortOrder: { type: 'integer' },
    isoCode: { type: ['string', 'null'] }
  },
  required: ['id', 'name', 'isActive', 'version'],
  additionalProperties: false
} as const
const sortOrder = { type: 'integer', minimum: 0, maximum: 10_000 } as const
const isoCode = { type: ['string', 'null'], pattern: '^[A-Z]{2}$' } as const

export function registerCatalogRoutes(app: FastifyInstance, options: { readonly db: Kysely<Database> }): void {
  const { db } = options

  app.get(
    '/api/catalog/:kind',
    {
      config: READ,
      schema: {
        params: { type: 'object', properties: { kind: kindParam }, required: ['kind'], additionalProperties: false },
        querystring: { type: 'object', properties: { includeInactive: { type: 'boolean' } }, additionalProperties: false },
        response: {
          200: { type: 'object', properties: { entries: { type: 'array', items: entrySchema } }, required: ['entries'], additionalProperties: false }
        }
      }
    },
    async (request) => {
      const { kind } = request.params as { kind: CatalogKind }
      const { includeInactive } = request.query as { includeInactive?: boolean }
      return { entries: await listCatalog(db, kind, includeInactive === true) }
    }
  )

  app.post(
    '/api/catalog/:kind',
    {
      config: MANAGE,
      schema: {
        params: { type: 'object', properties: { kind: kindParam }, required: ['kind'], additionalProperties: false },
        body: { type: 'object', properties: { name: nameText, sortOrder, isoCode }, required: ['name'], additionalProperties: false },
        response: { 201: entrySchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const { kind } = request.params as { kind: CatalogKind }
        const entry = await createCatalogEntry(trx, auditContext(request), actorFrom(request), kind, request.body as CatalogInput)
        return { status: 201, body: entry }
      })
  )

  app.patch(
    '/api/catalog/:kind/:id',
    {
      config: MANAGE,
      schema: {
        params: {
          type: 'object',
          properties: { kind: kindParam, id: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } },
          required: ['kind', 'id'],
          additionalProperties: false
        },
        body: {
          type: 'object',
          properties: { version, name: nameText, isActive: { type: 'boolean' }, sortOrder, isoCode },
          required: ['version'],
          minProperties: 2,
          additionalProperties: false
        },
        response: { 200: entrySchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const { kind } = request.params as { kind: CatalogKind }
        const id = routeIntegerParam(request, 'id') ?? -1
        const entry = await updateCatalogEntry(trx, auditContext(request), actorFrom(request), kind, id, request.body as CatalogUpdate)
        return { status: 200, body: entry }
      })
  )
}
