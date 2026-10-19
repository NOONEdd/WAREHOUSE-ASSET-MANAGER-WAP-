import { settingsRepository } from '../repositories/settingsRepository'

// Phase 4.4 (Saved Filters) — deliberately reuses the existing settings
// key/value table (settingsRepository) rather than a new database table:
// this is a short, occasionally-updated list of named presets, exactly
// the shape settings already exists for, and adding a dedicated table
// (with its own migration, FK considerations, etc.) for what's really
// one JSON blob would be the "unnecessary database complexity" the
// phase plan explicitly warned against. Entirely local to this
// installation — no cloud sync, matching the single-user, offline
// nature of the rest of the app.
const SETTINGS_KEY = 'assets.savedFilters'

function list() {
  const raw = settingsRepository.get(SETTINGS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Corrupted/unexpected stored value — fail soft to an empty list
    // rather than breaking the Assets page filter bar entirely.
    return []
  }
}

function create(name, filters) {
  const trimmed = name?.trim()
  if (!trimmed) throw new Error('نام فیلتر نمی‌تواند خالی باشد')

  const existing = list()
  if (existing.some((f) => f.name === trimmed)) {
    throw new Error('فیلتری با این نام از قبل وجود دارد')
  }

  // Only the fields AssetFilters.jsx / AssetsPage.jsx actually use are
  // stored — an unrecognized/stray key from a future renderer change
  // won't silently accumulate in old saved presets.
  const { search, statusId, workshopId, itemTypeId, countryId, from, to } = filters || {}
  const entry = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    filters: { search, statusId, workshopId, itemTypeId, countryId, from, to }
  }

  settingsRepository.set(SETTINGS_KEY, JSON.stringify([...existing, entry]))
  return entry
}

function remove(id) {
  const existing = list()
  const updated = existing.filter((f) => f.id !== id)
  settingsRepository.set(SETTINGS_KEY, JSON.stringify(updated))
  return { removed: existing.length !== updated.length }
}

export const savedFilterService = { list, create, remove }
