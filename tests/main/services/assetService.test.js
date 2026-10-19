import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let userDataDir

vi.mock('electron', () => ({
  app: {
    getPath: (name) => {
      if (name === 'userData') return userDataDir
      throw new Error('unexpected app.getPath: ' + name)
    }
  }
}))

const { assetService } = await import('../../../src/main/services/assetService.js')
const { closeDatabase, getDatabase } = await import('../../../src/main/database/connection.js')

let currentUser

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-asset-service-test-'))

  const db = getDatabase()
  const roleId = db.prepare('SELECT id FROM roles LIMIT 1').get().id
  const userId = db
    .prepare("INSERT INTO users (username, password_hash, full_name, role_id) VALUES ('admin','x','Admin',?)")
    .run(roleId).lastInsertRowid
  currentUser = { id: userId, username: 'admin' }

  db.prepare("INSERT INTO item_types (name) VALUES ('تجهیزات رایانه')").run()
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

function baseInput(overrides = {}) {
  return {
    assetCode: 'A-001',
    assetName: 'لپ‌تاپ',
    itemType: 'تجهیزات رایانه',
    serialNumber: 'SN-1',
    status: 'در انبار',
    ...overrides
  }
}

describe('assetService.createAsset — duplicate detection', () => {
  it('creates successfully when the code/serial are not already taken', () => {
    const asset = assetService.createAsset(baseInput(), currentUser)
    expect(asset.assetCode).toBe('A-001')
  })

  it('rejects a second asset with the same asset code as an existing, ACTIVE asset', () => {
    assetService.createAsset(baseInput(), currentUser)
    expect(() =>
      assetService.createAsset(baseInput({ serialNumber: 'SN-2' }), currentUser)
    ).toThrow(/کد دارایی/)
  })

  it('rejects a second asset with the same serial number as an existing, ACTIVE asset', () => {
    assetService.createAsset(baseInput(), currentUser)
    expect(() =>
      assetService.createAsset(baseInput({ assetCode: 'A-002' }), currentUser)
    ).toThrow(/شماره سریال/)
  })

  // Regression test for the duplicate-detection bug, required scenario #1
  // from the bug report, exactly as a person experiences it through the
  // Add Asset form: add an asset, delete it, then add the exact same
  // asset again — this must succeed, not be rejected as a duplicate of a
  // row that's no longer even visible in the Assets list.
  it('add asset -> delete asset -> add the same asset again succeeds', () => {
    const created = assetService.createAsset(baseInput(), currentUser)
    assetService.deleteAsset(created.id, currentUser)

    const recreated = assetService.createAsset(baseInput(), currentUser)
    expect(recreated.assetCode).toBe('A-001')
    expect(recreated.id).not.toBe(created.id)

    const db = getDatabase()
    expect(db.prepare("SELECT COUNT(*) n FROM assets WHERE asset_code = 'A-001' AND is_deleted = 0").get().n).toBe(
      1
    )
    expect(db.prepare("SELECT COUNT(*) n FROM assets WHERE asset_code = 'A-001'").get().n).toBe(2)
  })

  it('updateAsset also ignores a soft-deleted asset when checking for duplicates', () => {
    const deleted = assetService.createAsset(baseInput({ assetCode: 'WAS-DELETED', serialNumber: 'SN-DEL' }), currentUser)
    assetService.deleteAsset(deleted.id, currentUser)

    const other = assetService.createAsset(baseInput({ assetCode: 'OTHER', serialNumber: 'SN-OTHER' }), currentUser)

    // Renaming "other" to reuse the deleted asset's code must be allowed.
    const updated = assetService.updateAsset(
      other.id,
      baseInput({ assetCode: 'WAS-DELETED', serialNumber: 'SN-OTHER' }),
      currentUser
    )
    expect(updated.assetCode).toBe('WAS-DELETED')
  })

  it('updateAsset still rejects renaming onto an ACTIVE asset\'s code (existing behavior, preserved)', () => {
    assetService.createAsset(baseInput({ assetCode: 'TAKEN', serialNumber: 'SN-TAKEN' }), currentUser)
    const other = assetService.createAsset(baseInput({ assetCode: 'OTHER', serialNumber: 'SN-OTHER' }), currentUser)

    expect(() =>
      assetService.updateAsset(other.id, baseInput({ assetCode: 'TAKEN', serialNumber: 'SN-OTHER' }), currentUser)
    ).toThrow(/کد دارایی/)
  })
})
