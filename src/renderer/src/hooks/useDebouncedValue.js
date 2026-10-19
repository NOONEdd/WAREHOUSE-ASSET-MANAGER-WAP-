import { useEffect, useState } from 'react'

/**
 * Returns a copy of `value` that only updates after `delay` ms have passed
 * without it changing again. Used on the assets search box (Phase 11) so
 * typing doesn't fire an IPC query on every keystroke — only once the user
 * pauses.
 */
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debounced
}
