// The six field groups from Phase 4's wireframe, defined once and consumed
// by both AssetDetailsPage (read-only Descriptions) and AssetFormPage
// (editable Form) so the two views can never drift out of sync with each
// other or with the Phase 3 schema.
//
// `iconKey` (Phase 9) is presentational metadata only — a string, not a
// JSX icon component, so this stays a plain data module. Each consumer
// maps it to an actual @ant-design/icons component locally.

export const assetFieldGroups = [
  {
    title: 'شناسایی',
    iconKey: 'identity',
    fields: [
      { key: 'id', label: 'شناسه دارایی', readOnly: true, mono: true },
      { key: 'assetCode', label: 'کد دارایی', required: true, mono: true },
      { key: 'assetName', label: 'نام دارایی', required: true },
      { key: 'itemType', label: 'نوع کالا', required: true, type: 'select' },
      { key: 'model', label: 'مدل' },
      { key: 'serialNumber', label: 'شماره سریال', required: true, mono: true }
    ]
  },
  {
    title: 'مبدأ و محل',
    iconKey: 'location',
    fields: [
      { key: 'country', label: 'کشور سازنده', type: 'select' },
      { key: 'workshop', label: 'واحد / بخش', type: 'select' }
    ]
  },
  {
    title: 'تاریخ‌های انبار',
    iconKey: 'dates',
    fields: [
      { key: 'entryDate', label: 'تاریخ ورود به انبار', type: 'date' },
      { key: 'exitDate', label: 'تاریخ خروج از انبار', type: 'date' }
    ]
  },
  {
    title: 'تحویل',
    iconKey: 'handover',
    fields: [
      { key: 'deliveredBy', label: 'تحویل‌دهنده' },
      { key: 'receivedBy', label: 'تحویل‌گیرنده' }
    ]
  },
  {
    title: 'وضعیت و یادداشت',
    iconKey: 'status',
    fields: [
      { key: 'status', label: 'وضعیت فعلی', required: true, type: 'select' },
      { key: 'notes', label: 'یادداشت', wide: true, type: 'textarea' }
    ]
  },
  {
    title: 'اطلاعات سیستمی',
    hint: '(فقط نمایش)',
    iconKey: 'system',
    fields: [
      { key: 'createdAt', label: 'تاریخ ایجاد', readOnly: true, type: 'date' },
      { key: 'updatedAt', label: 'تاریخ آخرین ویرایش', readOnly: true, type: 'date' }
    ]
  }
]
