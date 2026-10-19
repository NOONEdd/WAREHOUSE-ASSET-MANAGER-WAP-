import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import PDFDocument from 'pdfkit'
import { isTextExtractable, parsePdfFile } from '../../../src/main/parsers/pdfParser.js'

// pdfkit is used ONLY to generate test fixtures here — it is not part of
// the shipped parser (pdfjs-dist reads real-world PDFs; pdfkit just
// writes throwaway ones for these tests to read back).
//
// Persian text needs `{ features: ['rtla'] }` on every pdfkit .text()
// call or word order comes out reversed (confirmed by hand: "در انبار"
// without the option extracts back as "انباردر"). Even with the option,
// pdfkit's shaping is still simplistic, not a full Unicode Bidi
// Algorithm implementation — two further quirks were observed and are
// deliberately avoided in the fixtures below rather than worked around,
// since they're artifacts of the fixture generator, not the parser:
//   - a Latin word embedded inside a Persian string gets reversed
//     (e.g. "لپ‌تاپ Dell" -> "لپ تاپ lleD") — fixtures below keep
//     Persian and Latin cell values separate, never mixed in one string
//   - a lam-alef ("لا") ligature can come out with the two characters
//     swapped (e.g. "کالا" -> "کاال") — fixtures use "نوع اموال" (a
//     real, listed alias for assetType with no lam-alef sequence)
//     instead of "نوع کالا" wherever the header itself must round-trip
//     through alias matching
const FONT_PATH = path.join(__dirname, 'fixtures', 'Vazirmatn-Regular.ttf')
const RTL = { features: ['rtla'] }

let pdfDir

function newPdfPath() {
  if (!pdfDir) pdfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-pdf-test-'))
  return path.join(pdfDir, `test-${Math.random().toString(36).slice(2)}.pdf`)
}

function finish(doc, filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath)
    doc.pipe(stream)
    stream.on('finish', resolve)
    stream.on('error', reject)
    doc.end()
  })
}

// Simple English-header 3-column table, one .text() call per cell — the
// baseline case with no font/bidi variables involved at all.
async function writeSimpleEnglishTable() {
  const filePath = newPdfPath()
  const doc = new PDFDocument({ size: 'A4', margin: 40 })
  doc.fontSize(10)
  const cols = [40, 200, 400]
  const rowsOfText = [
    ['Asset Code', 'Serial Number', 'Status'],
    ['A-001', 'SN-123', 'In Stock'],
    ['A-002', 'SN-456', 'Damaged']
  ]
  rowsOfText.forEach((row, r) => {
    const y = 60 + r * 20
    row.forEach((cell, c) => doc.text(cell, cols[c], y))
  })
  await finish(doc, filePath)
  return filePath
}

// Persian header + Persian/English-mixed data, matching the app's real
// export column set — but split ACROSS TWO PAGES, and with the header
// row repeated on page 2 (exactly what Chromium's printToPDF produces
// for a `<thead>` via `display: table-header-group`, which is how this
// app's own PDF export works).
async function writePersianTwoPageTable() {
  const filePath = newPdfPath()
  const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' })
  doc.font(FONT_PATH).fontSize(10)
  const cols = [40, 160, 300, 430, 560]
  const header = ['کد اموال', 'نام دارایی', 'نوع اموال', 'شماره سریال', 'وضعیت']

  function drawHeader(y) {
    header.forEach((cell, c) => doc.text(cell, cols[c], y, RTL))
  }

  drawHeader(40)
  const page1Rows = [
    ['15648', 'دستگاه یک', 'رایانه', 'ssf', 'در انبار'],
    ['99001', 'دستگاه دو', 'مبلمان', 'XYZ-999', 'آسیب‌دیده']
  ]
  page1Rows.forEach((row, r) => {
    const y = 65 + r * 20
    row.forEach((cell, c) => doc.text(cell, cols[c], y, RTL))
  })

  doc.addPage({ size: 'A4', margin: 40, layout: 'landscape' })
  drawHeader(40)
  const page2Rows = [['77777', 'دستگاه سه', 'برق', 'SN-777', 'صادر شده']]
  page2Rows.forEach((row, r) => {
    const y = 65 + r * 20
    row.forEach((cell, c) => doc.text(cell, cols[c], y, RTL))
  })

  await finish(doc, filePath)
  return filePath
}

async function writeImageOnlyPdf() {
  const filePath = newPdfPath()
  const doc = new PDFDocument({ size: 'A4', margin: 40 })
  // No text operators at all on this page — the way a scanned page's
  // PDF looks structurally (a raster image with no text layer), without
  // needing an actual image file for the test.
  doc.rect(40, 40, 200, 100).stroke()
  await finish(doc, filePath)
  return filePath
}

describe('pdfParser.isTextExtractable', () => {
  it('is true for a normal text-based PDF', async () => {
    const filePath = await writeSimpleEnglishTable()
    expect(await isTextExtractable(filePath)).toBe(true)
  })

  it('is false for a PDF with no text layer (scanned/image-only)', async () => {
    const filePath = await writeImageOnlyPdf()
    expect(await isTextExtractable(filePath)).toBe(false)
  })
})

describe('pdfParser.parsePdfFile', () => {
  it('reconstructs headers and rows from a simple positioned-text table', async () => {
    const filePath = await writeSimpleEnglishTable()
    const { headers, rows } = await parsePdfFile(filePath)

    expect(headers).toEqual(['Asset Code', 'Serial Number', 'Status'])
    expect(rows).toEqual([
      ['A-001', 'SN-123', 'In Stock'],
      ['A-002', 'SN-456', 'Damaged']
    ])
  })

  it('reconstructs a Persian table, skips the repeated per-page header, and merges both pages into one row set', async () => {
    const filePath = await writePersianTwoPageTable()
    const { headers, rows } = await parsePdfFile(filePath)

    expect(headers).toEqual(['کد اموال', 'نام دارایی', 'نوع اموال', 'شماره سریال', 'وضعیت'])
    expect(rows).toHaveLength(3)
    // Row from page 1
    expect(rows[0][0]).toBe('15648')
    expect(rows[0][3]).toBe('ssf')
    // Row from page 2 — proves the repeated header on page 2 was
    // recognized and skipped rather than becoming a garbage data row,
    // and that page 2's data still landed in the SAME combined table.
    expect(rows[2][0]).toBe('77777')
    expect(rows[2][2]).toBe('برق')
    expect(rows[2][4]).toBe('صادر شده')
  })

  it('produces headers that auto-map correctly via importFieldAliases', async () => {
    const filePath = await writePersianTwoPageTable()
    const { headers } = await parsePdfFile(filePath)
    const { autoMapHeaders } = await import('../../../src/main/utils/importFieldAliases.js')

    const { mapping } = autoMapHeaders(headers)
    expect(mapping[headers.indexOf('کد اموال')]).toBe('assetCode')
    expect(mapping[headers.indexOf('شماره سریال')]).toBe('serialNumber')
    expect(mapping[headers.indexOf('وضعیت')]).toBe('status')
  })

  it('rejects a scanned/image-only PDF with a clear OCR-needed message instead of a generic parse error', async () => {
    const filePath = await writeImageOnlyPdf()
    await expect(parsePdfFile(filePath)).rejects.toThrow(/اسکن‌شده|OCR/)
  })

  it('rejects a text PDF with no recognizable header row', async () => {
    const filePath = newPdfPath()
    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    doc.fontSize(10).text('این یک یادداشت متنی است، نه یک جدول.', 40, 40)
    await finish(doc, filePath)

    await expect(parsePdfFile(filePath)).rejects.toThrow(/سرستون/)
  })
})

describe('pdfParser — real production PDF (user-reported regression)', () => {
  // A genuine PDF exported by this app's own Reports page — Chromium's
  // printToPDF, RTL table, real banner. This caught two real bugs
  // pdfkit-generated fixtures never could, because pdfkit's simplistic
  // text layout doesn't reproduce either of them:
  //   1. Chromium positions Arabic/Persian glyphs of the SAME word
  //      right-to-left, one glyph-showing operator per glyph — reading
  //      left-to-right (correct for Latin, and what every earlier
  //      fixture in this file happened to need) silently reversed every
  //      Persian word, so no header cell could ever alias-match.
  //   2. Those glyphs are "presentation form" codepoints (a different
  //      Unicode character per shape than the plain logical letter,
  //      even though both render identically) — NFKC normalization is
  //      required before alias matching can ever see them as the text
  //      a person actually typed.
  // Kept as a real fixture rather than a synthetic one so a future
  // change to Chromium's PDF output, or a regression in either fix
  // above, is caught against the actual artifact that surfaced this.
  const REAL_PDF_PATH = path.join(__dirname, 'fixtures', 'real-export-fa.pdf')

  it('extracts the correct headers and all 3 rows, matching the visual table exactly', async () => {
    const { headers, rows } = await parsePdfFile(REAL_PDF_PATH)

    expect(headers).toEqual([
      'وضعیت',
      'واحد/بخش',
      'کشور ساخت',
      'شماره سریال',
      'نوع کالا',
      'نام دارایی',
      'کد دارایی'
    ])
    expect(rows).toEqual([
      ['در انبار', 'کنگان', 'ژاپن', '5647', 'lift truck', 'dastgah', 'iop'],
      ['تعمیر', '—', 'آمریکا', '8795', 'laptop', '5687', '5687'],
      ['در انبار', '—', '—', '8745', 'laptop', 'ssf', 'ssf']
    ])
  })

  it('every header auto-maps to the correct field — no manual mapping required for our own export', async () => {
    const { headers } = await parsePdfFile(REAL_PDF_PATH)
    const { autoMapHeaders } = await import('../../../src/main/utils/importFieldAliases.js')
    const { mapping } = autoMapHeaders(headers)

    // mapping is keyed by column index (see importFieldAliases.js's
    // autoMapHeaders), not header text — expressed here as "which header
    // maps to which field" and converted via headers.indexOf, rather
    // than hardcoding index positions that depend on PDF extraction
    // geometry and would make this test fragile to reorder.
    const expectedByHeader = {
      'وضعیت': 'status',
      'واحد/بخش': 'workshop',
      'کشور ساخت': 'country',
      'شماره سریال': 'serialNumber',
      'نوع کالا': 'assetType',
      'نام دارایی': 'assetName',
      'کد دارایی': 'assetCode'
    }
    expect(mapping).toEqual(
      Object.fromEntries(Object.entries(expectedByHeader).map(([h, field]) => [headers.indexOf(h), field]))
    )
  })
})

describe('pdfParser — real production PDF with wrapped cells, all 11 columns (user-reported regression)', () => {
  // A genuine PDF exported by this app's own Reports page with the FULL
  // 11-column asset list and realistic-length real-world values (long
  // department names, item descriptions, prefixed serial numbers). This
  // caught two real bugs the 7-column short-value fixture above never
  // could, because its values were all short enough to never wrap and
  // had no ZWNJ in any header:
  //   1. A cell whose content doesn't fit its column wraps onto a
  //      second visual line. The browser vertically centers a <tr> on
  //      its tallest cell, so a wrapped cell's extra lines land ABOVE
  //      and BELOW every single-line cell's one line in that same row —
  //      reading rows by simple Y-proximity alone (as if every line at
  //      a new Y were a new row) split one real record into up to 3
  //      "rows", leaving whichever field wrapped blank on the real one.
  //      At this app's real scale (5000+ assets with real department
  //      and item names) this reliably breaks the columns most likely
  //      to hold longer text — workshop, asset name, item type, serial
  //      number.
  //   2. 'تحویل‌دهنده' / 'تحویل‌گیرنده' (deliverer/receiver) contain a
  //      Persian half-space (U+200C, ZWNJ). This PDF's text layer
  //      doesn't carry a glyph for it at all, so the header extracts
  //      back as "تحویلدهنده" with NO separator whatsoever, not even a
  //      plain space — which normalizeForComparison's "ZWNJ -> space"
  //      rule can't fix, since there's no character left to convert.
  // Kept as a real fixture rather than a synthetic one so a future
  // change to Chromium's PDF output, or a regression in either fix
  // above, is caught against the actual artifact that surfaced this.
  const WRAPPED_PDF_PATH = path.join(__dirname, 'fixtures', 'real-export-fa-wrapped.pdf')

  it('reunites every wrapped cell with its own row instead of splitting it into a phantom row', async () => {
    const { headers, rows } = await parsePdfFile(WRAPPED_PDF_PATH)

    expect(headers).toEqual([
      'وضعیت',
      'تحویلگیرنده', // 'تحویل‌گیرنده' with the ZWNJ half-space lost during extraction
      'تحویلدهنده', // 'تحویل‌دهنده', same
      'تاریخ خروج از انبار',
      'تاریخ ورود به انبار',
      'واحد/بخش',
      'کشور ساخت',
      'شماره سریال',
      'نوع کالا',
      'نام دارایی',
      'کد دارایی'
    ])

    // Exactly 3 rows, not 9 — the three wrapped lines each row's
    // longest cells spilled onto are folded back in, not read as six
    // extra phantom rows.
    expect(rows).toHaveLength(3)

    expect(rows[0]).toEqual([
      'در انبار',
      'علی اکبر رستمی',
      'محمدرضا حسینی نژاد',
      '—',
      '1402/06/12',
      'واحد تولید و مونتاژ خط یک', // wrapped across 2 lines, word-boundary join
      'آلمان',
      'SN-2024-88451', // wrapped across 2 lines, hyphen-adjacent join (no inserted space)
      'تجهیزات جوشکاری',
      'دستگاه جوشکاری آرگون صنعتی مدل XR-500', // wrapped across 2 lines
      'AST-10234'
    ])
    expect(rows[1]).toEqual([
      'صادر شده',
      'فاطمه احمدی راد',
      'سید محمد طباطبایی',
      '1403/02/19',
      '1402/07/03',
      'واحد کنترل کیفیت و آزمایشگاه',
      'چین',
      'SN-2024-88452',
      // NB: the ZWNJ in 'رایانه‌ای' is lost the same way as in the
      // header case below — a known limitation for DATA values (as
      // opposed to headers, which have the compact-alias fallback):
      // there's no reliable geometric signal to tell "a real ZWNJ used
      // to be exactly here" apart from ordinary letter-to-letter
      // spacing within a word.
      'تجهیزات رایانهای',
      'رایانه رومیزی ایستگاه کاری مهندسی',
      'AST-10235'
    ])
    expect(rows[2]).toEqual([
      'تعمیر',
      '—',
      'رضا کریمی وند',
      '—',
      '1403/01/25',
      'انبار مرکزی کنگان',
      'ژاپن',
      'SN-2024-88453',
      'ماشینآلات حمل و نقل',
      'لیفتراک برقی ظرفیت سه تن',
      'AST-10236'
    ])
  })

  it('every one of the 11 headers auto-maps to its field, including the ZWNJ-stripped deliverer/receiver headers', async () => {
    const { headers } = await parsePdfFile(WRAPPED_PDF_PATH)
    const { autoMapHeaders } = await import('../../../src/main/utils/importFieldAliases.js')
    const { mapping, unmapped } = autoMapHeaders(headers)

    expect(unmapped).toEqual([])
    // mapping is keyed by column index (see importFieldAliases.js's
    // autoMapHeaders) — converted here via headers.indexOf for the same
    // reason as the test above.
    const expectedByHeader = {
      'وضعیت': 'status',
      'تحویلگیرنده': 'receivedBy', // matched via the compact ZWNJ-stripped fallback
      'تحویلدهنده': 'deliveredBy', // matched via the compact ZWNJ-stripped fallback
      'تاریخ خروج از انبار': 'warehouseExitDate',
      'تاریخ ورود به انبار': 'warehouseEntryDate',
      'واحد/بخش': 'workshop',
      'کشور ساخت': 'country',
      'شماره سریال': 'serialNumber',
      'نوع کالا': 'assetType',
      'نام دارایی': 'assetName',
      'کد دارایی': 'assetCode'
    }
    expect(mapping).toEqual(
      Object.fromEntries(Object.entries(expectedByHeader).map(([h, field]) => [headers.indexOf(h), field]))
    )
  })
})
