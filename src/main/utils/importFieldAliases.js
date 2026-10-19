import { normalizeForComparison, compactForComparison } from './digitUtils'
import { ASSET_IMPORT_SCHEMA } from './assetImportSchema'

// Header-matching table, derived from assetImportSchema.js rather than
// hand-listed here — that file is the one canonical schema the whole
// import system (this module, importService.js, and the renderer's
// wizard, over IPC) is built around, so a field's aliases live right next
// to its key/label/required-ness instead of drifting in a second file.
// Kept as its own exported object (not inlined) since importService.test.js
// and this module's own tests check it directly, and other code may still
// want "all aliases for field X" as a plain lookup.
//
// Aliases are intentionally generous (common Iranian-company ERP/Excel
// phrasing, Persian and English) but every one of them is an exact,
// unambiguous match to a single field — if a header doesn't match
// anything here, or could plausibly match more than one field, it's left
// unmapped and the person maps it manually in the wizard rather than us
// guessing.
export const IMPORT_FIELD_ALIASES = Object.fromEntries(
  ASSET_IMPORT_SCHEMA.map((f) => [f.key, f.aliases])
)

// Reverse lookup table built once: normalized alias text -> field key.
const ALIAS_INDEX = new Map()

// Fallback index for header text that lost its Persian half-space
// (U+200C, ZWNJ) entirely rather than having it turn into a space —
// e.g. a PDF's own text layer doesn't always carry a glyph for it, so a
// header written as "تحویل‌دهنده" can be extracted back as
// "تحویلدهنده" with NO separator at all. normalizeForComparison's
// "ZWNJ -> space" rule can't catch that, since there's no character
// left to convert once extraction has already dropped it. Keyed on the
// alias with every whitespace/ZWNJ character removed outright, and only
// ever consulted as a fallback after an exact match has already missed.
const COMPACT_ALIAS_INDEX = new Map()

for (const [fieldKey, aliases] of Object.entries(IMPORT_FIELD_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_INDEX.set(normalizeForComparison(alias), fieldKey)

    const compact = compactForComparison(alias)
    const existing = COMPACT_ALIAS_INDEX.get(compact)
    // If two different fields' aliases collapse to the same compact
    // form, neither is registered — an ambiguous fallback would risk
    // mapping a header to the wrong field, which is worse than leaving
    // it for the person to map by hand.
    if (existing === undefined) {
      COMPACT_ALIAS_INDEX.set(compact, fieldKey)
    } else if (existing !== fieldKey) {
      COMPACT_ALIAS_INDEX.set(compact, null)
    }
  }
}

/**
 * Matches one imported column header to a canonical field key, or null if
 * no alias matches. Exact match (after digit/whitespace/case
 * normalization) first — deliberately not fuzzy, so we never silently
 * map the wrong column — then, only if that misses, the compact
 * (whitespace/ZWNJ-stripped) fallback above.
 */
function matchHeaderToField(header) {
  const exact = ALIAS_INDEX.get(normalizeForComparison(header))
  if (exact) return exact
  return COMPACT_ALIAS_INDEX.get(compactForComparison(header)) || null
}

/**
 * Builds a header -> fieldKey mapping for a full header row. Returns both
 * the mapping (only for headers that matched) and the list of header
 * strings that didn't match anything, which the wizard must ask the user
 * to map manually. Works regardless of column order or how many extra,
 * unrecognized columns the file has — every header is matched purely by
 * its own text, independent of position or of any other header in the
 * row, so reordered and extra columns are handled with no special case.
 *
 * Keyed by column INDEX (a string, since that's what plain-object keys
 * always are — `mapping[2]` and `mapping['2']` read the same value), not
 * by the header text itself. A source file with two columns that happen
 * to share the exact same header — several columns all literally titled
 * "Date" is a real, common case, not a hypothetical one — would collide
 * on a header-text key: assigning the second "Date" column to one field
 * would silently overwrite whichever field the first "Date" column was
 * already assigned to, since both would be trying to use the identical
 * string as their key. Column position is always unique within one file,
 * so that's what identifies a column here; the header text remains
 * available from `headers[index]` purely for display.
 */
function autoMapHeaders(headers) {
  const mapping = {}
  const unmapped = []
  const usedFields = new Set()

  headers.forEach((header, index) => {
    const fieldKey = matchHeaderToField(header)
    // If two headers alias to the same field, treat the second as
    // unmapped rather than silently overwriting the first match —
    // an ambiguous file, not a confident one.
    if (fieldKey && !usedFields.has(fieldKey)) {
      mapping[index] = fieldKey
      usedFields.add(fieldKey)
    } else {
      unmapped.push(header)
    }
  })

  return { mapping, unmapped }
}

export { matchHeaderToField, autoMapHeaders }
