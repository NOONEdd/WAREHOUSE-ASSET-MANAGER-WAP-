import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { AppError } from '../../appError.js'
import { recordAudit } from '../../audit/audit.js'
import {
  confirmEnrollment,
  mfaState,
  removeMfa,
  replaceRecoveryCodes,
  serverUnixSeconds,
  startEnrollment,
  verifySecondFactor
} from '../../auth/mfa.js'
import { verifyPassword } from '../../auth/passwords.js'
import type { SecretKey } from '../../auth/secretBox.js'
import { markSessionMfaVerified, revokeUserSessions } from '../../auth/sessions.js'
import { isLoginThrottled, recordFailure } from '../../auth/throttle.js'
import type { Database } from '../../db/connection.js'
import { authOf } from '../authorization.js'
import { actorOf, auditContext } from '../requestContext.js'
import { enrollmentStartSchema, mfaCodeInput, recoveryCodesSchema } from './authRoutes.js'
import { nullableDateTime } from './schemas.js'

// The signed-in user's own multi-factor settings
// (docs/security/identity-and-access.md §3.2.4). Every change requires full
// re-authentication first (ASVS 5.0.0 V7.5.1): the password, plus a current
// code once an authenticator is enrolled. Enrolling, replacing or removing
// ends the user's other sessions (V7.4.3).

const AUTHENTICATED = { access: { kind: 'authenticated' } } as const
const passwordInput = { type: 'string', minLength: 1, maxLength: 1024 } as const

const reauthBody = {
  type: 'object',
  properties: { currentPassword: passwordInput, code: mfaCodeInput },
  required: ['currentPassword', 'code'],
  additionalProperties: false
} as const

const mfaStateSchema = {
  type: 'object',
  properties: {
    enrolled: { type: 'boolean' },
    required: { type: 'boolean' },
    locked: { type: 'boolean' },
    enrolledAt: nullableDateTime,
    recoveryCodesRemaining: { type: ['integer', 'null'] }
  },
  required: ['enrolled', 'required', 'locked', 'enrolledAt', 'recoveryCodesRemaining'],
  additionalProperties: false
} as const

const recoveryCodesResponse = {
  type: 'object',
  properties: { recoveryCodes: recoveryCodesSchema },
  required: ['recoveryCodes'],
  additionalProperties: false
} as const

export function registerMfaRoutes(app: FastifyInstance, options: { readonly db: Kysely<Database>; readonly mfaKey: SecretKey }): void {
  const { db, mfaKey } = options

  /** Password, then (when `code` is given or required) a current second factor. */
  async function reauthenticate(request: FastifyRequest, password: string, code: string | undefined): Promise<void> {
    const { session } = authOf(request)
    const context = auditContext(request)
    const target = { type: 'user', id: session.userId }
    if (await isLoginThrottled(db, session.username, request.ip)) throw new AppError('TOO_MANY_REQUESTS')
    const { password_hash: hash } = await db.selectFrom('users').select('password_hash').where('id', '=', session.userId).executeTakeFirstOrThrow()
    if (hash === null || !(await verifyPassword(password, hash))) {
      await recordFailure(db, 'login', session.username, request.ip)
      await recordAudit(db, context, { action: 'auth.reauth.failed', outcome: 'failure', actor: actorOf(request), target, details: { reason: 'wrong_password' } })
      throw new AppError('CURRENT_PASSWORD_INCORRECT')
    }
    if (code === undefined) return
    const result = await verifySecondFactor(db, mfaKey, session.userId, code, serverUnixSeconds())
    if (result.ok) return
    await recordAudit(db, context, {
      action: result.justLocked ? 'auth.mfa.locked' : 'auth.mfa.failed',
      outcome: 'failure',
      actor: actorOf(request),
      target,
      details: { step: 'reauthentication' }
    })
    throw new AppError(result.locked ? 'MFA_LOCKED' : 'INVALID_MFA_CODE')
  }

  app.get('/api/me/mfa', { config: AUTHENTICATED, schema: { response: { 200: mfaStateSchema } } }, async (request) =>
    mfaState(db, authOf(request).session.userId)
  )

  app.post(
    '/api/me/mfa/enroll/start',
    {
      config: AUTHENTICATED,
      schema: {
        body: {
          type: 'object',
          properties: { currentPassword: passwordInput, code: mfaCodeInput },
          required: ['currentPassword'],
          additionalProperties: false
        },
        response: { 200: enrollmentStartSchema }
      }
    },
    async (request) => {
      const body = request.body as { currentPassword: string; code?: string }
      const { session } = authOf(request)
      const state = await mfaState(db, session.userId)
      // Replacing an authenticator needs the current one (or a recovery code).
      if (state.enrolled && body.code === undefined) throw new AppError('VALIDATION_FAILED', { field: 'code', reason: 'a current code is required to replace the authenticator' })
      await reauthenticate(request, body.currentPassword, state.enrolled ? body.code : undefined)
      const started = await startEnrollment(db, mfaKey, { id: session.userId, username: session.username })
      await recordAudit(db, auditContext(request), {
        action: 'auth.mfa.enrollment_started',
        outcome: 'success',
        actor: actorOf(request),
        target: { type: 'user', id: session.userId },
        details: { step: 'self_service', replacing: state.enrolled }
      })
      return started
    }
  )

  app.post(
    '/api/me/mfa/enroll/confirm',
    {
      config: AUTHENTICATED,
      schema: {
        body: { type: 'object', properties: { code: mfaCodeInput }, required: ['code'], additionalProperties: false },
        response: { 200: recoveryCodesResponse }
      }
    },
    async (request) => {
      const { code } = request.body as { code: string }
      const { session } = authOf(request)
      return db.transaction().execute(async (trx) => {
        const confirmed = await confirmEnrollment(trx, mfaKey, session.userId, code, serverUnixSeconds(), { replace: true })
        if (confirmed === null) throw new AppError('INVALID_MFA_CODE')
        const otherSessionsEnded = await revokeUserSessions(trx, session.userId, 'mfa_changed', session.sessionId)
        await markSessionMfaVerified(trx, session.sessionId)
        await recordAudit(trx, auditContext(request), {
          action: confirmed.replaced ? 'auth.mfa.replaced' : 'auth.mfa.enrolled',
          outcome: 'success',
          actor: actorOf(request),
          target: { type: 'user', id: session.userId },
          details: { step: 'self_service', otherSessionsEnded }
        })
        return { recoveryCodes: confirmed.recoveryCodes }
      })
    }
  )

  app.post(
    '/api/me/mfa/recovery-codes',
    { config: AUTHENTICATED, schema: { body: reauthBody, response: { 200: recoveryCodesResponse } } },
    async (request) => {
      const body = request.body as { currentPassword: string; code: string }
      const { session } = authOf(request)
      if (!(await mfaState(db, session.userId)).enrolled) throw new AppError('VALIDATION_FAILED', { reason: 'no authenticator is set up' })
      await reauthenticate(request, body.currentPassword, body.code)
      return db.transaction().execute(async (trx) => {
        const recoveryCodes = await replaceRecoveryCodes(trx, session.userId)
        await recordAudit(trx, auditContext(request), {
          action: 'auth.mfa.recovery_codes_regenerated',
          outcome: 'success',
          actor: actorOf(request),
          target: { type: 'user', id: session.userId }
        })
        return { recoveryCodes }
      })
    }
  )

  app.post('/api/me/mfa/disable', { config: AUTHENTICATED, schema: { body: reauthBody } }, async (request, reply) => {
    const body = request.body as { currentPassword: string; code: string }
    const { session } = authOf(request)
    const state = await mfaState(db, session.userId)
    if (!state.enrolled) throw new AppError('VALIDATION_FAILED', { reason: 'no authenticator is set up' })
    // §3.2.1: never optional for the owner, administrators, or under the all-users policy.
    if (state.required) throw new AppError('FORBIDDEN', { reason: 'multi-factor authentication is required for this account' })
    await reauthenticate(request, body.currentPassword, body.code)
    await db.transaction().execute(async (trx) => {
      // Re-checked under the user's row lock — the lock an appointment takes —
      // so an appointment cannot slip in between the check and the removal (O-12).
      await trx.selectFrom('users').select('id').where('id', '=', session.userId).forUpdate().executeTakeFirstOrThrow()
      if ((await mfaState(trx, session.userId)).required) {
        throw new AppError('FORBIDDEN', { reason: 'multi-factor authentication is required for this account' })
      }
      await removeMfa(trx, session.userId)
      const otherSessionsEnded = await revokeUserSessions(trx, session.userId, 'mfa_changed', session.sessionId)
      await recordAudit(trx, auditContext(request), {
        action: 'auth.mfa.removed',
        outcome: 'success',
        actor: actorOf(request),
        target: { type: 'user', id: session.userId },
        details: { otherSessionsEnded }
      })
    })
    return reply.status(204).send()
  })
}
