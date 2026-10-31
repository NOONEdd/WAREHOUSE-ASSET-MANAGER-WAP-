import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Card, Divider, Form, Input, Select, Space, Typography, message, Spin } from 'antd'
import { ArrowRightOutlined } from '@ant-design/icons'
import { assetFieldGroups } from '../components/assets/assetFieldGroups'
import { GROUP_ICONS } from '../components/assets/groupIcons'
import PageHeader from '../components/common/PageHeader'
import JalaliDatePicker from '../components/common/JalaliDatePicker'
import { useAsset } from '../hooks/useAssets'
import { useLookups } from '../hooks/useLookups'
import { notifyBackupWarning } from '../utils/backupWarning'

const { Text } = Typography

const LOOKUP_KEY = { itemType: 'itemTypes', country: 'countries', workshop: 'workshops', status: 'statuses' }

// Read-only fields (Asset ID, Created Date, Last Modified Date) are never
// submitted or validated, so they're rendered as plain text rather than
// wired through Form.Item — kept as a standalone component (not nested
// inside AssetFormPage's render) so it isn't recreated on every keystroke.
function ReadOnlyField({ field, existing }) {
  const display =
    (existing && existing[field.key]) ||
    (field.key === 'id' ? '(خودکار)' : 'پس از ذخیره تعیین می‌شود')

  return (
    <Form.Item label={field.label}>
      <Text type="secondary" className={field.mono ? 'awm-mono' : undefined}>
        {display}
      </Text>
    </Form.Item>
  )
}

function EditableField({ field, lookups, currentValue }) {
  const rules = field.required ? [{ required: true, message: 'این فیلد الزامی است' }] : []

  if (field.type === 'select') {
    const allOptions = lookups?.[LOOKUP_KEY[field.key]] || []
    // Base Data Lifecycle phase — all four lookup kinds now carry
    // is_active (item types/workshops/countries alongside status). A
    // deactivated value must not be offered for a NEW selection, but if
    // the asset being edited already has one (set before it was
    // deactivated), it still needs to display correctly here rather than
    // as an invalid/blank value — the backend enforces the same "must be
    // active unless unchanged" rule independently in
    // assetService.resolveLookupId, so this is what keeps the form
    // consistent with what a save will actually accept, not the only
    // thing enforcing it.
    const selectable = allOptions.filter((v) => v.is_active || v.name === currentValue)
    const options = selectable.map((v) => ({ value: v.name, label: v.name }))
    return (
      <Form.Item label={field.label} name={field.key} rules={rules}>
        <Select placeholder="انتخاب کنید" options={options} />
      </Form.Item>
    )
  }

  if (field.type === 'date') {
    return (
      <Form.Item label={field.label} name={field.key} rules={rules}>
        <JalaliDatePicker ariaLabel={field.label} />
      </Form.Item>
    )
  }

  if (field.type === 'textarea') {
    return (
      <Form.Item label={field.label} name={field.key} rules={rules}>
        <Input.TextArea rows={2} />
      </Form.Item>
    )
  }

  return (
    <Form.Item label={field.label} name={field.key} rules={rules}>
      <Input className={field.mono ? 'awm-mono' : undefined} />
    </Form.Item>
  )
}

export default function AssetFormPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [form] = Form.useForm()
  const isEditing = id && id !== 'new'
  const existing = useAsset(isEditing ? id : null)
  const { lookups, loading: lookupsLoading } = useLookups()
  const [saving, setSaving] = useState(false)

  if (isEditing && existing === undefined) {
    return (
      <div className="awm-loading" style={{ textAlign: 'center', padding: 60 }}>
        <Spin size="large" />
      </div>
    )
  }

  // Audit finding (IMPORTANT): the previous single .catch() on this whole
  // chain caught both a failed validation AND a failed save the same way
  // — showing "please complete required fields" even when the real
  // problem was a save failure, and if the save call itself ever threw,
  // setSaving(false) was never reached, leaving the button stuck on
  // "loading" permanently. Split so each failure gets accurate feedback
  // and saving is always cleared.
  async function handleSave() {
    let values
    try {
      values = await form.validateFields()
    } catch {
      message.error('لطفاً فیلدهای الزامی را تکمیل کنید')
      return
    }

    setSaving(true)
    try {
      const result = isEditing
        ? await window.api.assets.update(Number(id), values)
        : await window.api.assets.create(values)
      if (result.success) {
        message.success(isEditing ? 'دارایی به‌روزرسانی شد' : 'دارایی ثبت شد')
        notifyBackupWarning(result)
        navigate(`/assets/${result.asset.id}`)
      } else {
        message.error(result.error)
      }
    } catch {
      message.error(isEditing ? 'به‌روزرسانی دارایی با خطا مواجه شد' : 'ثبت دارایی با خطا مواجه شد')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <Button
        type="link"
        icon={<ArrowRightOutlined />}
        onClick={() => navigate('/assets')}
        style={{ paddingInlineStart: 0, marginBottom: 4 }}
      >
        بازگشت به دارایی‌ها
      </Button>

      <PageHeader
        title={isEditing ? 'ویرایش دارایی' : 'افزودن دارایی'}
        description="اطلاعات را در گروه‌های زیر تکمیل کنید — فیلدهای ستاره‌دار الزامی هستند"
      />

      <Card size="small">
        <Form
          form={form}
          layout="vertical"
          initialValues={existing || { status: lookups?.statuses?.find((s) => s.is_active)?.name }}
        >
          {assetFieldGroups.map((group) => (
            <div key={group.title} style={{ marginBottom: 26 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  marginBottom: 16,
                  paddingBottom: 10,
                  borderBottom: '1px solid var(--awm-border)'
                }}
              >
                {/* Phase 10 — same tinted icon-chip used for the Dashboard's
                    section headers, so a "group of fields" and a "group of
                    stats" read as the same visual pattern across the app. */}
                <span className="awm-section-icon">{GROUP_ICONS[group.iconKey]}</span>
                <span
                  style={{
                    fontWeight: 700,
                    fontSize: 14,
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
              {/* Three columns where they fit (≈ 260px each), fewer on
                  tablets and one on phones; wide fields span the row. */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))', gap: '0 16px' }}>
                {group.fields.map((field) => (
                  <div key={field.key} style={{ gridColumn: field.wide ? '1 / -1' : 'auto' }}>
                    {field.readOnly ? (
                      <ReadOnlyField field={field} existing={existing} />
                    ) : (
                      <EditableField field={field} lookups={lookups} currentValue={existing?.[field.key]} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          <Divider style={{ margin: '4px 0 16px' }} />

          <Space>
            <Button type="primary" onClick={handleSave} loading={saving} disabled={lookupsLoading}>
              ذخیره
            </Button>
            <Button onClick={() => navigate('/assets')} disabled={saving}>
              انصراف
            </Button>
          </Space>
        </Form>
      </Card>
    </div>
  )
}
