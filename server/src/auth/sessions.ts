import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/connection.js'
import { newSessionToken, SESSION_TOKEN_PATTERN, sha256 } from './secrets.js'

// Server-side sessions (docs/security/identity-and-access.md §4). The client
// holds a random reference token; the database holds only its SHA-256.
// Validity is decided here, on every request, from the database clock.

export interface SessionSettings {
  readonly idleMinutes: number
  readonly absoluteHours: number
  /** A new login beyond this ends the user's oldest sessions. */
  readonly maxPerUser: number
}

export const MAX_SESSIONS_PER_USER = 5

export type RevokeReason =
  | 'logout'
  | 'login_replaced'
  | 'session_limit'
  | 'password_changed'
  | 'password_setup'
  | 'setup_code_issued'
  | 'user_disabled'
  | 'admin_revoked'
  | 'user_revoked'
  | 'owner_recovery'
  | 'owner_cli'

export interface ActiveSession {
  readonly sessionId: number
  readonly userId: number
  readonly username: string
  readonly displayName: string
  readonly isOwner: boolean
}

/** Last-seen time is written at most once a minute per session. */
const TOUCH_INTERVAL_SECONDS = 60

export async function createSession(
  db: Kysely<Database>,
  userId: number,
  settings: SessionSettings,
  client: { readonly sourceIp: string | null; readonly userAgent: string | null }
): Promise<{ readonly token: string; readonly sessionId: number }> {
  const token = newSessionToken()
  const { id } = await db
    .insertInto('sessions')
    .values({
      token_hash: sha256(token),
      user_id: userId,
      expires_at: sql<Date>`now() + make_interval(hours => ${settings.absoluteHours})`,
      source_ip: client.sourceIp,
      user_agent: client.userAgent === null ? null : client.userAgent.slice(0, 300)
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  // Keep at most maxPerUser live sessions: end the oldest beyond that.
  await db
    .updateTable('sessions')
    .set({ revoked_at: sql<Date>`now()`, revoked_reason: 'session_limit' })
    .where(
      'id',
      'in',
      db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .offset(settings.maxPerUser)
    )
    .execute()
  return { token, sessionId: id }
}

/** The session for a token, or null if unknown, ended, expired, idle too long, or its user is disabled. */
export async function findActiveSession(
  db: Kysely<Database>,
  token: string,
  settings: SessionSettings
): Promise<ActiveSession | null> {
  if (!SESSION_TOKEN_PATTERN.test(token)) return null
  const row = await sessionLookupQuery(db, sha256(token), settings.idleMinutes).executeTakeFirst()
  if (row === undefined) return null
  if (row.stale) {
    await db.updateTable('sessions').set({ last_seen_at: sql<Date>`now()` }).where('id', '=', row.sessionId).execute()
  }
  return { sessionId: row.sessionId, userId: row.userId, username: row.username, displayName: row.displayName, isOwner: row.isOwner }
}

/** The per-request session query; exported so the performance check can EXPLAIN exactly this query. */
export function sessionLookupQuery(db: Kysely<Database>, tokenHash: Buffer, idleMinutes: number) {
  return db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select([
      's.id as sessionId',
      's.user_id as userId',
      'u.username',
      'u.display_name as displayName',
      'u.is_owner as isOwner',
      sql<boolean>`s.last_seen_at < now() - make_interval(secs => ${TOUCH_INTERVAL_SECONDS})`.as('stale')
    ])
    .where('s.token_hash', '=', tokenHash)
    .where('s.revoked_at', 'is', null)
    .where('s.expires_at', '>', sql<Date>`now()`)
    .where('s.last_seen_at', '>', sql<Date>`now() - make_interval(mins => ${idleMinutes})`)
    .where('u.status', '=', 'active')
}

/** Ends the session holding this token, whoever it belongs to; returns its user, if it was live. */
export async function revokeSessionByToken(
  db: Kysely<Database>,
  token: string,
  reason: RevokeReason
): Promise<{ readonly sessionId: number; readonly userId: number } | null> {
  if (!SESSION_TOKEN_PATTERN.test(token)) return null
  const row = await db
    .updateTable('sessions')
    .set({ revoked_at: sql<Date>`now()`, revoked_reason: reason })
    .where('token_hash', '=', sha256(token))
    .where('revoked_at', 'is', null)
    .returning(['id', 'user_id'])
    .executeTakeFirst()
  return row === undefined ? null : { sessionId: row.id, userId: row.user_id }
}

/** Ends every live session of a user (optionally keeping one); returns how many. */
export async function revokeUserSessions(
  db: Kysely<Database>,
  userId: number,
  reason: RevokeReason,
  keepSessionId?: number
): Promise<number> {
  let query = db
    .updateTable('sessions')
    .set({ revoked_at: sql<Date>`now()`, revoked_reason: reason })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
  if (keepSessionId !== undefined) query = query.where('id', '<>', keepSessionId)
  const result = await query.executeTakeFirst()
  return Number(result.numUpdatedRows)
}

export interface SessionSummary {
  readonly id: number
  readonly createdAt: Date
  readonly lastSeenAt: Date
  readonly expiresAt: Date
  readonly sourceIp: string | null
  readonly userAgent: string | null
}

/** Live (not ended, not expired, not idle) sessions of a user, newest first. */
export async function listUserSessions(
  db: Kysely<Database>,
  userId: number,
  settings: SessionSettings
): Promise<SessionSummary[]> {
  return db
    .selectFrom('sessions')
    .select([
      'id',
      'created_at as createdAt',
      'last_seen_at as lastSeenAt',
      'expires_at as expiresAt',
      'source_ip as sourceIp',
      'user_agent as userAgent'
    ])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .where('last_seen_at', '>', sql<Date>`now() - make_interval(mins => ${settings.idleMinutes})`)
    .orderBy('created_at', 'desc')
    .execute()
}
