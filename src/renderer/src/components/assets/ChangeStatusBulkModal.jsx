import { useState } from 'react'
import { Modal, Form, Select, Input, message } from 'antd'
import { useLookups } from '../../hooks/useLookups'
import { formatPersianNumber } from '../../utils/numberFormat'
import { notifyBackupWarning } from '../../utils/backupWarning'

// Phase 4.1 — bulk counterpart of ChangeStatusModal. Kept as its own
// component rather than a branch inside that one: the active-status
// filter here can't exclude "the asset's current status" (selected
// assets may currently be at several different statuses at once), the
// API call and result shape differ (assets:changeStatusBulk vs
// assets:changeStatus), and the two success messages need to say
// different things. The form fields themselves (status/deliveredBy/
// receivedBy/notes) and the overall modal shape are deliberately
// identical, so switching between the single and bulk flows feels like
// the same feature, not two unrelated ones.
export default function ChangeStatusBulkModal({ open, count, assetIds, onClose, onChanged }) {
  const [form] = Form.useForm()
  const { lookups } = useLookups()
  const [saving, setSaving] = useState(false)

  async function handleOk() {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const result = await window.api.assets.changeStatusBulk(assetIds, values)
      if (result.success) {
        if (result.skippedCount > 0) {
          message.success(
            `وضعیت ${formatPersianNumber(result.changedCount)} دارایی تغییر کرد` +
              ` (${formatPersianNumber(result.skippedCount)} مورد از قبل همین وضعیت را داشتند)`
          )
        } else {
          message.success(`وضعیت ${formatPersianNumber(result.changedCount)} دارایی تغییر کرد`)
        }
        notifyBackupWarning(result)
        form.resetFields()
        onChanged()
      } else {
        message.error(result.error)
      }
    } catch {
      message.error('تغییر وضعیت با خطا مواجه شد')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`تغییر وضعیت گروهی — ${formatPersianNumber(count)} دارایی انتخاب‌شده`}
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={saving}
      okText="ثبت"
      cancelText="انصراف"
    >
      <Form form={form} layout="vertical" initialValues={{ newStatus: undefined }}>
        <Form.Item
          name="newStatus"
          label="وضعیت جدید"
          rules={[{ required: true, message: 'وضعیت جدید را انتخاب کنید' }]}
        >
          <Select
            placeholder="انتخاب کنید"
            // Only an active status is offered — same rule as the
            // single-asset modal (Base Data Lifecycle phase); the backend
            // (assetService.changeAssetStatusBulk → resolveLookupId)
            // enforces this regardless, this is just so the dropdown
            // itself never suggests an option the backend would reject.
            options={lookups?.statuses.filter((s) => s.is_active).map((s) => ({ value: s.name, label: s.name }))}
          />
        </Form.Item>
        <Form.Item name="deliveredBy" label="تحویل‌دهنده">
          <Input />
        </Form.Item>
        <Form.Item name="receivedBy" label="تحویل‌گیرنده">
          <Input />
        </Form.Item>
        <Form.Item name="notes" label="یادداشت">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
