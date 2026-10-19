import { useEffect, useState } from 'react'
import { Button, Input, Space, Card, Empty, Divider, Dropdown, message, Modal } from 'antd'
import {
  PlusOutlined,
  UploadOutlined,
  PrinterOutlined,
  DownloadOutlined,
  SearchOutlined,
  FileExcelOutlined,
  FilePdfOutlined,
  DeleteOutlined,
  SwapOutlined,
  ExclamationCircleFilled
} from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import AssetTable from '../components/assets/AssetTable'
import AssetFilters from '../components/assets/AssetFilters'
import ChangeStatusBulkModal from '../components/assets/ChangeStatusBulkModal'
import SavedFiltersBar from '../components/assets/SavedFiltersBar'
import PageHeader from '../components/common/PageHeader'
import { useAssets } from '../hooks/useAssets'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { formatPersianNumber } from '../utils/numberFormat'
import { toJalaliDisplay } from '../utils/dateDisplay'
import { notifyBackupWarning } from '../utils/backupWarning'

// Same 11 columns as Reports' "فهرست دارایی‌ها" (ReportsPage.jsx's
// AssetListReport) — kept identical so a person exporting from either
// screen gets the same file shape, not two different-looking asset lists.
const EXPORT_COLUMNS = [
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
]

// Phase 5 — Performance: with 5,000+ assets, the list must be fetched a
// page at a time (assetRepository.list's LIMIT/OFFSET) rather than all at
// once — PAGE_SIZE here is that page size, passed through as `limit`.
const PAGE_SIZE = 50

export default function AssetsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [search, setSearch] = useState('')
  // Seeded from Dashboard's clickable stat cards (navigate('/assets',
  // { state: { presetStatusId } })) so "در انبار: 128" actually takes you
  // to those 128 rows instead of just the unfiltered list.
  const [filters, setFilters] = useState(() =>
    location.state?.presetStatusId ? { statusId: location.state.presetStatusId } : {}
  )
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(null) // 'excel' | 'pdf' | null
  const [printing, setPrinting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [selectedRowKeys, setSelectedRowKeys] = useState([])
  // Selection is tracked by id (selectedRowKeys) but printing needs each
  // asset's actual code/name/serial — which only exist in `rows` for
  // whichever page is currently loaded. This caches that data as items
  // get selected, so a selection made on page 1 survives navigating to
  // page 3 and back, without needing to re-fetch anything at print time.
  const [selectedAssetsById, setSelectedAssetsById] = useState({})
  const [statusModalOpen, setStatusModalOpen] = useState(false)

  const debouncedSearch = useDebouncedValue(search, 300)

  // A new search term or filter selection can leave the previously
  // selected page out of range (e.g. page 4 of an unfiltered list has no
  // page 4 once a filter narrows the results down to one page) — jump
  // back to page 1 whenever the query itself changes, not on every
  // render (JSON.stringify(filters) is a proxy for "did the filter
  // selection actually change").
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setPage(1), [debouncedSearch, JSON.stringify(filters)])

  const { rows, total, loading, reload } = useAssets({
    search: debouncedSearch,
    ...filters,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE
  })

  // Whether the *current query* (not just the raw input) has a search term
  // or a filter applied — used to pick which empty state to show.
  const isFiltered = Boolean(
    debouncedSearch || Object.values(filters).some((v) => v !== undefined && v !== null && v !== '')
  )

  function clearSearchAndFilters() {
    setSearch('')
    setFilters({})
  }

  // Exports the *current* search/filter result — every matching row, not
  // just the 50-row page on screen — using the exact same export service
  // and file shape as Reports' "فهرست دارایی‌ها" (ReportsPage.jsx). Fetched
  // fresh here rather than reusing the paginated `rows` above, since that
  // state is intentionally capped at PAGE_SIZE for table performance.
  async function handleExport(kind) {
    setExporting(kind)
    try {
      const { rows: allRows } = await window.api.assets.list({
        search: debouncedSearch,
        ...filters,
        limit: -1
      })
      const payload = {
        title: 'فهرست دارایی‌ها',
        columns: EXPORT_COLUMNS,
        rows: allRows.map((a) => ({
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
      }
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

  function handleSelectionChange(keys, selectedRows) {
    setSelectedRowKeys(keys)
    setSelectedAssetsById((prev) => {
      const next = {}
      for (const k of keys) if (prev[k]) next[k] = prev[k]
      for (const r of selectedRows) if (r) next[r.id] = r
      return next
    })
  }

  async function handlePrintLabels() {
    const assets = selectedRowKeys.map((id) => selectedAssetsById[id]).filter(Boolean)
    if (assets.length === 0) return
    setPrinting(true)
    try {
      const result = await window.api.export.printLabels(
        assets.map((a) => ({
          assetCode: a.assetCode,
          assetName: a.assetName,
          serialNumber: a.serialNumber
        }))
      )
      if (result.success) {
        setSelectedRowKeys([])
        setSelectedAssetsById({})
      } else if (!result.canceled) {
        message.error(result.error || 'چاپ برچسب ناموفق بود')
      }
    } catch {
      message.error('چاپ برچسب ناموفق بود')
    } finally {
      setPrinting(false)
    }
  }

  function handleDeleteSelected() {
    const count = selectedRowKeys.length
    if (count === 0) return
    Modal.confirm({
      title: `حذف ${formatPersianNumber(count)} دارایی؟`,
      icon: <ExclamationCircleFilled />,
      content:
        'دارایی‌های انتخاب‌شده پنهان می‌شوند اما در سامانه و گزارش رویدادها باقی می‌مانند و قابل بازیابی هستند. اگر حتی یکی از موارد قابل حذف نباشد، هیچ‌کدام حذف نخواهند شد.',
      okText: 'حذف',
      okButtonProps: { danger: true },
      cancelText: 'انصراف',
      onOk: async () => {
        setDeleting(true)
        try {
          const result = await window.api.assets.deleteBulk(selectedRowKeys)
          if (result.success) {
            message.success(`${formatPersianNumber(result.count)} دارایی حذف شد`)
            notifyBackupWarning(result)
            setSelectedRowKeys([])
            setSelectedAssetsById({})
            setPage(1)
            reload()
          } else {
            message.error(result.error || 'حذف ناموفق بود')
          }
        } catch {
          message.error('حذف ناموفق بود')
        } finally {
          setDeleting(false)
        }
      }
    })
  }

  return (
    <div>
      <PageHeader
        title="دارایی‌ها"
        description={!loading ? `${formatPersianNumber(total)} دارایی${isFiltered ? ' (نتیجهٔ فیلتر فعلی)' : ''}` : undefined}
        actions={
          <Space size={4} wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/assets/new')}>
              افزودن دارایی
            </Button>
            <Button icon={<UploadOutlined />} onClick={() => navigate('/assets/import')}>
              درون‌ریزی
            </Button>
            <Divider type="vertical" style={{ height: 20, margin: '0 4px' }} />
            <Button
              type="text"
              icon={<PrinterOutlined />}
              disabled={selectedRowKeys.length === 0}
              loading={printing}
              onClick={handlePrintLabels}
            >
              چاپ برچسب{selectedRowKeys.length > 0 ? ` (${formatPersianNumber(selectedRowKeys.length)})` : ''}
            </Button>
            <Dropdown
              menu={{
                items: [
                  { key: 'excel', label: 'خروجی اکسل', icon: <FileExcelOutlined /> },
                  { key: 'pdf', label: 'خروجی PDF', icon: <FilePdfOutlined /> }
                ],
                onClick: ({ key }) => handleExport(key)
              }}
              trigger={['click']}
              disabled={total === 0}
            >
              <Button type="text" icon={<DownloadOutlined />} loading={Boolean(exporting)}>
                خروجی
              </Button>
            </Dropdown>
            <Divider type="vertical" style={{ height: 20, margin: '0 4px' }} />
            <Button
              type="text"
              icon={<SwapOutlined />}
              disabled={selectedRowKeys.length === 0}
              onClick={() => setStatusModalOpen(true)}
            >
              تغییر وضعیت{selectedRowKeys.length > 0 ? ` (${formatPersianNumber(selectedRowKeys.length)})` : ''}
            </Button>
            <Divider type="vertical" style={{ height: 20, margin: '0 4px' }} />
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              disabled={selectedRowKeys.length === 0}
              loading={deleting}
              onClick={handleDeleteSelected}
            >
              حذف{selectedRowKeys.length > 0 ? ` (${formatPersianNumber(selectedRowKeys.length)})` : ''}
            </Button>
          </Space>
        }
      />

      {/* Phase 10 — a "sunken" toolbar surface (a shade deeper than the
          page background) instead of a plain white Card sitting directly
          on top of another plain white Card below — reads as the controls
          tier rather than a second, visually-identical data card. */}
      <div className="awm-toolbar" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <Input
            size="large"
            prefix={<SearchOutlined style={{ color: 'var(--awm-text-secondary)' }} />}
            placeholder="جستجو با کد، سریال، نام، مدل یا شناسه..."
            style={{ width: 320, background: 'var(--awm-surface)' }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
          />
          <Divider type="vertical" style={{ height: 24, margin: 0 }} />
          <AssetFilters value={filters} onChange={setFilters} />
          <Divider type="vertical" style={{ height: 24, margin: 0 }} />
          <SavedFiltersBar
            currentSearch={search}
            currentFilters={filters}
            onApply={(preset) => {
              setSearch(preset.search || '')
              const { search: _search, ...rest } = preset
              setFilters(rest)
            }}
          />
        </div>
      </div>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        {!loading && total === 0 ? (
          isFiltered ? (
            <Empty style={{ padding: 40 }} description="نتیجه‌ای برای این جستجو یا فیلترها یافت نشد">
              <Button onClick={clearSearchAndFilters}>پاک کردن جستجو و فیلترها</Button>
            </Empty>
          ) : (
            <Empty
              style={{ padding: 40 }}
              description="هنوز دارایی‌ای ثبت نشده — با «+ افزودن دارایی» یا «درون‌ریزی» شروع کنید"
            />
          )
        ) : (
          <AssetTable
            assets={rows}
            total={total}
            loading={loading}
            page={page}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            onRowClick={(record) => navigate(`/assets/${record.id}`)}
            selectedRowKeys={selectedRowKeys}
            onSelectionChange={handleSelectionChange}
          />
        )}
      </Card>

      <ChangeStatusBulkModal
        open={statusModalOpen}
        count={selectedRowKeys.length}
        assetIds={selectedRowKeys}
        onClose={() => setStatusModalOpen(false)}
        onChanged={() => {
          setStatusModalOpen(false)
          setSelectedRowKeys([])
          setSelectedAssetsById({})
          reload()
        }}
      />
    </div>
  )
}
