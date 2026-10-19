import { useEffect, useState } from 'react'

// Versioning phase — same fail-safe shape as the hooks in useAssets.js:
// falls back to an empty string on rejection instead of leaving the
// caller with an unresolved promise. An empty string is intentionally
// falsy so callers can simply skip rendering the version line rather
// than showing "نسخه " with nothing after it.
export function useAppVersion() {
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.api.app
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion(''))
  }, [])

  return version
}
