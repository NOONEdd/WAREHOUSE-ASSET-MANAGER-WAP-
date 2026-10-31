import { randomBytes, randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loggerOptions } from '../../src/server.js'
import { call, createHarness, insertUser, insertWarehouse, login, ORIGIN, SESSIONS, type Harness } from '../support/appHarness.js'

// Finding NF-1: what reaches the logs when a request fails. The app runs with the server's own logger options
// at debug level, writing into a buffer; every assertion is about those serialized lines. Sentinels are unique
// per run. Faults are injected only into this throwaway database (a constraint, a trigger), to produce the
// database errors a real defect or a missed validation would.

const tag = randomBytes(5).toString('hex')
const S = {
  username: `zq.user.${tag}`,
  displayName: `Zq Display ${tag}`,
  newName: `Zq Injected ${tag}`,
  search: `ZqSearch${tag}`,
  token: `ZqToken${tag}`,
  cookie: `ZqCookie${tag}`,
  key: `zqkey${tag}`,
  value: `ZqValue${tag}`,
  warehouse: `SYN-ZQ${tag.slice(0, 4).toUpperCase()}`
}

const lines: string[] = []
const stream = new Writable({
  write(chunk: Buffer, _encoding, done) {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim() !== '') lines.push(line)
    done()
  }
})

let h: Harness
let owner: string
let targetId = 0
let passwordHash = ''
let warehouseId = 0

interface LogLine {
  level: number
  msg?: string
  route?: string | null
  err?: Record<string, unknown> & { validation?: { keyword: string; schemaPath: string }[]; frames?: string[] }
}
const parsed = (from: number): LogLine[] => lines.slice(from).map((l) => JSON.parse(l) as LogLine)

/** Every sentinel, the password hash, its first 64 bytes (what "Failing row contains" shows) and its salt. */
function forbidden(): string[] {
  const salt = passwordHash.split('$')[4] ?? ''
  return [...Object.values(S), passwordHash, passwordHash.slice(0, 64), salt, 'Failing row contains', 'PL/pgSQL', 'zq_fault_detail']
}
function expectClean(from: number): void {
  const text = lines.slice(from).join('\n')
  for (const value of forbidden()) expect(text, `log output contains "${value}"`).not.toContain(value)
}

beforeAll(async () => {
  h = await createHarness({ logger: { ...loggerOptions('debug'), stream } })
  await insertUser(h, { username: 'log.owner', isOwner: true })
  owner = await login(h, 'log.owner')
  targetId = await insertUser(h, { username: S.username, displayName: S.displayName })
  passwordHash = (await h.ownerDb.selectFrom('users').select('password_hash').where('id', '=', targetId).executeTakeFirstOrThrow()).password_hash ?? ''
  expect(passwordHash.length).toBeGreaterThan(64)
  warehouseId = await insertWarehouse(h, S.warehouse)
})

afterAll(async () => {
  await h.close()
})

const versionOf = async (id: number) => (await h.ownerDb.selectFrom('users').select('version').where('id', '=', id).executeTakeFirstOrThrow()).version
const patchUser = async (body: Record<string, unknown>) =>
  call(h, { method: 'PATCH', url: `/api/admin/users/${String(targetId)}`, cookie: owner, headers: { 'idempotency-key': randomUUID() }, payload: { version: await versionOf(targetId), ...body } })

describe('NF-1: an unexpected database error leaves no row value in the logs', () => {
  it('a constraint failure on a table without row-level security (users): the database reports the row, the log does not', async () => {
    await sql`ALTER TABLE wam.users ADD CONSTRAINT zq_fault CHECK (display_name NOT LIKE '%Injected%')`.execute(h.superDb)
    try {
      // The source of the leak is real: as the server's role, the database puts the whole row into `detail`.
      const direct = await h.appDb
        .updateTable('users')
        .set({ display_name: S.newName })
        .where('id', '=', targetId)
        .execute()
        .then(() => null, (err: unknown) => err as { detail?: string })
      expect(direct?.detail).toContain(S.username)
      expect(direct?.detail).toContain(passwordHash.slice(0, 40))

      const from = lines.length
      const res = await patchUser({ displayName: S.newName })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: expect.any(String) as string } })
      expectClean(from)
      const failure = parsed(from).find((l) => l.msg === 'request failed')
      expect(failure?.level).toBe(50)
      expect(failure?.route).toBe('/api/admin/users/:id')
      expect(failure?.err).toMatchObject({ kind: 'database', sqlstate: '23514', category: 'integrity_constraint_violation', constraint: 'zq_fault', severity: 'ERROR' })
      for (const key of ['message', 'detail', 'hint', 'where', 'internalQuery', 'schema', 'table', 'column', 'stack', 'routine', 'file', 'line']) {
        expect(failure?.err ?? {}, key).not.toHaveProperty(key)
      }
    } finally {
      await sql`ALTER TABLE wam.users DROP CONSTRAINT IF EXISTS zq_fault`.execute(h.superDb)
    }
  })

  it('an ordinary unexpected database error keeps safe diagnostics: SQLSTATE, its class, the route and code locations', async () => {
    await sql.raw(`
      CREATE FUNCTION wam.zq_raise() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'raised for %', NEW.display_name
          USING DETAIL = 'zq_fault_detail ' || NEW.username, HINT = 'hint ' || NEW.display_name, ERRCODE = 'P0001';
      END $$;
      CREATE TRIGGER zq_raise BEFORE UPDATE ON wam.users FOR EACH ROW WHEN (NEW.display_name LIKE 'Zq Injected%') EXECUTE FUNCTION wam.zq_raise();`).execute(h.superDb)
    try {
      const from = lines.length
      const res = await patchUser({ displayName: S.newName })
      expect(res.statusCode).toBe(500)
      expectClean(from)
      const failure = parsed(from).find((l) => l.msg === 'request failed')
      expect(failure?.err).toMatchObject({ kind: 'database', sqlstate: 'P0001', category: 'plpgsql_error' })
      expect(failure?.err?.frames?.length ?? 0).toBeGreaterThan(0)
      for (const frame of failure?.err?.frames ?? []) expect(frame).toMatch(/^at .*:\d+:\d+\)?$/)
    } finally {
      await sql.raw('DROP TRIGGER IF EXISTS zq_raise ON wam.users; DROP FUNCTION IF EXISTS wam.zq_raise()').execute(h.superDb)
    }
  })
})

describe('NF-1: the app enforces the rules itself, whatever logger options it is given', () => {
  it('built with plain pino options (not the server\'s), a database failure still logs no row value', async () => {
    const own: string[] = []
    const plain = new Writable({
      write(chunk: Buffer, _encoding, done) {
        for (const line of chunk.toString('utf8').split('\n')) if (line.trim() !== '') own.push(line)
        done()
      }
    })
    const h2 = await createHarness({ logger: { level: 'debug', stream: plain } })
    try {
      await insertUser(h2, { username: 'plain.owner', isOwner: true })
      const cookie = await login(h2, 'plain.owner')
      const id = await insertUser(h2, { username: S.username, displayName: S.displayName })
      const hash = (await h2.ownerDb.selectFrom('users').select('password_hash').where('id', '=', id).executeTakeFirstOrThrow()).password_hash ?? ''
      await sql`ALTER TABLE wam.users ADD CONSTRAINT zq_fault CHECK (display_name NOT LIKE '%Injected%')`.execute(h2.superDb)
      const version = (await h2.ownerDb.selectFrom('users').select('version').where('id', '=', id).executeTakeFirstOrThrow()).version
      const res = await call(h2, { method: 'PATCH', url: `/api/admin/users/${String(id)}`, cookie, headers: { 'idempotency-key': randomUUID() }, payload: { version, displayName: S.newName } })
      expect(res.statusCode).toBe(500)
      const text = own.join('\n')
      for (const value of [S.username, S.displayName, S.newName, hash, hash.slice(0, 64), 'Failing row contains']) expect(text, value).not.toContain(value)
      expect(text).toContain('"sqlstate":"23514"')
    } finally {
      await h2.close()
    }
  })
})

describe('NF-1: buildApp applies the rules to any logger options it is given', () => {
  it('a route that logs a raw database error under an arbitrary key, with plain pino options, logs no error contents', async () => {
    const own: string[] = []
    const plain = new Writable({
      write(chunk: Buffer, _encoding, done) {
        for (const line of chunk.toString('utf8').split('\n')) if (line.trim() !== '') own.push(line)
        done()
      }
    })
    const app = buildApp({ db: h.appDb, logger: { level: 'info', stream: plain }, publicOrigin: ORIGIN, sessions: SESSIONS, mfaEncryptionKey: randomBytes(32) })
    const err = Object.assign(new Error(`failed for ${S.displayName}`), { code: '23514', severity: 'ERROR', detail: `Failing row contains (${S.username}, ${passwordHash.slice(0, 64)})` })
    app.get('/zq-log-probe', { config: { access: { kind: 'public' } } }, (request) => {
      request.log.error({ failure: err }, 'probe')
      return { ok: true }
    })
    await app.ready()
    expect((await app.inject({ method: 'GET', url: '/zq-log-probe' })).statusCode).toBe(200)
    await app.close()
    const text = own.join('\n')
    for (const value of [S.username, S.displayName, passwordHash.slice(0, 64), 'Failing row contains']) expect(text, value).not.toContain(value)
    expect(text).toContain('"sqlstate":"23514"')
  })
})

describe('NF-1: a display name is validated after normalization, before the database', () => {
  it('updating a user to a whitespace-only display name is a validation error; nothing changes and nothing is logged as an error', async () => {
    const before = await h.ownerDb.selectFrom('users').select(['display_name', 'version']).where('id', '=', targetId).executeTakeFirstOrThrow()
    for (const blank of ['   ', '\t \n', '  　']) {
      const from = lines.length
      const res = await patchUser({ displayName: blank })
      expect(res.statusCode, JSON.stringify(blank)).toBe(400)
      expect(res.json<{ error: unknown }>().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'displayName', reason: 'blank' } })
      expect(parsed(from).filter((l) => l.level >= 50)).toEqual([])
      expectClean(from)
    }
    const after = await h.ownerDb.selectFrom('users').select(['display_name', 'version']).where('id', '=', targetId).executeTakeFirstOrThrow()
    expect(after).toEqual(before)
  })

  it('creating a user with a whitespace-only display name is refused the same way, and no user is created', async () => {
    const from = lines.length
    const username = `zq.new.${tag}`
    const res = await call(h, { method: 'POST', url: '/api/admin/users', cookie: owner, headers: { 'idempotency-key': randomUUID() }, payload: { username, displayName: ' \t ' } })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: unknown }>().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'displayName', reason: 'blank' } })
    expect(await h.ownerDb.selectFrom('users').select('id').where('username', '=', username).executeTakeFirst()).toBeUndefined()
    expect(parsed(from).filter((l) => l.level >= 50)).toEqual([])
  })

  it('a valid name with surrounding whitespace is stored trimmed', async () => {
    const res = await patchUser({ displayName: `  ${S.displayName} ` })
    expect(res.statusCode).toBe(200)
    expect((await h.ownerDb.selectFrom('users').select('display_name').where('id', '=', targetId).executeTakeFirstOrThrow()).display_name).toBe(S.displayName)
  })

  it('the Phase 1B-3 entry points refuse whitespace-only names as validation errors too (person, asset, catalogue)', async () => {
    const w = String(warehouseId)
    const itemTypeId = (await sql<{ id: number }>`INSERT INTO wam.item_types (name) VALUES ('Synthetic log type') RETURNING id`.execute(h.ownerDb)).rows[0]?.id
    const statusId = (await sql<{ id: number }>`SELECT id FROM wam.asset_statuses WHERE code = 'in_stock'`.execute(h.ownerDb)).rows[0]?.id
    const post = (url: string, payload: Record<string, unknown>) => call(h, { method: 'POST', url, cookie: owner, headers: { 'idempotency-key': randomUUID() }, payload })
    const from = lines.length
    const person = await post(`/api/warehouses/${w}/persons`, { displayName: '   ' })
    const asset = await post(`/api/warehouses/${w}/assets`, { assetCode: `SYN-ZQ-${tag}`, name: '   ', itemTypeId, statusId })
    const catalog = await post('/api/catalog/item-types', { name: ' \t ' })
    for (const [res, fieldName] of [[person, 'displayName'], [asset, 'name'], [catalog, 'name']] as const) {
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json<{ error: unknown }>().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: fieldName } })
    }
    expect(parsed(from).filter((l) => l.level >= 50)).toEqual([])
  })
})

describe('NF-1: expected failures keep their responses, and their log lines carry no request values', () => {
  it('a schema validation error is logged with its keyword and schema path only', async () => {
    const from = lines.length
    const res = await call(h, {
      method: 'POST', url: '/api/admin/users', cookie: owner, headers: { 'idempotency-key': randomUUID() },
      payload: { username: S.username, displayName: S.displayName, [S.key]: S.value }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED')
    expectClean(from)
    const rejected = parsed(from).find((l) => l.msg === 'request rejected')
    expect(rejected?.err).toMatchObject({ kind: 'request', code: 'FST_ERR_VALIDATION', statusCode: 400, validation: [{ keyword: 'additionalProperties', schemaPath: '#/additionalProperties' }] })
  })

  it('a version conflict and a taken username keep their codes and details', async () => {
    const conflict = await call(h, { method: 'PATCH', url: `/api/admin/users/${String(targetId)}`, cookie: owner, headers: { 'idempotency-key': randomUUID() }, payload: { version: (await versionOf(targetId)) + 100, displayName: 'Synthetic other' } })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json<{ error: unknown }>().error).toMatchObject({ code: 'VERSION_CONFLICT' })
    const taken = await call(h, { method: 'POST', url: '/api/admin/users', cookie: owner, headers: { 'idempotency-key': randomUUID() }, payload: { username: S.username, displayName: 'Synthetic other' } })
    expect(taken.statusCode).toBe(409)
    expect(taken.json<{ error: unknown }>().error).toMatchObject({ code: 'USERNAME_TAKEN' })
  })

  it('search terms, a bearer token and cookies stay out of the logs, for succeeding and failing requests', async () => {
    const from = lines.length
    const w = String(warehouseId)
    const ok = await call(h, { method: 'GET', url: `/api/warehouses/${w}/persons?q=${S.search}`, cookie: owner, headers: { authorization: `Bearer ${S.token}` } })
    expect(ok.statusCode).toBe(200)
    const anon = await call(h, { method: 'GET', url: `/api/warehouses/${w}/assets?q=${S.search}`, headers: { cookie: `wam_session=${S.cookie}` } })
    expect(anon.statusCode).toBe(401)
    const tooLong = await call(h, { method: 'GET', url: `/api/warehouses/${w}/assets?q=${S.search}${'x'.repeat(120)}`, cookie: owner })
    expect(tooLong.statusCode).toBe(400)
    expectClean(from)
    const sessionValue = owner.split('=')[1] ?? ''
    expect(sessionValue.length).toBeGreaterThan(10)
    expect(lines.slice(from).join('\n')).not.toContain(sessionValue)
  })

  it('a database error on an unchanged earlier path (a warehouse renamed to whitespace) also leaves nothing in the logs', async () => {
    // Pre-existing (Phase 1B-2) and not changed here: a whitespace-only warehouse name reaches the database's
    // check. What this test pins is the log: the row (code, name) must not appear in it.
    const version = (await h.ownerDb.selectFrom('warehouses').select('version').where('id', '=', warehouseId).executeTakeFirstOrThrow()).version
    const from = lines.length
    const res = await call(h, { method: 'PATCH', url: `/api/admin/warehouses/${String(warehouseId)}`, cookie: owner, headers: { 'idempotency-key': randomUUID() }, payload: { version, name: '   ' } })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.body).not.toContain(S.warehouse)
    expectClean(from)
  })
})
