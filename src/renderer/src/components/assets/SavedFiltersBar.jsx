import { useState } from 'react'
import { Select, Button, Tooltip, Modal, Input, message, Space } from 'antd'
import { SaveOutlined, CloseOutlined } from '@ant-design/icons'
import { useSavedFilters } from '../../hooks/useAssets'

// Phase 4.4 — Assets page's saved filter presets. A small, self-contained
// bar: AssetsPage only needs to hand it the current search/filters and a
// callback for when a saved preset is picked — it owns its own
// fetch/save/delete plumbing (useSavedFilters) rather than pushing that
// state up into AssetsPage, which already has enough of its own.
export default function SavedFiltersBar({ currentSearch, currentFilters, onApply }) {
  const { savedFilters, loading, reload } = useSavedFilters()
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const hasActiveQuery = Boolean(
    currentSearch || Object.values(currentFilters).some((v) => v !== undefined && v !== null && v !== '')
  )

  async function handleSave() {
    setSaving(true)
    try {
      const result = await window.api.savedFilters.create(name, { search: currentSearch, ...currentFilters })
      if (result.success) {
        message.success('فیلتر ذخیره شد')
        setSaveModalOpen(false)
        setName('')
        reload()
      } else {
        message.error(result.error)
      }
    } catch {
      message.error('ذخیره فیلتر با خطا مواجه شد')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id) {
    try {
      await window.api.savedFilters.delete(id)
      reload()
    } catch {
      message.error('حذف فیلتر با خطا مواجه شد')
    }
  }

  return (
    <>
      <Space size={4}>
        <Select
          placeholder="فیلترهای ذخیره‌شده"
          aria-label="فیلترهای ذخیره‌شده"
          style={{ width: 180, background: 'var(--awm-surface)' }}
          loading={loading}
          value={undefined}
          notFoundContent="هنوز فیلتری ذخیره نشده"
          onChange={(id) => {
            const preset = savedFilters.find((f) => f.id === id)
            if (preset) onApply(preset.filters)
          }}
          options={savedFilters.map((f) => ({ value: f.id, label: f.name }))}
          // Each option renders with its own delete (×) button — the
          // simplest way to manage the list without a separate
          // "manage saved filters" screen for what's usually a short list.
          optionRender={(option) => (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
              <span>{option.label}</span>
              <CloseOutlined
                style={{ color: 'var(--awm-text-secondary)', fontSize: 11 }}
                onClick={(e) => {
                  e.stopPropagation()
                  handleDelete(option.value)
                }}
              />
            </div>
          )}
        />
        <Tooltip title={hasActiveQuery ? 'ذخیره فیلتر فعلی' : 'ابتدا جستجو یا فیلتری اعمال کنید'}>
          <Button icon={<SaveOutlined />} aria-label="ذخیره فیلتر فعلی" disabled={!hasActiveQuery} onClick={() => setSaveModalOpen(true)} />
        </Tooltip>
      </Space>

      <Modal
        title="ذخیره فیلتر فعلی"
        open={saveModalOpen}
        onCancel={() => setSaveModalOpen(false)}
        onOk={handleSave}
        okText="ذخیره"
        cancelText="انصراف"
        confirmLoading={saving}
        okButtonProps={{ disabled: !name.trim() }}
      >
        <Input
          placeholder="نام این فیلتر را وارد کنید"
          aria-label="نام فیلتر"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={handleSave}
          autoFocus
        />
      </Modal>
    </>
  )
}
