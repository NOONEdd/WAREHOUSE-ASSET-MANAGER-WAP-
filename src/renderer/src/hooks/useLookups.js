import { useEffect, useState, useCallback } from 'react'
import { message } from 'antd'

export function useLookups() {
  const [lookups, setLookups] = useState(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    window.api.lookups
      .getAll()
      .then((data) => setLookups(data))
      .catch(() => message.error('بارگذاری اطلاعات پایه با خطا مواجه شد'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  async function createItem(kind, name) {
    try {
      const result = await window.api.lookups.create(kind, name)
      if (result.success) reload()
      return result
    } catch {
      return { success: false, error: 'ثبت مقدار جدید با خطا مواجه شد' }
    }
  }

  return { lookups, loading, reload, createItem }
}
