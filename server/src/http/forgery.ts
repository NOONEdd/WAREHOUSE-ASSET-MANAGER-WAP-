import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { AppError } from '../appError.js'
import type { Database } from '../db/connection.js'
import { auditDenial } from './requestContext.js'

// Cross-site request forgery protection (docs/security/identity-and-access.md
// §5; ASVS 5.0.0 V3.5.1, V3.5.3). Every request that is not GET/HEAD/OPTIONS
// must carry the custom header (which a cross-site page cannot send without a
// CORS preflight, and no CORS is configured), come from the configured
// origin, and, if the browser says where it came from, be same-origin.

export const CSRF_HEADER = 'x-wam-csrf'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function registerForgeryProtection(app: FastifyInstance, options: { db: Kysely<Database>; publicOrigin: string }): void {
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return
    const reasons: string[] = []
    if (request.headers[CSRF_HEADER] !== '1') reasons.push('missing_csrf_header')
    if (request.headers.origin !== options.publicOrigin) reasons.push(request.headers.origin === undefined ? 'missing_origin' : 'foreign_origin')
    const site = request.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin') reasons.push('cross_site_fetch')
    if (reasons.length === 0) return
    await auditDenial(options.db, request, {
      action: 'security.request_forgery_blocked',
      outcome: 'denied',
      actor: null,
      details: { method: request.method, path: request.url.split('?')[0] ?? '', reasons }
    })
    throw new AppError('FORBIDDEN')
  })
}
