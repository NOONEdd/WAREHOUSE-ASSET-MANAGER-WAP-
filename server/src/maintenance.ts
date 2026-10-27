import { sql, type Kysely } from 'kysely'
import type { Database } from './db/connection.js'

// Periodic clean-up of short-lived security records. It never touches the
// audit trail or any business data. Retention:
//   sessions           7 days after they ended or expired (users can review recent sessions)
//   auth_failures      1 day (throttling only looks back 15 minutes)
//   idempotency_keys   1 day (retries happen within minutes)
//   setup codes        once expired

export const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000

export interface MaintenanceResult {
  readonly sessions: number
  readonly authFailures: number
  readonly idempotencyKeys: number
  readonly setupCodes: number
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
  return {
    sessions: Number(sessions.numDeletedRows),
    authFailures: Number(authFailures.numDeletedRows),
    idempotencyKeys: Number(idempotencyKeys.numDeletedRows),
    setupCodes: Number(setupCodes.numDeletedRows)
  }
}
