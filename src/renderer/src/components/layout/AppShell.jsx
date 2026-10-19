import { Suspense } from 'react'
import { Layout, Spin } from 'antd'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import Header from './Header'

const { Content } = Layout

function PageFallback() {
  return (
    <div style={{ height: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Spin size="large" />
    </div>
  )
}

export default function AppShell() {
  const location = useLocation()

  return (
    <Layout style={{ height: '100vh' }}>
      <Sidebar />
      <Layout>
        <Header />
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
          <Content style={{ padding: 20 }}>
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
    </Layout>
  )
}
