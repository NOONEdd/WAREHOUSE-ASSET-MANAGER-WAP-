import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { actorFrom } from '../../admin/rules.js'
import type { Database } from '../../db/connection.js'
import { inDataContext, setDataContext } from '../../db/dataContext.js'
import { cancelBatch, commitBatch, getBatch, IMPORT_FIELDS, listBatches, previewBatch } from '../../imports/imports.js'
import { routeIntegerParam } from '../authorization.js'
import { sendIdempotent } from '../idempotency.js'
import { auditContext } from '../requestContext.js'
import { warehouseContext } from './assetRoutes.js'
import { version } from './schemas.js'

// Staged imports of one warehouse (decision O-16; proposal §6). Registered only when WAM_IMPORT_ENABLED
// is set, which it is not by default: gates G-2…G-9 and O-14 are open. There is deliberately no upload
// route — no parser is approved (O-13) — so batches are staged only by the service, from synthetic
// fixtures in tests. Every route needs asset.import in the route's warehouse (missing access answers 404)
// and runs with the data context of exactly that warehouse.

const ID = { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } as const
const IMPORT = { access: { kind: 'warehouse', permission: 'asset.import', param: 'warehouseId' } } as const
const warehouseParams = { type: 'object', properties: { warehouseId: ID }, required: ['warehouseId'], additionalProperties: false } as const
const batchParams = {
  type: 'object',
  properties: { warehouseId: ID, batchId: ID },
  required: ['warehouseId', 'batchId'],
  additionalProperties: false
} as const

const batchSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    state: { type: 'string' },
    fileFormat: { type: 'string' },
    fileName: { type: ['string', 'null'] },
    rowCount: { type: ['integer', 'null'] },
    createdAt: { type: 'string' },
    createdBy: { type: 'integer' },
    closedAt: { type: ['string', 'null'] },
    version: { type: 'integer' }
  },
  required: ['id', 'state', 'fileFormat', 'fileName', 'rowCount', 'createdAt', 'createdBy', 'closedAt', 'version'],
  additionalProperties: false
} as const

const issueSchema = {
  type: 'object',
  properties: { code: { type: 'string' }, column: { type: 'string', enum: IMPORT_FIELDS } },
  required: ['code'],
  additionalProperties: false
} as const

const rowSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    sheetName: { type: ['string', 'null'] },
    rowNumber: { type: 'integer' },
    cells: { type: 'object', properties: Object.fromEntries(IMPORT_FIELDS.map((f) => [f, { type: 'string' }])), additionalProperties: false },
    outcome: { type: 'string' },
    issues: { type: 'array', items: issueSchema },
    matchedAssetId: { type: ['integer', 'null'] },
    appliedAt: { type: ['string', 'null'] }
  },
  required: ['id', 'sheetName', 'rowNumber', 'cells', 'outcome', 'issues', 'matchedAssetId', 'appliedAt'],
  additionalProperties: false
} as const

const countsSchema = {
  type: 'object',
  properties: {
    create: { type: 'integer' },
    update: { type: 'integer' },
    unchanged: { type: 'integer' },
    suspected_duplicate: { type: 'integer' },
    invalid: { type: 'integer' }
  },
  required: ['create', 'update', 'unchanged', 'suspected_duplicate', 'invalid'],
  additionalProperties: false
} as const

const batchWithCounts = {
  type: 'object',
  properties: { batch: batchSchema, counts: countsSchema },
  required: ['batch', 'counts'],
  additionalProperties: false
} as const

const versionBody = { type: 'object', properties: { version }, required: ['version'], additionalProperties: false } as const

function param(request: FastifyRequest, name: string): number {
  return routeIntegerParam(request, name) ?? -1
}

export function registerImportRoutes(app: FastifyInstance, options: { readonly db: Kysely<Database> }): void {
  const { db } = options
  const base = '/api/warehouses/:warehouseId/imports'

  app.get(
    base,
    {
      config: IMPORT,
      schema: {
        params: warehouseParams,
        response: {
          200: { type: 'object', properties: { batches: { type: 'array', items: batchSchema } }, required: ['batches'], additionalProperties: false }
        }
      }
    },
    async (request) => {
      const warehouseId = param(request, 'warehouseId')
      const batches = await inDataContext(db, warehouseContext(request, warehouseId), (trx) => listBatches(trx, warehouseId))
      return { batches }
    }
  )

  app.get(
    `${base}/:batchId`,
    {
      config: IMPORT,
      schema: {
        params: batchParams,
        querystring: {
          type: 'object',
          properties: { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } },
          additionalProperties: false
        },
        response: {
          200: {
            type: 'object',
            properties: { batch: batchSchema, rows: { type: 'array', items: rowSchema }, nextAfter: { type: ['integer', 'null'] } },
            required: ['batch', 'rows', 'nextAfter'],
            additionalProperties: false
          }
        }
      }
    },
    (request) => {
      const warehouseId = param(request, 'warehouseId')
      const query = request.query as { after?: number; limit?: number }
      return inDataContext(db, warehouseContext(request, warehouseId), (trx) =>
        getBatch(trx, warehouseId, param(request, 'batchId'), { ...query, limit: query.limit ?? 100 })
      )
    }
  )

  app.post(
    `${base}/:batchId/preview`,
    { config: IMPORT, schema: { params: batchParams, body: versionBody, response: { 200: batchWithCounts } } },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const warehouseId = param(request, 'warehouseId')
        await setDataContext(trx, warehouseContext(request, warehouseId))
        const { version: expected } = request.body as { version: number }
        const result = await previewBatch(trx, auditContext(request), actorFrom(request), warehouseId, param(request, 'batchId'), expected)
        return { status: 200, body: result }
      })
  )

  app.post(
    `${base}/:batchId/commit`,
    { config: IMPORT, schema: { params: batchParams, body: versionBody, response: { 200: batchWithCounts } } },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const warehouseId = param(request, 'warehouseId')
        await setDataContext(trx, warehouseContext(request, warehouseId))
        const { version: expected } = request.body as { version: number }
        const result = await commitBatch(trx, auditContext(request), actorFrom(request), warehouseId, param(request, 'batchId'), expected)
        return { status: 200, body: result }
      })
  )

  app.post(
    `${base}/:batchId/cancel`,
    { config: IMPORT, schema: { params: batchParams, body: versionBody, response: { 200: batchSchema } } },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const warehouseId = param(request, 'warehouseId')
        await setDataContext(trx, warehouseContext(request, warehouseId))
        const { version: expected } = request.body as { version: number }
        const batch = await cancelBatch(trx, auditContext(request), actorFrom(request), warehouseId, param(request, 'batchId'), expected)
        return { status: 200, body: batch }
      })
  )
}
