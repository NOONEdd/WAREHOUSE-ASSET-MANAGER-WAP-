// The single canonical schema the entire import system is built around.
// Every Excel, CSV, and PDF import maps into exactly these 13 fields —
// nothing else. This is the ONE place that lists them; importFieldAliases.js
// derives its header-matching table from this, importService.js derives
// its required-field list and lookup-field list from this, and the
// renderer's import wizard (ColumnMappingStep, ImportPreviewStep) receives
// this same list over IPC (see importService.parseFile's `fieldSchema` in
// its response) instead of hardcoding its own copy — so a future field
// addition, rename, or label change only ever happens in this one file.
//
// This is deliberately a SEPARATE schema from assetFieldGroups.js (the
// renderer's Add/Edit Asset form). That form's field keys (itemType,
// entryDate, exitDate, notes) are the app's long-standing internal/DB
// vocabulary, used by assetService, assetRepository's row mapping, the
// asset detail/table views, and exports — changing those is a much larger,
// separate concern than "how does an imported file map in," and nothing
// here requires touching them. Where the two names differ, `appKey` below
// records the mapping so importService can write into the existing
// repository/DB shape without the rest of the app ever needing to change.
//
// `aliases` are intentionally generous (common Iranian-company ERP/Excel
// phrasing, in Persian and English) but every one is an exact,
// unambiguous match to a single field — see importFieldAliases.js for why
// that matters (never silently guessing a column).

export const ASSET_IMPORT_SCHEMA = [
  {
    key: 'assetCode',
    appKey: 'assetCode',
    label: 'کد دارایی',
    required: true,
    type: 'text',
    aliases: [
      'کد اموال', 'کد دارایی', 'شماره اموال', 'کد کالا', 'شماره اموالی',
      'asset code', 'assetcode', 'code'
    ]
  },
  {
    key: 'assetName',
    appKey: 'assetName',
    label: 'نام دارایی',
    required: true,
    type: 'text',
    aliases: [
      'نام کالا', 'نام جنس', 'شرح کالا', 'نام دارایی', 'عنوان کالا', 'عنوان دارایی',
      'asset name', 'assetname', 'name', 'item name'
    ]
  },
  {
    key: 'assetType',
    appKey: 'itemType',
    label: 'نوع کالا',
    required: true,
    type: 'select',
    lookupKind: 'itemTypes',
    aliases: [
      'نوع کالا', 'نوع دارایی', 'گروه کالا', 'نوع اموال',
      'item type', 'asset type', 'type', 'category'
    ]
  },
  {
    key: 'model',
    appKey: 'model',
    label: 'مدل',
    required: false,
    type: 'text',
    aliases: ['مدل', 'مدل کالا', 'model']
  },
  {
    key: 'serialNumber',
    appKey: 'serialNumber',
    label: 'شماره سریال',
    required: true,
    type: 'text',
    aliases: [
      'شماره سریال', 'سریال', 'سریال کالا',
      'serial number', 'serial', 'serial no', 's/n', 'sn'
    ]
  },
  {
    key: 'country',
    appKey: 'country',
    label: 'کشور سازنده',
    required: false,
    type: 'select',
    lookupKind: 'countries',
    aliases: [
      'کشور سازنده', 'کشور', 'ساخت کشور', 'کشور ساخت', 'کشور تولید کننده',
      'country', 'country of manufacture', 'made in'
    ]
  },
  {
    key: 'workshop',
    appKey: 'workshop',
    label: 'واحد / بخش',
    required: false,
    type: 'select',
    lookupKind: 'workshops',
    aliases: [
      'واحد', 'بخش', 'واحد/بخش', 'محل استفاده', 'کارگاه', 'واحد سازمانی', 'محل نصب',
      'workshop', 'department', 'used in', 'location'
    ]
  },
  {
    key: 'warehouseEntryDate',
    appKey: 'entryDate',
    label: 'تاریخ ورود به انبار',
    required: false,
    type: 'date',
    aliases: [
      'تاریخ ورود به انبار', 'تاریخ ورود', 'تاریخ ثبت', 'تاریخ خرید',
      'entry date', 'warehouse entry date', 'date in'
    ]
  },
  {
    key: 'warehouseExitDate',
    appKey: 'exitDate',
    label: 'تاریخ خروج از انبار',
    required: false,
    type: 'date',
    aliases: [
      'تاریخ خروج از انبار', 'تاریخ خروج',
      'exit date', 'warehouse exit date', 'date out'
    ]
  },
  {
    key: 'deliveredBy',
    appKey: 'deliveredBy',
    label: 'تحویل‌دهنده',
    required: false,
    type: 'text',
    aliases: ['تحویل‌دهنده', 'تحویل دهنده', 'نام تحویل دهنده', 'delivered by', 'deliverer']
  },
  {
    key: 'receivedBy',
    appKey: 'receivedBy',
    label: 'تحویل‌گیرنده',
    required: false,
    type: 'text',
    aliases: ['تحویل‌گیرنده', 'تحویل گیرنده', 'گیرنده', 'نام تحویل گیرنده', 'received by', 'recipient']
  },
  {
    key: 'status',
    appKey: 'status',
    label: 'وضعیت',
    required: true,
    type: 'select',
    lookupKind: 'statuses',
    // Manual Status Management phase — status is no longer a fixed enum;
    // an administrator can add new ones through Settings → داده‌های پایه
    // → وضعیت (lookupService.js's createStatus). strictLookup stays true
    // regardless: unlike assetType/country/workshop, a typo or
    // mismatched value in an import file must still be rejected as an
    // error rather than silently creating a brand-new status nobody
    // asked for — creating a status is something an administrator does
    // deliberately through that screen, never as an import side effect.
    // Only currently-active statuses count as a match here (see
    // importService.js's buildLookupIndex) — a deactivated status is not
    // selectable for a new asset via the form, so it must not be
    // importable either.
    strictLookup: true,
    aliases: ['وضعیت', 'وضعیت فعلی', 'status']
  },
  {
    key: 'description',
    appKey: 'notes',
    label: 'توضیحات',
    required: false,
    type: 'textarea',
    aliases: ['توضیحات', 'شرح', 'یادداشت', 'ملاحظات', 'description', 'notes', 'remarks']
  }
]

// Convenience derivations used by importFieldAliases.js / importService.js
// so nothing downstream ever hand-maintains its own copy of these lists.
export const CANONICAL_FIELD_KEYS = ASSET_IMPORT_SCHEMA.map((f) => f.key)
export const REQUIRED_FIELD_KEYS = ASSET_IMPORT_SCHEMA.filter((f) => f.required).map((f) => f.key)
export const LOOKUP_FIELD_KIND = Object.fromEntries(
  ASSET_IMPORT_SCHEMA.filter((f) => f.lookupKind).map((f) => [f.key, f.lookupKind])
)
// Lookup fields where an unrecognized value must be REJECTED (an error,
// same as a missing required field) rather than silently turned into a
// newly-created lookup row — see the `status` field's comment above for
// why. assetType/country/workshop are correctly absent from this set:
// growing those via import is intentional, existing behavior.
export const STRICT_LOOKUP_FIELD_KEYS = new Set(ASSET_IMPORT_SCHEMA.filter((f) => f.strictLookup).map((f) => f.key))
export const FIELD_LABEL_BY_KEY = Object.fromEntries(ASSET_IMPORT_SCHEMA.map((f) => [f.key, f.label]))
export const APP_KEY_BY_IMPORT_KEY = Object.fromEntries(ASSET_IMPORT_SCHEMA.map((f) => [f.key, f.appKey]))

// The subset of {key, label, required, type} the renderer's import wizard
// actually needs — sent to it inside importService.parseFile's response
// (see `fieldSchema`) rather than duplicated as a hardcoded renderer-side
// list, so the wizard can never silently drift from this file.
export const PUBLIC_FIELD_SCHEMA = ASSET_IMPORT_SCHEMA.map(({ key, label, required, type }) => ({
  key,
  label,
  required,
  type
}))
