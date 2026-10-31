import { useEffect, useState, useCallback } from 'react'
import { message } from 'antd'

// Audit finding (IMPORTANT): none of the four hooks below had a .catch()
// on their window.api calls. On any backend failure — a locked/corrupt
// db file, a disk issue, anything — the promise just never resolves the
// state update, so `loading` (or the undefined/null sentinel below)
// stays stuck forever with a silent console error and no feedback at
// all. Each now fails toward a safe, empty state and a one-line toast,
// not a UI redesign — the loading→data shape each page already renders
// is unchanged, this only makes sure it's reachable on failure too.

export function useAssets(filters) {
  const [data, setData] = useState({ rows: [], total: 0 })
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    window.api.assets
      .list(filters)
      .then((result) => setData(result))
      .catch(() => {
        setData({ rows: [], total: 0 })
        message.error('بارگذاری فهرست دارایی‌ها با خطا مواجه شد')
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)])

  useEffect(() => {
    reload()
  }, [reload])

  return { ...data, loading, reload }
}

export function useAsset(id) {
  const [asset, setAsset] = useState(undefined) // undefined = loading, null = not found
  useEffect(() => {
    if (!id) return
    setAsset(undefined)
    window.api.assets
      .get(Number(id))
      .then((result) => setAsset(result ?? null))
      .catch(() => {
        setAsset(null)
        message.error('بارگذاری دارایی با خطا مواجه شد')
      })
  }, [id])
  return asset
}

// Dashboard: same data as useDashboardStats below, plus whether loading
// failed and a retry — so a failed load shows an error with a retry
// button instead of spinners that never stop.
export function useDashboardData() {
  const [stats, setStats] = useState(null)
  const [failed, setFailed] = useState(false)

  const reload = useCallback(() => {
    setFailed(false)
    window.api.assets
      .dashboardStats()
      .then(setStats)
      .catch(() => {
        setFailed(true)
        message.error('بارگذاری آمار داشبورد با خطا مواجه شد')
      })
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  return { stats, failed, reload }
}

export function useDashboardStats() {
  return useDashboardData().stats
}

// Dashboard's data-quality panel (assetService.getDataQuality). null while
// loading; { failed: true } if the request failed.
export function useDataQuality() {
  const [quality, setQuality] = useState(null)
  useEffect(() => {
    window.api.assets
      .dataQuality()
      .then(setQuality)
      .catch(() => setQuality({ failed: true }))
  }, [])
  return quality
}

export function useAssetCountByWorkshop() {
  const [data, setData] = useState(null)
  useEffect(() => {
    window.api.assets
      .countByWorkshop()
      .then(setData)
      .catch(() => message.error('بارگذاری آمار واحدها با خطا مواجه شد'))
  }, [])
  return data
}

// Phase 4.3 — Reports page's Item Type / Country breakdowns, same
// fetch-once-on-mount shape as useAssetCountByWorkshop above.
export function useAssetCountByItemType() {
  const [data, setData] = useState(null)
  useEffect(() => {
    window.api.assets
      .countByItemType()
      .then(setData)
      .catch(() => message.error('بارگذاری آمار انواع کالا با خطا مواجه شد'))
  }, [])
  return data
}

export function useAssetCountByCountry() {
  const [data, setData] = useState(null)
  useEffect(() => {
    window.api.assets
      .countByCountry()
      .then(setData)
      .catch(() => message.error('بارگذاری آمار کشور سازنده با خطا مواجه شد'))
  }, [])
  return data
}

// Phase 4.2 — Dashboard's "recently added / recently modified" section.
export function useRecentActivity(limit = 5) {
  const [data, setData] = useState({ recentlyAdded: [], recentlyModified: [] })
  useEffect(() => {
    window.api.assets
      .recentActivity(limit)
      .then(setData)
      .catch(() => message.error('بارگذاری فعالیت اخیر با خطا مواجه شد'))
  }, [limit])
  return data
}

// Phase 4.4 — Assets page's saved filter presets.
export function useSavedFilters() {
  const [savedFilters, setSavedFilters] = useState([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    window.api.savedFilters
      .list()
      .then(setSavedFilters)
      .catch(() => message.error('بارگذاری فیلترهای ذخیره‌شده با خطا مواجه شد'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  return { savedFilters, loading, reload }
}
