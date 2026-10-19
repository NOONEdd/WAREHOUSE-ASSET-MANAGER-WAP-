import { useEffect, useState } from 'react'
import { Card, List, Button, Typography, Drawer, Table, Tooltip, Empty, Spin, Space, message } from 'antd'
import {
  FileExcelOutlined,
  FilePdfOutlined,
  EyeOutlined,
  UnorderedListOutlined,
  PieChartOutlined,
  ApartmentOutlined,
  TagsOutlined,
  GlobalOutlined,
  SwapOutlined,
  HistoryOutlined
} from '@ant-design/icons'
import { formatPersianNumber } from '../utils/numberFormat'
import { toJalaliDisplay } from '../utils/dateDisplay'
import {
  useDashboardStats,
  useAssetCountByWorkshop,
  useAssetCountByItemType,
  useAssetCountByCountry,
  useAssets
} from '../hooks/useAssets'
import { useAllTransactions } from '../hooks/useTransactions'
import { useAuditLog } from '../hooks/useAuditLog'
import StatusBadge from '../components/assets/StatusBadge'
import PageHeader from '../components/common/PageHeader'

const { Text } = Typography

const reportTypes = [
  {
    key: 'asset-list',
    title: 'فهرست دارایی‌ها',
    desc: 'فهرست کامل دارایی‌ها با کد، نام، نوع کالا، سریال، کشور سازنده، واحد، تاریخ ورود/خروج، تحویل‌دهنده/گیرنده و وضعیت',
    icon: <UnorderedListOutlined />
  },
  {
    key: 'by-status',
    title: 'دارایی‌ها بر اساس وضعیت',
    desc: 'تفکیک تعداد دارایی‌ها به ازای هر وضعیت',
    icon: <PieChartOutlined />
  },
  {
    key: 'by-workshop',
    title: 'دارایی‌ها بر اساس واحد',
    desc: 'تفکیک تعداد دارایی‌ها به ازای هر واحد/بخش',
    icon: <ApartmentOutlined />
  },
  {
    key: 'by-item-type',
    title: 'دارایی‌ها بر اساس نوع کالا',
    desc: 'تفکیک تعداد دارایی‌ها به ازای هر نوع کالا',
    icon: <TagsOutlined />
  },
  {
    key: 'by-country',
    title: 'دارایی‌ها بر اساس کشور سازنده',
    desc: 'تفکیک تعداد دارایی‌ها به ازای هر کشور سازنده',
    icon: <GlobalOutlined />
  },
  {
    key: 'transactions',
    title: 'تاریخچه تراکنش‌ها',
    desc: 'تمام رویدادهای ورود، خروج و تغییر وضعیت',
    icon: <SwapOutlined />
  },
  {
    key: 'audit',
    title: 'گزارش رویدادها',
    desc: 'گزارش کامل تغییرات ثبت‌شده در سامانه',
    icon: <HistoryOutlined />
  }
]

// Same two label maps AuditLogPage uses. That page doesn't export them, so
// they're kept here too — duplicating two small objects beats importing
// from another page's internals.
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

function CenteredSpin() {
  return (
    <div className="awm-loading" style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
      <Spin />
    </div>
  )
}

function BreakdownTable({ data, labelTitle }) {
  const columns = [
    { title: labelTitle, dataIndex: 'label', key: 'label' },
    {
      title: 'تعداد',
      dataIndex: 'n',
      key: 'n',
      render: (v) => <span className="awm-mono">{formatPersianNumber(v)}</span>
    }
  ]
  return <Table size="small" rowKey="label" columns={columns} dataSource={data} pagination={false} />
}

// Each report body reports its own export-ready data up to the drawer via
// onExportDataChange as soon as it has loaded — numeric columns keep real
// numbers (not Persian-digit text) so Excel's sort/sum/filter still work;
// exportService formats them for display only in the PDF path. The parent
// remounts these (see key={openReport} below) whenever the selected report
// changes, so stale data from a previous report can't linger.

const assetListColumns = [
  {
    title: 'کد دارایی',
    dataIndex: 'assetCode',
    key: 'assetCode',
    render: (v) => <span className="awm-mono">{v}</span>
  },
  { title: 'نام دارایی', dataIndex: 'assetName', key: 'assetName', render: (v) => v || '—' },
  { title: 'نوع کالا', dataIndex: 'itemType', key: 'itemType', render: (v) => v || '—' },
  {
    title: 'شماره سریال',
    dataIndex: 'serialNumber',
    key: 'serialNumber',
    render: (v) => <span className="awm-mono">{v || '—'}</span>
  },
  { title: 'کشور ساخت', dataIndex: 'country', key: 'country', render: (v) => v || '—' },
  { title: 'واحد/بخش', dataIndex: 'workshop', key: 'workshop', render: (v) => v || '—' },
  {
    title: 'تاریخ ورود به انبار',
    dataIndex: 'entryDate',
    key: 'entryDate',
    render: (v) => <span className="awm-mono">{toJalaliDisplay(v)}</span>
  },
  {
    title: 'تاریخ خروج از انبار',
    dataIndex: 'exitDate',
    key: 'exitDate',
    render: (v) => <span className="awm-mono">{toJalaliDisplay(v)}</span>
  },
  { title: 'تحویل‌دهنده', dataIndex: 'deliveredBy', key: 'deliveredBy', render: (v) => v || '—' },
  { title: 'تحویل‌گیرنده', dataIndex: 'receivedBy', key: 'receivedBy', render: (v) => v || '—' },
  { title: 'وضعیت', dataIndex: 'status', key: 'status', render: (v) => <StatusBadge status={v} /> }
]

// The 11 fields needed to identify and account for an asset from a
// printed/exported list without having to look each one up individually
// by its code: what it is (name, type), how to physically find/verify it
// (code, serial), where it stands (country, unit), when and by whom it
// moved (entry/exit date, deliverer, receiver), and its current status.
// limit: -1 is SQLite's own "no limit" (verified — not a guessed cap like
// 10000), so this never silently truncates as the inventory grows past
// whatever number seemed "big enough" today.
function AssetListReport({ onExportDataChange }) {
  const { rows, loading } = useAssets({ limit: -1 })

  useEffect(() => {
    if (loading) return
    onExportDataChange({
      columns: [
        { title: 'کد دارایی', key: 'assetCode' },
        { title: 'نام دارایی', key: 'assetName' },
        { title: 'نوع کالا', key: 'itemType' },
        { title: 'شماره سریال', key: 'serialNumber' },
        { title: 'کشور ساخت', key: 'country' },
        { title: 'واحد/بخش', key: 'workshop' },
        { title: 'تاریخ ورود به انبار', key: 'entryDate' },
        { title: 'تاریخ خروج از انبار', key: 'exitDate' },
        { title: 'تحویل‌دهنده', key: 'deliveredBy' },
        { title: 'تحویل‌گیرنده', key: 'receivedBy' },
        { title: 'وضعیت', key: 'status' }
      ],
      rows: rows.map((a) => ({
        assetCode: a.assetCode,
        assetName: a.assetName || '—',
        itemType: a.itemType || '—',
        serialNumber: a.serialNumber || '—',
        country: a.country || '—',
        workshop: a.workshop || '—',
        entryDate: toJalaliDisplay(a.entryDate),
        exitDate: toJalaliDisplay(a.exitDate),
        deliveredBy: a.deliveredBy || '—',
        receivedBy: a.receivedBy || '—',
        status: a.status
      }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, rows])

  if (!loading && rows.length === 0) {
    return <Empty style={{ padding: 24 }} description="هنوز دارایی‌ای ثبت نشده" />
  }
  return (
    <Table
      size="small"
      rowKey="id"
      loading={loading}
      columns={assetListColumns}
      dataSource={rows}
      pagination={{ pageSize: 15 }}
    />
  )
}

function ByStatusReport({ onExportDataChange }) {
  const stats = useDashboardStats()

  useEffect(() => {
    if (!stats) return
    onExportDataChange({
      columns: [
        { title: 'وضعیت', key: 'label' },
        { title: 'تعداد', key: 'n', numeric: true }
      ],
      rows: stats.byStatus.map((s) => ({ label: s.status, n: s.n }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats])

  if (!stats) return <CenteredSpin />
  return <BreakdownTable data={stats.byStatus.map((s) => ({ label: s.status, n: s.n }))} labelTitle="وضعیت" />
}

function ByWorkshopReport({ onExportDataChange }) {
  const data = useAssetCountByWorkshop()

  useEffect(() => {
    if (!data) return
    onExportDataChange({
      columns: [
        { title: 'واحد', key: 'label' },
        { title: 'تعداد', key: 'n', numeric: true }
      ],
      rows: data.map((w) => ({ label: w.workshop, n: w.n }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  if (!data) return <CenteredSpin />
  return <BreakdownTable data={data.map((w) => ({ label: w.workshop, n: w.n }))} labelTitle="واحد" />
}

// Phase 4.3 — same exact shape as ByWorkshopReport above, just backed by
// useAssetCountByItemType/useAssetCountByCountry instead.
function ByItemTypeReport({ onExportDataChange }) {
  const data = useAssetCountByItemType()

  useEffect(() => {
    if (!data) return
    onExportDataChange({
      columns: [
        { title: 'نوع کالا', key: 'label' },
        { title: 'تعداد', key: 'n', numeric: true }
      ],
      rows: data.map((t) => ({ label: t.itemType, n: t.n }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  if (!data) return <CenteredSpin />
  return <BreakdownTable data={data.map((t) => ({ label: t.itemType, n: t.n }))} labelTitle="نوع کالا" />
}

function ByCountryReport({ onExportDataChange }) {
  const data = useAssetCountByCountry()

  useEffect(() => {
    if (!data) return
    onExportDataChange({
      columns: [
        { title: 'کشور سازنده', key: 'label' },
        { title: 'تعداد', key: 'n', numeric: true }
      ],
      rows: data.map((c) => ({ label: c.country, n: c.n }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  if (!data) return <CenteredSpin />
  return <BreakdownTable data={data.map((c) => ({ label: c.country, n: c.n }))} labelTitle="کشور سازنده" />
}

const transactionColumns = [
  { title: 'تاریخ', dataIndex: 'transactionDate', key: 'transactionDate', render: toJalaliDisplay },
  {
    title: 'دارایی',
    key: 'asset',
    render: (_, row) => (
      <span>
        {row.assetName} <span className="awm-mono">({row.assetCode})</span>
      </span>
    )
  },
  {
    title: 'وضعیت قبلی ← جدید',
    key: 'change',
    render: (_, row) => `${row.previousStatus || '—'} ← ${row.newStatus}`
  },
  { title: 'توسط', dataIndex: 'performedBy', key: 'performedBy' }
]

function TransactionsReport({ onExportDataChange }) {
  const { transactions, loading } = useAllTransactions()

  useEffect(() => {
    if (loading) return
    // Split into separate previous/new columns for export — a single
    // arrow-joined string (used on-screen, more compact) is harder to
    // filter or read in a spreadsheet.
    onExportDataChange({
      columns: [
        { title: 'تاریخ', key: 'date' },
        { title: 'دارایی', key: 'asset' },
        { title: 'وضعیت قبلی', key: 'prevStatus' },
        { title: 'وضعیت جدید', key: 'newStatus' },
        { title: 'توسط', key: 'by' }
      ],
      rows: transactions.map((t) => ({
        date: toJalaliDisplay(t.transactionDate),
        asset: `${t.assetName} (${t.assetCode})`,
        prevStatus: t.previousStatus || '—',
        newStatus: t.newStatus,
        by: t.performedBy
      }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, transactions])

  if (!loading && transactions.length === 0) {
    return <Empty style={{ padding: 24 }} description="هنوز تراکنشی ثبت نشده" />
  }
  return (
    <Table
      size="small"
      rowKey="id"
      loading={loading}
      columns={transactionColumns}
      dataSource={transactions}
      pagination={{ pageSize: 10 }}
    />
  )
}

const auditColumns = [
  { title: 'تاریخ', dataIndex: 'occurred_at', key: 'occurred_at', render: toJalaliDisplay },
  {
    title: 'کاربر',
    dataIndex: 'username_snapshot',
    key: 'username_snapshot',
    render: (v) => <span className="awm-mono">{v}</span>
  },
  { title: 'عملیات', dataIndex: 'action', key: 'action', render: (v) => ACTION_LABELS[v] || v },
  {
    title: 'مورد',
    key: 'entity',
    render: (_, row) =>
      `${ENTITY_LABELS[row.entity_type] || row.entity_type}${row.entity_id ? ` #${row.entity_id}` : ''}`
  }
]

function AuditReport({ onExportDataChange }) {
  const { rows: entries, loading } = useAuditLog({ limit: 100 })

  useEffect(() => {
    if (loading) return
    onExportDataChange({
      columns: [
        { title: 'تاریخ', key: 'date' },
        { title: 'کاربر', key: 'user' },
        { title: 'عملیات', key: 'action' },
        { title: 'مورد', key: 'entity' }
      ],
      rows: entries.map((e) => ({
        date: toJalaliDisplay(e.occurred_at),
        user: e.username_snapshot,
        action: ACTION_LABELS[e.action] || e.action,
        entity: `${ENTITY_LABELS[e.entity_type] || e.entity_type}${e.entity_id ? ` #${e.entity_id}` : ''}`
      }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, entries])

  if (!loading && entries.length === 0) {
    return <Empty style={{ padding: 24 }} description="هنوز رویدادی ثبت نشده" />
  }
  return (
    <Table
      size="small"
      rowKey="id"
      loading={loading}
      columns={auditColumns}
      dataSource={entries}
      pagination={{ pageSize: 10 }}
    />
  )
}

const REPORT_BODIES = {
  'asset-list': AssetListReport,
  'by-status': ByStatusReport,
  'by-workshop': ByWorkshopReport,
  'by-item-type': ByItemTypeReport,
  'by-country': ByCountryReport,
  transactions: TransactionsReport,
  audit: AuditReport
}

export default function ReportsPage() {
  const [openReport, setOpenReport] = useState(null)
  const [exportData, setExportData] = useState(null)
  const [exporting, setExporting] = useState(null) // 'excel' | 'pdf' | null

  const activeReport = reportTypes.find((r) => r.key === openReport)
  const ActiveBody = openReport ? REPORT_BODIES[openReport] : null

  function openDrawer(key) {
    setExportData(null) // cleared immediately, not just on unmount — see ActiveBody's key below
    setOpenReport(key)
  }

  async function handleExport(kind) {
    if (!exportData || !activeReport) return
    setExporting(kind)
    try {
      const payload = { title: activeReport.title, ...exportData }
      const result =
        kind === 'excel' ? await window.api.export.toExcel(payload) : await window.api.export.toPdf(payload)
      if (result.success) {
        message.success('فایل با موفقیت ذخیره شد')
      } else if (!result.canceled) {
        message.error(result.error || 'ذخیره فایل ناموفق بود')
      }
    } catch {
      message.error('ذخیره فایل ناموفق بود')
    } finally {
      setExporting(null)
    }
  }

  return (
    <>
      <PageHeader title="گزارش‌ها" description="گزارش‌های آماده برای مشاهده و خروجی اکسل یا PDF" />
      <Card size="small">
        <List
          dataSource={reportTypes}
          renderItem={(report) => (
            <List.Item
              actions={[
                <Button
                  key="view"
                  type="primary"
                  size="small"
                  icon={<EyeOutlined />}
                  onClick={() => openDrawer(report.key)}
                >
                  مشاهده
                </Button>
              ]}
            >
              <List.Item.Meta
                avatar={
                  <div className="awm-icon-chip" style={{ background: 'rgba(200,134,43,0.1)', color: 'var(--awm-accent)' }}>
                    {report.icon}
                  </div>
                }
                title={report.title}
                description={<Text type="secondary">{report.desc}</Text>}
              />
            </List.Item>
          )}
        />
      </Card>

      <Drawer
        title={activeReport?.title}
        open={!!openReport}
        onClose={() => setOpenReport(null)}
        width={640}
        destroyOnClose
        extra={
          <Space>
            <Tooltip title={!exportData ? 'در حال بارگذاری داده‌ها…' : undefined}>
              <Button
                size="small"
                icon={<FileExcelOutlined />}
                disabled={!exportData}
                loading={exporting === 'excel'}
                onClick={() => handleExport('excel')}
              >
                اکسل
              </Button>
            </Tooltip>
            <Tooltip title={!exportData ? 'در حال بارگذاری داده‌ها…' : undefined}>
              <Button
                size="small"
                icon={<FilePdfOutlined />}
                disabled={!exportData}
                loading={exporting === 'pdf'}
                onClick={() => handleExport('pdf')}
              >
                PDF
              </Button>
            </Tooltip>
          </Space>
        }
      >
        {ActiveBody && <ActiveBody key={openReport} onExportDataChange={setExportData} />}
      </Drawer>
    </>
  )
}
