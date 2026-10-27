import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { createDatabase, createPool, type Database } from '../../src/db/connection.js'

// No PostgreSQL needed: the database points at a socket path that does not
// exist, so any query fails immediately — which is exactly what the
// readiness test needs, and proves the other routes never touch it.
const UNREACHABLE = 'postgresql://nobody:nothing@%2Fnonexistent%2Fwam-socket:5432/none'
const ORIGIN = 'http://127.0.0.1:3000'
/** What a same-origin browser request from the WAM UI carries. */
const SAME_ORIGIN = { origin: ORIGIN, 'x-wam-csrf': '1' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

let app: FastifyInstance
let db: Kysely<Database>

beforeEach(async () => {
  db = createDatabase(createPool({ connectionString: UNREACHABLE, poolMax: 1, statementTimeoutMs: 1_000 }, () => undefined))
  app = buildApp({ db, logger: false, readinessTimeoutMs: 1_000, publicOrigin: ORIGIN, sessions: { idleMinutes: 30, absoluteHours: 12 } })
  // Test-only routes, registered before the app is ready, to exercise error handling.
  const config = { access: { kind: 'public' } } as const
  app.get('/test/boom', { config }, () => {
    throw new Error('connection to 10.0.0.5 failed for user "secret_admin"')
  })
  app.post('/test/echo', { config, schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } }, (request) => request.body)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  await db.destroy()
})

describe('GET /health/live', () => {
  it('answers 200 {status:"ok"} with the standard response headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
    expect(res.headers['x-request-id']).toMatch(UUID)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'")
    // Plain-http development origin: no HSTS.
    expect(res.headers['strict-transport-security']).toBeUndefined()
  })

  it('sends HSTS when the public origin is https', async () => {
    const secure = buildApp({ db, logger: false, publicOrigin: 'https://wam.example', sessions: { idleMinutes: 30, absoluteHours: 12 } })
    try {
      const res = await secure.inject({ method: 'GET', url: '/health/live' })
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
    } finally {
      await secure.close()
    }
  })

  it('ignores a client-supplied X-Request-Id', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': 'attacker-chosen' } })
    expect(res.headers['x-request-id']).toMatch(UUID)
  })
})

describe('GET /health/ready', () => {
  it('answers 503 {status:"unavailable"} when the database is unreachable, with no error details', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'unavailable' })
  })
})

describe('error responses', () => {
  it('uses the standard shape for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/no/such/route' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: res.headers['x-request-id'] } })
  })

  it('never reveals the internal message of an unexpected error', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: res.headers['x-request-id'] }
    })
    expect(res.body).not.toMatch(/10\.0\.0\.5|secret_admin/)
  })

  it('reports schema validation failures generically', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/echo', headers: SAME_ORIGIN, payload: { other: 1 } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED', message: 'Request validation failed' } })
  })

  it('reports malformed JSON without echoing the parser message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      payload: '{"name": '
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST', message: 'Bad request' } })
  })

  it('reports an unsupported content type with its own code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { ...SAME_ORIGIN, 'content-type': 'application/x-unknown' },
      payload: 'x'
    })
    expect(res.statusCode).toBe(415)
    expect(res.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } })
  })
})

describe('request forgery protection (state-changing requests)', () => {
  it('accepts a same-origin request carrying the custom header', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/echo', headers: { ...SAME_ORIGIN, 'sec-fetch-site': 'same-origin' }, payload: { name: 'x' } })
    expect(res.statusCode).toBe(200)
  })

  it.each([
    ['without the X-WAM-CSRF header', { origin: ORIGIN }],
    ['with a wrong X-WAM-CSRF value', { origin: ORIGIN, 'x-wam-csrf': 'yes' }],
    ['without an Origin header', { 'x-wam-csrf': '1' }],
    ['from a foreign origin', { origin: 'https://evil.example', 'x-wam-csrf': '1' }],
    ['from a look-alike origin', { origin: 'http://127.0.0.1:3000.evil.example', 'x-wam-csrf': '1' }],
    ['marked cross-site by the browser', { ...SAME_ORIGIN, 'sec-fetch-site': 'cross-site' }],
    ['marked same-site (another subdomain) by the browser', { ...SAME_ORIGIN, 'sec-fetch-site': 'same-site' }]
  ])('refuses a POST %s with 403, before the handler runs', async (_label, headers) => {
    const res = await app.inject({ method: 'POST', url: '/test/echo', headers, payload: { name: 'x' } })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
  })

  it('also guards routes that do not exist (no information about which do)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/anything', headers: { origin: 'https://evil.example' } })
    expect(res.statusCode).toBe(403)
  })

  it('does not apply to GET', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live', headers: { origin: 'https://evil.example' } })
    expect(res.statusCode).toBe(200)
  })
})

describe('route access declarations', () => {
  it('refuse to register a route that does not declare who may call it', () => {
    const fresh = buildApp({ db, logger: false, publicOrigin: ORIGIN, sessions: { idleMinutes: 30, absoluteHours: 12 } })
    expect(() => fresh.get('/test/undeclared', () => 'x')).toThrow(/no access declaration/)
  })
})
