import { Select, Space } from 'antd'
import { toJalaali, toGregorian, jalaaliMonthLength } from 'jalaali-js'
import { toPersianDigits } from '../../utils/numberFormat'

const PERSIAN_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند'
]

const nowJy = toJalaali(new Date()).jy

function parseIsoDate(iso) {
  if (!iso) return null
  const [gy, gm, gd] = iso.split('-').map(Number)
  if (!gy || !gm || !gd) return null
  return toJalaali(gy, gm, gd)
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/**
 * A Jalali (Shamsi) date picker built directly on jalaali-js rather than a
 * third-party antd-Jalali wrapper — the available community packages for
 * that are small, low-maintenance projects, not something to build
 * commercial software's core calendar requirement on top of.
 *
 * Value/onChange both work in plain ISO date strings ("YYYY-MM-DD"),
 * matching how dates are stored (Phase 3) and returned by the API —
 * deliberately not JS Date objects, which carry a time-of-day and
 * timezone that have no meaning for a plain calendar date and are a
 * classic source of off-by-one-day bugs when round-tripped.
 */
// `ariaLabel` names the date as a whole (e.g. "از تاریخ"); each of the three
// selects gets "<ariaLabel> — روز/ماه/سال" as its accessible name, since a
// placeholder alone is not one.
export default function JalaliDatePicker({ value, onChange, allowClear = true, ariaLabel = 'تاریخ' }) {
  const jalali = parseIsoDate(value)

  const years = Array.from({ length: 90 }, (_, i) => nowJy - 80 + i)

  function update(part, newValue) {
    const current = jalali || { jy: nowJy, jm: 1, jd: 1 }
    const next = { ...current, [part]: newValue }
    // clamp day if the new month/year has fewer days (e.g. moving off the 31st)
    const maxDay = jalaaliMonthLength(next.jy, next.jm)
    next.jd = Math.min(next.jd, maxDay)
    const { gy, gm, gd } = toGregorian(next.jy, next.jm, next.jd)
    onChange?.(`${gy}-${pad2(gm)}-${pad2(gd)}`)
  }

  return (
    <Space.Compact>
      <Select
        placeholder="روز"
        aria-label={`${ariaLabel} — روز`}
        style={{ width: 70 }}
        value={jalali?.jd}
        allowClear={allowClear}
        onChange={(v) => update('jd', v)}
        options={Array.from(
          { length: jalali ? jalaaliMonthLength(jalali.jy, jalali.jm) : 31 },
          (_, i) => ({ value: i + 1, label: toPersianDigits(i + 1) })
        )}
      />
      <Select
        placeholder="ماه"
        aria-label={`${ariaLabel} — ماه`}
        style={{ width: 110 }}
        value={jalali?.jm}
        allowClear={allowClear}
        onChange={(v) => update('jm', v)}
        options={PERSIAN_MONTHS.map((m, i) => ({ value: i + 1, label: m }))}
      />
      <Select
        placeholder="سال"
        aria-label={`${ariaLabel} — سال`}
        style={{ width: 90 }}
        value={jalali?.jy}
        allowClear={allowClear}
        onChange={(v) => update('jy', v)}
        options={years.map((y) => ({ value: y, label: toPersianDigits(y) }))}
      />
    </Space.Compact>
  )
}
