import { useEffect, useState, useCallback } from 'react'
import { message } from 'antd'

export function useTransactions(assetId) {
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    if (!assetId) return
    setLoading(true)
    window.api.transactions
      .listByAsset(Number(assetId))
      .then((rows) => setTransactions(rows))
      .catch(() => {
        setTransactions([])
        message.error('بارگذاری تراکنش‌ها با خطا مواجه شد')
      })
      .finally(() => setLoading(false))
  }, [assetId])

  useEffect(() => {
    reload()
  }, [reload])

  return { transactions, loading, reload }
}

// Cross-asset version for the Reports page (Phase 13) — same shape, no
// assetId scoping, and each row carries its own assetCode/assetName since
// it's no longer implied by the page context.
export function useAllTransactions() {
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.api.transactions
      .listAll({ limit: 200 })
      .then((rows) => setTransactions(rows))
      .catch(() => {
        setTransactions([])
        message.error('بارگذاری تراکنش‌ها با خطا مواجه شد')
      })
      .finally(() => setLoading(false))
  }, [])

  return { transactions, loading }
}
