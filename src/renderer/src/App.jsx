import { lazy } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Spin } from 'antd'
import { ThemeProvider } from './context/ThemeContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import AppShell from './components/layout/AppShell'
import LoginPage from './pages/LoginPage'
import SetupPasswordPage from './pages/SetupPasswordPage'
import './styles/global.css'

// Performance: everything used to live in one ~3.8MB renderer bundle, so
// launching the app (or even just landing on the Dashboard) meant
// parsing and evaluating every page's dependencies up front — including
// pdfjs-dist/exceljs/PapaParse (Import) and recharts (Dashboard's chart),
// none of which the other pages need. Lazy-loading each page splits
// those into separate chunks fetched on first visit; AppShell's
// <Suspense> covers the brief gap. LoginPage stays a normal (non-lazy)
// import — it's the very first thing an unauthenticated session sees,
// so there's nothing to gain from deferring it.
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const AssetsPage = lazy(() => import('./pages/AssetsPage'))
const AssetDetailsPage = lazy(() => import('./pages/AssetDetailsPage'))
const AssetFormPage = lazy(() => import('./pages/AssetFormPage'))
const ImportPage = lazy(() => import('./pages/ImportPage'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
const AuditLogPage = lazy(() => import('./pages/AuditLogPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))

function CenteredSpinner() {
  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Spin size="large" />
    </div>
  )
}

// First-Run Security phase — needsSetup takes priority over everything
// else: it means the app cannot possibly have anyone to log in as yet,
// so every protected route redirects to /setup, not /login, until it's
// resolved.
function RequireAuth({ children }) {
  const { user, checking, needsSetup } = useAuth()

  if (checking) return <CenteredSpinner />
  if (needsSetup) return <Navigate to="/setup" replace />
  if (!user) return <Navigate to="/login" replace />

  return children
}

// Guards /login itself: redirects away to /setup while first-run setup
// is still pending (so the login form is never reachable with no usable
// password behind it), and to / if someone is already signed in.
function LoginRoute() {
  const { user, checking, needsSetup } = useAuth()

  if (checking) return <CenteredSpinner />
  if (needsSetup) return <Navigate to="/setup" replace />
  if (user) return <Navigate to="/" replace />

  return <LoginPage />
}

// Guards /setup itself: the mandatory setup screen is only ever valid
// while needsSetup is true — once it's done (or was never needed on
// this database), navigating here directly just bounces to the normal
// login/app routes instead of re-showing a stale setup form.
function SetupRoute() {
  const { user, checking, needsSetup } = useAuth()

  if (checking) return <CenteredSpinner />
  if (!needsSetup) return <Navigate to={user ? '/' : '/login'} replace />

  return <SetupPasswordPage />
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <HashRouter>
          <Routes>
            <Route path="/login" element={<LoginRoute />} />
            <Route path="/setup" element={<SetupRoute />} />
            <Route
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route path="/" element={<DashboardPage />} />
              <Route path="/assets" element={<AssetsPage />} />
              <Route path="/assets/new" element={<AssetFormPage />} />
              <Route path="/assets/:id" element={<AssetDetailsPage />} />
              <Route path="/assets/:id/edit" element={<AssetFormPage />} />
              <Route path="/assets/import" element={<ImportPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/audit-log" element={<AuditLogPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </HashRouter>
      </AuthProvider>
    </ThemeProvider>
  )
}
