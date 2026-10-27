import { randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { AppError } from '../appError.js'
import type { Database } from '../db/connection.js'
import { sha256 } from './secrets.js'
import { open, seal, totpSecretContext, type SecretKey } from './secretBox.js'
import { base32Encode, newTotpSecret, otpauthUri, TOTP_CODE_PATTERN, verifyTotp } from './totp.js'

// Multi-factor authentication (docs/security/identity-and-access.md §3.2;
// decision O-07): who must use it, enrolment, verification with single use
// and the failure lock, recovery codes. The HTTP layer decides what a result
// means for the request; nothing here creates sessions.

/** Consecutive wrong codes that lock second-factor sign-in until a password reset (E-14). */
export const MFA_MAX_FAILED_ATTEMPTS = 10
export const RECOVERY_CODE_COUNT = 10
export const ENROLLMENT_TTL_MINUTES = 10
/** The issuer name an authenticator app shows next to the account. */
export const MFA_ISSUER = 'WAM'

/**
 * Whether the role or the policy requires a second factor for user `u` (an
 * alias the surrounding query must define): the owner, administrators
 * (any system profile, as rules A2–A4 count them), or everyone under the
 * `all_users` policy. A missing policy row counts as `all_users` (fail closed).
 */
export const POLICY_REQUIRES_MFA = sql<boolean>`(
  u.is_owner
  OR EXISTS (SELECT 1 FROM wam.user_system_profiles usp WHERE usp.user_id = u.id)
  OR COALESCE((SELECT sp.mfa_required_for <> 'privileged' FROM wam.security_policy sp), true)
)`

/** Whether user `u` has an authenticator enrolled. */
export const MFA_ENROLLED = sql<boolean>`EXISTS (SELECT 1 FROM wam.user_mfa m WHERE m.user_id = u.id)`

export interface MfaState {
  readonly enrolled: boolean
  /** Required by role or policy (enrolment cannot then be removed). */
  readonly required: boolean
  readonly locked: boolean
  readonly enrolledAt: Date | null
  readonly recoveryCodesRemaining: number | null
}

export async function mfaState(db: Kysely<Database>, userId: number): Promise<MfaState> {
  const row = await db
    .selectFrom('users as u')
    .leftJoin('user_mfa as m', 'm.user_id', 'u.id')
    .select([
      POLICY_REQUIRES_MFA.as('required'),
      'm.enrolled_at',
      'm.failed_attempts',
      sql<number>`(SELECT count(*)::int FROM wam.mfa_recovery_codes c WHERE c.user_id = u.id AND c.used_at IS NULL)`.as('remaining')
    ])
    .where('u.id', '=', userId)
    .executeTakeFirstOrThrow()
  const enrolled = row.enrolled_at !== null
  return {
    enrolled,
    required: row.required,
    locked: enrolled && (row.failed_attempts ?? 0) >= MFA_MAX_FAILED_ATTEMPTS,
    enrolledAt: row.enrolled_at,
    recoveryCodesRemaining: enrolled ? row.remaining : null
  }
}

// --- enrolment -----------------------------------------------------------------

export interface EnrollmentStart {
  /** Base32, for manual entry in the app. */
  readonly secret: string
  /** For a QR code. */
  readonly otpauthUri: string
  readonly expiresInMinutes: number
}

/** Creates (or replaces) the user's pending enrolment. Nothing is active until confirmed. */
export async function startEnrollment(db: Kysely<Database>, key: SecretKey, user: { readonly id: number; readonly username: string }): Promise<EnrollmentStart> {
  const secret = newTotpSecret()
  const sealed = seal(key, secret, totpSecretContext(user.id))
  const values = {
    user_id: user.id,
    totp_secret: sealed,
    totp_key_id: key.id,
    created_at: sql<Date>`now()`,
    expires_at: sql<Date>`now() + make_interval(mins => ${ENROLLMENT_TTL_MINUTES})`
  }
  await db
    .insertInto('mfa_enrollments')
    .values(values)
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        totp_secret: (eb) => eb.ref('excluded.totp_secret'),
        totp_key_id: (eb) => eb.ref('excluded.totp_key_id'),
        created_at: (eb) => eb.ref('excluded.created_at'),
        expires_at: (eb) => eb.ref('excluded.expires_at')
      })
    )
    .execute()
  return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, user.username, MFA_ISSUER), expiresInMinutes: ENROLLMENT_TTL_MINUTES }
}

/**
 * Activates the pending enrolment if `code` comes from it, and issues fresh
 * recovery codes. With `replace: false` (sign-in enrolment) an existing
 * enrolment is never overwritten. Returns null for a wrong code; wrong codes
 * here are not counted, because whoever holds a pending enrolment knows its
 * secret. Run inside the caller's transaction.
 */
export async function confirmEnrollment(
  trx: Kysely<Database>,
  key: SecretKey,
  userId: number,
  code: string,
  unixSeconds: number,
  options: { readonly replace: boolean }
): Promise<{ readonly recoveryCodes: string[]; readonly replaced: boolean } | null> {
  const pending = await trx
    .selectFrom('mfa_enrollments')
    .select(['totp_secret', 'totp_key_id'])
    .where('user_id', '=', userId)
    .where('expires_at', '>', sql<Date>`now()`)
    .forUpdate()
    .executeTakeFirst()
  if (pending === undefined) throw new AppError('MFA_ENROLLMENT_EXPIRED')
  const step = verifyTotp(openSecret(key, pending.totp_key_id, pending.totp_secret, userId), normalizeTotpCode(code), unixSeconds, 0)
  if (step === null) return null

  const existing = await trx.selectFrom('user_mfa').select('user_id').where('user_id', '=', userId).forUpdate().executeTakeFirst()
  if (existing !== undefined) {
    if (!options.replace) throw new AppError('MFA_ALREADY_ENROLLED')
    await trx.deleteFrom('user_mfa').where('user_id', '=', userId).execute()
  }
  await trx
    .insertInto('user_mfa')
    .values({ user_id: userId, totp_secret: pending.totp_secret, totp_key_id: pending.totp_key_id, totp_last_step: step })
    .execute()
  await trx.deleteFrom('mfa_enrollments').where('user_id', '=', userId).execute()
  return { recoveryCodes: await replaceRecoveryCodes(trx, userId), replaced: existing !== undefined }
}

// --- verification --------------------------------------------------------------

export type SecondFactorResult =
  | { readonly ok: true; readonly method: 'totp' | 'recovery_code'; readonly recoveryCodesRemaining: number }
  | { readonly ok: false; readonly locked: boolean; readonly justLocked: boolean }

/**
 * Checks an authenticator code or a recovery code in its own transaction,
 * so that a failure is counted even though the request then fails. Single
 * use: an accepted code's step (or the recovery code) can never be accepted
 * again, not even by a concurrent request (row lock).
 */
export async function verifySecondFactor(
  db: Kysely<Database>,
  key: SecretKey,
  userId: number,
  input: string,
  unixSeconds: number
): Promise<SecondFactorResult> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('user_mfa')
      .select(['totp_secret', 'totp_key_id', 'totp_last_step', 'failed_attempts'])
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst()
    if (row === undefined) return { ok: false, locked: false, justLocked: false }
    if (row.failed_attempts >= MFA_MAX_FAILED_ATTEMPTS) return { ok: false, locked: true, justLocked: false }

    let method: 'totp' | 'recovery_code' | null = null
    const totp = normalizeTotpCode(input)
    if (TOTP_CODE_PATTERN.test(totp)) {
      // A wrong key throws here: a configuration error, never counted against the user.
      const step = verifyTotp(openSecret(key, row.totp_key_id, row.totp_secret, userId), totp, unixSeconds, Number(row.totp_last_step))
      if (step !== null) {
        await trx.updateTable('user_mfa').set({ totp_last_step: step, failed_attempts: 0 }).where('user_id', '=', userId).execute()
        method = 'totp'
      }
    } else {
      const recovery = normalizeRecoveryCode(input)
      const used =
        recovery === null
          ? undefined
          : await trx
              .updateTable('mfa_recovery_codes')
              .set({ used_at: sql<Date>`now()` })
              .where('user_id', '=', userId)
              .where('code_hash', '=', sha256(recovery))
              .where('used_at', 'is', null)
              .returning('user_id')
              .executeTakeFirst()
      if (used !== undefined) {
        await trx.updateTable('user_mfa').set({ failed_attempts: 0 }).where('user_id', '=', userId).execute()
        method = 'recovery_code'
      }
    }

    if (method === null) {
      const failed = row.failed_attempts + 1
      await trx.updateTable('user_mfa').set({ failed_attempts: failed }).where('user_id', '=', userId).execute()
      return { ok: false, locked: failed >= MFA_MAX_FAILED_ATTEMPTS, justLocked: failed === MFA_MAX_FAILED_ATTEMPTS }
    }
    const { remaining } = await trx
      .selectFrom('mfa_recovery_codes')
      .select(sql<number>`count(*)::int`.as('remaining'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow()
    return { ok: true, method, recoveryCodesRemaining: remaining }
  })
}

function openSecret(key: SecretKey, keyId: string, sealed: Buffer, userId: number): Buffer {
  if (keyId !== key.id) {
    throw new Error('WAM_MFA_ENCRYPTION_KEY is not the key that sealed this authenticator secret (see identity-and-access §3.2.5)')
  }
  return open(key, sealed, totpSecretContext(userId))
}

/** Authenticator codes as typed: spaces allowed ("123 456"). */
function normalizeTotpCode(input: string): string {
  return input.replace(/\s/g, '')
}

// --- recovery codes ------------------------------------------------------------

/** 120 bits as 24 base32 characters in groups of four. */
export function newRecoveryCode(): string {
  return (base32Encode(randomBytes(15)).match(/.{4}/g) ?? []).join('-')
}

/** Accepts a recovery code as typed: any case, with or without dashes and spaces. */
export function normalizeRecoveryCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '')
  return /^[A-Z2-7]{24}$/.test(compact) ? (compact.match(/.{4}/g) ?? []).join('-') : null
}

/** Invalidates all earlier codes and returns new ones (shown once; only hashes are stored). */
export async function replaceRecoveryCodes(trx: Kysely<Database>, userId: number): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode)
  await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute()
  await trx
    .insertInto('mfa_recovery_codes')
    .values(codes.map((code) => ({ user_id: userId, code_hash: sha256(code) })))
    .execute()
  return codes
}

// --- removal and unlocking -----------------------------------------------------

/** Removes the authenticator, its recovery codes and any pending enrolment; true if one was enrolled. */
export async function removeMfa(trx: Kysely<Database>, userId: number): Promise<boolean> {
  await trx.deleteFrom('mfa_enrollments').where('user_id', '=', userId).execute()
  const result = await trx.deleteFrom('user_mfa').where('user_id', '=', userId).executeTakeFirst()
  return Number(result.numDeletedRows) > 0
}

/** A password reset ends a lock: whoever was guessing codes no longer has the password. */
export async function clearMfaFailures(trx: Kysely<Database>, userId: number): Promise<void> {
  await trx.updateTable('user_mfa').set({ failed_attempts: 0 }).where('user_id', '=', userId).execute()
}

/** The server's clock, the only time source for authenticator codes (ASVS V6.5.8). */
export function serverUnixSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
