import { toJalaali } from 'jalaali-js'
import { toPersianDigits } from './numberFormat'

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * Converts a Gregorian date (Date object or ISO string, as stored per
 * Phase 3) into a Jalali display string, e.g. "۱۴۰۵/۰۵/۰۸".
 * Dates are always stored as Gregorian/ISO internally — this is a display
 * conversion only (Phase 2, Section 8 / Phase 1, Section 3).
 */
export function toJalaliDisplay(input) {
  if (!input) return '—'
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return '—'

  const { jy, jm, jd } = toJalaali(date)
  return toPersianDigits(`${jy}/${pad2(jm)}/${pad2(jd)}`)
}
