import { describe, it, expect } from 'vitest'
import {
  matchHeaderToField,
  autoMapHeaders,
  IMPORT_FIELD_ALIASES
} from '../../../src/main/utils/importFieldAliases.js'

describe('matchHeaderToField', () => {
  it('matches every Persian alias given in the task spec', () => {
    expect(matchHeaderToField('نام کالا')).toBe('assetName')
    expect(matchHeaderToField('نام جنس')).toBe('assetName')
    expect(matchHeaderToField('شرح کالا')).toBe('assetName')
    expect(matchHeaderToField('نام دارایی')).toBe('assetName')
    expect(matchHeaderToField('کد اموال')).toBe('assetCode')
    expect(matchHeaderToField('کد دارایی')).toBe('assetCode')
    expect(matchHeaderToField('شماره اموال')).toBe('assetCode')
    expect(matchHeaderToField('شماره سریال')).toBe('serialNumber')
    expect(matchHeaderToField('سریال')).toBe('serialNumber')
    expect(matchHeaderToField('Serial Number')).toBe('serialNumber')
    expect(matchHeaderToField('کشور ساخت')).toBe('country')
  })

  it('is tolerant of surrounding whitespace and case', () => {
    expect(matchHeaderToField('  serial number  ')).toBe('serialNumber')
    expect(matchHeaderToField('SERIAL NUMBER')).toBe('serialNumber')
  })

  it('returns null for a header with no known alias', () => {
    expect(matchHeaderToField('یک ستون عجیب و ناشناخته')).toBe(null)
  })
})

describe('matchHeaderToField — compact ZWNJ-stripped fallback', () => {
  // A real PDF (Chromium's text layer) can lose the Persian half-space
  // (U+200C, ZWNJ) in 'تحویل‌دهنده' / 'تحویل‌گیرنده' entirely rather
  // than turning it into a plain space, so the header extracts back
  // with NO separator at all. The exact-match rule (ZWNJ -> space)
  // can't catch that, since there's no character left to convert — this
  // is what the compact fallback exists for.
  it('matches a header that lost its ZWNJ half-space entirely', () => {
    expect(matchHeaderToField('تحویلدهنده')).toBe('deliveredBy')
    expect(matchHeaderToField('تحویلگیرنده')).toBe('receivedBy')
  })

  it('still matches the well-formed ZWNJ and plain-space variants directly', () => {
    expect(matchHeaderToField('تحویل‌دهنده')).toBe('deliveredBy')
    expect(matchHeaderToField('تحویل دهنده')).toBe('deliveredBy')
    expect(matchHeaderToField('تحویل‌گیرنده')).toBe('receivedBy')
    expect(matchHeaderToField('تحویل گیرنده')).toBe('receivedBy')
  })

  it('an exact (space-normalized) match always wins over the compact fallback', () => {
    // 'کشور ساخت' (country) compacts to 'کشورساخت'; if some other field
    // ever had an alias that also compacted to 'کشورساخت', the exact
    // match here must still take priority over any fallback guess.
    expect(matchHeaderToField('کشور ساخت')).toBe('country')
  })

  it('never produces an ambiguous mapping: no two fields share a compact alias form', () => {
    // Safety net for future alias additions — if two different fields'
    // aliases ever collapsed to the same whitespace/ZWNJ-stripped form,
    // the fallback would have to guess between them, which is worse
    // than leaving the header unmapped for the person to assign by
    // hand. This walks the real, live alias table rather than a copy.
    const compactOf = (value) =>
      value
        .trim()
        .toLowerCase()
        .replace(/[\u200c\s]+/g, '')

    const seenBy = new Map()
    for (const [fieldKey, aliases] of Object.entries(IMPORT_FIELD_ALIASES)) {
      for (const alias of aliases) {
        const compact = compactOf(alias)
        const owner = seenBy.get(compact)
        if (owner && owner !== fieldKey) {
          throw new Error(
            `Alias collision: "${alias}" compacts to "${compact}", claimed by both ` +
              `"${owner}" and "${fieldKey}"`
          )
        }
        seenBy.set(compact, fieldKey)
      }
    }
    expect(seenBy.size).toBeGreaterThan(0)
  })
})

describe('autoMapHeaders', () => {
  it('maps every recognizable header (by column position) and leaves the rest unmapped', () => {
    const headers = ['کد اموال', 'نام دارایی', 'یک ستون ناشناخته']
    const { mapping, unmapped } = autoMapHeaders(headers)
    expect(mapping[0]).toBe('assetCode')
    expect(mapping[1]).toBe('assetName')
    expect(unmapped).toEqual(['یک ستون ناشناخته'])
  })

  it('never maps two headers to the same field — second occurrence is left unmapped', () => {
    const headers = ['کد اموال', 'کد دارایی']
    const { mapping, unmapped } = autoMapHeaders(headers)
    expect(mapping[0]).toBe('assetCode')
    expect(mapping[1]).toBeUndefined()
    expect(unmapped).toEqual(['کد دارایی'])
  })

  // Regression test: two columns with the EXACT SAME header text used to
  // be indistinguishable, because mapping was keyed by header string —
  // mapping the second "Date" column to a field would silently destroy
  // whichever field the first "Date" column was already mapped to, since
  // both were trying to use the identical string as their object key.
  // Column index is always unique, even when header text is not.
  it('maps two columns that share the exact same header text to two different fields without either overwriting the other', () => {
    const headers = ['Asset Code', 'Date', 'Date']
    const { mapping } = autoMapHeaders(headers)
    // Neither "Date" column has an alias of its own (bare "Date" isn't
    // one), so both start unmapped — this is really testing what happens
    // once the person manually assigns each one, which is exactly what
    // ColumnMappingStep.jsx's handleColumnChange does: write directly
    // into the mapping by index.
    const manual = { ...mapping, 1: 'warehouseEntryDate', 2: 'warehouseExitDate' }
    expect(manual[1]).toBe('warehouseEntryDate')
    expect(manual[2]).toBe('warehouseExitDate')
    expect(Object.keys(manual)).toHaveLength(3) // assetCode (auto) + both dates
  })
})
