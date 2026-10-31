import { AppError } from '../appError.js'

// Decision O-20 (search cost), technical part: a cap on name searches running at once. A search (an asset list
// or count, or a person list, with a non-blank `q`) is the only request whose cost grows with the warehouse's
// size, and one user sending many at once could take every pool connection and starve everyone else (system
// performance test). Excess searches are refused at once with 429 SEARCH_BUSY and Retry-After instead of
// queueing: the check runs in the handler before it opens a transaction, so a refused search never takes a
// database connection. Counted per user id, so several sessions of one user share the limit, plus a global cap
// that keeps the rest of the pool free for ordinary requests.
//
// The counter lives in this process. That is exact for the current single-process server (main.ts starts one
// Fastify instance; no cluster, no workers). With several processes or instances each would count on its own;
// moving the counter into PostgreSQL (one pg_try_advisory_xact_lock per user and slot) is the documented path.

export interface SearchLimits {
  /** Searches one user may have running at once. */
  readonly perUser: number
  /** Searches all users together may have running at once; keep it below the database pool size. */
  readonly total: number
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = { perUser: 2, total: 5 }

export class SearchLimiter {
  readonly #limits: SearchLimits
  readonly #byUser = new Map<number, number>()
  #total = 0

  constructor(limits: SearchLimits = DEFAULT_SEARCH_LIMITS) {
    if (!(Number.isInteger(limits.perUser) && limits.perUser >= 1 && Number.isInteger(limits.total) && limits.total >= limits.perUser)) {
      throw new Error('search limits must be whole numbers with 1 <= perUser <= total')
    }
    this.#limits = limits
  }

  /** Takes a slot for `userId` and returns its release function, or throws SEARCH_BUSY. */
  acquire(userId: number): () => void {
    const mine = this.#byUser.get(userId) ?? 0
    if (mine >= this.#limits.perUser || this.#total >= this.#limits.total) throw new AppError('SEARCH_BUSY')
    this.#byUser.set(userId, mine + 1)
    this.#total += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#total -= 1
      const left = (this.#byUser.get(userId) ?? 1) - 1
      if (left === 0) this.#byUser.delete(userId)
      else this.#byUser.set(userId, left)
    }
  }

  /** Runs `fn` holding a slot when `query` is a search, and without one otherwise. */
  async run<T>(userId: number, query: string | undefined, fn: () => Promise<T>): Promise<T> {
    if ((query?.trim() ?? '') === '') return fn()
    const release = this.acquire(userId)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /** For monitoring and tests. */
  get running(): number {
    return this.#total
  }
}
