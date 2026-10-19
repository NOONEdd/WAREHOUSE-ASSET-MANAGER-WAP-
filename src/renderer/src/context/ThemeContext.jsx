import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import faIR from 'antd/locale/fa_IR'
import { lightTheme, darkTheme } from '../theme'

const ThemeContext = createContext(null)
const STORAGE_KEY = 'awm-theme-mode'

function getInitialMode() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light' // localStorage unavailable (e.g. restricted context) — fall back quietly
  }
}

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(getInitialMode)

  // Dark-mode bug fix: AntD's own components already switch correctly
  // below via ConfigProvider's `theme` prop, but everything styled with
  // the plain CSS custom properties in global.css (Header's bar, the
  // Asset Details/Form field-group labels, the dashboard's total-assets
  // figure, ...) depends on the `dark` class actually being present on
  // <html> — global.css's `html.dark { --awm-text: ...; }` etc. were
  // defined correctly but nothing ever applied the class, so those
  // elements stayed locked to their light-mode colors while the AntD
  // surfaces around them correctly went dark — e.g. light text on a
  // component that AntD had already made dark, or dark text left on a
  // background that ConfigProvider had already switched to dark. This is
  // what made those specific labels unreadable in dark mode.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', mode === 'dark')
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // localStorage unavailable — theme choice just won't persist across restarts
    }
  }, [mode])

  const toggleMode = () => setMode((m) => (m === 'light' ? 'dark' : 'light'))

  const antdConfig = useMemo(() => {
    const base = mode === 'dark' ? darkTheme : lightTheme
    return {
      ...base,
      algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm
    }
  }, [mode])

  return (
    <ThemeContext.Provider value={{ mode, toggleMode }}>
      <ConfigProvider direction="rtl" locale={faIR} theme={antdConfig}>
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  )
}

export function useThemeMode() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useThemeMode must be used inside ThemeProvider')
  return ctx
}
