import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/appError.js'
import { SearchLimiter } from '../../src/http/searchLimiter.js'

// Decision O-20: the counting rules of the search limiter, on their own.

describe('SearchLimiter', () => {
  it('limits per user and in all, releases each slot exactly once, and refuses invalid limits', () => {
    const limiter = new SearchLimiter({ perUser: 2, total: 3 })
    const a1 = limiter.acquire(1)
    const a2 = limiter.acquire(1)
    expect(() => limiter.acquire(1)).toThrow(AppError)
    const b1 = limiter.acquire(2)
    expect(() => limiter.acquire(3)).toThrow(expect.objectContaining({ code: 'SEARCH_BUSY', status: 429 }) as Error)
    expect(limiter.running).toBe(3)
    a1()
    a1() // a second call releases nothing more
    expect(limiter.running).toBe(2)
    limiter.acquire(3)()
    a2()
    b1()
    expect(limiter.running).toBe(0)
    for (const bad of [{ perUser: 0, total: 1 }, { perUser: 3, total: 2 }, { perUser: 1.5, total: 2 }]) expect(() => new SearchLimiter(bad)).toThrow()
  })

  it('holds a slot only for a non-blank query, and releases it when the work fails', async () => {
    const limiter = new SearchLimiter({ perUser: 1, total: 1 })
    let inside = -1
    await limiter.run(1, '  ', () => {
      inside = limiter.running
      return Promise.resolve()
    })
    expect(inside).toBe(0)
    await expect(limiter.run(1, 'zq', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(limiter.running).toBe(0)
    await limiter.run(1, 'zq', () => {
      inside = limiter.running
      return Promise.resolve()
    })
    expect(inside).toBe(1)
  })
})
