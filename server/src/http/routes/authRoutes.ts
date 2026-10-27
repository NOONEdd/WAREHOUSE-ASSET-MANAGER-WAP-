import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { AppError } from '../../appError.js'
import { recordAudit } from '../../audit/audit.js'
import { checkPassword, PASSWORD_MAX_LENGTH } from '../../auth/passwordPolicy.js'
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from '../../auth/passwords.js'
import {
  createSession,
  revokeSessionByToken,
  revokeUserSessions,
  type SessionSettings
} from '../../auth/sessions.js'
import { checkSetupCode, deleteSetupCode } from '../../auth/setupCodes.js'
import { isLoginThrottled, isSetupThrottled, recordFailure, usernameKey } from '../../auth/throttle.js'
import type { Database } from '../../db/connection.js'
import { authOf } from '../authorization.js'
import { clearedSessionCookie, readCookie, sessionCookie, type CookieSettings } from '../cookies.js'
import { actorOf, auditContext, userAgentOf } from '../requestContext.js'

// Authentication endpoints (docs/security/identity-and-access.md §3–§4).
// Exactly two ways to authenticate exist: password login, and a one-time
// setup code that sets a new password (ASVS 5.0.0 V6.1.3, V6.3.4).

export interface AuthRouteOptions {
  readonly db: Kysely<Database>
  readonly sessions: SessionSettings
  readonly cookie: CookieSettings
}

const PUBLIC = { access: { kind: 'public' } } as const
const AUTHENTICATED = { access: { kind: 'authenticated' } } as const

// Generous upper bounds on input; the policy itself is enforced in code.
const passwordInput = { type: 'string', minLength: 1, maxLength: 1024 } as const
const usernameInput = { type: 'string', minLength: 1, maxLength: 64 } as const

export const userSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    username: { type: 'string' },
    displayName: { type: 'string' },
    isOwner: { type: 'boolean' }
  },
  required: ['id', 'username', 'displayName', 'isOwner'],
  additionalProperties: false
} as const

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { db, sessions, cookie } = options

  app.post(
    '/api/auth/login',
    {
      config: PUBLIC,
      schema: {
        body: {
          type: 'object',
          properties: { username: usernameInput, password: passwordInput },
          required: ['username', 'password'],
          additionalProperties: false
        },
        response: {
          200: {
            type: 'object',
            properties: { user: userSummarySchema },
            required: ['user'],
            additionalProperties: false
          }
        }
      }
    },
    async (request, reply) => {
      const { username, password } = request.body as { username: string; password: string }
      const key = usernameKey(username)
      const context = auditContext(request)
      const user = await db
        .selectFrom('users')
        .select(['id', 'username', 'display_name', 'is_owner', 'status', 'password_hash'])
        .where('username', '=', key)
        .executeTakeFirst()
      // Only a known account is named in the audit trail; an unknown name may
      // be a password typed into the wrong field, so it is not recorded there.
      const target = user === undefined ? undefined : { type: 'user', id: user.id }

      if (await isLoginThrottled(db, key, request.ip)) {
        await recordAudit(db, context, { action: 'auth.login.throttled', outcome: 'denied', actor: null, target })
        throw new AppError('TOO_MANY_REQUESTS')
      }

      const hash = user?.status === 'active' ? user.password_hash : null
      const verified = hash === null ? await verifyAgainstDummy(password) : await verifyPassword(password, hash)
      if (user === undefined || hash === null || !verified) {
        await recordFailure(db, 'login', key, request.ip)
        const reason =
          user === undefined ? 'unknown_user' : user.status !== 'active' ? 'disabled' : hash === null ? 'not_activated' : 'wrong_password'
        await recordAudit(db, context, { action: 'auth.login.failed', outcome: 'failure', actor: null, target, details: { reason } })
        throw new AppError('INVALID_CREDENTIALS')
      }

      const upgradedHash = needsRehash(hash) ? await hashPassword(password) : null
      const existingToken = readCookie(request.headers.cookie, cookie.name)
      const { token } = await db.transaction().execute(async (trx) => {
        // ASVS V7.2.4: a login always gets a new token and ends the old one.
        if (existingToken !== null) await revokeSessionByToken(trx, existingToken, 'login_replaced')
        const created = await createSession(trx, user.id, sessions, { sourceIp: request.ip, userAgent: userAgentOf(request) })
        await trx
          .updateTable('users')
          .set(upgradedHash === null ? { last_login_at: sql<Date>`now()` } : { last_login_at: sql<Date>`now()`, password_hash: upgradedHash })
          .where('id', '=', user.id)
          .execute()
        await recordAudit(trx, context, {
          action: 'auth.login.succeeded',
          outcome: 'success',
          actor: { id: user.id, username: user.username },
          target,
          details: { method: 'password', ...(upgradedHash === null ? {} : { hashUpgraded: true }) }
        })
        return created
      })
      reply.header('set-cookie', sessionCookie(cookie, token))
      return { user: { id: user.id, username: user.username, displayName: user.display_name, isOwner: user.is_owner } }
    }
  )

  app.post('/api/auth/logout', { config: PUBLIC }, async (request, reply) => {
    const token = readCookie(request.headers.cookie, cookie.name)
    const ended = token === null ? null : await revokeSessionByToken(db, token, 'logout')
    if (ended !== null) {
      const user = await db.selectFrom('users').select('username').where('id', '=', ended.userId).executeTakeFirstOrThrow()
      await recordAudit(db, auditContext(request), {
        action: 'auth.logout',
        outcome: 'success',
        actor: { id: ended.userId, username: user.username },
        target: { type: 'session', id: ended.sessionId }
      })
    }
    // ASVS 5.0.0 V14.3.1: also ask the browser to drop anything it kept for this session.
    return reply
      .header('set-cookie', clearedSessionCookie(cookie))
      .header('clear-site-data', '"cache", "cookies", "storage"')
      .status(204)
      .send()
  })

  app.post(
    '/api/auth/change-password',
    {
      config: AUTHENTICATED,
      schema: {
        body: {
          type: 'object',
          properties: { currentPassword: passwordInput, newPassword: passwordInput },
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false
        }
      }
    },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body as { currentPassword: string; newPassword: string }
      const { session } = authOf(request)
      const context = auditContext(request)
      if (await isLoginThrottled(db, session.username, request.ip)) throw new AppError('TOO_MANY_REQUESTS')
      const { password_hash: hash } = await db
        .selectFrom('users')
        .select('password_hash')
        .where('id', '=', session.userId)
        .executeTakeFirstOrThrow()
      if (hash === null || !(await verifyPassword(currentPassword, hash))) {
        await recordFailure(db, 'login', session.username, request.ip)
        await recordAudit(db, context, {
          action: 'auth.password.change_failed',
          outcome: 'failure',
          actor: actorOf(request),
          target: { type: 'user', id: session.userId },
          details: { reason: 'wrong_current_password' }
        })
        throw new AppError('CURRENT_PASSWORD_INCORRECT')
      }
      const problems = checkPassword(newPassword, { username: session.username })
      if (problems.length > 0) throw new AppError('PASSWORD_POLICY', { problems, maxLength: PASSWORD_MAX_LENGTH })

      const newHash = await hashPassword(newPassword)
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('users')
          .set({ password_hash: newHash, password_changed_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
          .where('id', '=', session.userId)
          .execute()
        const ended = await revokeUserSessions(trx, session.userId, 'password_changed', session.sessionId)
        await recordAudit(trx, context, {
          action: 'auth.password.changed',
          outcome: 'success',
          actor: actorOf(request),
          target: { type: 'user', id: session.userId },
          details: { otherSessionsEnded: ended }
        })
      })
      return reply.status(204).send()
    }
  )

  app.post(
    '/api/auth/setup-password',
    {
      config: PUBLIC,
      schema: {
        body: {
          type: 'object',
          properties: {
            username: usernameInput,
            setupCode: { type: 'string', minLength: 1, maxLength: 64 },
            newPassword: passwordInput
          },
          required: ['username', 'setupCode', 'newPassword'],
          additionalProperties: false
        }
      }
    },
    async (request, reply) => {
      const body = request.body as { username: string; setupCode: string; newPassword: string }
      const context = auditContext(request)
      if (await isSetupThrottled(db, request.ip)) {
        await recordAudit(db, context, { action: 'auth.setup.throttled', outcome: 'denied', actor: null })
        throw new AppError('TOO_MANY_REQUESTS')
      }
      const key = usernameKey(body.username)
      const user = await db.selectFrom('users').select(['id', 'username', 'status']).where('username', '=', key).executeTakeFirst()
      const valid = user?.status === 'active' && (await checkSetupCode(db, user.id, body.setupCode))
      if (user === undefined || !valid) {
        await recordFailure(db, 'setup', key, request.ip)
        await recordAudit(db, context, {
          action: 'auth.setup.failed',
          outcome: 'failure',
          actor: null,
          target: user === undefined ? undefined : { type: 'user', id: user.id }
        })
        throw new AppError('INVALID_SETUP_CODE')
      }
      // Checked before the code is used up, so a rejected password can be retried with the same code.
      const problems = checkPassword(body.newPassword, { username: user.username })
      if (problems.length > 0) throw new AppError('PASSWORD_POLICY', { problems, maxLength: PASSWORD_MAX_LENGTH })

      const newHash = await hashPassword(body.newPassword)
      await db.transaction().execute(async (trx) => {
        // Re-checked under a row lock: two concurrent uses of one code cannot both succeed.
        if (!(await checkSetupCode(trx, user.id, body.setupCode))) throw new AppError('INVALID_SETUP_CODE')
        await deleteSetupCode(trx, user.id)
        await trx
          .updateTable('users')
          .set({ password_hash: newHash, password_changed_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
          .where('id', '=', user.id)
          .execute()
        const ended = await revokeUserSessions(trx, user.id, 'password_setup')
        await recordAudit(trx, context, {
          action: 'auth.setup.completed',
          outcome: 'success',
          actor: { id: user.id, username: user.username },
          target: { type: 'user', id: user.id },
          details: { sessionsEnded: ended }
        })
      })
      return reply.status(204).send()
    }
  )
}
