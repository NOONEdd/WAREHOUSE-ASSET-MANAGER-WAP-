import { Layout, Switch, Dropdown, Avatar, Typography } from 'antd'
import { SunOutlined, MoonOutlined, UserOutlined, LogoutOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useThemeMode } from '../../context/ThemeContext'
import { useAuth } from '../../context/AuthContext'

const { Header: AntHeader } = Layout

// Presentational only — translates the four fixed role names seeded in
// schema.sql (English, since they were never meant to be user-facing
// text) for display in the user menu. Same pattern as DashboardPage's
// ACTION_LABELS/ENTITY_LABELS: a label lookup, not a data change: if a
// role name isn't in this map it just falls back to the raw value.
const ROLE_LABELS = {
  Administrator: 'مدیر سامانه',
  Manager: 'مدیر',
  'Warehouse Staff': 'کارشناس انبار',
  'Read Only': 'فقط مشاهده'
}

export default function Header() {
  const { mode, toggleMode } = useThemeMode()
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  async function handleMenuClick({ key }) {
    if (key === 'logout') {
      await logout()
      navigate('/login')
    }
  }

  const userMenuItems = [
    {
      key: 'profile',
      label: (
        <div style={{ padding: '2px 0' }}>
          <div>{user.fullName}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {ROLE_LABELS[user.role] || user.role}
          </Typography.Text>
        </div>
      ),
      disabled: true
    },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: 'خروج از حساب', danger: true }
  ]

  return (
    <AntHeader
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        borderBottom: '1px solid var(--awm-border)',
        height: 64,
        // Phase 10 — same tone as the page body (colorBgLayout/--awm-paper)
        // instead of a separate white toolbar surface, so the header reads
        // as the top edge of the page rather than a floating bar sitting
        // on top of it. The hairline border below is still enough to
        // separate it from scrolled content.
        background: 'var(--awm-paper)'
      }}
    >
      {/* Software product name — the company's own corporate banner has its
          own full-width row directly below this bar, per spec. Each page's
          own <PageHeader> now carries page-specific context, so this stays
          fixed brand chrome rather than duplicating a breadcrumb here. */}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span className="awm-header-accent-bar" />
        <Typography.Text strong style={{ fontSize: 15 }}>
          سامانه مدیریت دارایی و انبار
        </Typography.Text>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Switch
          checkedChildren={<MoonOutlined />}
          unCheckedChildren={<SunOutlined />}
          checked={mode === 'dark'}
          onChange={toggleMode}
          aria-label="تغییر حالت روشن/تاریک"
        />
        <Dropdown menu={{ items: userMenuItems, onClick: handleMenuClick }} placement="bottomLeft">
          <div
            className="awm-list-item-clickable"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px' }}
          >
            <span>{user.fullName}</span>
            <Avatar size={28} icon={<UserOutlined />} style={{ background: 'var(--awm-ink)' }} />
          </div>
        </Dropdown>
      </div>
    </AntHeader>
  )
}
