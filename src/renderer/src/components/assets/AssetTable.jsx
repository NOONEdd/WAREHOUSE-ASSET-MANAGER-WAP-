import { Table } from 'antd'
import StatusBadge from './StatusBadge'

// Phase 9: asset code / serial number get a distinct "code chip" treatment
// (mono font, subtle bordered pill) instead of plain mono text — these are
// the two fields a warehouse worker actually scans/matches against a
// physical label, so they need to visually stand apart from ordinary text
// columns like the asset name.
function CodeChip({ value }) {
  return (
    <span className="awm-mono awm-code-chip">{value}</span>
  )
}

const columns = [
  {
    title: 'کد دارایی',
    dataIndex: 'assetCode',
    key: 'assetCode',
    width: 150,
    render: (v) => <CodeChip value={v} />
  },
  { title: 'نام دارایی', dataIndex: 'assetName', key: 'assetName', ellipsis: true },
  {
    title: 'شماره سریال',
    dataIndex: 'serialNumber',
    key: 'serialNumber',
    width: 170,
    render: (v) => <CodeChip value={v} />
  },
  {
    title: 'وضعیت',
    dataIndex: 'status',
    key: 'status',
    width: 130,
    render: (status) => <StatusBadge status={status} />
  },
  { title: 'واحد', dataIndex: 'workshop', key: 'workshop', width: 160, ellipsis: true }
]

// Phase 5 — Performance: pagination is now server-driven. `assets` is
// only ever the current page's rows (assetRepository.list's LIMIT/OFFSET
// — see AssetsPage), not the full result set, so this must NOT let AntD
// paginate client-side over `assets` again (which would only ever show
// one page, sized to however many rows the server happened to return).
// `current`/`total` come from the real server-side page/count so the
// pager reflects all matching assets, not just the ones already fetched;
// `onChange` reports the requested page back up to AssetsPage, which
// re-queries with the new offset.
export default function AssetTable({
  assets,
  total,
  loading,
  page = 1,
  pageSize = 50,
  onPageChange,
  onRowClick,
  selectedRowKeys,
  onSelectionChange
}) {
  // Row selection is opt-in — only turns on when AssetsPage passes a
  // handler for it, so this component stays a plain read-only table for
  // any other future caller that doesn't need bulk actions.
  const rowSelection = onSelectionChange
    ? { selectedRowKeys, onChange: onSelectionChange, columnWidth: 42 }
    : undefined

  return (
    <Table
      rowKey="id"
      dataSource={assets}
      columns={columns}
      size="middle"
      loading={loading}
      rowSelection={rowSelection}
      pagination={{
        current: page,
        pageSize,
        total,
        showTotal: (t) => `${t} دارایی`,
        onChange: onPageChange
      }}
      onRow={(record) => ({
        // Clicking the row navigates to its details — but not when the
        // click actually landed on the selection checkbox, or checking a
        // box to bulk-select for label printing would also yank the user
        // into the details page.
        onClick: (e) => {
          if (e.target.closest('.ant-checkbox-wrapper')) return
          onRowClick?.(record)
        },
        style: { cursor: 'pointer' }
      })}
    />
  )
}
