import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/connection.js'
import { newSetupCode, normalizeSetupCode, sameHash, sha256 } from './secrets.js'

// One-time setup codes: how a user sets their first password, and how a
// reset works (docs/security/identity-and-access.md §3; ASVS 5.0.0 V6.4.1).
// One code per user; issuing replaces the previous one. Callers issue and
// consume inside the transaction of the surrounding change.

export const SETUP_CODE_TTL_HOURS = 24

/** Issues (or replaces) the user's code and returns it; only its hash is stored. */
export async function issueSetupCode(db: Kysely<Database>, userId: number, createdBy: number | null): Promise<string> {
  const code = newSetupCode()
  await db
    .insertInto('password_setup_codes')
    .values({
      user_id: userId,
      code_hash: sha256(code),
      expires_at: sql<Date>`now() + make_interval(hours => ${SETUP_CODE_TTL_HOURS})`,
      created_at: sql<Date>`now()`,
      created_by: createdBy
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        code_hash: (eb) => eb.ref('excluded.code_hash'),
        expires_at: (eb) => eb.ref('excluded.expires_at'),
        created_at: (eb) => eb.ref('excluded.created_at'),
        created_by: (eb) => eb.ref('excluded.created_by')
      })
    )
    .execute()
  return code
}

/** True if `input` is the user's live code. Locks the row; does not consume it. */
export async function checkSetupCode(db: Kysely<Database>, userId: number, input: string): Promise<boolean> {
  const code = normalizeSetupCode(input)
  if (code === null) return false
  const row = await db
    .selectFrom('password_setup_codes')
    .select('code_hash')
    .where('user_id', '=', userId)
    .where('expires_at', '>', sql<Date>`now()`)
    .forUpdate()
    .executeTakeFirst()
  return row !== undefined && sameHash(row.code_hash, sha256(code))
}

export async function deleteSetupCode(db: Kysely<Database>, userId: number): Promise<void> {
  await db.deleteFrom('password_setup_codes').where('user_id', '=', userId).execute()
}
