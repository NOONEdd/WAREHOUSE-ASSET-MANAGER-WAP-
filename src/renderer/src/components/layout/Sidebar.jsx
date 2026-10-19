import { Layout, Menu } from 'antd'
import {
  DashboardOutlined,
  ContainerOutlined,
  BarChartOutlined,
  HistoryOutlined,
  SettingOutlined
} from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAppVersion } from '../../hooks/useAppVersion'

const { Sider } = Layout

const items = [
  { key: '/', icon: <DashboardOutlined />, label: 'داشبورد' },
  { key: '/assets', icon: <ContainerOutlined />, label: 'دارایی‌ها' },
  { key: '/reports', icon: <BarChartOutlined />, label: 'گزارش‌ها' },
  { key: '/audit-log', icon: <HistoryOutlined />, label: 'گزارش رویدادها' },
  { key: '/settings', icon: <SettingOutlined />, label: 'تنظیمات' }
]

export default function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const version = useAppVersion()

  // Sub-pages (asset details, add/edit, import) all belong under "دارایی‌ها"
  const selectedKey = location.pathname.startsWith('/assets') ? '/assets' : location.pathname

  return (
    <Sider
      width={216}
      theme="dark"
      // Phase 10 — a quiet vertical gradient (same ink family, just a
      // second stop) instead of a flat fill. The flex column that pins
      // the brand block / nav / footer has to go on `styles.body`, not
      // the top-level `style` — Sider renders children inside its own
      // internal wrapper div (.ant-layout-sider-children), one level
      // below the <aside> that `style` targets, so a flex-direction set
      // there has only a single child to apply to and does nothing.
      style={{
        background: 'linear-gradient(180deg, var(--awm-ink) 0%, var(--awm-ink-deep) 100%)'
      }}
      styles={{ body: { display: 'flex', flexDirection: 'column', height: '100%' } }}
    >
      <div className="awm-sidebar-brand">
        <img src="./branding/sfz-mark.png" alt="" className="awm-sidebar-mark" />
        <div className="awm-sidebar-wordmark">
          <span className="awm-sidebar-wordmark-title">سامانه انبار</span>
          <span className="awm-sidebar-wordmark-sub">مدیریت دارایی‌های سازمانی</span>
        </div>
      </div>

      <div className="awm-sidebar-divider" />

      <Menu
        theme="dark"
        mode="inline"
        selectedKeys={[selectedKey]}
        items={items}
        onClick={({ key }) => navigate(key)}
        style={{ borderInlineEnd: 'none', paddingTop: 10, background: 'transparent', flex: 1 }}
      />

      <div className="awm-sidebar-footer">
        <div>شرکت صنعت فرابر زرین</div>
        {version && <div className="awm-sidebar-version">نسخه {version}</div>}
      </div>
    </Sider>
  )
}
