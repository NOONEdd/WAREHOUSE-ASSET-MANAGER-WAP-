import { useEffect, useState, useCallback } from 'react'
import { message } from 'antd'

// Reliability + UX phase (3.1) — return shape now matches useAssets:
// { rows, total, loading, reload }. Total comes from the repository's own
// COUNT query (auditLogRepository.list), not the length of whatever page
// happened to load, so callers can build real pagination instead of
// just showing however many rows fit in one fixed-size request.
export function useAuditLog(filters) {
  const [data, setData] = useState({ rows: [], total: 0 })
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    window.api.auditLog
      .list(filters)
      .then((result) => setData(result))
      .catch(() => {
        setData({ rows: [], total: 0 })
        message.error('بارگذاری گزارش رویدادها با خطا مواجه شد')
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)])

  useEffect(() => {
    reload()
  }, [reload])

  return { ...data, loading, reload }
}
