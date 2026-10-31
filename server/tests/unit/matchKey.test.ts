import { describe, expect, it } from 'vitest'
import { isBlankIdentifier, matchKey, MATCH_KEY_REMOVED_CODE_POINTS, MATCH_KEY_TRANSLATIONS } from '../../src/assets/matchKey.js'
import { forAll, type Random } from '../support/seededRandom.js'

// Match keys (src/assets/matchKey.ts): examples first, then properties over generated
// identifiers. Everything here is invented; no real asset value appears.

const REMOVED = MATCH_KEY_REMOVED_CODE_POINTS.map((cp) => String.fromCodePoint(cp))
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
/** Characters that are already in canonical form: what a key may consist of (one code point each). */
const CANONICAL = [...Array.from('abcdefghijklmnopqrstuvwxyz0123456789'), ...Array.from('آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی'), '#', '+']

/** Writes a canonical identifier the way people and other systems actually do. */
function decorate(random: Random, canonical: string): string {
  let out = ''
  for (const char of canonical) {
    while (random.int(4) === 0) out += random.pick(REMOVED)
    const digit = '0123456789'.indexOf(char)
    if (digit >= 0 && random.bool()) out += random.pick([PERSIAN_DIGITS, ARABIC_INDIC_DIGITS])[digit] ?? char
    else if (char >= 'a' && char <= 'z' && random.bool()) out += char.toUpperCase()
    else if (char === 'ی' && random.bool()) out += random.pick(['ي', 'ى'])
    else if (char === 'ک' && random.bool()) out += 'ك'
    else if (char >= 'a' && char <= 'z' && random.int(5) === 0) out += String.fromCodePoint(0xff41 + char.charCodeAt(0) - 0x61) // full-width
    else out += char
  }
  while (random.int(3) === 0) out += random.pick(REMOVED)
  return out
}

function canonicalString(random: Random, maxLength = 16): string {
  return Array.from({ length: random.int(maxLength + 1) }, () => random.pick(CANONICAL)).join('')
}

describe('matchKey: examples', () => {
  it.each([
    ['AB-12/3', 'ab123'],
    ['  sn_00.42  ', 'sn0042'],
    ['۰۰۷', '007'],
    ['٠٠٧', '007'],
    ['SN\u200c۱۲۳', 'sn123'],
    ['\u200fRTL\u200e-mark', 'rtlmark'],
    ['ＡＢＣ－１２', 'abc12'],
    ['كيف', 'کیف'],
    ['مى', 'می'],
    ['a\\b', 'ab'],
    ['A\u00a0B\u2009C', 'abc'],
    ['x–y−z', 'xyz']
  ])('%j → %j', (input, expected) => {
    expect(matchKey(input)).toBe(expected)
  })

  it('keeps leading zeros: 007 and 7 are different identifiers', () => {
    expect(matchKey('007')).not.toBe(matchKey('7'))
  })

  it('leaves an unknown value unknown', () => {
    expect(matchKey(null)).toBeNull()
  })

  it('treats a value of only separators and invisible characters as blank', () => {
    expect(isBlankIdentifier(' -_/.\\\u200c\u200b\ufeff ')).toBe(true)
    expect(isBlankIdentifier('')).toBe(true)
    expect(isBlankIdentifier(' 0 ')).toBe(false)
  })

  it('does not fold non-ASCII Latin letters (locale-independent, like the database twin)', () => {
    expect(matchKey('Ä')).toBe('Ä')
  })

  it('removes nothing that identifies: no letter or digit is ever in the removed set', () => {
    for (const char of REMOVED) expect(char).not.toMatch(/[\p{L}\p{N}]/u)
  })

  it('translates only to canonical characters', () => {
    for (const [, to] of MATCH_KEY_TRANSLATIONS) expect(CANONICAL).toContain(String.fromCodePoint(to))
  })

  // NFKC runs first, so each listed character must survive it (or become another listed
  // one); otherwise a rule would silently never apply.
  it('removes every listed character, also after NFKC', () => {
    for (const char of REMOVED) expect(matchKey(`a${char}b`), JSON.stringify(char)).toBe('ab')
  })

  it('applies every listed translation, also after NFKC', () => {
    for (const [from, to] of MATCH_KEY_TRANSLATIONS) expect(matchKey(String.fromCodePoint(from))).toBe(String.fromCodePoint(to))
  })
})

describe('matchKey: properties', () => {
  it('recovers the canonical identifier however it was written', () => {
    forAll(0x5eed01, 3000, (random) => {
      const canonical = canonicalString(random)
      const written = decorate(random, canonical)
      expect(matchKey(written), JSON.stringify(written)).toBe(canonical)
    })
  })

  it('is idempotent', () => {
    forAll(0x5eed02, 3000, (random) => {
      const written = decorate(random, canonicalString(random))
      const key = matchKey(written)
      expect(matchKey(key)).toBe(key)
    })
  })

  it('distinguishes identifiers that differ in any letter or digit', () => {
    forAll(0x5eed03, 3000, (random) => {
      const a = canonicalString(random)
      const b = canonicalString(random)
      if (a === b) return
      expect(matchKey(decorate(random, a))).not.toBe(matchKey(decorate(random, b)))
    })
  })

  it('never puts a removed or untranslated character into a key', () => {
    const forbidden = new Set([...REMOVED, ...MATCH_KEY_TRANSLATIONS.map(([from]) => String.fromCodePoint(from))])
    forAll(0x5eed04, 2000, (random) => {
      const written = decorate(random, canonicalString(random))
      for (const char of matchKey(written) ?? '') expect(forbidden.has(char), JSON.stringify(written)).toBe(false)
    })
  })
})
