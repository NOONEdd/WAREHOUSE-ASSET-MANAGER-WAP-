import { getDatabase } from '../database/connection'

function get(key) {
  return getDatabase().prepare('SELECT setting_value FROM settings WHERE setting_key = ?').get(key)
    ?.setting_value
}

function getAll() {
  const rows = getDatabase().prepare('SELECT setting_key, setting_value FROM settings').all()
  return Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]))
}

function set(key, value) {
  getDatabase()
    .prepare(
      `INSERT INTO settings (setting_key, setting_value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')`
    )
    .run(key, value)
}

export const settingsRepository = { get, getAll, set }
