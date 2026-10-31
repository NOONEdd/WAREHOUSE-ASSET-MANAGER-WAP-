import { sql, type Kysely } from 'kysely'
import type { Database } from './db/connection.js'

// Periodic clean-up of short-lived security records. It never touches the
// audit trail or any business data. Retention:
//   sessions           7 days after they ended or expired (users can review recent sessions)
//   auth_failures      1 day (throttling only looks back 15 minutes)
//   idempotency_keys   1 day (retries happen within minutes)
//   setup codes        once expired
//   sign-in challenges and pending authenticator enrolments   once expired

export const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000

// Import retention (decision O-16, PD-09) runs separately, once at start-up and then daily: the periods
// (7/7/90 days) are constants inside wam.apply_import_retention(), so a missed day is caught up by the
// next run, and each run writes one import.retention_applied audit event (Phase 1D alerts on none in
// 48 hours). It runs whether or not imports are enabled.
export const IMPORT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface MaintenanceResult {
  readonly sessions: number
  readonly authFailures: number
  readonly idempotencyKeys: number
  readonly setupCodes: number
  readonly loginChallenges: number
  readonly mfaEnrollments: number
}

export async function runMaintenance(db: Kysely<Database>): Promise<MaintenanceResult> {
  const sessions = await db
    .deleteFrom('sessions')
    .where((eb) =>
      eb.or([
        eb('revoked_at', '<', sql<Date>`now() - interval '7 days'`),
        eb('expires_at', '<', sql<Date>`now() - interval '7 days'`)
      ])
    )
    .executeTakeFirst()
  const authFailures = await db
    .deleteFrom('auth_failures')
    .where('occurred_at', '<', sql<Date>`now() - interval '1 day'`)
    .executeTakeFirst()
  const idempotencyKeys = await db
    .deleteFrom('idempotency_keys')
    .where('created_at', '<', sql<Date>`now() - interval '1 day'`)
    .executeTakeFirst()
  const setupCodes = await db.deleteFrom('password_setup_codes').where('expires_at', '<', sql<Date>`now()`).executeTakeFirst()
  const loginChallenges = await db.deleteFrom('login_challenges').where('expires_at', '<', sql<Date>`now()`).executeTakeFirst()
  const mfaEnrollments = await db.deleteFrom('mfa_enrollments').where('expires_at', '<', sql<Date>`now()`).executeTakeFirst()
  return {
    sessions: Number(sessions.numDeletedRows),
    authFailures: Number(authFailures.numDeletedRows),
    idempotencyKeys: Number(idempotencyKeys.numDeletedRows),
    setupCodes: Number(setupCodes.numDeletedRows),
    loginChallenges: Number(loginChallenges.numDeletedRows),
    mfaEnrollments: Number(mfaEnrollments.numDeletedRows)
  }
}
