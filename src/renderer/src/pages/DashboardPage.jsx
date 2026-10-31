import { Row, Col, Card, Typography, List, Empty, Spin, Button, Space, Alert } from 'antd'
import {
  PlusOutlined,
  UploadOutlined,
  DatabaseOutlined,
  InboxOutlined,
  ExportOutlined,
  WarningOutlined,
  PieChartOutlined,
  HistoryOutlined,
  PlusCircleOutlined,
  EditOutlined,
  SafetyCertificateOutlined,
  LeftOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { formatPersianNumber } from '../utils/numberFormat'
import { toJalaliDisplay } from '../utils/dateDisplay'
import { useDashboardData, useDataQuality, useRecentActivity } from '../hooks/useAssets'
import { useAuditLog } from '../hooks/useAuditLog'
import { useLookups } from '../hooks/useLookups'
import StatusDonutChart from '../components/dashboard/StatusDonutChart'
import PageHeader from '../components/common/PageHeader'

const { Text } = Typography

const ACTION_LABELS = {
  CREATE: 'ایجاد',
  UPDATE: 'ویرایش',
  DELETE: 'حذف',
  LOGIN: 'ورود',
  LOGOUT: 'خروج',
  BACKUP_CREATED: 'پشتیبان‌گیری',
  BACKUP_RESTORED: 'بازیابی',
  EXPORT: 'خروجی',
  STATUS_CREATED: 'ایجاد وضعیت',
  STATUS_RENAMED: 'تغییر نام وضعیت',
  STATUS_ACTIVATED: 'فعال‌سازی وضعیت',
  STATUS_DEACTIVATED: 'غیرفعال‌سازی وضعیت',
  STATUS_DELETED: 'حذف وضعیت',
  DEACTIVATED: 'غیرفعال‌سازی',
  REACTIVATED: 'فعال‌سازی',
  PASSWORD_SET: 'تعیین رمز عبور',
  PASSWORD_CHANGED: 'تغییر رمز عبور'
}

const ENTITY_LABELS = {
  Asset: 'دارایی',
  User: 'کاربر',
  Setting: 'تنظیمات',
  Database: 'پایگاه داده',
  AssetStatus: 'وضعیت (داده پایه)',
  ItemType: 'نوع کالا (داده پایه)',
  Workshop: 'واحد/بخش (داده پایه)',
  Country: 'کشور سازنده (داده پایه)',
  Export: 'خروجی گزارش'
}

// Status names come back from the database in Persian now (fixed in
// Phase 9 — schema.sql previously seeded English names that never
// matched anything the UI looked up). Keying off those same names here.
//
// Each card's `tint` is the plain brand hex (theme.js/global.css's
// --awm-status-*, spelled out literally here since it needs an alpha
// suffix appended for the icon-chip background — a CSS var reference
// can't be string-concatenated with an opacity digit). `iconColor` is
// the separate, per-theme-safe glyph color (--awm-icon-*) — seven of
// the plain brand colors read too faint as a small icon against a dark
// card, so that's a deliberately different value in dark mode, not a
// CSS-var indirection of the same one.
//
// `statuses` records which system status each card represents, so a
// click can jump to the Assets list pre-filtered to match — omitted for
// "total" (no filter, just browse everything) and left undefined for
// "damagedOrLost" (it's a combined count of two statuses; AssetFilters
// only supports a single status at a time, so there's no single filter
// that would accurately reproduce this card's number — better to leave
// it as a plain, non-interactive figure than silently show only half of
// what the card display already promised).
function statCardsFrom(stats) {
  const byStatus = Object.fromEntries((stats?.byStatus || []).map((s) => [s.status, s.n]))
  return [
    {
      key: 'total',
      label: 'کل دارایی‌ها',
      value: stats?.total ?? 0,
      statuses: [],
      tint: '#1e2a3a',
      iconColor: 'var(--awm-icon-navy)',
      icon: <DatabaseOutlined />
    },
    {
      key: 'inWarehouse',
      label: 'در انبار',
      value: byStatus['در انبار'] ?? 0,
      statuses: ['در انبار'],
      tint: '#4a6fa5',
      iconColor: 'var(--awm-icon-blue)',
      icon: <InboxOutlined />
    },
    {
      key: 'issued',
      label: 'صادر شده',
      value: byStatus['صادر شده'] ?? 0,
      statuses: ['صادر شده'],
      tint: '#c8862b',
      iconColor: 'var(--awm-accent)',
      icon: <ExportOutlined />
    },
    {
      key: 'damagedOrLost',
      label: 'آسیب‌دیده / مفقود',
      value: (byStatus['آسیب‌دیده'] ?? 0) + (byStatus['مفقود'] ?? 0),
      tint: '#b0472f',
      iconColor: 'var(--awm-icon-red)',
      icon: <WarningOutlined />
    }
  ]
}

// Phase 4.2 — compact shared list for the two "recent asset activity"
// cards below (recently added / recently modified). Deliberately its own
// small component rather than inlined twice: same row shape, same click-
// through-to-details behavior, only the empty-state text and which date
// field to show differ between the two callers.
function AssetMiniList({ assets, dateField, emptyText, navigate }) {
  if (assets.length === 0) {
    return <Empty description={emptyText} image={Empty.PRESENTED_IMAGE_SIMPLE} />
  }
  return (
    <List
      size="small"
      dataSource={assets}
      renderItem={(asset) => (
        // The button role sits on an element inside the <li>: a role on the
        // <li> itself hides it from the list (axe: "list" violation).
        <List.Item style={{ padding: 0 }}>
          <div
            onClick={() => navigate(`/assets/${asset.id}`)}
            className="awm-list-item-clickable"
            style={{ width: '100%', display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px' }}
            tabIndex={0}
            role="button"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                navigate(`/assets/${asset.id}`)
              }
            }}
          >
            <div style={{ minWidth: 0 }}>
              <Text strong className="awm-mono">
                {asset.assetCode}
              </Text>
              <Text type="secondary" style={{ fontSize: 12, marginInlineStart: 6 }} ellipsis>
                {asset.assetName}
              </Text>
            </div>
            <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {toJalaliDisplay(asset[dateField])}
            </Text>
          </div>
        </List.Item>
      )}
    />
  )
}

// Data-quality panel: what each check means, and the `quality` filter of
// the asset list that shows exactly those assets (assetRepository's
// QUALITY_CONDITIONS — the count and the list use the same condition).
const QUALITY_ITEMS = [
  { key: 'noWorkshop', label: 'بدون واحد', hint: 'واحد/بخش ثبت نشده است' },
  { key: 'noEntryDate', label: 'بدون تاریخ ورود', hint: 'تاریخ ورود به انبار ثبت نشده است' },
  { key: 'issuedNoReceiver', label: 'صادر شده بدون تحویل‌گیرنده', hint: 'وضعیت «صادر شده» بدون نام تحویل‌گیرنده' }
]

function DataQualityPanel({ quality, navigate }) {
  if (quality?.failed) {
    return <Alert type="warning" showIcon message="بررسی کیفیت داده‌ها بارگذاری نشد" />
  }
  if (!quality) {
    return (
      <div className="awm-loading" style={{ padding: 24, textAlign: 'center' }}>
        <Spin />
      </div>
    )
  }
  const allClear = QUALITY_ITEMS.every((item) => quality[item.key] === 0)
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {allClear && (
        <Text type="secondary" style={{ fontSize: 12.5 }}>
          هیچ موردی برای بررسی یافت نشد.
        </Text>
      )}
      {QUALITY_ITEMS.map((item) => {
        const count = quality[item.key] ?? 0
        const open = () => count > 0 && navigate('/assets', { state: { presetQuality: item.key } })
        return (
          <div
            key={item.key}
            role="button"
            tabIndex={count > 0 ? 0 : -1}
            aria-disabled={count === 0}
            className="awm-quality-item"
            onClick={open}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                open()
              }
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600, fontSize: 13 }}>{item.label}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--awm-text-secondary)' }}>{item.hint}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <span className="awm-mono" style={{ fontSize: 17, fontWeight: 600 }}>
                {formatPersianNumber(count)}
              </span>
              {count > 0 && <LeftOutlined aria-hidden style={{ fontSize: 11, color: 'var(--awm-text-secondary)' }} />}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function SectionTitle({ icon, children }) {
  return (
    <span>
      <span className="awm-section-icon" aria-hidden>
        {icon}
      </span>
      {children}
    </span>
  )
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const { stats, failed: statsFailed, reload: reloadStats } = useDashboardData()
  const quality = useDataQuality()
  const { rows: entries, loading: activityLoading } = useAuditLog({ limit: 5 })
  const { recentlyAdded, recentlyModified } = useRecentActivity(5)
  const { lookups } = useLookups()

  function goToAssets(card) {
    if (!card.statuses) return // combined multi-status card — no single accurate filter, stays inert
    if (card.statuses.length === 0) {
      navigate('/assets')
      return
    }
    const status = lookups?.statuses?.find((s) => s.name === card.statuses[0])
    navigate('/assets', status ? { state: { presetStatusId: status.id } } : undefined)
  }

  // A figure while loading shows a spinner; after a failed load, a dash
  // (the alert above the cards says why) — never a made-up zero.
  const figure = (value) => (stats ? formatPersianNumber(value) : statsFailed ? '—' : <Spin size="small" />)

  // Phase 10 — composition only: statCardsFrom's data/order/click-target
  // logic is untouched. Card 0 ("کل دارایی‌ها") becomes the full hero;
  // the remaining three sit beside it on wide screens and wrap below it
  // on narrower ones (auto-fit grid), so the total stays the visually
  // dominant figure at every width.
  const [heroCard, ...secondaryCards] = statCardsFrom(stats)
  const heroClickable = Boolean(heroCard.statuses)

  return (
    <div>
      <PageHeader
        title="نمای کلی"
        description="خلاصه وضعیت انبار و دارایی‌ها"
        actions={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/assets/new')}>
              افزودن دارایی
            </Button>
            <Button icon={<UploadOutlined />} onClick={() => navigate('/assets/import')}>
              درون‌ریزی
            </Button>
          </Space>
        }
      />

      {statsFailed && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="آمار داشبورد بارگذاری نشد"
          description="ارقام زیر تا بارگذاری دوباره نمایش داده نمی‌شوند."
          action={
            <Button size="small" onClick={reloadStats}>
              تلاش دوباره
            </Button>
          }
        />
      )}

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={7}>
          <Card
            className={heroClickable ? 'awm-hero-card awm-stat-card' : 'awm-hero-card'}
            styles={{ body: { padding: 20, height: '100%', display: 'flex', alignItems: 'center' } }}
            style={{ height: '100%', minHeight: 132 }}
            onClick={heroClickable ? () => goToAssets(heroCard) : undefined}
            tabIndex={heroClickable ? 0 : undefined}
            role={heroClickable ? 'button' : undefined}
            aria-label={heroClickable ? `مشاهده دارایی‌های «${heroCard.label}»` : undefined}
            onKeyDown={
              heroClickable
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      goToAssets(heroCard)
                    }
                  }
                : undefined
            }
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div className="awm-hero-icon-chip">{heroCard.icon}</div>
              <div style={{ minWidth: 0 }}>
                <div className="awm-hero-label">{heroCard.label}</div>
                <div className="awm-mono awm-hero-figure">{figure(heroCard.value)}</div>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={17}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: 12,
              height: '100%'
            }}
          >
            {secondaryCards.map((card) => {
              const clickable = Boolean(card.statuses)
              return (
                <Card
                  key={card.key}
                  hoverable={clickable}
                  className={clickable ? 'awm-stat-card awm-metric-card' : 'awm-metric-card'}
                  onClick={clickable ? () => goToAssets(card) : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  role={clickable ? 'button' : undefined}
                  aria-label={clickable ? `مشاهده دارایی‌های «${card.label}»` : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            goToAssets(card)
                          }
                        }
                      : undefined
                  }
                  style={{ height: '100%', minHeight: 84, '--awm-metric-color': card.tint }}
                  styles={{ body: { padding: '12px 14px', height: '100%', display: 'flex', alignItems: 'center' } }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <div
                      className="awm-icon-chip"
                      style={{ background: `${card.tint}1a`, color: card.iconColor }}
                    >
                      {card.icon}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <Text type="secondary" style={{ fontSize: 12.5 }}>
                        {card.label}
                      </Text>
                      <div className="awm-mono" style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}>
                        {figure(card.value)}
                      </div>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            title={<SectionTitle icon={<PieChartOutlined />}>توزیع وضعیت دارایی‌ها</SectionTitle>}
            size="small"
            style={{ height: '100%', minHeight: 280 }}
          >
            {stats ? (
              <StatusDonutChart byStatus={stats.byStatus} total={stats.total} />
            ) : statsFailed ? (
              <Empty description="آمار در دسترس نیست" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <div
                className="awm-loading"
                style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Spin />
              </div>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card
            title={<SectionTitle icon={<SafetyCertificateOutlined />}>کیفیت داده‌ها</SectionTitle>}
            size="small"
            style={{ height: '100%', minHeight: 280 }}
          >
            <DataQualityPanel quality={quality} navigate={navigate} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={8}>
          <Card
            title={<SectionTitle icon={<HistoryOutlined />}>فعالیت‌های اخیر</SectionTitle>}
            extra={
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => navigate('/audit-log')}>
                مشاهده همه
              </Button>
            }
            size="small"
            style={{ height: '100%', minHeight: 260 }}
          >
            {!activityLoading && entries.length === 0 ? (
              <Empty description="هنوز فعالیتی ثبت نشده" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <List
                size="small"
                loading={activityLoading}
                dataSource={entries}
                renderItem={(item) => {
                  const clickable = item.entity_type === 'Asset' && item.entity_id
                  const content = (
                    <div style={{ width: '100%' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <Text strong>
                          {ENTITY_LABELS[item.entity_type] || item.entity_type}
                          {item.entity_id ? ` #${item.entity_id}` : ''}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                          {toJalaliDisplay(item.occurred_at)}
                        </Text>
                      </div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {ACTION_LABELS[item.action] || item.action} · {item.username_snapshot}
                      </Text>
                    </div>
                  )
                  return (
                    <List.Item style={clickable ? { padding: 0 } : undefined}>
                      {clickable ? (
                        <div
                          onClick={() => navigate(`/assets/${item.entity_id}`)}
                          className="awm-list-item-clickable"
                          style={{ width: '100%', padding: 8 }}
                          tabIndex={0}
                          role="button"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              navigate(`/assets/${item.entity_id}`)
                            }
                          }}
                        >
                          {content}
                        </div>
                      ) : (
                        content
                      )}
                    </List.Item>
                  )
                }}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} md={12} lg={8}>
          <Card
            title={<SectionTitle icon={<PlusCircleOutlined />}>دارایی‌های تازه‌افزوده</SectionTitle>}
            size="small"
            style={{ height: '100%', minHeight: 260 }}
          >
            <AssetMiniList
              assets={recentlyAdded}
              dateField="createdAt"
              emptyText="هنوز دارایی‌ای ثبت نشده"
              navigate={navigate}
            />
          </Card>
        </Col>
        <Col xs={24} md={12} lg={8}>
          <Card
            title={<SectionTitle icon={<EditOutlined />}>دارایی‌های اخیراً ویرایش‌شده</SectionTitle>}
            size="small"
            style={{ height: '100%', minHeight: 260 }}
          >
            <AssetMiniList
              assets={recentlyModified}
              dateField="updatedAt"
              emptyText="هنوز ویرایشی ثبت نشده"
              navigate={navigate}
            />
          </Card>
        </Col>
      </Row>
    </div>
  )
}
