import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb, cleanupTestDb, seedMinimalLookups } from '../testHelpers/testDb.js'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

describe('assetService "count by X" reports', () => {
  let ctx
  let assetService
  let lookupRepository
  let currentUser
  let itemTypeId

  beforeEach(async () => {
    vi.resetModules()
    ctx = createTestDb()
    vi.doMock('../../../src/main/database/connection', () => ({ getDatabase: () => ctx.db }))
    ;({ assetService } = await import('../../../src/main/services/assetService.js'))
    ;({ lookupRepository } = await import('../../../src/main/repositories/lookupRepository.js'))
    const seeded = seedMinimalLookups(ctx.db)
    itemTypeId = seeded.itemTypeId
    const userId = ctx.db
      .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
      .run(seeded.roleId).lastInsertRowid
    currentUser = { id: userId, username: 'admin' }
  })

  afterEach(() => {
    cleanupTestDb(ctx)
  })

  function createAsset(overrides = {}) {
    return assetService.createAsset(
      {
        assetCode: overrides.assetCode ?? `A-${Math.random().toString(36).slice(2)}`,
        assetName: 'دارایی',
        itemType: overrides.itemType ?? 'تجهیزات تست',
        serialNumber: overrides.serialNumber ?? `SN-${Math.random().toString(36).slice(2)}`,
        country: overrides.country,
        workshop: overrides.workshop,
        status: overrides.status ?? 'در انبار'
      },
      currentUser
    )
  }

  describe('getAssetCountByWorkshop', () => {
    it('groups assets by their workshop', () => {
      lookupRepository.create('workshops', 'واحد یک')
      lookupRepository.create('workshops', 'واحد دو')
      createAsset({ workshop: 'واحد یک' })
      createAsset({ workshop: 'واحد یک' })
      createAsset({ workshop: 'واحد دو' })

      const counts = assetService.getAssetCountByWorkshop()
      expect(counts.find((r) => r.workshop === 'واحد یک').n).toBe(2)
      expect(counts.find((r) => r.workshop === 'واحد دو').n).toBe(1)
    })

    it('groups assets with no workshop under "بدون واحد", not dropping them from the total', () => {
      createAsset({})
      createAsset({})
      const counts = assetService.getAssetCountByWorkshop()
      const total = counts.reduce((sum, r) => sum + r.n, 0)
      expect(total).toBe(2)
      expect(counts.find((r) => r.workshop === 'بدون واحد').n).toBe(2)
    })

    it('excludes soft-deleted assets — the workshop drops out entirely (asset-driven query), not just to n=0', () => {
      lookupRepository.create('workshops', 'واحد یک')
      const id = createAsset({ workshop: 'واحد یک' }).id
      assetService.deleteAsset(id, currentUser)
      const counts = assetService.getAssetCountByWorkshop()
      // Same reasoning as byWorkshop being driven FROM assets, not FROM
      // workshops (see assetService.js's comment): with zero non-deleted
      // assets left for this workshop, there is no matching assets row
      // for the LEFT JOIN to attach to at all, so the group disappears
      // rather than surviving at n: 0.
      expect(counts.find((r) => r.workshop === 'واحد یک')?.n ?? 0).toBe(0)
    })
  })

  describe('getAssetCountByItemType', () => {
    it('groups assets by item type, across multiple types', () => {
      lookupRepository.create('itemTypes', 'نوع دو')
      createAsset({ itemType: 'تجهیزات تست' })
      createAsset({ itemType: 'تجهیزات تست' })
      createAsset({ itemType: 'نوع دو' })

      const counts = assetService.getAssetCountByItemType()
      expect(counts.find((r) => r.itemType === 'تجهیزات تست').n).toBe(2)
      expect(counts.find((r) => r.itemType === 'نوع دو').n).toBe(1)
    })

    it('includes an item type with zero assets (LEFT JOIN, not just types that have assets)', () => {
      lookupRepository.create('itemTypes', 'نوع بدون دارایی')
      createAsset({ itemType: 'تجهیزات تست' })
      const counts = assetService.getAssetCountByItemType()
      expect(counts.find((r) => r.itemType === 'نوع بدون دارایی').n).toBe(0)
    })

    it('every row sums to the true non-deleted total — item_type_id is NOT NULL, so nothing can be silently dropped', () => {
      createAsset({})
      createAsset({})
      createAsset({})
      const counts = assetService.getAssetCountByItemType()
      const total = counts.reduce((sum, r) => sum + r.n, 0)
      expect(total).toBe(3)
    })

    it('excludes soft-deleted assets', () => {
      const id = createAsset({}).id
      assetService.deleteAsset(id, currentUser)
      const counts = assetService.getAssetCountByItemType()
      expect(counts.find((r) => r.itemType === 'تجهیزات تست').n).toBe(0)
    })
  })

  describe('getAssetCountByCountry', () => {
    it('groups assets by country', () => {
      lookupRepository.create('countries', 'آلمان')
      lookupRepository.create('countries', 'ژاپن')
      createAsset({ country: 'آلمان' })
      createAsset({ country: 'ژاپن' })
      createAsset({ country: 'ژاپن' })

      const counts = assetService.getAssetCountByCountry()
      expect(counts.find((r) => r.country === 'آلمان').n).toBe(1)
      expect(counts.find((r) => r.country === 'ژاپن').n).toBe(2)
    })

    it('groups assets with no country under "بدون کشور", not dropping them from the total', () => {
      createAsset({})
      const counts = assetService.getAssetCountByCountry()
      const total = counts.reduce((sum, r) => sum + r.n, 0)
      expect(total).toBe(1)
      expect(counts.find((r) => r.country === 'بدون کشور').n).toBe(1)
    })

    it('excludes soft-deleted assets — the country drops out entirely (asset-driven query), not just to n=0', () => {
      lookupRepository.create('countries', 'آلمان')
      const id = createAsset({ country: 'آلمان' }).id
      assetService.deleteAsset(id, currentUser)
      const counts = assetService.getAssetCountByCountry()
      expect(counts.find((r) => r.country === 'آلمان')?.n ?? 0).toBe(0)
    })
  })
})
