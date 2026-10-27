import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { actorFrom } from '../../admin/rules.js'
import { getSecurityPolicy, updateSecurityPolicy } from '../../admin/securityPolicy.js'
import type { Database, MfaRequiredFor } from '../../db/connection.js'
import { sendIdempotent } from '../idempotency.js'
import { auditContext } from '../requestContext.js'
import { dateTime, version } from './schemas.js'

// The security policy, managed by the owner only (decisions O-07, O-09).

const OWNER = { access: { kind: 'owner' } } as const

const policySchema = {
  type: 'object',
  properties: {
    mfaRequiredFor: { type: 'string', enum: ['privileged', 'all_users'] },
    updatedAt: dateTime,
    version: { type: 'integer' }
  },
  required: ['mfaRequiredFor', 'updatedAt', 'version'],
  additionalProperties: false
} as const

export function registerAdminSecurityRoutes(app: FastifyInstance, options: { readonly db: Kysely<Database> }): void {
  const { db } = options

  app.get('/api/admin/security-policy', { config: OWNER, schema: { response: { 200: policySchema } } }, async () => getSecurityPolicy(db))

  app.put(
    '/api/admin/security-policy',
    {
      config: OWNER,
      schema: {
        body: {
          type: 'object',
          properties: { version, mfaRequiredFor: { type: 'string', enum: ['privileged', 'all_users'] } },
          required: ['version', 'mfaRequiredFor'],
          additionalProperties: false
        },
        response: { 200: policySchema }
      }
    },
    (request, reply) =>
      sendIdempotent(db, request, reply, async (trx) => {
        const body = request.body as { version: number; mfaRequiredFor: MfaRequiredFor }
        return { status: 200, body: await updateSecurityPolicy(trx, auditContext(request), actorFrom(request), body) }
      })
  )
}
