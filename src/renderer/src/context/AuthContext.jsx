import { createContext, useContext, useEffect, useState } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    // Audit finding (CRITICAL): this had no .catch(). If the initial
    // session check ever rejects — including the exact case above, a
    // failed startup that used to still open the window with no IPC
    // handlers registered — `checking` never becomes false and
    // App.jsx's <RequireAuth> shows a full-screen spinner forever, with
    // no error and no way to reach even the login screen. Falling back
    // to "not logged in" is the only reasonable behavior on failure:
    // the person can still see the login page and try again.
    //
    // First-Run Security phase — needsFirstRunSetup is checked
    // alongside currentUser, before `checking` clears, so App.jsx's
    // routing never has a moment where it might show the normal login
    // screen before redirecting to the mandatory setup screen. A
    // rejected needsFirstRunSetup call falls back to false (not
    // pending) — the safer failure direction, since it leaves the
    // person at the ordinary login screen rather than locking a
    // working install behind a setup screen it doesn't actually need.
    Promise.all([
      window.api.auth.currentUser().catch(() => null),
      window.api.auth.needsFirstRunSetup().catch(() => false)
    ])
      .then(([u, pending]) => {
        setUser(u)
        setNeedsSetup(Boolean(pending))
      })
      .finally(() => setChecking(false))
  }, [])

  async function login(username, password) {
    const result = await window.api.auth.login(username, password)
    if (result.success) setUser(result.user)
    return result
  }

  async function logout() {
    await window.api.auth.logout()
    setUser(null)
  }

  async function completeFirstRunSetup(newPassword, confirmPassword) {
    const result = await window.api.auth.completeFirstRunSetup(newPassword, confirmPassword)
    if (result.success) {
      setUser(result.user)
      setNeedsSetup(false)
    }
    return result
  }

  return (
    <AuthContext.Provider value={{ user, needsSetup, checking, login, logout, completeFirstRunSetup }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
