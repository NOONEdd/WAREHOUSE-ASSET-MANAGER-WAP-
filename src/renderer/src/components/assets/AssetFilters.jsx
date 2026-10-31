import { Select, Space, Typography, Button } from 'antd'
import { FilterOutlined } from '@ant-design/icons'
import JalaliDatePicker from '../common/JalaliDatePicker'
import { useLookups } from '../../hooks/useLookups'

export default function AssetFilters({ value = {}, onChange }) {
  const { lookups, loading } = useLookups()

  function update(patch) {
    onChange?.((prev) => ({ ...prev, ...patch }))
  }

  const hasActiveFilter = Object.values(value).some((v) => v !== undefined && v !== null && v !== '')

  return (
    <Space wrap size={8}>
      <FilterOutlined aria-hidden style={{ color: 'var(--awm-text-secondary)' }} />
      <Select
        placeholder="وضعیت"
        aria-label="فیلتر وضعیت"
        style={{ width: 140 }}
        allowClear
        loading={loading}
        value={value.statusId}
        options={lookups?.statuses.map((s) => ({ value: s.id, label: s.name }))}
        onChange={(v) => update({ statusId: v })}
      />
      <Select
        placeholder="واحد"
        aria-label="فیلتر واحد"
        style={{ width: 150 }}
        allowClear
        loading={loading}
        value={value.workshopId}
        options={lookups?.workshops.map((w) => ({ value: w.id, label: w.name }))}
        onChange={(v) => update({ workshopId: v })}
      />
      <Select
        placeholder="نوع کالا"
        aria-label="فیلتر نوع کالا"
        style={{ width: 140 }}
        allowClear
        loading={loading}
        value={value.itemTypeId}
        options={lookups?.itemTypes.map((t) => ({ value: t.id, label: t.name }))}
        onChange={(v) => update({ itemTypeId: v })}
      />
      <Select
        placeholder="کشور"
        aria-label="فیلتر کشور"
        style={{ width: 130 }}
        allowClear
        loading={loading}
        value={value.countryId}
        options={lookups?.countries.map((c) => ({ value: c.id, label: c.name }))}
        onChange={(v) => update({ countryId: v })}
      />
      <Space size={4} wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          از
        </Typography.Text>
        <JalaliDatePicker value={value.from} onChange={(d) => update({ from: d })} ariaLabel="از تاریخ ورود" />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          تا
        </Typography.Text>
        <JalaliDatePicker value={value.to} onChange={(d) => update({ to: d })} ariaLabel="تا تاریخ ورود" />
      </Space>
      {hasActiveFilter && (
        <Button size="small" onClick={() => onChange?.(() => ({}))}>
          پاک کردن فیلترها
        </Button>
      )}
    </Space>
  )
}
