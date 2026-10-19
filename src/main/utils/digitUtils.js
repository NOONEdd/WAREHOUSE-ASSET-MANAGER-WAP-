// Main-process-only counterpart to renderer/src/utils/numberFormat.js's
// toPersianDigits — that file converts Western -> Persian for display;
// this does the reverse for import, normalizing whatever digit script the
// source file used (Persian ۰-۹ or Arabic-Indic ٠-٩, both seen in Iranian
// company spreadsheets) back to Western digits. Duplicated here rather than
// imported across the process boundary because main and renderer are
// separate electron-vite build targets (same reasoning as exportService.js's
// own formatPersianNumber copy).
//
// Character-level replacement only — never touches numeric interpretation,
// so leading zeros and non-digit characters pass through untouched. This is
// what lets Asset Code / Serial Number values keep their exact shape while
// still normalizing which digit glyphs they use.

const PERSIAN_TO_WESTERN = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
}

const ARABIC_INDIC_TO_WESTERN = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
}

/**
 * Converts Persian and Arabic-Indic digit characters within a string to
 * Western digits. Non-digit characters (including everything else in the
 * string) are left exactly as-is.
 */
function normalizeDigits(value) {
  if (value === null || value === undefined) return value
  return String(value).replace(/[۰-۹٠-٩]/g, (ch) => PERSIAN_TO_WESTERN[ch] || ARABIC_INDIC_TO_WESTERN[ch] || ch)
}

/**
 * Trims and collapses internal whitespace variants (regular space, Persian
 * half-space U+200C) that commonly differ between how a company's export
 * tool wrote a header/cell and how our alias list expects it — used only
 * for comparison purposes (header matching), never applied to stored data.
 */
function normalizeForComparison(value) {
  if (value === null || value === undefined) return ''
  return normalizeDigits(String(value))
    .replace(/\u200c/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Fallback comparison form for text that may have lost its Persian
 * half-space (U+200C, ZWNJ) ENTIRELY during extraction rather than having
 * it turn into a space — a real, observed PDF text-layer quirk (Chromium
 * doesn't always carry a glyph for it), not a hypothetical one: "آسیب‌دیده"
 * can come back as "آسیبدیده" with NO separator at all. normalizeForComparison's
 * "ZWNJ -> space" rule can't catch that, since there's no character left to
 * convert. Strips ALL whitespace/ZWNJ instead of normalizing it, so two
 * strings that only differ in whether a half-space survived extraction
 * still compare equal. Used as a fallback AFTER normalizeForComparison
 * misses — both for matching an imported header to a canonical field
 * (importFieldAliases.js) and for matching an imported status/lookup
 * value to an existing row (importService.js) — never as the primary
 * match, since collapsing all whitespace is more aggressive and could in
 * principle blur together two genuinely different short values.
 */
function compactForComparison(value) {
  return normalizeForComparison(value).replace(/\s+/g, '')
}

export { normalizeDigits, normalizeForComparison, compactForComparison }
