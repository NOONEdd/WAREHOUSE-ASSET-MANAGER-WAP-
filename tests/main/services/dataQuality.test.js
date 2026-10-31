import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb, cleanupTestDb, seedMinimalLookups } from '../testHelpers/testDb.js'

// Dashboard data-quality panel: the counts (getDataQuality) and the list
// it opens (listAssets({ quality })) must always agree, ignore deleted
// assets, and refuse a filter value they do not know.

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

describe('assetService data-quality counts and the matching list filter', () => {
  let ctx
  let assetService
  let currentUser

  beforeEach(async () => {
    vi.resetModules()
    ctx = createTestDb()
    vi.doMock('../../../src/main/database/connection', () => ({ getDatabase: () => ctx.db }))
    ;({ assetService } = await import('../../../src/main/services/assetService.js'))
    const { roleId } = seedMinimalLookups(ctx.db)
    const userId = ctx.db
      .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
      .run(roleId).lastInsertRowid
    currentUser = { id: userId, username: 'admin' }
    ctx.db.prepare("INSERT INTO workshops (name) VALUES ('واحد آزمایشی')").run()
  })

  afterEach(() => {
    cleanupTestDb(ctx)
  })

  const create = (n, extra = {}) =>
    assetService.createAsset(
      {
        assetCode: `Q-${n}`,
        assetName: `دارایی ${n}`,
        itemType: 'تجهیزات تست',
        serialNumber: `SN-Q-${n}`,
        status: 'در انبار',
        workshop: 'واحد آزمایشی',
        entryDate: '2026-01-10',
        ...extra
      },
      currentUser
    )

  const listed = (quality) => assetService.listAssets({ quality, limit: -1 })

  it('is all zero on an empty database', () => {
    expect(assetService.getDataQuality()).toEqual({ noWorkshop: 0, noEntryDate: 0, issuedNoReceiver: 0 })
  })

  it('counts each check, and the filtered list returns exactly those assets', () => {
    create(1)
    const noUnit = create(2, { workshop: undefined })
    const noDate = create(3, { entryDate: undefined })
    const issuedNoReceiver = create(4)
    assetService.changeAssetStatus(issuedNoReceiver.id, { newStatus: 'صادر شده' }, currentUser)
    const issuedWithReceiver = create(5)
    assetService.changeAssetStatus(issuedWithReceiver.id, { newStatus: 'صادر شده', receivedBy: 'کارمند آزمایشی' }, currentUser)
    const issuedBlankReceiver = create(6)
    assetService.changeAssetStatus(issuedBlankReceiver.id, { newStatus: 'صادر شده', receivedBy: '   ' }, currentUser)

    const counts = assetService.getDataQuality()
    expect(counts).toEqual({ noWorkshop: 1, noEntryDate: 1, issuedNoReceiver: 2 })
    expect(listed('noWorkshop').rows.map((a) => a.id)).toEqual([noUnit.id])
    expect(listed('noEntryDate').rows.map((a) => a.id)).toEqual([noDate.id])
    expect(listed('issuedNoReceiver').rows.map((a) => a.id).sort()).toEqual([issuedNoReceiver.id, issuedBlankReceiver.id].sort())
    for (const key of Object.keys(counts)) expect(listed(key).total).toBe(counts[key])
  })

  it('leaves deleted assets out of both the counts and the list', () => {
    const gone = create(7, { workshop: undefined })
    assetService.deleteAsset(gone.id, currentUser)
    expect(assetService.getDataQuality().noWorkshop).toBe(0)
    expect(listed('noWorkshop').total).toBe(0)
  })

  it('combines with the other filters', () => {
    create(8, { workshop: undefined })
    create(9, { workshop: undefined, assetName: 'چاپگر' })
    expect(assetService.listAssets({ quality: 'noWorkshop', search: 'چاپگر', limit: -1 }).total).toBe(1)
  })

  it('refuses an unknown filter value instead of returning the whole list', () => {
    create(10)
    expect(() => listed('everything')).toThrow('فیلتر کیفیت داده نامعتبر است')
    expect(() => listed('toString')).toThrow('فیلتر کیفیت داده نامعتبر است')
  })
})
