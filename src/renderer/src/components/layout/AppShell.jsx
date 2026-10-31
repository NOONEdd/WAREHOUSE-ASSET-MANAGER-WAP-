import { Suspense, useCallback, useEffect, useState } from 'react'
import { Drawer, Grid, Layout, Spin } from 'antd'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar, { SidebarContent } from './Sidebar'
import Header from './Header'
import ShortcutsHelp from './ShortcutsHelp'
import { useGlobalShortcuts } from '../../hooks/useGlobalShortcuts'

const { Content } = Layout

function PageFallback() {
  return (
    <div style={{ height: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Spin size="large" />
    </div>
  )
}

// Responsive shell. Width tiers follow antd's breakpoints:
//   ≥ 992px (lg)     full sidebar, as before;
//   768–991px (md)   a narrow icon rail (labels as tooltips), so a tablet in
//                    portrait keeps ~750px for content instead of ~620px;
//   < 768px          no rail at all — the header's menu button opens the
//                    same navigation in a drawer (phones, split-screen).
// HashRouter owns the URL fragment, so the skip link moves focus itself
// instead of using href="#main-content" (which would be read as a route).
export default function AppShell() {
  const location = useLocation()
  const screens = Grid.useBreakpoint()
  const isPhone = !screens.md
  const isRail = Boolean(screens.md && !screens.lg)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const openHelp = useCallback(() => setHelpOpen(true), [])

  useGlobalShortcuts({ onHelp: openHelp })

  // A route change from inside the drawer closes it.
  useEffect(() => setDrawerOpen(false), [location.pathname])

  function skipToContent(e) {
    e.preventDefault()
    document.getElementById('main-content')?.focus()
  }

  return (
    <Layout style={{ height: '100vh' }}>
      <a href="#main-content" className="awm-skip-link" onClick={skipToContent}>
        رفتن به محتوای اصلی
      </a>
      {!isPhone && <Sidebar collapsed={isRail} />}
      {isPhone && (
        <Drawer
          title="منوی اصلی"
          placement="right"
          size={272}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          className="awm-nav-drawer"
          styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
        >
          <SidebarContent collapsed={false} />
        </Drawer>
      )}
      <Layout style={{ minWidth: 0 }}>
        <Header
          compact={isPhone}
          navOpen={drawerOpen}
          onToggleNav={isPhone ? () => setDrawerOpen((o) => !o) : undefined}
          onOpenHelp={openHelp}
        />
        <div style={{ flex: 1, overflow: 'auto' }}>
          {/* Removed the large CompanyBanner here (was pushing every
              page's actual content below the fold on every navigation —
              it rendered full-width on top of every authenticated page).
              The banner asset and CompanyBanner.jsx itself are untouched;
              exportService.js reads the same PNG straight off disk for
              PDF/Excel letterheads, completely independent of this
              component, so removing this usage has no effect on exports.
              Sidebar/Header branding (logomark, wordmark, product name)
              is unchanged — that was never this component. */}
          <Content id="main-content" tabIndex={-1} className="awm-main" style={{ padding: isPhone ? 12 : 20 }}>
            {/* Suspense: pages are lazy-loaded (App.jsx) so a heavy,
                page-specific dependency (pdfjs-dist/exceljs/PapaParse for
                Import, recharts for Dashboard) isn't parsed and evaluated
                until its page is actually visited. The key remounts the
                page on every route change, which replays the fade-in
                below and — for routes like /assets/:id — guarantees a
                fresh mount when only the :id param changes. */}
            <Suspense fallback={<PageFallback />}>
              <div key={location.pathname} className="awm-page-transition">
                <Outlet />
              </div>
            </Suspense>
          </Content>
        </div>
      </Layout>
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </Layout>
  )
}
