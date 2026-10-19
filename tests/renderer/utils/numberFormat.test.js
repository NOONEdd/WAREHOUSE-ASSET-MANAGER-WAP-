import { describe, it, expect } from 'vitest'
import { toPersianDigits, formatPersianNumber } from '../../../src/renderer/src/utils/numberFormat'

describe('toPersianDigits', () => {
  it('converts each Western digit 0-9 to its Persian equivalent', () => {
    expect(toPersianDigits('0123456789')).toBe('۰۱۲۳۴۵۶۷۸۹')
  })

  it('leaves non-digit characters untouched', () => {
    expect(toPersianDigits('A-42/B')).toBe('A-۴۲/B')
  })

  it('accepts a number, not just a string', () => {
    expect(toPersianDigits(2026)).toBe('۲۰۲۶')
  })
})

describe('formatPersianNumber', () => {
  it('adds thousands separators before converting to Persian digits', () => {
    expect(formatPersianNumber(5247)).toBe('۵,۲۴۷')
  })

  it('handles small numbers with no separator needed', () => {
    expect(formatPersianNumber(7)).toBe('۷')
  })

  it('handles zero', () => {
    expect(formatPersianNumber(0)).toBe('۰')
  })
})
