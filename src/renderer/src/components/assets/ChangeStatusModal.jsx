import { useState } from 'react'
import { Modal, Form, Select, Input, message } from 'antd'
import { useLookups } from '../../hooks/useLookups'
import { notifyBackupWarning } from '../../utils/backupWarning'

export default function ChangeStatusModal({ open, asset, onClose, onChanged }) {
  const [form] = Form.useForm()
  const { lookups } = useLookups()
  const [saving, setSaving] = useState(false)

  // Same fix as AssetFormPage's handleSave: without a try/finally around
  // the actual IPC call, a failure here would leave `saving` stuck true
  // forever — confirmLoading on the modal's OK button would never clear.
  async function handleOk() {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const result = await window.api.assets.changeStatus(asset.id, values)
      if (result.success) {
        message.success('وضعیت به‌روزرسانی شد')
        notifyBackupWarning(result)
        form.resetFields()
        onChanged(result.asset)
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
      title="تغییر وضعیت"
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
            options={lookups?.statuses
              // A deactivated status isn't offered for a new selection
              // (Manual Status Management phase) — same rule
              // AssetFormPage applies, and the asset's current status is
              // already excluded below regardless of its own active state.
              .filter((s) => s.is_active && s.name !== asset?.status)
              .map((s) => ({ value: s.name, label: s.name }))}
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
