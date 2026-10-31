import type { Kysely, Transaction } from 'kysely'
import type { Database } from './connection.js'
import { databaseFailureKind } from './failures.js'

/** COMMIT was sent, but the connection broke before PostgreSQL answered: the transaction may have committed. */
export class CommitOutcomeUnknownError extends Error {
  constructor(failure: unknown) {
    super('database connection lost during commit', { cause: failure })
    this.name = 'CommitOutcomeUnknownError'
  }
}

/**
 * Runs `fn` in one transaction and commits it, telling apart a failure before COMMIT (thrown as is; PostgreSQL
 * rolls the transaction back) from a connection lost while COMMIT was in flight (CommitOutcomeUnknownError).
 * A COMMIT that PostgreSQL answers with an error (for example a deferred constraint) is a definite failure and is
 * thrown as is.
 */
export async function inTransaction<T>(db: Kysely<Database>, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  const trx = await db.startTransaction().execute()
  let result: T
  try {
    result = await fn(trx)
  } catch (err) {
    await trx.rollback().execute().catch(() => undefined)
    throw err
  }
  try {
    await trx.commit().execute()
  } catch (err) {
    // Kysely's commit() releases the connection only when COMMIT succeeds; rollback() always releases it (and
    // pg-pool discards a broken client instead of reusing it). After a refused COMMIT there is no transaction
    // left, so this ROLLBACK only releases the connection.
    await trx.rollback().execute().catch(() => undefined)
    if (databaseFailureKind(err) === 'unavailable') throw new CommitOutcomeUnknownError(err)
    throw err
  }
  return result
}
