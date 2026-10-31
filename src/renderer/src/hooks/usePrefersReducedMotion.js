import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

// Follows the operating system's "reduce motion" setting live (Windows:
// Settings → Accessibility → Visual effects → Animation effects), so a
// change applies without restarting the app.
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia(QUERY).matches
    } catch {
      return false
    }
  })

  useEffect(() => {
    let media
    try {
      media = window.matchMedia(QUERY)
    } catch {
      return undefined
    }
    const onChange = (e) => setReduced(e.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return reduced
}
