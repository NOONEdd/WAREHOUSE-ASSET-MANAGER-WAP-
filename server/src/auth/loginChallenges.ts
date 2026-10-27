import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/connection.js'
import { newSessionToken, SESSION_TOKEN_PATTERN, sha256 } from './secrets.js'

// The second sign-in step (docs/security/identity-and-access.md §3.2.4). A
// correct password for an account that needs a second factor yields a
// short-lived challenge, not a session. The client holds a random reference
// in a cookie; the database holds only its SHA-256. One challenge per user.

export type ChallengePurpose = 'verify' | 'enroll'

/** E-17: time to enter a code after the password, or to finish setting up an app. */
export const CHALLENGE_TTL_MINUTES: Readonly<Record<ChallengePurpose, number>> = { verify: 5, enroll: 10 }

export interface LoginChallenge {
  readonly id: number
  readonly userId: number
  readonly purpose: ChallengePurpose
}

export async function createLoginChallenge(
  trx: Kysely<Database>,
  userId: number,
  purpose: ChallengePurpose
): Promise<{ readonly token: string; readonly maxAgeSeconds: number }> {
  await deleteUserLoginChallenges(trx, userId)
  const token = newSessionToken()
  const minutes = CHALLENGE_TTL_MINUTES[purpose]
  await trx
    .insertInto('login_challenges')
    .values({
      token_hash: sha256(token),
      user_id: userId,
      purpose,
      expires_at: sql<Date>`now() + make_interval(mins => ${minutes})`
    })
    .execute()
  return { token, maxAgeSeconds: minutes * 60 }
}

/** The live challenge for a token, or null if unknown or expired. */
export async function findLoginChallenge(db: Kysely<Database>, token: string | null): Promise<LoginChallenge | null> {
  if (token === null || !SESSION_TOKEN_PATTERN.test(token)) return null
  const row = await db
    .selectFrom('login_challenges')
    .select(['id', 'user_id', 'purpose'])
    .where('token_hash', '=', sha256(token))
    .where('expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst()
  return row === undefined ? null : { id: row.id, userId: row.user_id, purpose: row.purpose }
}

/** True if this call removed it: a challenge completes at most one sign-in, even under concurrent requests. */
export async function deleteLoginChallenge(db: Kysely<Database>, id: number): Promise<boolean> {
  const result = await db.deleteFrom('login_challenges').where('id', '=', id).executeTakeFirst()
  return Number(result.numDeletedRows) > 0
}

/** Called whenever a user's credentials change: a half-finished sign-in must not survive it. */
export async function deleteUserLoginChallenges(db: Kysely<Database>, userId: number): Promise<void> {
  await db.deleteFrom('login_challenges').where('user_id', '=', userId).execute()
}
