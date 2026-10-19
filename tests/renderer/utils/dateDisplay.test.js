import { describe, it, expect } from 'vitest'
import { toJalaali } from 'jalaali-js'
import { toJalaliDisplay } from '../../../src/renderer/src/utils/dateDisplay'
import { toPersianDigits } from '../../../src/renderer/src/utils/numberFormat'

// Expected values are computed from the same underlying jalaali-js used by
// the function under test — the goal here is verifying toJalaliDisplay's
// OWN formatting/padding/null-handling logic, not re-validating jalaali-js
// itself (an already-established third-party library).
function expectedDisplay(date) {
  const { jy, jm, jd } = toJalaali(date)
  const pad2 = (n) => String(n).padStart(2, '0')
  return toPersianDigits(`${jy}/${pad2(jm)}/${pad2(jd)}`)
}

describe('toJalaliDisplay', () => {
  it('converts a Date object to the correct zero-padded, Persian-digit Jalali string', () => {
    const date = new Date('2026-08-06T00:00:00Z')
    expect(toJalaliDisplay(date)).toBe(expectedDisplay(date))
  })

  it('accepts an ISO string, not just a Date object', () => {
    expect(toJalaliDisplay('2026-01-05')).toBe(expectedDisplay(new Date('2026-01-05')))
  })

  it('zero-pads single-digit months and days', () => {
    // Any date whose Jalali month or day is a single digit should still
    // render as two characters (e.g. "۰۵" not "۵").
    const date = new Date('2026-03-25T00:00:00Z') // early in the Jalali year
    const result = toJalaliDisplay(date)
    const parts = result.split('/')
    expect(parts[1]).toHaveLength(2)
    expect(parts[2]).toHaveLength(2)
  })

  it('returns "—" for null, undefined, or empty input', () => {
    expect(toJalaliDisplay(null)).toBe('—')
    expect(toJalaliDisplay(undefined)).toBe('—')
    expect(toJalaliDisplay('')).toBe('—')
  })

  it('returns "—" for an unparseable date string rather than throwing', () => {
    expect(toJalaliDisplay('not-a-date')).toBe('—')
  })
})
