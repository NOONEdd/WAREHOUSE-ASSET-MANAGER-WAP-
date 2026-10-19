import { useEffect } from 'react'
import { Table, Select, Alert, Button, Space, Typography, Radio, Input, AutoComplete } from 'antd'
import { useLookups } from '../../hooks/useLookups'
import { toPersianDigits } from '../../utils/numberFormat'

const { Text } = Typography

// Same mapping used by AssetFormPage.jsx (field key -> lookups object key).
// Kept here rather than in the canonical schema itself since it's purely a
// renderer-side concern (which lookups hook result backs which field's
// dropdown), not part of what a field IS.
const LOOKUP_KEY = { assetType: 'itemTypes', country: 'countries', workshop: 'workshops', status: 'statuses' }

/**
 * A short preview of a column's actual data, shown next to its header in
 * the dropdown below. Exists for one reason: a real file can have two or
 * more columns that share the exact same header text — several columns
 * all literally titled "Date" is common, not hypothetical — and a person
 * cannot pick "the right one" from identical labels alone. The values
 * underneath are almost always different even when the headers aren't,
 * so this is what actually lets someone tell them apart. Checks up to
 * the first 20 rows for a non-empty cell rather than just row 0, since a
 * column can legitimately have its first few values blank (an optional
 * exit date, say) without being empty throughout.
 */
function sampleValueForColumn(rows, columnIndex) {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const raw = rows[r]?.[columnIndex]
    const value = raw instanceof Date ? raw.toLocaleDateString() : String(raw ?? '').trim()
    if (value) return value.length > 24 ? `${value.slice(0, 24)}…` : value
  }
  return null
}

/**
 * Column-mapping step of the Import Wizard.
 *
 * One row per ASSET FIELD (not per file column) — every one of the 13
 * canonical fields (assetImportSchema.js, received here as `fieldSchema`
 * straight from importService.parseFile's response rather than a second
 * hardcoded copy) is always listed, required or not, so a field with no
 * matching column in the file (or one the person simply hasn't looked for
 * yet) is exactly as visible and pickable as one that auto-mapped
 * successfully. For each field the person picks which file column
 * supplies it; auto-mapped guesses (importFieldAliases.js, exact-alias-
 * match only) are pre-selected but always editable — a header that's
 * missing or ambiguous is never silently guessed at, only ever left for
 * the person to resolve here. A required field left with no column gets
 * an inline default (constant value, or copied from another mapped field
 * on the same row) right next to its own column picker — not a separate
 * section — so every field is configured in exactly the same place.
 *
 * `mapping` is keyed by column INDEX, not header text (see
 * importFieldAliases.js's autoMapHeaders) — every read/write here goes
 * through that index, with `headers[index]` used purely for display.
 */
export default function ColumnMappingStep({
  headers,
  rows,
  mapping,
  onChange,
  defaults,
  onDefaultsChange,
  fieldSchema,
  onBack,
  onContinue
}) {
  const FIELD_LABEL = Object.fromEntries(fieldSchema.map((f) => [f.key, f.label]))
  const mappedFieldKeys = new Set(Object.values(mapping).filter(Boolean))
  const missingRequiredFields = fieldSchema.filter(
    (f) => f.required && !mappedFieldKeys.has(f.key)
  )
  // Only fields that actually have real per-row data (mapped to a column
  // in the file) are valid "mirror" sources — mirroring another
  // still-unresolved required field would just chain the gap forward.
  const mirrorableFields = fieldSchema.filter((f) => mappedFieldKeys.has(f.key))
  const unmappedHeaders = headers
    .map((h, i) => ({ header: h, index: i }))
    .filter(({ index }) => !mapping[index])

  const { lookups } = useLookups()

  // A free-text required field (assetName is the only realistic case)
  // has no sensible single value to type — "mirror Asset Code" is a far
  // better starting point than an empty box the person has to guess at.
  // A lookup field (assetType, status, ...) is left for the person to
  // choose explicitly, since guessing a business category isn't safe.
  // Runs once per newly-missing field; never touches a field the person
  // already configured.
  useEffect(() => {
    const assetCodeAvailable = mirrorableFields.some((f) => f.key === 'assetCode')
    const patch = {}
    for (const f of missingRequiredFields) {
      if (defaults[f.key]) continue
      if (f.type !== 'select' && assetCodeAvailable && f.key !== 'assetCode') {
        patch[f.key] = { type: 'mirror', sourceField: 'assetCode', value: '' }
      }
    }
    if (Object.keys(patch).length > 0) onDefaultsChange({ ...defaults, ...patch })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingRequiredFields.map((f) => f.key).join(',')])

  function isDefaultConfigured(fieldKey) {
    const d = defaults[fieldKey]
    if (!d) return false
    if (d.type === 'mirror') return !!d.sourceField
    return !!(d.value && d.value.trim())
  }

  const unresolvedRequiredFields = missingRequiredFields.filter(
    (f) => !isDefaultConfigured(f.key)
  )

  function updateDefault(fieldKey, patch) {
    onDefaultsChange({
      ...defaults,
      [fieldKey]: { type: 'constant', value: '', sourceField: null, ...defaults[fieldKey], ...patch }
    })
  }

  // header index -> field is a one-to-one mapping, so picking a column
  // for this field automatically takes it away from whichever field held
  // it before (plain object key overwrite); we only need to explicitly
  // release the index this field itself was previously holding.
  function handleColumnChange(fieldKey, newIndex) {
    const next = { ...mapping }
    for (const idx of Object.keys(next)) {
      if (next[idx] === fieldKey) delete next[idx]
    }
    if (newIndex !== undefined && newIndex !== null) next[newIndex] = fieldKey
    onChange(next)
  }

  const columns = [
    {
      title: 'فیلد',
      key: 'field',
      width: 170,
      render: (_, f) => <Text strong>{f.required ? `${f.label} *` : f.label}</Text>
    },
    {
      title: 'ستون در فایل',
      key: 'header',
      width: 260,
      render: (_, f) => {
        const currentIndex = headers.findIndex((h, i) => mapping[i] === f.key)
        return (
          <Select
            style={{ width: 250 }}
            allowClear
            placeholder="بدون ستون"
            value={currentIndex >= 0 ? currentIndex : undefined}
            onChange={(i) => handleColumnChange(f.key, i)}
            options={headers.map((h, i) => {
              const takenBy = mapping[i] && mapping[i] !== f.key ? FIELD_LABEL[mapping[i]] : null
              const sample = sampleValueForColumn(rows, i)
              // Column position (۱-based, matching how a person counts
              // columns in a spreadsheet) plus a real sample value —
              // together, these are what make two columns that happen to
              // share the exact same header text ("Date" and "Date")
              // distinguishable at all.
              const parts = [`ستون ${toPersianDigits(i + 1)}`]
              if (sample) parts.push(`نمونه: ${sample}`)
              if (takenBy) parts.push(`نگاشته شده به ${takenBy}`)
              return { value: i, label: `${h || '(بدون عنوان)'} — ${parts.join(' · ')}` }
            })}
          />
        )
      }
    },
    {
      title: 'در صورت نبود ستون',
      key: 'default',
      render: (_, f) => {
        const currentIndex = headers.findIndex((h, i) => mapping[i] === f.key)
        if (currentIndex >= 0) return <Text type="secondary">—</Text>
        if (!f.required) return <Text type="secondary" style={{ fontSize: 12 }}>اختیاری — خالی می‌ماند</Text>

        const d = defaults[f.key] || { type: 'constant', value: '', sourceField: null }
        const isLookup = f.type === 'select'
        const lookupOptions = isLookup
          ? (lookups?.[LOOKUP_KEY[f.key]] || []).map((v) => ({ value: v.name }))
          : []
        return (
          <Space direction="vertical" size={4}>
            <Radio.Group
              size="small"
              value={d.type}
              onChange={(e) => updateDefault(f.key, { type: e.target.value })}
            >
              <Radio value="constant">مقدار ثابت</Radio>
              <Radio value="mirror" disabled={mirrorableFields.length === 0}>
                کپی از فیلد دیگر
              </Radio>
            </Radio.Group>
            {d.type === 'mirror' ? (
              <Select
                style={{ width: 200 }}
                placeholder="انتخاب فیلد"
                value={d.sourceField || undefined}
                onChange={(v) => updateDefault(f.key, { sourceField: v })}
                options={mirrorableFields.map((mf) => ({ value: mf.key, label: mf.label }))}
              />
            ) : isLookup ? (
              <AutoComplete
                style={{ width: 220 }}
                placeholder="انتخاب از فهرست یا تایپ مقدار جدید"
                value={d.value}
                options={lookupOptions}
                filterOption={(input, option) => option.value.includes(input)}
                onChange={(v) => updateDefault(f.key, { value: v })}
              />
            ) : (
              <Input
                style={{ width: 220 }}
                placeholder="مقدار برای همه ردیف‌ها"
                value={d.value}
                onChange={(e) => updateDefault(f.key, { value: e.target.value })}
              />
            )}
          </Space>
        )
      }
    }
  ]

  return (
    <div>
      <Text style={{ display: 'block', marginBottom: 12 }}>
        برای هر فیلد، ستون متناظر در فایل را انتخاب کنید — نگاشت پیشنهادی بر اساس عنوان ستون‌ها از
        قبل انجام شده و در صورت نیاز قابل تغییر است. برای فیلدهای الزامی (*) بدون ستون در فایل، در
        همان ردیف یک مقدار پیش‌فرض تعیین کنید.
      </Text>

      {unresolvedRequiredFields.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="فیلدهای الزامی نگاشت نشده‌اند"
          description={`لطفاً برای موارد زیر ستونی مشخص کنید یا مقدار پیش‌فرض تعیین کنید: ${unresolvedRequiredFields.map((f) => f.label).join('، ')}`}
        />
      )}

      <Table
        size="small"
        rowKey="key"
        dataSource={fieldSchema}
        columns={columns}
        pagination={false}
        style={{ marginBottom: 8 }}
      />

      {unmappedHeaders.length > 0 && (
        <Text type="secondary" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
          این ستون‌های فایل به هیچ فیلدی نگاشت نشده و وارد نمی‌شوند:{' '}
          {unmappedHeaders
            .map(({ header, index }) => `${header || '(بدون عنوان)'} (ستون ${toPersianDigits(index + 1)})`)
            .join('، ')}
        </Text>
      )}

      <Space>
        <Button type="primary" disabled={unresolvedRequiredFields.length > 0} onClick={onContinue}>
          ادامه
        </Button>
        <Button onClick={onBack}>بازگشت</Button>
      </Space>
    </div>
  )
}
