import { describe, it, expect } from 'vitest'
import { parseImportDate } from '../../../src/main/utils/importDateParser.js'

describe('parseImportDate', () => {
  it('parses a Jalali date with Western digits and / separator', () => {
    // 1403/05/12 -> 2024-08-02 (verified against jalaali-js's own conversion)
    expect(parseImportDate('1403/05/12')).toBe('2024-08-02')
  })

  it('parses a Jalali date with Persian digits and - separator', () => {
    expect(parseImportDate('۱۴۰۳-۰۵-۱۲')).toBe('2024-08-02')
  })

  it('parses a Gregorian ISO date unchanged', () => {
    expect(parseImportDate('2024-08-02')).toBe('2024-08-02')
  })

  it('parses a real JS Date object (from an Excel date-typed cell) as Gregorian', () => {
    expect(parseImportDate(new Date(2024, 7, 2))).toBe('2024-08-02') // month is 0-indexed
  })

  it('returns null for an empty or missing value', () => {
    expect(parseImportDate('')).toBe(null)
    expect(parseImportDate(null)).toBe(null)
    expect(parseImportDate(undefined)).toBe(null)
  })

  it('returns null for an invalid Jalali date (e.g. month 13)', () => {
    expect(parseImportDate('1403/13/01')).toBe(null)
  })

  it('returns null for a Gregorian date that rolls over (e.g. Feb 30)', () => {
    expect(parseImportDate('2024-02-30')).toBe(null)
  })

  it('returns null for unparseable garbage text', () => {
    expect(parseImportDate('not a date')).toBe(null)
  })

  it('returns null for an ambiguous two-digit year', () => {
    expect(parseImportDate('12/05/24')).toBe(null)
  })

  it('handles DD/MM/YYYY (4-digit year in the last segment)', () => {
    expect(parseImportDate('02/08/2024')).toBe('2024-08-02')
  })
})
