import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, cleanupTestDb } from '../testHelpers/testDb'

let ctx

vi.mock('../../../src/main/database/connection', () => ({
  getDatabase: () => ctx.db
}))

const { auditLogRepository } = await import('../../../src/main/repositories/auditLogRepository')

beforeEach(() => {
  ctx = createTestDb()
})

afterEach(() => {
  cleanupTestDb(ctx)
})

function seedUser(username = 'admin') {
  const roleId = ctx.db.prepare('SELECT id FROM roles LIMIT 1').get().id
  return ctx.db
    .prepare(`INSERT INTO users (username, password_hash, full_name, role_id) VALUES (?, 'x', 'Admin', ?)`)
    .run(username, roleId).lastInsertRowid
}

// Inserts directly (bypassing auditService.recordAudit) so occurred_at
// can be controlled precisely — the repository is what's under test
// here, not the service layer that calls it.
function seedEntry({ userId = null, username = 'admin', action, entityType = 'Asset', entityId = 1, occurredAt }) {
  ctx.db
    .prepare(
      `INSERT INTO audit_log (user_id, username_snapshot, action, entity_type, entity_id, changes, occurred_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    )
    .run(userId, username, action, entityType, entityId, occurredAt)
}

describe('auditLogRepository.list — total count', () => {
  it('total reflects the full matching count, not just the returned page size', () => {
    for (let i = 0; i < 5; i++) {
      seedEntry({ action: 'CREATE', occurredAt: `2026-01-0${i + 1} 10:00:00` })
    }
    const { rows, total } = auditLogRepository.list({ limit: 2, offset: 0 })
    expect(rows.length).toBe(2)
    expect(total).toBe(5)
  })

  it('total is 0 for an empty audit log', () => {
    const { rows, total } = auditLogRepository.list({})
    expect(rows).toEqual([])
    expect(total).toBe(0)
  })

  it('total stays correct across pages — never drifts from the filtered result set', () => {
    for (let i = 0; i < 7; i++) {
      seedEntry({ action: 'CREATE', occurredAt: `2026-01-0${i + 1} 10:00:00` })
    }
    const page1 = auditLogRepository.list({ limit: 3, offset: 0 })
    const page2 = auditLogRepository.list({ limit: 3, offset: 3 })
    const page3 = auditLogRepository.list({ limit: 3, offset: 6 })
    expect(page1.total).toBe(7)
    expect(page2.total).toBe(7)
    expect(page3.total).toBe(7)
    expect(page1.rows.length).toBe(3)
    expect(page2.rows.length).toBe(3)
    expect(page3.rows.length).toBe(1)
    // No overlap between pages.
    const allIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id)
    expect(new Set(allIds).size).toBe(7)
  })
})

describe('auditLogRepository.list — filters', () => {
  it('filters by action', () => {
    seedEntry({ action: 'CREATE', occurredAt: '2026-01-01 10:00:00' })
    seedEntry({ action: 'DELETE', occurredAt: '2026-01-02 10:00:00' })
    const { rows, total } = auditLogRepository.list({ action: 'DELETE' })
    expect(total).toBe(1)
    expect(rows[0].action).toBe('DELETE')
  })

  it('filters by entityType', () => {
    seedEntry({ action: 'CREATE', entityType: 'Asset', occurredAt: '2026-01-01 10:00:00' })
    seedEntry({ action: 'CREATE', entityType: 'Workshop', occurredAt: '2026-01-02 10:00:00' })
    const { total } = auditLogRepository.list({ entityType: 'Workshop' })
    expect(total).toBe(1)
  })

  it('filters by userId', () => {
    const userA = seedUser('user-a')
    const userB = seedUser('user-b')
    seedEntry({ userId: userA, username: 'user-a', action: 'CREATE', occurredAt: '2026-01-01 10:00:00' })
    seedEntry({ userId: userB, username: 'user-b', action: 'CREATE', occurredAt: '2026-01-02 10:00:00' })
    const { rows, total } = auditLogRepository.list({ userId: userA })
    expect(total).toBe(1)
    expect(rows[0].username_snapshot).toBe('user-a')
  })

  it('filters by from/to date range (inclusive of the entire "to" day)', () => {
    seedEntry({ action: 'CREATE', occurredAt: '2026-01-01 08:00:00' })
    seedEntry({ action: 'CREATE', occurredAt: '2026-01-05 08:00:00' })
    // Late in the day — the exact case the end-of-day padding fixes: a
    // bare 'to: 2026-01-05' must still include an event from later that
    // same day, not just ones before midnight.
    seedEntry({ action: 'CREATE', occurredAt: '2026-01-05 23:30:00' })
    seedEntry({ action: 'CREATE', occurredAt: '2026-01-10 08:00:00' })

    const { total } = auditLogRepository.list({ from: '2026-01-02', to: '2026-01-05' })
    expect(total).toBe(2)
  })

  it('combines multiple filters with AND', () => {
    seedEntry({ action: 'CREATE', entityType: 'Asset', occurredAt: '2026-01-01 10:00:00' })
    seedEntry({ action: 'DELETE', entityType: 'Asset', occurredAt: '2026-01-02 10:00:00' })
    seedEntry({ action: 'CREATE', entityType: 'Workshop', occurredAt: '2026-01-03 10:00:00' })
    const { total } = auditLogRepository.list({ action: 'CREATE', entityType: 'Asset' })
    expect(total).toBe(1)
  })

  it('returns an empty result (not an error) when nothing matches', () => {
    seedEntry({ action: 'CREATE', occurredAt: '2026-01-01 10:00:00' })
    const { rows, total } = auditLogRepository.list({ action: 'DELETE' })
    expect(rows).toEqual([])
    expect(total).toBe(0)
  })
})

describe('auditLogRepository.list — deterministic ordering', () => {
  it('orders newest first, with id as a tiebreaker for identical timestamps', () => {
    // Same second, e.g. a bulk operation's several audit rows committed
    // inside one transaction — exactly the case the id DESC tiebreaker
    // exists for (see the comment in auditLogRepository.js).
    seedEntry({ action: 'CREATE', entityId: 1, occurredAt: '2026-01-01 10:00:00' })
    seedEntry({ action: 'CREATE', entityId: 2, occurredAt: '2026-01-01 10:00:00' })
    seedEntry({ action: 'CREATE', entityId: 3, occurredAt: '2026-01-01 10:00:00' })

    const { rows } = auditLogRepository.list({})
    expect(rows.map((r) => r.entity_id)).toEqual([3, 2, 1])
  })

  it('a full walk across pages with a tiebreaker never skips or duplicates a row', () => {
    for (let i = 0; i < 10; i++) {
      seedEntry({ action: 'CREATE', entityId: i, occurredAt: '2026-01-01 10:00:00' })
    }
    const page1 = auditLogRepository.list({ limit: 4, offset: 0 })
    const page2 = auditLogRepository.list({ limit: 4, offset: 4 })
    const page3 = auditLogRepository.list({ limit: 4, offset: 8 })
    const allEntityIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.entity_id)
    expect(new Set(allEntityIds).size).toBe(10)
  })
})
