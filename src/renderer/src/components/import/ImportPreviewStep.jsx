import { Table, Tag, Statistic, Row, Col, Radio, Alert, Button, Space, Typography } from 'antd'
import { FileTextOutlined, CheckCircleOutlined, ExclamationCircleOutlined, CopyOutlined, CloseCircleOutlined } from '@ant-design/icons'
import { toPersianDigits } from '../../utils/numberFormat'

const { Text } = Typography

const SEVERITY_TAG = {
  valid: { color: 'success', label: 'معتبر' },
  warning: { color: 'warning', label: 'هشدار' },
  duplicate: { color: 'blue', label: 'تکراری' },
  error: { color: 'error', label: 'خطا' }
}

// Fields worth a monospace/ltr rendering — codes and serials read better
// this way regardless of what the field itself is called.
const MONO_FIELDS = new Set(['assetCode', 'serialNumber'])

/**
 * One column per canonical field (assetImportSchema.js, received as
 * `fieldSchema` from the same parseFile response the mapping step used) —
 * every field the row COULD have, not just the handful that happened to
 * auto-map. A required field with no value renders as a red dash rather
 * than a plain one, so a gap is something the person notices while
 * scanning the table, not something they only find out about from the
 * summary count off to the side.
 */
function buildFieldColumns(fieldSchema) {
  return fieldSchema.map((f) => ({
    title: f.required ? `${f.label} *` : f.label,
    key: f.key,
    render: (_, row) => {
      const value = row.fields?.[f.key]
      if (value) {
        return MONO_FIELDS.has(f.key) ? <span className="awm-mono awm-code-chip">{value}</span> : value
      }
      return f.required ? <Text type="danger">—</Text> : <Text type="secondary">—</Text>
    }
  }))
}

const LEADING_COLUMNS = [
  {
    title: 'ردیف',
    dataIndex: 'rowNumber',
    key: 'rowNumber',
    width: 70,
    render: (v) => toPersianDigits(v)
  },
  {
    title: 'وضعیت',
    dataIndex: 'severity',
    key: 'severity',
    width: 100,
    render: (severity) => {
      const tag = SEVERITY_TAG[severity] || { color: 'default', label: severity }
      return <Tag color={tag.color}>{tag.label}</Tag>
    }
  },
  {
    title: 'پیام',
    key: 'messages',
    width: 220,
    render: (_, row) =>
      row.messages?.length ? (
        <Text type={row.severity === 'error' ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
          {row.messages.join(' · ')}
        </Text>
      ) : (
        '—'
      )
  }
]

/**
 * Preview + Validate + Handle Duplicates step, combined into one screen:
 * the classification (VALID/WARNING/DUPLICATE/ERROR) already reflects
 * duplicate detection, so choosing what to do about duplicates belongs
 * right next to seeing them, rather than as a separate screen the person
 * has to remember the numbers from.
 */
export default function ImportPreviewStep({
  results,
  summary,
  duplicatePolicy,
  onDuplicatePolicyChange,
  fieldSchema,
  onBack,
  onConfirm,
  committing
}) {
  const importableCount = summary.valid + summary.warning + (duplicatePolicy !== 'cancel' ? summary.duplicate : 0)
  const columns = [...LEADING_COLUMNS, ...buildFieldColumns(fieldSchema)]

  return (
    <div>
      {/* Phase 10 — each classification is its own edge-accented panel
          (same language as the Dashboard's .awm-metric-card) instead of
          five Statistics sitting in one undifferentiated Card — the
          accent bar itself now carries the valid/warning/duplicate/error
          distinction, restrained rather than a full-color block. */}
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={5}>
          <div className="awm-preview-chip" style={{ '--awm-metric-color': 'var(--awm-text-secondary)' }}>
            <Statistic
              title="کل ردیف‌ها"
              value={toPersianDigits(summary.total)}
              prefix={<FileTextOutlined style={{ color: 'var(--awm-text-secondary)' }} />}
            />
          </div>
        </Col>
        <Col span={5}>
          <div className="awm-preview-chip" style={{ '--awm-metric-color': 'var(--awm-preview-valid)' }}>
            <Statistic
              title="معتبر"
              value={toPersianDigits(summary.valid)}
              valueStyle={{ color: 'var(--awm-preview-valid)' }}
              prefix={<CheckCircleOutlined />}
            />
          </div>
        </Col>
        <Col span={5}>
          <div className="awm-preview-chip" style={{ '--awm-metric-color': 'var(--awm-preview-warning)' }}>
            <Statistic
              title="هشدار"
              value={toPersianDigits(summary.warning)}
              valueStyle={{ color: 'var(--awm-preview-warning)' }}
              prefix={<ExclamationCircleOutlined />}
            />
          </div>
        </Col>
        <Col span={5}>
          <div className="awm-preview-chip" style={{ '--awm-metric-color': 'var(--awm-preview-duplicate)' }}>
            <Statistic
              title="تکراری"
              value={toPersianDigits(summary.duplicate)}
              valueStyle={{ color: 'var(--awm-preview-duplicate)' }}
              prefix={<CopyOutlined />}
            />
          </div>
        </Col>
        <Col span={4}>
          <div className="awm-preview-chip" style={{ '--awm-metric-color': 'var(--awm-preview-error)' }}>
            <Statistic
              title="خطا (وارد نمی‌شود)"
              value={toPersianDigits(summary.error)}
              valueStyle={{ color: 'var(--awm-preview-error)' }}
              prefix={<CloseCircleOutlined />}
            />
          </div>
        </Col>
      </Row>

      {summary.duplicate > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="نحوه برخورد با ردیف‌های تکراری"
          description={
            <Radio.Group
              value={duplicatePolicy}
              onChange={(e) => onDuplicatePolicyChange(e.target.value)}
              style={{ marginTop: 8 }}
            >
              <Space direction="vertical">
                <Radio value="skip">نادیده گرفتن موارد تکراری (دارایی موجود دست‌نخورده می‌ماند)</Radio>
                <Radio value="update">به‌روزرسانی دارایی‌های موجود با اطلاعات فایل</Radio>
                <Radio value="cancel">لغو کامل ورود اطلاعات</Radio>
              </Space>
            </Radio.Group>
          }
        />
      )}

      <Table
        size="small"
        rowKey="rowNumber"
        dataSource={results}
        columns={columns}
        scroll={{ x: 'max-content' }}
        pagination={{ pageSize: 50, showTotal: (total) => `${toPersianDigits(total)} ردیف` }}
        style={{ marginBottom: 16 }}
      />

      <Space>
        <Button
          type="primary"
          disabled={importableCount === 0}
          loading={committing}
          onClick={onConfirm}
        >
          {duplicatePolicy === 'cancel' && summary.duplicate > 0
            ? 'لغو ورود اطلاعات'
            : `شروع ورود اطلاعات (${toPersianDigits(importableCount)} ردیف)`}
        </Button>
        <Button onClick={onBack} disabled={committing}>
          بازگشت
        </Button>
      </Space>
    </div>
  )
}
