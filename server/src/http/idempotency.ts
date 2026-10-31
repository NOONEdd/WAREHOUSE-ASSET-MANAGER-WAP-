import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely, Transaction } from 'kysely'
import { AppError } from '../appError.js'
import type { Database } from '../db/connection.js'
import { authOf } from './authorization.js'

// Retry safety for the online-only application (decision D-05;
// docs/security/identity-and-access.md §6.1). A state-changing request
// carries an Idempotency-Key (UUID). The key, a fingerprint of the request
// and the response are written in the SAME transaction as the change:
//
//   - retry after a lost response   → the stored response is replayed;
//   - concurrent duplicate          → its INSERT waits on the first one's
//                                     uncommitted key row, then replays it;
//   - the change fails              → the transaction rolls back, nothing is
//                                     stored, and a retry runs it once;
//   - same key, different request   → 422 IDEMPOTENCY_KEY_REUSED.
//
// Keys are per user and kept 24 hours (src/maintenance.ts).
//
// Personal data (decision PD-05, review finding S-2): a response that contains the name of a person without
// a WAM account names that person as its subject. Erasing the person replaces every such stored response
// with an id-only tombstone and its fingerprint with TOMBSTONE_FINGERPRINT, in the erasing transaction
// (migration 0008). A later request with such a key replays the tombstone, whatever its body: the
// original request can no longer be compared, because its fingerprint was a hash of the name. A replay
// that arrives while an erasure is tombstoning its row waits, as a concurrent duplicate does: its INSERT …
// ON CONFLICT waits for the transaction changing the conflicting row (tested: personPrivacy.test.ts).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface IdempotentResult<T> {
  readonly status: number
  readonly body: T
  /** The person whose name `body` contains, if any (see above). */
  readonly subjectPersonId?: number
}

/** What wam.persons_tombstone_idempotency() writes in place of an erased person's request fingerprint. */
export const TOMBSTONE_FINGERPRINT = Buffer.alloc(32)

/** JSON with object keys sorted, so the fingerprint does not depend on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function requestFingerprint(request: FastifyRequest): Buffer {
  return createHash('sha256').update(`${request.method}\n${request.url}\n${canonical(request.body ?? null)}`).digest()
}

/**
 * Runs `work` in a transaction guarded by the request's Idempotency-Key and
 * sends the result (or the replayed result) on `reply`.
 */
export async function sendIdempotent<T>(
  db: Kysely<Database>,
  request: FastifyRequest,
  reply: FastifyReply,
  work: (trx: Transaction<Database>) => Promise<IdempotentResult<T>>
): Promise<FastifyReply> {
  const header = request.headers['idempotency-key']
  if (typeof header !== 'string' || !UUID.test(header)) throw new AppError('IDEMPOTENCY_KEY_REQUIRED')
  const key = header.toLowerCase()
  const userId = authOf(request).session.userId
  const fingerprint = requestFingerprint(request)

  const outcome = await db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('idempotency_keys')
      .values({ user_id: userId, key, fingerprint })
      .onConflict((oc) => oc.columns(['user_id', 'key']).doNothing())
      .returning('key')
      .executeTakeFirst()
    if (inserted === undefined) {
      const stored = await trx
        .selectFrom('idempotency_keys')
        .select(['fingerprint', 'status_code', 'response_body'])
        .where('user_id', '=', userId)
        .where('key', '=', key)
        .executeTakeFirstOrThrow()
      const tombstoned = stored.fingerprint.equals(TOMBSTONE_FINGERPRINT)
      if ((!tombstoned && !stored.fingerprint.equals(fingerprint)) || stored.status_code === null) throw new AppError('IDEMPOTENCY_KEY_REUSED')
      return { status: stored.status_code, body: stored.response_body, replayed: true }
    }
    const result = await work(trx)
    await trx
      .updateTable('idempotency_keys')
      .set({
        status_code: result.status,
        response_body: JSON.stringify(result.body ?? null),
        ...(result.subjectPersonId === undefined ? {} : { subject_person_id: String(result.subjectPersonId) })
      })
      .where('user_id', '=', userId)
      .where('key', '=', key)
      .execute()
    return { ...result, replayed: false }
  })
  return reply.header('idempotency-replayed', String(outcome.replayed)).status(outcome.status).send(outcome.body)
}
