import { toGregorian, isValidJalaaliDate } from 'jalaali-js'
import { normalizeDigits } from './digitUtils'

const pad2 = (n) => String(n).padStart(2, '0')

// Excel/CSV date cells arrive in Warehouse Entry/Exit Date columns, which
// in an Iranian company's export are almost always Jalali (e.g.
// "1403/05/12" or "۱۴۰۳/۰۵/۱۲"), matching how the app's own JalaliDatePicker
// (Phase 5) collects them everywhere else. The app always stores Gregorian
// ISO internally (dateDisplay.js) — this is the import-side equivalent of
// that conversion, done once here rather than trusting the source file's
// format.

/**
 * Parses a date value pulled from an imported row into the app's internal
 * Gregorian ISO (YYYY-MM-DD) format, or returns null if it can't be
 * confidently parsed. Never throws — an unparseable date is a per-row
 * WARNING, not a crash.
 *
 * Accepts:
 *  - A native JS Date (from an Excel cell typed as a real date — built by
 *    excelParser.js as a UTC-midnight Date via XLSX.SSF.parse_date_code,
 *    not SheetJS's own cellDates conversion, which has a DST-lookup bug
 *    that silently shifts the date by a day in some timezones, Iran's
 *    included — confirmed empirically, not just by reading the source).
 *  - A Jalali date string, any of /, -, . as separator, Persian or Western
 *    digits, e.g. "1403/05/12", "۱۴۰۳-۰۵-۱۲".
 *  - A Gregorian ISO string "YYYY-MM-DD" (some source files already use
 *    this, especially ones exported from another database).
 *
 * Distinguishing Jalali vs Gregorian text input is by year magnitude: the
 * current Jalali year is ~1404-1405 while Gregorian is ~2024-2026 — a
 * 4-digit leading year under 1500 is treated as Jalali, otherwise Gregorian.
 * This matches every real-world date this app will ever see (SFZ has no
 * data predating 1300 SH / 1921 CE).
 */
function parseImportDate(value) {
  if (value === null || value === undefined || value === '') return null

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    // UTC getters, not local — excelParser.js hands over Date cells built
    // as UTC midnight (via XLSX.SSF.parse_date_code, not SheetJS's own
    // cellDates conversion — see the comment there for why). Reading that
    // back with local getters would re-introduce the exact timezone bug
    // this was built to avoid: correct in UTC and other positive-offset
    // zones close to it, silently one day off in negative-offset zones.
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`
  }

  const normalized = normalizeDigits(String(value)).trim()
  if (!normalized) return null

  const match = normalized.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/)
  if (!match) return null

  let [, a, b, c] = match

  // Handle both "YYYY/MM/DD" (standard) and the rarer "DD/MM/YYYY" some
  // export tools use, detected by which segment is 4 digits.
  let year, month, day
  if (a.length === 4) {
    year = Number(a)
    month = Number(b)
    day = Number(c)
  } else if (c.length === 4) {
    year = Number(c)
    month = Number(b)
    day = Number(a)
  } else {
    return null // ambiguous two-digit year — refuse rather than guess
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  if (year < 1500) {
    // Jalali
    if (!isValidJalaaliDate(year, month, day)) return null
    const { gy, gm, gd } = toGregorian(year, month, day)
    return `${gy}-${pad2(gm)}-${pad2(gd)}`
  }

  // Gregorian
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null // rolled over — invalid date like 2026-02-30
  }
  return `${year}-${pad2(month)}-${pad2(day)}`
}

export { parseImportDate }
