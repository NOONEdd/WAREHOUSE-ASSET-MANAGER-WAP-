import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Card, Descriptions, Divider, Table, Typography, Space, Result, Spin, Empty, Modal, message } from 'antd'
import {
  EditOutlined,
  PrinterOutlined,
  SwapOutlined,
  DeleteOutlined,
  ArrowRightOutlined,
  ExclamationCircleFilled
} from '@ant-design/icons'
import { assetFieldGroups } from '../components/assets/assetFieldGroups'
import { GROUP_ICONS } from '../components/assets/groupIcons'
import StatusBadge from '../components/assets/StatusBadge'
import QrCode from '../components/common/QrCode'
import ChangeStatusModal from '../components/assets/ChangeStatusModal'
import { toJalaliDisplay } from '../utils/dateDisplay'
import { useAsset } from '../hooks/useAssets'
import { useTransactions } from '../hooks/useTransactions'
import { notifyBackupWarning } from '../utils/backupWarning'

const { Title } = Typography

const transactionColumns = [
  { title: 'تاریخ', dataIndex: 'transactionDate', key: 'transactionDate', render: toJalaliDisplay },
  {
    title: 'وضعیت قبلی ← جدید',
    key: 'change',
    render: (_, row) => `${row.previousStatus || '—'} ← ${row.newStatus}`
  },
  { title: 'توسط', dataIndex: 'performedBy', key: 'performedBy' },
  { title: 'یادداشت', dataIndex: 'notes', key: 'notes', render: (v) => v || '—' }
]

export default function AssetDetailsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const fetchedAsset = useAsset(id)
  const [localAsset, setLocalAsset] = useState(null)
  const { transactions, loading: transactionsLoading, reload: reloadTransactions } = useTransactions(id)
  const [statusModalOpen, setStatusModalOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const asset = localAsset || fetchedAsset

  if (asset === undefined) {
    return (
      <div className="awm-loading" style={{ textAlign: 'center', padding: 60 }}>
        <Spin size="large" />
      </div>
    )
  }

  if (!asset) {
    return (
      <Result
        status="404"
        title="دارایی یافت نشد"
        extra={
          <Button type="primary" onClick={() => navigate('/assets')}>
            بازگشت به دارایی‌ها
          </Button>
        }
      />
    )
  }

  function handleStatusChanged(updatedAsset) {
    setLocalAsset(updatedAsset)
    setStatusModalOpen(false)
    reloadTransactions()
  }

  function handleDelete() {
    Modal.confirm({
      title: 'حذف این دارایی؟',
      icon: <ExclamationCircleFilled />,
      content: `دارایی «${asset.assetName}» (${asset.assetCode}) پنهان می‌شود اما در سامانه و گزارش رویدادها باقی می‌ماند و قابل بازیابی است.`,
      okText: 'حذف',
      okButtonProps: { danger: true },
      cancelText: 'انصراف',
      onOk: async () => {
        setDeleting(true)
        const result = await window.api.assets.delete(asset.id)
        setDeleting(false)
        if (result.success) {
          message.success('دارایی حذف شد')
          notifyBackupWarning(result)
          navigate('/assets')
        } else {
          message.error(result.error)
        }
      }
    })
  }

  return (
    <div>
      <Button
        type="link"
        icon={<ArrowRightOutlined />}
        onClick={() => navigate('/assets')}
        style={{ paddingInlineStart: 0, marginBottom: 8 }}
      >
        بازگشت به دارایی‌ها
      </Button>

      <Card size="small" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <Space size={14}>
            <QrCode value={asset.assetCode} size={48} />
            <div>
              <Title level={4} style={{ margin: 0 }}>
                {asset.assetName}
              </Title>
              <Space size={8} style={{ marginTop: 4 }}>
                <span className="awm-mono awm-code-chip">{asset.assetCode}</span>
                <StatusBadge status={asset.status} />
              </Space>
            </div>
          </Space>
          <Space split={<Divider type="vertical" style={{ margin: 0 }} />}>
            <Space>
              <Button icon={<EditOutlined />} onClick={() => navigate(`/assets/${asset.id}/edit`)}>
                ویرایش
              </Button>
              <Button icon={<PrinterOutlined />}>چاپ برچسب</Button>
              <Button icon={<SwapOutlined />} onClick={() => setStatusModalOpen(true)}>
                تغییر وضعیت
              </Button>
            </Space>
            <Button danger icon={<DeleteOutlined />} loading={deleting} onClick={handleDelete}>
              حذف
            </Button>
          </Space>
        </div>
      </Card>

      <Card size="small" style={{ marginBottom: 12 }}>
        {assetFieldGroups.map((group) => (
          <div key={group.title} style={{ marginBottom: 22 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                marginBottom: 10,
                paddingBottom: 6,
                borderBottom: '1px solid var(--awm-border)'
              }}
            >
              <span className="awm-section-icon">{GROUP_ICONS[group.iconKey]}</span>
              <span
                style={{
                  fontWeight: 700,
                  fontSize: 13.5,
                  color: group.hint ? 'var(--awm-text-secondary)' : 'var(--awm-text)'
                }}
              >
                {group.title}
              </span>
              {group.hint && (
                <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--awm-text-secondary)', marginInlineStart: 4 }}>
                  {group.hint}
                </span>
              )}
            </div>
            <Descriptions column={3} size="small">
              {group.fields.map((field) => (
                <Descriptions.Item key={field.key} label={field.label} span={field.wide ? 3 : 1}>
                  <span className={field.mono ? 'awm-mono' : undefined}>
                    {renderFieldValue(asset, field)}
                  </span>
                </Descriptions.Item>
              ))}
            </Descriptions>
          </div>
        ))}
      </Card>

      <Card size="small" title="تاریخچه تراکنش‌ها">
        {!transactionsLoading && transactions.length === 0 ? (
          <Empty description="تاکنون رویدادی برای این دارایی ثبت نشده" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table
            size="small"
            rowKey="id"
            loading={transactionsLoading}
            columns={transactionColumns}
            dataSource={transactions}
            pagination={false}
          />
        )}
      </Card>

      <ChangeStatusModal
        open={statusModalOpen}
        asset={asset}
        onClose={() => setStatusModalOpen(false)}
        onChanged={handleStatusChanged}
      />
    </div>
  )
}

function renderFieldValue(asset, field) {
  const raw = asset[field.key]
  if (field.type === 'date') return toJalaliDisplay(raw)
  return raw || '—'
}
