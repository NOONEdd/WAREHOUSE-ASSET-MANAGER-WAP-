import { Row, Col, Card, Typography, List, Empty, Spin, Button, Space } from 'antd'
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
  EditOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { formatPersianNumber } from '../utils/numberFormat'
import { toJalaliDisplay } from '../utils/dateDisplay'
import { useDashboardStats, useRecentActivity } from '../hooks/useAssets'
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
        <List.Item
          onClick={() => navigate(`/assets/${asset.id}`)}
          className="awm-list-item-clickable"
          style={{ paddingInline: 8 }}
          tabIndex={0}
          role="button"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              navigate(`/assets/${asset.id}`)
            }
          }}
        >
          <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
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

export default function DashboardPage() {
  const navigate = useNavigate()
  const stats = useDashboardStats()
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

  // Phase 10 — composition only: statCardsFrom's data/order/click-target
  // logic is untouched. Card 0 ("کل دارایی‌ها") becomes the full hero;
  // the remaining three render in a single row beside it (previously a
  // 2×2 grid for four cards — reduced to one row of three when "تعمیر"
  // was dropped from the system status set, so the total is still the
  // visually dominant figure instead of one of several identically-sized
  // cards).
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

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={7}>
          <Card
            className={heroClickable ? 'awm-hero-card awm-stat-card' : 'awm-hero-card'}
            styles={{ body: { padding: 20, height: '100%', display: 'flex', alignItems: 'center' } }}
            style={{ height: '100%', minHeight: 148 }}
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
                <div className="awm-mono awm-hero-figure">
                  {stats ? formatPersianNumber(heroCard.value) : <Spin size="small" />}
                </div>
              </div>
            </div>
          </Card>
        </Col>
        <Col span={17}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gridTemplateRows: '1fr',
              gap: 12,
              height: '100%',
              minHeight: 148
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
                  style={{ height: '100%', '--awm-metric-color': card.tint }}
                  styles={{ body: { padding: '0 14px', height: '100%', display: 'flex', alignItems: 'center' } }}
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
                        {stats ? formatPersianNumber(card.value) : <Spin size="small" />}
                      </div>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={14}>
          <Card
            title={
              <span>
                <span className="awm-section-icon">
                  <PieChartOutlined />
                </span>
                روند وضعیت دارایی‌ها
              </span>
            }
            size="small"
            style={{ height: 280 }}
          >
            {stats ? (
              <StatusDonutChart byStatus={stats.byStatus} total={stats.total} />
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
        <Col span={10}>
          <Card
            title={
              <span>
                <span className="awm-section-icon">
                  <HistoryOutlined />
                </span>
                فعالیت‌های اخیر
              </span>
            }
            extra={
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => navigate('/audit-log')}>
                مشاهده همه
              </Button>
            }
            size="small"
            style={{ height: 280, overflow: 'auto' }}
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
                  return (
                    <List.Item
                      onClick={() => clickable && navigate(`/assets/${item.entity_id}`)}
                      className={clickable ? 'awm-list-item-clickable' : undefined}
                      style={clickable ? { paddingInline: 8 } : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      role={clickable ? 'button' : undefined}
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                navigate(`/assets/${item.entity_id}`)
                              }
                            }
                          : undefined
                      }
                    >
                      <div style={{ width: '100%' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Text strong>
                            {ENTITY_LABELS[item.entity_type] || item.entity_type}
                            {item.entity_id ? ` #${item.entity_id}` : ''}
                          </Text>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {toJalaliDisplay(item.occurred_at)}
                          </Text>
                        </div>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {ACTION_LABELS[item.action] || item.action} · {item.username_snapshot}
                        </Text>
                      </div>
                    </List.Item>
                  )
                }}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card
            title={
              <span>
                <span className="awm-section-icon">
                  <PlusCircleOutlined />
                </span>
                دارایی‌های تازه‌افزوده
              </span>
            }
            size="small"
            style={{ height: 260, overflow: 'auto' }}
          >
            <AssetMiniList
              assets={recentlyAdded}
              dateField="createdAt"
              emptyText="هنوز دارایی‌ای ثبت نشده"
              navigate={navigate}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card
            title={
              <span>
                <span className="awm-section-icon">
                  <EditOutlined />
                </span>
                دارایی‌های اخیراً ویرایش‌شده
              </span>
            }
            size="small"
            style={{ height: 260, overflow: 'auto' }}
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
