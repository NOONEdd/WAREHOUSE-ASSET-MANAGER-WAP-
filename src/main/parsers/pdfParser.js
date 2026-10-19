import fs from 'fs'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { autoMapHeaders } from '../utils/importFieldAliases'

// PDF import (Phase 3).
//
// A PDF has no concept of "rows and columns" — a spreadsheet exported to
// PDF is really just a page of individually-positioned text fragments.
// This module reconstructs the table by geometry: fragments with nearly
// the same Y are one row; within a row, fragments are ordered left to
// right by X. The row identified as the header (same alias-matching
// approach as Excel/CSV — see findHeaderRowIndex below, deliberately
// duplicated rather than shared, matching this project's existing
// per-parser convention in excelParser.js/csvParser.js) fixes a set of
// column X-positions; every later row's fragments are then assigned to
// whichever column position they sit closest to. This also makes
// multi-page tables and repeated per-page headers (exactly what our own
// PDF export produces via `thead { display: table-header-group }`) work
// for free: each page is scanned independently for a header-like row, so
// a repeated header or banner/title text above it is recognized and
// skipped the same way on every page, not just the first.
//
// A cell whose content wraps onto a second visual line (any long
// department name, item description, or serial number will do this in
// an 11-column table) is reunited with its row rather than read as a
// phantom row of its own — see ROW_GROUP_GAP_THRESHOLD and
// groupLinesIntoRows below for how.

const Y_TOLERANCE = 3 // points — fragments within this Y distance are the same row
const COLUMN_GAP_THRESHOLD = 8 // points — an X gap bigger than this starts a new cell.
// Derived from real measurements: a genuine inter-word gap within one
// cell's text (checked across several multi-word headers and data
// values) measured 0-2pt; the smallest genuine gap between two
// DIFFERENT adjacent columns measured ~11.2pt, in a densely packed
// 15-column table where several headers are only a few characters wide
// — narrow enough that the old threshold of 12 sat just above that real
// column boundary and merged three separate narrow columns into one.
// 8 sits with real margin on both sides of the true boundary.
// A right-to-left PDF (any table exported from RTL-styled HTML — this
// app's own PDF export included) positions Arabic-script glyphs starting
// from the right, one glyph-showing operator at a time, so multiple
// glyphs of the SAME word can arrive as separate fragments in
// right-to-left position order. Concatenating a cluster of such
// fragments in ascending-X (left-to-right) order — the correct order for
// Latin text — reads the word backwards. A fragment counts as
// RTL-scripted if it contains any Arabic/Persian character, including
// the isolated/initial/medial/final presentation forms PDF generators
// commonly emit instead of the plain logical letter.
const RTL_CHAR_RANGE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/
// Points of X gap between two glyphs of the same RTL cluster before it's
// read as an actual space rather than two glyphs of one word. Derived
// from a real exported PDF: same-word glyph transitions measured
// ~0 (touching or slightly overlapping); a genuine inter-word space
// measured ~2pt. This sits between the two, comfortably below
// COLUMN_GAP_THRESHOLD.
const WORD_GAP_THRESHOLD = 1
// Points of Y gap between two consecutive text lines before they're read
// as two separate table rows rather than two wrapped lines of the same
// row. A cell's own wrapped lines sit close together — the browser
// vertically centers a <tr> on its tallest cell, so a wrapped cell's
// line 1 sits just above, and line 2 just below, every single-line
// cell's one line in that same row (measured on a real generated
// export: ~6-7pt). The gap between two actual rows (border + top/bottom
// padding of the next <tr>) measures ~21-26pt on that same export. This
// sits well inside that margin either way.
const ROW_GROUP_GAP_THRESHOLD = 12
const MAX_HEADER_SCAN_ROWS = 15
const MIN_ALIAS_MATCHES_FOR_HEADER_ROW = 2
// A page with fewer real characters than this, summed across every
// fragment, is treated as having no usable text layer at all (i.e. a
// scanned/image-only page) rather than as an oddly sparse table.
const MIN_EXTRACTABLE_CHARS = 5

async function loadDocument(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath))
  return pdfjsLib.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise
}

/**
 * Per page: [{ str, x, y, width }], blank/whitespace-only fragments
 * dropped (PDF generators — pdfkit among them — routinely emit
 * zero-content or pure-space fragments to pad out horizontal gaps).
 */
async function extractPagesFragments(doc) {
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const textContent = await page.getTextContent()
    const fragments = textContent.items
      .filter((it) => it.str && it.str.trim().length > 0)
      .map((it) => ({
        // PDF generators commonly emit Arabic/Persian text as
        // "presentation form" glyph codepoints (isolated/initial/
        // medial/final shape variants — a DIFFERENT Unicode codepoint
        // per shape than the plain logical letter) rather than the
        // plain letters themselves. Visually identical, but as text
        // they will never equal (or alias-match against) the plain
        // form a person would actually type — e.g. "ﺖ" (U+FE95) is not
        // "ت" (U+062A) as a string, even though both render as the
        // same glyph. NFKC's standard compatibility decomposition
        // converts these back to plain letters; this is applied at the
        // extraction boundary so every consumer downstream (header
        // alias matching, cell values written into the database) sees
        // ordinary Unicode text, the same as Excel/CSV always has.
        str: it.str.normalize('NFKC'),
        x: it.transform[4],
        y: it.transform[5],
        width: it.width || 0
      }))
    pages.push(fragments)
  }
  return pages
}

function clusterIntoRows(fragments) {
  const sorted = [...fragments].sort((a, b) => b.y - a.y)
  const rows = []
  for (const frag of sorted) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(row.y - frag.y) <= Y_TOLERANCE) {
      row.fragments.push(frag)
    } else {
      rows.push({ y: frag.y, fragments: [frag] })
    }
  }
  rows.forEach((r) => r.fragments.sort((a, b) => a.x - b.x))
  return rows
}

/**
 * Groups same-row fragments into cells by X gap (a gap bigger than
 * COLUMN_GAP_THRESHOLD is a real column boundary), then, per cell,
 * concatenates its fragments in the correct reading order: right-to-left
 * for an RTL-scripted cell (see RTL_CHAR_RANGE above), left-to-right
 * otherwise — inserting a space only where the gap between two
 * consecutive fragments indicates a real word boundary rather than two
 * glyphs of the same word (see WORD_GAP_THRESHOLD above).
 */
function mergeRowIntoCells(rowFragments) {
  // Purely geometric grouping — order-agnostic, so this works the same
  // whether the row reads left-to-right or right-to-left.
  const groups = []
  for (const frag of rowFragments) {
    const lastGroup = groups[groups.length - 1]
    const lastFrag = lastGroup ? lastGroup[lastGroup.length - 1] : null
    if (lastFrag && frag.x - (lastFrag.x + lastFrag.width) <= COLUMN_GAP_THRESHOLD) {
      lastGroup.push(frag)
    } else {
      groups.push([frag])
    }
  }

  return groups.map((group) => {
    const isRtl = group.some((f) => RTL_CHAR_RANGE.test(f.str))
    // group[] arrived in ascending-X order from clusterIntoRows; reading
    // an RTL cluster correctly means walking it right to left.
    const ordered = isRtl ? [...group].reverse() : group

    let str = ''
    let prevTrailingEdge = null
    for (const frag of ordered) {
      const leadingEdge = isRtl ? frag.x + frag.width : frag.x
      const trailingEdge = isRtl ? frag.x : frag.x + frag.width
      if (prevTrailingEdge !== null) {
        const gap = isRtl ? prevTrailingEdge - leadingEdge : leadingEdge - prevTrailingEdge
        if (gap > WORD_GAP_THRESHOLD) str += ' '
      }
      str += frag.str
      prevTrailingEdge = trailingEdge
    }

    const startX = Math.min(...group.map((f) => f.x))
    const endX = Math.max(...group.map((f) => f.x + f.width))
    return { str: str.replace(/\s+/g, ' ').trim(), startX, endX }
  })
}

function isRowEmpty(cellTexts) {
  return cellTexts.every((c) => !c || !String(c).trim())
}

/**
 * Joins two pieces of the same cell's text (either two fragments the
 * geometry placed in the same column on one line, or one column's text
 * split across two wrapped lines). A trailing hyphen on the first piece
 * means the browser wrapped without an original space there (e.g.
 * "SN-2024-" / "88451" -> "SN-2024-88451", a real observed case);
 * anything else wrapped at an actual word boundary, which needs the
 * space put back (e.g. "واحد تولید و مونتاژ خط" / "یک" ->
 * "واحد تولید و مونتاژ خط یک").
 */
function joinWrappedText(existing, addition) {
  if (!existing) return addition
  if (!addition) return existing
  const sep = /-$/.test(existing) ? '' : ' '
  return `${existing}${sep}${addition}`
}

/**
 * Reunites a wrapped header: with 11 Persian labels in one row, some
 * won't fit their column and wrap ("شماره سریال" -> "شماره" / "سریال",
 * "تاریخ ورود به انبار" -> "تاریخ ورود به" / "انبار") — the same
 * phenomenon as a wrapped data cell, just happening in the header row
 * itself.
 *
 * Each line is merged into cells independently first (mergeRowIntoCells
 * already gets the right-to-left glyph order correct WITHIN one line —
 * pooling raw fragments across lines before that step and reversing the
 * whole pool as one run is what actually breaks it, since each line is
 * its own separately-ordered run). The resulting cells are then
 * regrouped into columns purely by proximity of their right edge
 * (endX): a right-aligned RTL column keeps the exact same right edge
 * across every wrapped sub-line of its header (measured on a real
 * export: identical to sub-pixel precision), while the smallest gap
 * between two actually-different columns' right edges measured over
 * 50pt on that same export — COLUMN_GAP_THRESHOLD sits safely between
 * the two. Cells in the same cluster are then joined top-to-bottom by
 * plain string concatenation (joinWrappedText), the same as a wrapped
 * data cell — never by re-merging their raw fragments.
 */
function reconstructHeaderCells(lineGroup) {
  const perLineCells = lineGroup.flatMap((entry) =>
    mergeRowIntoCells(entry.fragments).map((cell) => ({ ...cell, y: entry.y }))
  )
  const sorted = [...perLineCells].sort((a, b) => b.endX - a.endX)
  const clusters = []
  for (const cell of sorted) {
    const last = clusters[clusters.length - 1]
    if (last && Math.abs(last[0].endX - cell.endX) <= COLUMN_GAP_THRESHOLD) {
      last.push(cell)
    } else {
      clusters.push([cell])
    }
  }
  return clusters
    .map((cluster) => {
      cluster.sort((a, b) => b.y - a.y) // top to bottom
      const str = cluster.reduce((acc, c) => joinWrappedText(acc, c.str), '')
      return {
        str,
        startX: Math.min(...cluster.map((c) => c.startX)),
        endX: Math.max(...cluster.map((c) => c.endX))
      }
    })
    .sort((a, b) => a.endX - b.endX) // restore ascending-X order, matching mergeRowIntoCells' convention
}

// Deliberately mirrors excelParser.js / csvParser.js's header-row search
// (see the module comment above for why this isn't shared instead).
// Operates on row GROUPS rather than individual lines so a wrapped
// header is reconstructed (see reconstructHeaderCells) before its cell
// texts are checked against the alias table — checking line-by-line
// would only ever see whichever single sub-line happens to hold the
// most complete labels, silently losing whichever headers wrapped.
function findHeaderGroupIndex(lineGroups) {
  const scanLimit = Math.min(lineGroups.length, MAX_HEADER_SCAN_ROWS)
  for (let i = 0; i < scanLimit; i++) {
    const texts = reconstructHeaderCells(lineGroups[i]).map((c) => c.str)
    if (isRowEmpty(texts)) continue
    const { mapping } = autoMapHeaders(texts)
    if (Object.keys(mapping).length >= MIN_ALIAS_MATCHES_FOR_HEADER_ROW) return i
  }
  return -1
}

function alignCellsToColumns(cells, columnCenters) {
  const result = new Array(columnCenters.length).fill('')
  for (const cell of cells) {
    const cellCenter = (cell.startX + cell.endX) / 2
    let bestIdx = 0
    let bestDist = Infinity
    columnCenters.forEach((center, idx) => {
      const dist = Math.abs(center - cellCenter)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = idx
      }
    })
    result[bestIdx] = joinWrappedText(result[bestIdx], cell.str)
  }
  return result
}

/**
 * Groups consecutive text lines (already Y-sorted top to bottom, as
 * clusterIntoRows produces) into row groups: a new group starts only
 * when the gap to the previous line exceeds ROW_GROUP_GAP_THRESHOLD, so
 * a wrapped cell's extra lines stay bundled with the row they belong to
 * while a genuinely new row still starts its own group.
 */
function groupLinesIntoRows(entries) {
  const groups = []
  for (const entry of entries) {
    const lastGroup = groups[groups.length - 1]
    const lastEntry = lastGroup ? lastGroup[lastGroup.length - 1] : null
    if (lastEntry && lastEntry.y - entry.y <= ROW_GROUP_GAP_THRESHOLD) {
      lastGroup.push(entry)
    } else {
      groups.push([entry])
    }
  }
  return groups
}

/**
 * Collapses one row group (one or more wrapped lines belonging to the
 * same logical row) into a single column-value array: each line's
 * fragments are merged into cells and aligned to the column grid
 * independently, then per column the pieces from every line in the
 * group are stitched back together in top-to-bottom order — the same
 * reconstruction whether a column had one line (the overwhelmingly
 * common case) or several.
 */
function mergeRowGroupIntoColumns(lineGroup, columnCenters) {
  const result = new Array(columnCenters.length).fill('')
  for (const entry of lineGroup) {
    const aligned = alignCellsToColumns(mergeRowIntoCells(entry.fragments), columnCenters)
    aligned.forEach((value, idx) => {
      if (!value) return
      result[idx] = joinWrappedText(result[idx], value)
    })
  }
  return result
}

/**
 * True if the document has essentially no extractable text layer at all
 * (a scanned/image-only PDF) — checked up front so the wizard can show a
 * clear "this needs OCR" message instead of a confusing "no header row
 * found" a step later.
 */
async function isTextExtractable(filePath) {
  const doc = await loadDocument(filePath)
  const pages = await extractPagesFragments(doc)
  const totalChars = pages.reduce(
    (sum, page) => sum + page.reduce((s, f) => s + f.str.trim().length, 0),
    0
  )
  return totalChars >= MIN_EXTRACTABLE_CHARS
}

/**
 * Full extraction: geometry -> rows -> cells -> a header-anchored column
 * grid -> { headers, rows }, the same shape excelParser/csvParser return.
 */
async function parsePdfFile(filePath) {
  const doc = await loadDocument(filePath)
  const pages = await extractPagesFragments(doc)

  const totalChars = pages.reduce(
    (sum, page) => sum + page.reduce((s, f) => s + f.str.trim().length, 0),
    0
  )
  if (totalChars < MIN_EXTRACTABLE_CHARS) {
    throw new Error(
      'این فایل PDF متن قابل استخراج ندارد و احتمالاً اسکن‌شده است. لطفاً از OCR استفاده کنید یا فایل را به‌صورت Excel یا CSV وارد کنید.'
    )
  }

  let headers = null
  let columnCenters = null
  const dataRows = []

  for (const pageFragments of pages) {
    if (pageFragments.length === 0) continue
    const lines = clusterIntoRows(pageFragments)
    const lineGroups = groupLinesIntoRows(lines)

    const headerGroupIdx = findHeaderGroupIndex(lineGroups)

    if (headers === null) {
      // First page must supply the canonical header — every following
      // page is read against the columns it defines.
      if (headerGroupIdx === -1) {
        throw new Error('ردیف سرستون در فایل شناسایی نشد.')
      }
      const headerCells = reconstructHeaderCells(lineGroups[headerGroupIdx])
      headers = headerCells.map((c) => c.str)
      columnCenters = headerCells.map((c) => (c.startX + c.endX) / 2)
      for (const group of lineGroups.slice(headerGroupIdx + 1)) {
        dataRows.push(mergeRowGroupIntoColumns(group, columnCenters))
      }
    } else {
      // A later page: if its own first rows look like a repeated header
      // (or a banner/title above one — same logic, same threshold),
      // skip everything through that row; otherwise the whole page is
      // data, anchored to the columns the first page already fixed.
      const startIdx = headerGroupIdx === -1 ? 0 : headerGroupIdx + 1
      for (const group of lineGroups.slice(startIdx)) {
        dataRows.push(mergeRowGroupIntoColumns(group, columnCenters))
      }
    }
  }

  const rows = dataRows.filter((r) => !isRowEmpty(r))

  return { headers, rows }
}

export { isTextExtractable, parsePdfFile }
