import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, cleanupTestDb } from '../testHelpers/testDb'

let ctx

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

const { savedFilterService } = await import('../../../src/main/services/savedFilterService')

beforeEach(() => {
  ctx = createTestDb()
})

afterEach(() => {
  cleanupTestDb(ctx)
})

describe('savedFilterService', () => {
  it('starts empty on a fresh database', () => {
    expect(savedFilterService.list()).toEqual([])
  })

  it('create() adds a named preset that list() then returns', () => {
    const entry = savedFilterService.create('در انبار - واحد یک', { statusId: 1, workshopId: 2 })
    expect(entry.name).toBe('در انبار - واحد یک')
    expect(entry.id).toBeTruthy()

    const list = savedFilterService.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(entry)
  })

  it('only stores the recognized filter fields — a stray key is dropped, not carried along', () => {
    const entry = savedFilterService.create('test', {
      statusId: 1,
      workshopId: 2,
      itemTypeId: 3,
      countryId: 4,
      search: 'foo',
      from: '2026-01-01',
      to: '2026-01-31',
      someUnrelatedKey: 'should not be stored'
    })
    expect(entry.filters).toEqual({
      statusId: 1,
      workshopId: 2,
      itemTypeId: 3,
      countryId: 4,
      search: 'foo',
      from: '2026-01-01',
      to: '2026-01-31'
    })
  })

  it('persists across multiple create() calls, preserving earlier entries', () => {
    savedFilterService.create('اول', { statusId: 1 })
    savedFilterService.create('دوم', { statusId: 2 })
    const list = savedFilterService.list()
    expect(list.map((f) => f.name)).toEqual(['اول', 'دوم'])
  })

  it('rejects an empty or whitespace-only name', () => {
    expect(() => savedFilterService.create('', { statusId: 1 })).toThrow(/نام/)
    expect(() => savedFilterService.create('   ', { statusId: 1 })).toThrow(/نام/)
    expect(savedFilterService.list()).toEqual([])
  })

  it('rejects a duplicate name', () => {
    savedFilterService.create('تکراری', { statusId: 1 })
    expect(() => savedFilterService.create('تکراری', { statusId: 2 })).toThrow(/از قبل وجود دارد/)
    // The failed attempt didn't overwrite or add a second entry.
    expect(savedFilterService.list()).toHaveLength(1)
  })

  it('remove() deletes the matching preset by id and leaves the others intact', () => {
    const a = savedFilterService.create('اول', { statusId: 1 })
    const b = savedFilterService.create('دوم', { statusId: 2 })
    const result = savedFilterService.remove(a.id)
    expect(result.removed).toBe(true)
    const list = savedFilterService.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(b.id)
  })

  it('remove() on a nonexistent id is a safe no-op, not an error', () => {
    savedFilterService.create('اول', { statusId: 1 })
    const result = savedFilterService.remove('does-not-exist')
    expect(result.removed).toBe(false)
    expect(savedFilterService.list()).toHaveLength(1)
  })

  it('a corrupted stored value fails soft to an empty list rather than throwing', () => {
    ctx.db
      .prepare(`INSERT INTO settings (setting_key, setting_value) VALUES ('assets.savedFilters', 'not valid json')`)
      .run()
    expect(savedFilterService.list()).toEqual([])
  })
})
