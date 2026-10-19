import { useEffect, useState } from 'react'
import { Card, Table, Space, Select, Empty, Typography } from 'antd'
import { FilterOutlined } from '@ant-design/icons'
import { toJalaliDisplay } from '../utils/dateDisplay'
import JalaliDatePicker from '../components/common/JalaliDatePicker'
import PageHeader from '../components/common/PageHeader'
import { useAuditLog } from '../hooks/useAuditLog'

const { Text } = Typography

// Reliability + UX phase (3.1) — real server-side pagination, same
// PAGE_SIZE/page/onChange shape as AssetsPage/AssetTable.
const PAGE_SIZE = 50

const ACTION_LABELS = {
  CREATE: 'ایجاد',
  UPDATE: 'ویرایش',
  DELETE: 'حذف',
  LOGIN: 'ورود',
  LOGOUT: 'خروج',
  BACKUP_CREATED: 'پشتیبان‌گیری',
  BACKUP_RESTORED: 'بازیابی',
  EXPORT: 'خروجی',
  IMPORT: 'ایجاد از ورود اطلاعات',
  IMPORT_UPDATE: 'به‌روزرسانی از ورود اطلاعات',
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

const columns = [
  { title: 'تاریخ', dataIndex: 'occurred_at', key: 'occurred_at', render: toJalaliDisplay, width: 150 },
  {
    title: 'کاربر',
    dataIndex: 'username_snapshot',
    key: 'username_snapshot',
    width: 130,
    render: (v) => <span className="awm-mono">{v}</span>
  },
  {
    title: 'عملیات',
    dataIndex: 'action',
    key: 'action',
    width: 150,
    render: (v) => ACTION_LABELS[v] || v
  },
  {
    title: 'مورد',
    key: 'entity',
    width: 130,
    render: (_, row) =>
      `${ENTITY_LABELS[row.entity_type] || row.entity_type}${row.entity_id ? ` #${row.entity_id}` : ''}`
  },
  {
    title: 'جزئیات',
    dataIndex: 'changes',
    key: 'changes',
    render: (v) =>
      v ? (
        <Text className="awm-mono" style={{ fontSize: 12 }} ellipsis={{ tooltip: JSON.stringify(v) }}>
          {JSON.stringify(v)}
        </Text>
      ) : (
        '—'
      )
  }
]

export default function AuditLogPage() {
  // Reliability + UX phase (3.1) — these three used to sit in the JSX
  // below with no value/onChange at all: visually a filter bar, but
  // every control was inert, and the page always just showed a flat
  // "latest 100" with no way to see anything older. Now real state,
  // wired through to the repository's WHERE clause (auditLogRepository.js).
  const [actionFilter, setActionFilter] = useState(undefined)
  const [dateFrom, setDateFrom] = useState(undefined)
  const [dateTo, setDateTo] = useState(undefined)
  const [page, setPage] = useState(1)

  // A changed filter can leave a previously-selected page out of range
  // (page 3 of an unfiltered log may not exist once a filter narrows the
  // result down to one page) — same reasoning/pattern as AssetsPage.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setPage(1), [actionFilter, dateFrom, dateTo])

  const { rows: entries, total, loading } = useAuditLog({
    action: actionFilter,
    from: dateFrom,
    to: dateTo,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE
  })

  const isFiltered = Boolean(actionFilter || dateFrom || dateTo)

  return (
    <div>
      <PageHeader title="گزارش رویدادها" description="تاریخچه کامل رویدادهای ثبت‌شده در سامانه" />
      {/* Phase 10 — same "sunken" toolbar treatment as the Assets page's
          search/filter bar, so the two filter bars in the app (which do
          the same job) look like the same component. */}
      <div className="awm-toolbar" style={{ marginBottom: 12 }}>
        <Space wrap>
          <FilterOutlined style={{ color: 'var(--awm-text-secondary)' }} />
          <Select
            placeholder="نوع عملیات"
            style={{ width: 150, background: 'var(--awm-surface)' }}
            allowClear
            value={actionFilter}
            onChange={setActionFilter}
            options={Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <Space size={4}>
            از <JalaliDatePicker value={dateFrom} onChange={setDateFrom} /> تا{' '}
            <JalaliDatePicker value={dateTo} onChange={setDateTo} />
          </Space>
        </Space>
      </div>
      <Card size="small" styles={{ body: { padding: 0 } }}>
        {!loading && entries.length === 0 ? (
          <Empty
            style={{ padding: 40 }}
            description={isFiltered ? 'رویدادی مطابق این فیلترها یافت نشد' : 'هنوز رویدادی ثبت نشده'}
          />
        ) : (
          <Table
            size="middle"
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={entries}
            pagination={{
              current: page,
              pageSize: PAGE_SIZE,
              total,
              showTotal: (t) => `${t} رویداد`,
              onChange: setPage
            }}
          />
        )}
      </Card>
    </div>
  )
}
