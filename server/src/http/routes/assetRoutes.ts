import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { actorFrom } from '../../admin/rules.js'
import {
  changeAssetStatus,
  countAssets,
  createAsset,
  editAsset,
  getAsset,
  getAssetHistory,
  listAssets,
  type AssetFields,
  type Party
} from '../../assets/assets.js'
import { createPerson, erasePerson, listPersons, renamePerson } from '../../assets/persons.js'
import type { Database } from '../../db/connection.js'
import { inDataContext, setDataContext, type DataContext } from '../../db/dataContext.js'
import { authOf, routeIntegerParam } from '../authorization.js'
import { sendIdempotent } from '../idempotency.js'
import { auditContext } from '../requestContext.js'
import { positiveId, version } from './schemas.js'

// Assets and the person register of one warehouse (Phase 1B-3, decision O-16). The route's warehouse
// permission is checked first (missing access answers 404, like a missing warehouse); every handler
// then runs in a transaction whose data context is exactly that warehouse, the signed-in user and the
// request ID, so row-level security confines every query to it as a second layer. Changes need an
// Idempotency-Key (D-05) and the record's version (optimistic concurrency).

const ID = { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } as const
const warehouseParams = { type: 'object', properties: { warehouseId: ID }, required: ['warehouseId'], additionalProperties: false } as const
const assetParams = {
  type: 'object',
  properties: { warehouseId: ID, assetId: ID },
  required: ['warehouseId', 'assetId'],
  additionalProperties: false
} as const
const personParams = {
  type: 'object',
  properties: { warehouseId: ID, personId: ID },
  required: ['warehouseId', 'personId'],
  additionalProperties: false
} as const

const access = (permission: 'asset.view' | 'asset.create' | 'asset.edit' | 'asset.change_status') =>
  ({ access: { kind: 'warehouse', permission, param: 'warehouseId' } }) as const
const ERASE = { access: { kind: 'system', anyOf: ['person.erase'] } } as const

const date = { type: ['string', 'null'], pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' } as const
const text = (max: number) => ({ type: ['string', 'null'], maxLength: max }) as const
const partyInput = {
  anyOf: [
    { type: 'null' },
    { type: 'object', properties: { userId: positiveId }, required: ['userId'], additionalProperties: false },
    { type: 'object', properties: { personId: positiveId }, required: ['personId'], additionalProperties: false }
  ]
} as const
const partyOutput = {
  anyOf: [
    { type: 'null' },
    { type: 'object', properties: { userId: { type: 'integer' } }, required: ['userId'], additionalProperties: false },
    { type: 'object', properties: { personId: { type: 'integer' } }, required: ['personId'], additionalProperties: false }
  ]
} as const

const editableFields = {
  assetCode: { type: 'string', minLength: 1, maxLength: 100 },
  name: { type: 'string', minLength: 1, maxLength: 300 },
  itemTypeId: positiveId,
  model: text(200),
  serialNumber: { type: ['string', 'null'], minLength: 1, maxLength: 100 },
  countryId: { type: ['integer', 'null'], minimum: 1, maximum: 2_147_483_647 },
  workshopId: { type: ['integer', 'null'], minimum: 1, maximum: 2_147_483_647 },
  entryDate: date,
  exitDate: date,
  deliveredBy: partyInput,
  receivedBy: partyInput,
  notes: text(2000)
} as const

const assetSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    warehouseId: { type: 'integer' },
    assetCode: { type: 'string' },
    name: { type: 'string' },
    itemTypeId: { type: 'integer' },
    model: { type: ['string', 'null'] },
    serialNumber: { type: ['string', 'null'] },
    countryId: { type: ['integer', 'null'] },
    workshopId: { type: ['integer', 'null'] },
    statusId: { type: 'integer' },
    entryDate: { type: ['string', 'null'] },
    exitDate: { type: ['string', 'null'] },
    deliveredBy: partyOutput,
    receivedBy: partyOutput,
    notes: { type: ['string', 'null'] },
    origin: { type: 'string' },
    originImportRowId: { type: ['integer', 'null'] },
    createdAt: { type: 'string' },
    createdBy: { type: 'integer' },
    updatedAt: { type: 'string' },
    updatedBy: { type: 'integer' },
    version: { type: 'integer' }
  },
  required: ['id', 'warehouseId', 'assetCode', 'name', 'itemTypeId', 'statusId', 'origin', 'version'],
  additionalProperties: false
} as const

const duplicatesSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: { id: { type: 'integer' }, assetCode: { type: 'string' } },
    required: ['id', 'assetCode'],
    additionalProperties: false
  }
} as const

const assetWithDuplicates = {
  type: 'object',
  properties: { asset: assetSchema, suspectedDuplicates: duplicatesSchema },
  required: ['asset', 'suspectedDuplicates'],
  additionalProperties: false
} as const

const personSchema = {
  type: 'object',
  properties: { id: { type: 'integer' }, displayName: { type: ['string', 'null'] }, erased: { type: 'boolean' }, version: { type: 'integer' } },
  required: ['id', 'displayName', 'erased', 'version'],
  additionalProperties: false
} as const

const filterQuery = {
  q: { type: 'string', maxLength: 100 },
  statusId: positiveId,
  itemTypeId: positiveId
} as const

interface FilterQuery {
  q?: string
  statusId?: number
  itemTypeId?: number
  after?: number
  limit?: number
}

function param(request: FastifyRequest, name: string): number {
  return routeIntegerParam(request, name) ?? -1
}

/** Exactly the route's warehouse (already authorized), the signed-in user and this request. */
export function warehouseContext(request: FastifyRequest, warehouseId: number): DataContext {
  return { warehouseIds: [warehouseId], actorUserId: authOf(request).session.userId, requestId: request.id }
}

export function registerAssetRoutes(app: FastifyInstance, options: { readonly db: Kysely<Database> }): void {
  const { db } = options
  const base = '/api/warehouses/:warehouseId'

  // --- assets ---------------------------------------------------------------------------------------
  app.get(
    `${base}/assets`,
    {
      config: access('asset.view'),
      schema: {
        params: warehouseParams,
        querystring: {
          type: 'object',
          properties: { ...filterQuery, after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
          additionalProperties: false
        },
        response: {
          200: {
            type: 'object',
            properties: { assets: { type: 'array', items: assetSchema }, nextAfter: { type: ['integer', 'null'] } },
            required: ['assets', 'nextAfter'],
            additionalProperties: false
          }
        }
      }
    },
    (request) => {
      const warehouseId = param(request, 'warehouseId')
      const query = request.query as FilterQuery
      return inDataContext(db, warehouseContext(request, warehouseId), (trx) =>
        listAssets(trx, warehouseId, { ...query, limit: query.limit ?? 50 })
      )
    }
  )

  app.get(
    `${base}/assets/count`,
    {
      config: access('asset.view'),
      schema: {
        params: warehouseParams,
        querystring: { type: 'object', properties: filterQuery, additionalProperties: false },
        response: { 200: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }
      }
    },
    async (request) => {
      const warehouseId = param(request, 'warehouseId')
      const count = await inDataContext(db, warehouseContext(request, warehouseId), (trx) =>
        countAssets(trx, warehouseId, request.query as FilterQuery)
      )
      return { count }
    }
  )

  app.get(
    `${base}/assets/:assetId`,
    { config: access('asset.view'), schema: { params: assetParams, response: { 200: assetSchema } } },
    (request) => {
      const warehouseId = param(request, 'warehouseId')
      return inDataContext(db, warehouseContext(request, warehouseId), (trx) => getAsset(trx, warehouseId, param(request, 'assetId')))
    }
  )

  app.get(
    `${base}/assets/:assetId/history`,
    {
      config: access('asset.view'),
      schema: {
        params: assetParams,
        response: {
          200: {
            type: 'object',
            properties: {
              statusChanges: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    fromStatusId: { type: ['integer', 'null'] },
                    toStatusId: { type: 'integer' },
                    changedAt: { type: 'string' },
                    changedBy: { type: 'integer' },
                    reason: { type: ['string', 'null'] },
                    deliveredBy: partyOutput,
                    receivedBy: partyOutput,
                    importRowId: { type: ['integer', 'null'] }
                  },
                  additionalProperties: false
                }
              },
              moves: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    fromWarehouseId: { type: ['integer', 'null'] },
                    toWarehouseId: { type: 'integer' },
                    changedAt: { type: 'string' },
                    changedBy: { type: 'integer' },
                    reason: { type: ['string', 'null'] }
                  },
                  additionalProperties: false
                }
              }
            },
            required: ['statusChanges', 'moves'],
            additionalProperties: false
          }
        }
      }
    },
    (request) => {
      const warehouseId = param(request, 'warehouseId')
      return inDataContext(db, warehouseContext(request, warehouseId), (trx) => getAssetHistory(trx, warehouseId, param(request, 'assetId')))
    }
  )

  app.post(
    `${base}/assets`,
    {
      config: access('asset.create'),
      schema: {
        params: warehouseParams,
        body: {
          type: 'object',
          properties: { ...editableFields, statusId: positiveId },
          required: ['assetCode', 'name', 'itemTypeId', 'statusId'],
          additionalProperties: false
        },
        response: { 201: assetWithDuplicates }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const warehouseId = param(request, 'warehouseId')
        await setDataContext(trx, warehouseContext(request, warehouseId))
        const body = request.body as Partial<AssetFields> & { assetCode: string; name: string; itemTypeId: number; statusId: number }
        const input = {
          model: null,
          serialNumber: null,
          countryId: null,
          workshopId: null,
          entryDate: null,
          exitDate: null,
          deliveredBy: null,
          receivedBy: null,
          notes: null,
          ...body
        }
        return { status: 201, body: await createAsset(trx, auditContext(request), actorFrom(request), warehouseId, input) }
      })
  )

  app.patch(
    `${base}/assets/:assetId`,
    {
      config: access('asset.edit'),
      schema: {
        params: assetParams,
        body: {
          type: 'object',
          properties: { version, ...editableFields, assetCode: { type: ['string', 'null'], minLength: 1, maxLength: 100 }, name: { type: ['string', 'null'], minLength: 1, maxLength: 300 }, itemTypeId: { type: ['integer', 'null'], minimum: 1, maximum: 2_147_483_647 } },
          required: ['version'],
          minProperties: 2,
          additionalProperties: false
        },
        response: { 200: assetWithDuplicates }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const warehouseId = param(request, 'warehouseId')
        await setDataContext(trx, warehouseContext(request, warehouseId))
        const { version: expected, ...changes } = request.body as { version: number } & Partial<AssetFields>
        const result = await editAsset(trx, auditContext(request), actorFrom(request), warehouseId, param(request, 'assetId'), {
          version: expected,
          changes
        })
        return { status: 200, body: result }
      })
  )

  app.post(
    `${base}/assets/:assetId/status`,
    {
      config: access('asset.change_status'),
      schema: {
        params: assetParams,
        body: {
          type: 'object',
          properties: { version, statusId: positiveId, reason: text(500), deliveredBy: partyInput, receivedBy: partyInput },
          required: ['version', 'statusId'],
          additionalProperties: false
        },
        response: { 200: assetSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const warehouseId = param(request, 'warehouseId')
        await setDataContext(trx, warehouseContext(request, warehouseId))
        const body = request.body as { version: number; statusId: number; reason?: string | null; deliveredBy?: Party | null; receivedBy?: Party | null }
        const asset = await changeAssetStatus(trx, auditContext(request), actorFrom(request), warehouseId, param(request, 'assetId'), body)
        return { status: 200, body: asset }
      })
  )

  // --- persons without WAM accounts (PD-05) -------------------------------------------------------------
  app.get(
    `${base}/persons`,
    {
      config: access('asset.view'),
      schema: {
        params: warehouseParams,
        querystring: {
          type: 'object',
          properties: { q: { type: 'string', maxLength: 100 }, after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
          additionalProperties: false
        },
        response: {
          200: { type: 'object', properties: { persons: { type: 'array', items: personSchema } }, required: ['persons'], additionalProperties: false }
        }
      }
    },
    async (request) => {
      const warehouseId = param(request, 'warehouseId')
      const query = request.query as { q?: string; after?: number; limit?: number }
      const persons = await inDataContext(db, warehouseContext(request, warehouseId), (trx) =>
        listPersons(trx, warehouseId, { ...query, limit: query.limit ?? 50 })
      )
      return { persons }
    }
  )

  app.post(
    `${base}/persons`,
    {
      config: access('asset.edit'),
      schema: {
        params: warehouseParams,
        body: {
          type: 'object',
          properties: { displayName: { type: 'string', minLength: 1, maxLength: 200 } },
          required: ['displayName'],
          additionalProperties: false
        },
        response: { 201: personSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const warehouseId = param(request, 'warehouseId')
        await setDataContext(trx, warehouseContext(request, warehouseId))
        const { displayName } = request.body as { displayName: string }
        const person = await createPerson(trx, auditContext(request), actorFrom(request), warehouseId, displayName)
        // The stored response contains the name: erasing the person tombstones it (PD-05, migration 0008).
        return { status: 201, body: person, subjectPersonId: person.id }
      })
  )

  app.patch(
    `${base}/persons/:personId`,
    {
      config: access('asset.edit'),
      schema: {
        params: personParams,
        body: {
          type: 'object',
          properties: { version, displayName: { type: 'string', minLength: 1, maxLength: 200 } },
          required: ['version', 'displayName'],
          additionalProperties: false
        },
        response: { 200: personSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const warehouseId = param(request, 'warehouseId')
        await setDataContext(trx, warehouseContext(request, warehouseId))
        const body = request.body as { version: number; displayName: string }
        const person = await renamePerson(trx, auditContext(request), actorFrom(request), warehouseId, param(request, 'personId'), body)
        return { status: 200, body: person, subjectPersonId: person.id }
      })
  )

  // Erasure is a system permission (MFA through rule A7); the person is looked up in the named warehouse.
  app.post(
    `${base}/persons/:personId/erase`,
    {
      config: ERASE,
      schema: {
        params: personParams,
        body: { type: 'object', properties: { version }, required: ['version'], additionalProperties: false },
        response: { 200: personSchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const warehouseId = param(request, 'warehouseId')
        await setDataContext(trx, warehouseContext(request, warehouseId))
        const body = request.body as { version: number }
        return { status: 200, body: await erasePerson(trx, auditContext(request), actorFrom(request), warehouseId, param(request, 'personId'), body) }
      })
  )
}
