import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/connection.js'

// Login and setup-code throttling (docs/security/identity-and-access.md
// §3.1; ASVS 5.0.0 V6.1.1, V6.3.1). Sliding 15-minute windows over recorded
// failures: nothing is ever locked permanently, and one address cannot block
// many accounts.

export const THROTTLE_WINDOW_MINUTES = 15
export const LOGIN_LIMITS = { perUsernameAndAddress: 5, perUsername: 20, perAddress: 50 } as const
export const SETUP_LIMITS = { perAddress: 20 } as const

/** Usernames are compared lower-case; anything longer than a username cannot match one. */
export function usernameKey(username: string): string {
  return username.trim().toLowerCase().slice(0, 64)
}

export async function recordFailure(
  db: Kysely<Database>,
  kind: 'login' | 'setup',
  username: string,
  sourceIp: string
): Promise<void> {
  await db.insertInto('auth_failures').values({ kind, username_key: usernameKey(username), source_ip: sourceIp }).execute()
}

export async function isLoginThrottled(db: Kysely<Database>, username: string, sourceIp: string): Promise<boolean> {
  const key = usernameKey(username)
  const counts = await db
    .selectFrom('auth_failures')
    .select([
      sql<number>`count(*) FILTER (WHERE username_key = ${key} AND source_ip = ${sourceIp}::inet)::int`.as('pair'),
      sql<number>`count(*) FILTER (WHERE username_key = ${key})::int`.as('username'),
      sql<number>`count(*) FILTER (WHERE source_ip = ${sourceIp}::inet)::int`.as('address')
    ])
    .where('kind', '=', 'login')
    .where('occurred_at', '>', sql<Date>`now() - make_interval(mins => ${THROTTLE_WINDOW_MINUTES})`)
    .where((eb) => eb.or([eb('username_key', '=', key), eb('source_ip', '=', sql<string>`${sourceIp}::inet`)]))
    .executeTakeFirstOrThrow()
  return (
    counts.pair >= LOGIN_LIMITS.perUsernameAndAddress ||
    counts.username >= LOGIN_LIMITS.perUsername ||
    counts.address >= LOGIN_LIMITS.perAddress
  )
}

export async function isSetupThrottled(db: Kysely<Database>, sourceIp: string): Promise<boolean> {
  const { failures } = await db
    .selectFrom('auth_failures')
    .select(sql<number>`count(*)::int`.as('failures'))
    .where('kind', '=', 'setup')
    .where('source_ip', '=', sql<string>`${sourceIp}::inet`)
    .where('occurred_at', '>', sql<Date>`now() - make_interval(mins => ${THROTTLE_WINDOW_MINUTES})`)
    .executeTakeFirstOrThrow()
  return failures >= SETUP_LIMITS.perAddress
}

/** Used by owner recovery, so an attacker cannot keep the owner locked out. */
export async function clearLoginFailures(db: Kysely<Database>, username: string): Promise<number> {
  const result = await db.deleteFrom('auth_failures').where('username_key', '=', usernameKey(username)).executeTakeFirst()
  return Number(result.numDeletedRows)
}
