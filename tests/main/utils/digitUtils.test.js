import { describe, it, expect } from 'vitest'
import { normalizeDigits, normalizeForComparison, compactForComparison } from '../../../src/main/utils/digitUtils.js'

describe('normalizeDigits', () => {
  it('converts Persian digits to Western', () => {
    expect(normalizeDigits('۱۲۳۴۵۶۷۸۹۰')).toBe('1234567890')
  })

  it('converts Arabic-Indic digits to Western', () => {
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789')
  })

  it('leaves Western digits and non-digit characters untouched', () => {
    expect(normalizeDigits('AB-123/xyz')).toBe('AB-123/xyz')
  })

  it('preserves leading zeros — never reinterprets as a number', () => {
    expect(normalizeDigits('۰۰۴۸')).toBe('0048')
  })

  it('handles mixed Persian and Western digits in the same string', () => {
    expect(normalizeDigits('AC-۱۲3')).toBe('AC-123')
  })

  it('passes through null/undefined unchanged', () => {
    expect(normalizeDigits(null)).toBe(null)
    expect(normalizeDigits(undefined)).toBe(undefined)
  })
})

describe('normalizeForComparison', () => {
  it('normalizes digits, collapses whitespace, and lowercases', () => {
    expect(normalizeForComparison('  Serial Number  ')).toBe('serial number')
  })

  it('treats a Persian half-space (ZWNJ) as a regular space', () => {
    expect(normalizeForComparison('کد\u200cدارایی')).toBe('کد دارایی')
  })

  it('two differently-formatted headers that mean the same thing compare equal', () => {
    expect(normalizeForComparison('  کد اموال')).toBe(normalizeForComparison('کد اموال  '))
  })
})

describe('compactForComparison', () => {
  it('matches text that lost its ZWNJ entirely against the well-formed ZWNJ version', () => {
    // The real, observed failure mode this exists for: a PDF text layer
    // that drops U+200C rather than turning it into a space, so
    // "آسیب‌دیده" extracts back as "آسیبدیده" with no separator at all.
    expect(compactForComparison('آسیبدیده')).toBe(compactForComparison('آسیب\u200cدیده'))
  })

  it('also matches against the plain-space variant', () => {
    expect(compactForComparison('آسیبدیده')).toBe(compactForComparison('آسیب دیده'))
  })

  it('does not blur together two genuinely different short values', () => {
    expect(compactForComparison('در انبار')).not.toBe(compactForComparison('صادر شده'))
  })
})
