const WESTERN_TO_PERSIAN = { 0: '۰', 1: '۱', 2: '۲', 3: '۳', 4: '۴', 5: '۵', 6: '۶', 7: '۷', 8: '۸', 9: '۹' }

/**
 * Converts Western digits (0-9) in a number or string to Persian numerals.
 * Used for counts, pagination, and dates shown in the UI — never for
 * Serial Numbers or Asset Codes, which stay in Western digits on purpose
 * (Phase 4 — scanner/manufacturer compatibility).
 */
export function toPersianDigits(value) {
  return String(value).replace(/[0-9]/g, (d) => WESTERN_TO_PERSIAN[d])
}

/**
 * Formats a number with thousands separators, then converts to Persian
 * digits — e.g. 5247 -> "۵,۲۴۷".
 */
export function formatPersianNumber(value) {
  const withSeparators = Number(value).toLocaleString('en-US')
  return toPersianDigits(withSeparators)
}
