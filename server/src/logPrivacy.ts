import type { FastifyServerOptions } from 'fastify'
import pg from 'pg'
import { AppError } from './appError.js'

// What an error may put into a log line (review finding NF-1). A raw error object is never logged: a
// PostgreSQL error carries the failing row in `detail` ("Failing row contains (…)": a user's name, a password
// hash), input values in `message` (22P02 "invalid input syntax for type integer: …"), SQL in `internalQuery`
// and `where`, and pino serializes every enumerable property of whatever it is given. JSON parse errors quote
// the request body in their message. So the default is deny: a log line gets an allowlisted summary — kind,
// type, a validated SQLSTATE and its class, a constraint name, an application or Node error code, the
// validation keyword and schema path, and the stack frames (code locations only, never the message) — and
// nothing else, not even the message. The same rule covers nested causes, a bare Error passed to the logger,
// an Error under any key, and a message string taken from an Error (Fastify's fallback handler does that).

export interface SafeErrorSummary {
  readonly kind: 'database' | 'application' | 'request' | 'system' | 'other'
  readonly type?: string
  readonly sqlstate?: string
  readonly category?: string
  readonly severity?: string
  readonly constraint?: string
  readonly code?: string
  readonly statusCode?: number
  readonly validation?: readonly { readonly keyword: string; readonly schemaPath: string }[]
  readonly frames?: readonly string[]
  readonly cause?: SafeErrorSummary
}

const SUMMARY = Symbol('wam.safeErrorSummary')
const MAX_DEPTH = 2
const MAX_FRAMES = 12
const WITHHELD = 'error (message withheld; see the error summary)'

const TYPE = /^[A-Za-z_$][\w$]{0,63}$/
const SQLSTATE = /^[0-9A-Z]{5}$/
// Constraint names are schema objects, created only by migrations; the pattern keeps anything else out.
const CONSTRAINT = /^[a-z_][a-z0-9_]{0,62}$/
// AppError codes, Fastify's FST_… codes and Node's system error codes (ECONNREFUSED, …).
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/
const SEVERITY = new Set(['ERROR', 'FATAL', 'PANIC'])
const KEYWORD = /^[A-Za-z]{1,32}$/
const SCHEMA_PATH = /^#(?:\/[A-Za-z0-9_-]{1,64}){0,16}$/
// A V8 frame: "at fn (file:///…/x.js:1:2)", "at /…/x.js:1:2", "at node:internal/…:1:2" — a code location.
const FRAME = /^at (?:[^\s()][^()\n]{0,199} \()?(?:file:\/\/\/|node:|\/)[^\s()]{1,300}:\d+:\d+\)?$/

// SQLSTATE classes (PostgreSQL documentation, Appendix A).
const SQLSTATE_CLASS: Readonly<Record<string, string>> = {
  '08': 'connection_exception',
  '22': 'data_exception',
  '23': 'integrity_constraint_violation',
  '25': 'invalid_transaction_state',
  '28': 'invalid_authorization_specification',
  '3D': 'invalid_catalog_name',
  '40': 'transaction_rollback',
  '42': 'syntax_error_or_access_rule_violation',
  '53': 'insufficient_resources',
  '54': 'program_limit_exceeded',
  '55': 'object_not_in_prerequisite_state',
  '57': 'operator_intervention',
  '58': 'system_error',
  P0: 'plpgsql_error',
  XX: 'internal_error'
}

function field(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined
}

function frames(err: Error): string[] | undefined {
  const stack = typeof err.stack === 'string' ? err.stack : ''
  // The stack starts with "<name>: <message>", and a message can itself contain lines that look like frames:
  // only what follows the message is considered.
  const at = err.message !== '' ? stack.indexOf(err.message) : -1
  // Without the current message in it (a message changed after the stack was taken), drop at least the header.
  const body = at >= 0 ? stack.slice(at + err.message.length) : stack.slice(stack.indexOf('\n') + 1)
  const out = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => FRAME.test(line))
    .slice(0, MAX_FRAMES)
  return out.length > 0 ? out : undefined
}

function isDatabaseError(err: Error): boolean {
  if (err instanceof pg.DatabaseError) return true
  const e = err as { code?: unknown; severity?: unknown }
  return typeof e.code === 'string' && SQLSTATE.test(e.code) && typeof e.severity === 'string' && SEVERITY.has(e.severity)
}

function validationOf(err: Error): SafeErrorSummary['validation'] {
  const list = (err as { validation?: unknown }).validation
  if (!Array.isArray(list)) return undefined
  const out: { keyword: string; schemaPath: string }[] = []
  for (const item of list.slice(0, 10) as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const v = item as { keyword?: unknown; schemaPath?: unknown }
    const keyword = field(v.keyword, KEYWORD)
    const schemaPath = field(v.schemaPath, SCHEMA_PATH)
    if (keyword !== undefined && schemaPath !== undefined) out.push({ keyword, schemaPath })
  }
  return out
}

function brand(summary: SafeErrorSummary): SafeErrorSummary {
  Object.defineProperty(summary, SUMMARY, { value: true, enumerable: false })
  return summary
}

/** The allowlisted summary of any thrown value. Never contains a message, a value or SQL. */
export function safeErrorSummary(value: unknown, depth = 0): SafeErrorSummary {
  if (isSafeErrorSummary(value)) return value
  if (!(value instanceof Error)) return brand({ kind: 'other', type: typeof value })
  const type = field(value.constructor.name, TYPE)
  const cause = depth < MAX_DEPTH && value.cause !== undefined ? safeErrorSummary(value.cause, depth + 1) : undefined
  const common = { ...(type === undefined ? {} : { type }), ...(cause === undefined ? {} : { cause }) }
  const stackFrames = frames(value)
  const withFrames = stackFrames === undefined ? common : { ...common, frames: stackFrames }
  if (isDatabaseError(value)) {
    const e = value as { code?: unknown; severity?: unknown; constraint?: unknown }
    const sqlstate = field(e.code, SQLSTATE)
    const category = sqlstate === undefined ? undefined : SQLSTATE_CLASS[sqlstate.slice(0, 2)]
    const severity = typeof e.severity === 'string' && SEVERITY.has(e.severity) ? e.severity : undefined
    const constraint = field(e.constraint, CONSTRAINT)
    return brand({
      kind: 'database',
      ...withFrames,
      ...(sqlstate === undefined ? {} : { sqlstate }),
      ...(category === undefined ? {} : { category }),
      ...(severity === undefined ? {} : { severity }),
      ...(constraint === undefined ? {} : { constraint })
    })
  }
  if (value instanceof AppError) return brand({ kind: 'application', ...withFrames, code: value.code, statusCode: value.status })
  const e = value as { code?: unknown; statusCode?: unknown }
  const code = field(e.code, CODE)
  const statusCode = typeof e.statusCode === 'number' && Number.isInteger(e.statusCode) && e.statusCode >= 100 && e.statusCode <= 599 ? e.statusCode : undefined
  const validation = validationOf(value)
  const kind = statusCode !== undefined || code?.startsWith('FST_') === true ? 'request' : code !== undefined ? 'system' : 'other'
  return brand({
    kind,
    ...withFrames,
    ...(code === undefined ? {} : { code }),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(validation === undefined ? {} : { validation })
  })
}

export function isSafeErrorSummary(value: unknown): value is SafeErrorSummary {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[SUMMARY] === true
}

type LoggerConfig = Exclude<NonNullable<FastifyServerOptions['logger']>, boolean>
type LogMethodHook = NonNullable<NonNullable<LoggerConfig['hooks']>['logMethod']>
type ErrSerializer = NonNullable<NonNullable<LoggerConfig['serializers']>['err']>

/**
 * pino's logMethod hook: every Error among a log call's arguments — a bare Error, an Error under any key of the
 * merge object (pino would otherwise serialize all its enumerable properties) or an interpolation argument —
 * becomes its summary, and a message string that contains an Error's message is replaced by a fixed text.
 */
export const safeLogMethod: LogMethodHook = function (this: ThisParameterType<LogMethodHook>, args, method) {
  const [first, ...rest] = args as unknown[]
  const isMergeObject = typeof first === 'object' && first !== null && !(first instanceof Error) && !Array.isArray(first)
  const values: unknown[] = isMergeObject ? Object.values(first as Record<string, unknown>) : []
  const errors = [first, ...values, ...rest].filter((v): v is Error => v instanceof Error)
  const messages = errors.map((e) => e.message).filter((m) => m !== '')
  const text = (value: unknown): unknown => (typeof value === 'string' && messages.some((m) => value.includes(m)) ? WITHHELD : value)
  let merge: unknown
  if (first instanceof Error) merge = { err: safeErrorSummary(first) }
  else if (isMergeObject) {
    merge = Object.fromEntries(Object.entries(first as Record<string, unknown>).map(([k, v]) => [k, v instanceof Error ? safeErrorSummary(v) : v]))
  }
  else merge = text(first)
  const tail = rest.map((value) => (value instanceof Error ? '[error withheld]' : text(value)))
  if (first instanceof Error && typeof tail[0] !== 'string') tail.unshift(WITHHELD)
  method.apply(this, [merge, ...tail] as Parameters<typeof method>)
}

/** The `err` serializer: whatever reaches it leaves as a summary. */
export function safeErrorSerializer(value: unknown): SafeErrorSummary {
  return safeErrorSummary(value)
}

/** Adds the error summary rules to pino options (idempotent); `false` (no logging) stays `false`. */
export function withLogPrivacy<T extends NonNullable<FastifyServerOptions['logger']>>(logger: T): T {
  if (logger === false) return logger
  const base: LoggerConfig = logger === true ? {} : logger
  const options: LoggerConfig = {
    ...base,
    // Fastify types `err` as returning pino's shape (with message and stack); returning less is the point here.
    serializers: { ...(base.serializers ?? {}), err: safeErrorSerializer as unknown as ErrSerializer },
    hooks: { ...(base.hooks ?? {}), logMethod: safeLogMethod }
  }
  return options as T
}

/** One JSON line with the error's summary, for paths without a logger (start-up, CLIs, fatal handlers). */
export function safeErrorLine(msg: string, err: unknown): string {
  return JSON.stringify({ level: 'error', time: new Date().toISOString(), msg, error: safeErrorSummary(err) })
}

export interface FatalErrorTarget {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (err: unknown) => void): unknown
  readonly write: (line: string) => void
  readonly exit: (code: number) => void
}

/**
 * Replaces Node's default handling of an uncaught exception or unhandled rejection — which prints the whole
 * error object, every property included — with one summary line, then exits with code 1 as Node would.
 */
export function installFatalErrorHandlers(target: FatalErrorTarget): void {
  target.on('uncaughtException', (err) => {
    target.write(safeErrorLine('uncaught exception; exiting', err))
    target.exit(1)
  })
  target.on('unhandledRejection', (err) => {
    target.write(safeErrorLine('unhandled rejection; exiting', err))
    target.exit(1)
  })
}
