import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import Fastify from 'fastify'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/appError.js'
import { registerErrorHandling } from '../../src/http/errors.js'
import { installFatalErrorHandlers, safeErrorSummary } from '../../src/logPrivacy.js'
import { loggerOptions } from '../../src/server.js'

// Finding NF-1: an error reaches a log line only as its allowlisted summary. Each test builds errors whose
// every field holds a unique sentinel, then inspects the serialized output.

const tag = randomBytes(5).toString('hex')
const HASH = `$argon2id$v=19$m=19456,t=2,p=1$ZqSalt${tag}AAAAAAAAAA$ZqHash${tag}BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`
const S = {
  username: `zq.user.${tag}`,
  displayName: `Zq Display ${tag}`,
  row: `ZqRow${tag}`,
  cookie: `ZqCookie${tag}`,
  token: `ZqToken${tag}`,
  search: `ZqSearch${tag}`,
  sql: `ZqSql${tag}`,
  cause: `ZqCause${tag}`,
  meta: `ZqMeta${tag}`
}
const FORBIDDEN = [...Object.values(S), HASH, HASH.slice(0, 64), `ZqSalt${tag}`, `ZqHash${tag}`, 'Failing row contains', 'PL/pgSQL']

function expectNoSentinel(text: string): void {
  for (const value of FORBIDDEN) expect(text, `output contains "${value}"`).not.toContain(value)
}

/** A real pg DatabaseError, every field carrying sensitive values. */
function databaseError(): pg.DatabaseError {
  // The message carries a line that imitates a stack frame: it must not survive as a frame.
  const err = new pg.DatabaseError(`new row for relation "users" violates check constraint, value ${S.displayName}\n    at /fake/${S.row}.js:1:1`, 210, 'error')
  Object.assign(err, {
    severity: 'ERROR',
    code: '23514',
    detail: `Failing row contains (7, ${S.username}, ${S.displayName}, ${HASH.slice(0, 64)}...).`,
    hint: `hint ${S.row}`,
    position: '17',
    internalPosition: '3',
    internalQuery: `SELECT ${S.sql}`,
    where: `PL/pgSQL function wam.f() line 3 at RAISE ${S.row}`,
    schema: 'wam',
    table: 'users',
    column: 'display_name',
    dataType: 'text',
    constraint: 'users_display_name_length',
    file: 'execMain.c',
    line: '2109',
    routine: 'ExecConstraints',
    query: `UPDATE wam.users SET display_name = '${S.displayName}'`,
    parameters: [S.displayName, HASH],
    client: { password: S.token, cookie: S.cookie },
    cause: Object.assign(new Error(`cause ${S.cause}`), { detail: `nested ${S.row}`, password: HASH })
  })
  err.stack = `error: ${err.message}\n    at Parser.parseErrorMessage (file:///srv/node_modules/pg-protocol/dist/parser.js:306:11)`
  return err
}

describe('safeErrorSummary', () => {
  it('reduces a database error to allowlisted fields: SQLSTATE, its class, severity, constraint, code locations', () => {
    const summary = safeErrorSummary(databaseError())
    expectNoSentinel(JSON.stringify(summary))
    expect(summary).toMatchObject({ kind: 'database', type: 'DatabaseError', sqlstate: '23514', category: 'integrity_constraint_violation', severity: 'ERROR', constraint: 'users_display_name_length' })
    const allowed = new Set(['kind', 'type', 'sqlstate', 'category', 'severity', 'constraint', 'code', 'statusCode', 'validation', 'frames', 'cause'])
    for (const key of Object.keys(summary)) expect(allowed.has(key), key).toBe(true)
  })

  it('keeps no frame that the message itself contains, only the frames after it', () => {
    const summary = safeErrorSummary(databaseError())
    expect(summary.frames).toEqual(['at Parser.parseErrorMessage (file:///srv/node_modules/pg-protocol/dist/parser.js:306:11)'])
  })

  it('applies the same rules to a nested cause, up to two levels', () => {
    const outer = new Error(`outer ${S.cause}`, { cause: new Error(`middle ${S.row}`, { cause: databaseError() }) })
    const summary = safeErrorSummary(outer)
    expectNoSentinel(JSON.stringify(summary))
    expect(summary.cause?.cause).toMatchObject({ kind: 'database', sqlstate: '23514' })
    expect(summary.cause?.cause?.cause).toBeUndefined()
  })

  it('recognizes a database error by its shape when it is not a pg DatabaseError instance', () => {
    const lookalike = Object.assign(new Error(`relation ${S.row}`), { code: '22P02', severity: 'ERROR', detail: S.row, constraint: `bad name ${S.row}` })
    const summary = safeErrorSummary(lookalike)
    expectNoSentinel(JSON.stringify(summary))
    expect(summary).toMatchObject({ kind: 'database', sqlstate: '22P02', category: 'data_exception' })
    expect(summary).not.toHaveProperty('constraint') // not an identifier: dropped
  })

  it('keeps a validation error to its keyword and schema path', () => {
    const err = Object.assign(new Error(`body/${S.row} must NOT have additional properties`), {
      code: 'FST_ERR_VALIDATION',
      statusCode: 400,
      validation: [
        { keyword: 'additionalProperties', instancePath: `/${S.row}`, schemaPath: '#/additionalProperties', params: { additionalProperty: S.row }, message: S.row },
        { keyword: 'minLength', instancePath: '/displayName', schemaPath: `#/properties/${S.row} x`, params: {}, message: 'm' }
      ]
    })
    const summary = safeErrorSummary(err)
    expectNoSentinel(JSON.stringify(summary))
    expect(summary).toMatchObject({ kind: 'request', code: 'FST_ERR_VALIDATION', statusCode: 400, validation: [{ keyword: 'additionalProperties', schemaPath: '#/additionalProperties' }] })
    expect(summary.validation).toHaveLength(1)
  })

  it('summarizes application errors, system errors and thrown non-errors without their text', () => {
    expect(safeErrorSummary(new AppError('VERSION_CONFLICT', { currentVersion: 3 }))).toMatchObject({ kind: 'application', code: 'VERSION_CONFLICT', statusCode: 409 })
    const system = Object.assign(new Error(`connect ECONNREFUSED ${S.meta}`), { code: 'ECONNREFUSED', address: S.meta, syscall: 'connect' })
    expect(safeErrorSummary(system)).toMatchObject({ kind: 'system', code: 'ECONNREFUSED' })
    for (const thrown of [S.row, { detail: S.row, message: S.row }, 42, null, undefined]) {
      const summary = safeErrorSummary(thrown)
      expectNoSentinel(JSON.stringify(summary))
      expect(summary.kind).toBe('other')
    }
    expectNoSentinel(JSON.stringify(safeErrorSummary(system)))
  })
})

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim() !== '') lines.push(line)
      done()
    }
  })
  return { lines, stream }
}

describe('the server logger (loggerOptions): no call shape lets error contents through', () => {
  it('a bare Error, an Error under any key, an interpolated Error, a message built from it, and a child logger', async () => {
    const { lines, stream } = capture()
    const app = Fastify({ logger: { ...loggerOptions('debug'), stream } })
    app.get('/x', (request) => {
      const err = databaseError()
      request.log.error(err)
      request.log.error(err, 'with a message')
      request.log.error({ err }, 'under err')
      request.log.error({ error: err, other: 1 }, 'under another key')
      request.log.error({ err }, `built from it: ${err.message}`)
      request.log.error('interpolated %s', err)
      request.log.child({ part: 'child' }).warn({ cause: err }, 'child logger')
      request.log.error({ err: { detail: S.row, message: S.row, hint: HASH } }, 'a plain object under err')
      return { ok: true }
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: `/x?q=${S.search}`, headers: { cookie: `wam_session=${S.cookie}`, authorization: `Bearer ${S.token}` } })
    expect(res.statusCode).toBe(200)
    await app.close()
    expectNoSentinel(lines.join('\n'))
    const logged = lines.map((l) => JSON.parse(l) as { msg?: string; err?: { sqlstate?: string }; error?: { sqlstate?: string }; cause?: { sqlstate?: string } })
    const withErrors = logged.filter((l) => l.err !== undefined || l.error !== undefined || l.cause !== undefined)
    expect(withErrors).toHaveLength(7) // every call but the interpolated one, whose Error became text
    for (const l of withErrors.filter((x) => x.msg !== 'a plain object under err')) expect((l.err ?? l.error ?? l.cause)?.sqlstate).toBe('23514')
    const messages = logged.map((l) => l.msg)
    expect(messages).toContain('under another key')
    expect(messages).toContain('interpolated [error withheld]')
    expect(messages).toContain('error (message withheld; see the error summary)')
  })

  it("Fastify's own fallback error handler, which logs the error's message as the line's message", async () => {
    const { lines, stream } = capture()
    const app = Fastify({ logger: { ...loggerOptions('info'), stream } }) // no application error handler: Fastify's default
    app.get('/boom', () => {
      throw databaseError()
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)
    await app.close()
    expectNoSentinel(lines.join('\n'))
    expect(lines.some((l) => l.includes('"sqlstate":"23514"'))).toBe(true)
  })
})

describe('the application error handler logs a summary by itself, whatever logger it is given', () => {
  it('with plain pino options (no privacy serializer or hook), a failed request still logs no error contents', async () => {
    const { lines, stream } = capture()
    const app = Fastify({ logger: { level: 'info', stream } })
    registerErrorHandling(app)
    app.get('/boom', () => {
      throw databaseError()
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)
    await app.close()
    expectNoSentinel(lines.join('\n'))
    const failed = lines.map((l) => JSON.parse(l) as { msg?: string; err?: { sqlstate?: string } }).find((l) => l.msg === 'request failed')
    expect(failed?.err?.sqlstate).toBe('23514')
  })
})

describe('fatal error handlers (uncaught exception, unhandled rejection)', () => {
  it('write one summary line and exit with 1, for an Error and for a non-Error rejection', () => {
    const listeners = new Map<string, (err: unknown) => void>()
    const written: string[] = []
    const exits: number[] = []
    installFatalErrorHandlers({ on: (event, listener) => listeners.set(event, listener), write: (line) => written.push(line), exit: (code) => exits.push(code) })
    listeners.get('uncaughtException')?.(databaseError())
    listeners.get('unhandledRejection')?.({ detail: S.row, password: HASH })
    expect(exits).toEqual([1, 1])
    expect(written).toHaveLength(2)
    expectNoSentinel(written.join('\n'))
    expect(JSON.parse(written[0] ?? '{}')).toMatchObject({ msg: 'uncaught exception; exiting', error: { kind: 'database', sqlstate: '23514' } })
    expect(JSON.parse(written[1] ?? '{}')).toMatchObject({ msg: 'unhandled rejection; exiting', error: { kind: 'other', type: 'object' } })
  })
})
