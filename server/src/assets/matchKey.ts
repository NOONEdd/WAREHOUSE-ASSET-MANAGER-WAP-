// Match keys for duplicate detection (docs/architecture/asset-schema-proposal.md §4;
// tools/data-quality/README.md, "Design rules"). Asset codes and serial numbers are
// stored exactly as written. A match key is a separate, derived value used only to
// find values that are probably the same identifier written differently — it never
// changes what is stored, and a match is reported as a suspected duplicate, never
// merged automatically.
//
// The rules, in this order:
//   1. Unicode NFKC: full-width forms, Arabic presentation forms and ligatures become
//      their base characters (copy-pasted values often carry them);
//   2. whitespace, invisible format characters (zero-width, bidirectional marks,
//      soft hyphen, BOM) and the separators - _ / . \ and Unicode dashes are removed;
//   3. Persian (۰–۹) and Arabic-Indic (٠–٩) digits become ASCII digits;
//   4. Arabic yeh ي and alef maksura ى become Persian yeh ی; Arabic kaf ك becomes
//      Persian keheh ک;
//   5. ASCII letters A–Z become a–z. Only ASCII: the result must not depend on a
//      locale, and the database twin (wam.match_key, proposed) must produce exactly
//      the same key.
// Leading zeros are kept: "۰۰۷" and "007" share the key "007", "7" does not.

/** Code points removed by rule 2. */
export const MATCH_KEY_REMOVED_CODE_POINTS: readonly number[] = [
  // whitespace
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  // invisible format characters
  0xad, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067,
  0x2068, 0x2069, 0xfeff,
  // separators: - _ / . \ and Unicode dashes
  0x2d, 0x5f, 0x2f, 0x2e, 0x5c, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212
]

/** Code point replacements of rules 3–5, as [from, to]. */
export const MATCH_KEY_TRANSLATIONS: readonly (readonly [from: number, to: number])[] = [
  ...Array.from({ length: 10 }, (_, d) => [0x06f0 + d, 0x30 + d] as const),
  ...Array.from({ length: 10 }, (_, d) => [0x0660 + d, 0x30 + d] as const),
  [0x064a, 0x06cc],
  [0x0649, 0x06cc],
  [0x0643, 0x06a9],
  ...Array.from({ length: 26 }, (_, i) => [0x41 + i, 0x61 + i] as const)
]

const REMOVED = new Set(MATCH_KEY_REMOVED_CODE_POINTS)
const TRANSLATED = new Map(MATCH_KEY_TRANSLATIONS)

/** The match key of an identifier; null stays null (an unknown serial has no key). */
export function matchKey(value: string | null): string | null {
  if (value === null) return null
  let key = ''
  for (const char of value.normalize('NFKC')) {
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined || REMOVED.has(codePoint)) continue
    const replacement = TRANSLATED.get(codePoint)
    key += replacement === undefined ? char : String.fromCodePoint(replacement)
  }
  return key
}

/**
 * True when a value contains nothing that identifies anything — only whitespace,
 * invisible characters or separators. Such a value is rejected as an asset code or a
 * serial number rather than stored: an unknown serial is recorded as unknown (null),
 * never as an empty or placeholder text.
 */
export function isBlankIdentifier(value: string): boolean {
  return matchKey(value) === ''
}
