import { dialog, BrowserWindow, app } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import ExcelJS from 'exceljs'
import QRCode from 'qrcode'
import { auditService } from './auditService'

/**
 * Phase 14 — Excel/PDF export with the SFZ banner letterhead
 * (resources/branding/BRANDING.md).
 *
 * Excel uses exceljs directly. PDF deliberately does NOT use a PDF-drawing
 * library (e.g. pdfkit): those lay out text as a raw glyph sequence and
 * don't perform Arabic-script shaping/bidi, so Persian text comes out
 * disconnected or reversed. Instead this renders an HTML template through
 * Electron's own Chromium (webContents.printToPDF) — the same engine that
 * already renders the app's Persian UI correctly, so the PDF gets that for
 * free, and a plain HTML <table> with the banner in <thead> naturally
 * repeats it on every printed page (BRANDING.md's "every page, not just
 * the first" requirement) without any manual pagination code.
 */

// Resources aren't processed by Vite (renderer-only) — read the same
// source files directly from disk. app.getAppPath() is the project root
// in dev; if this app is ever packaged, the builder config needs to keep
// resources/ alongside the app for this path to keep resolving.
function resourcePath(...segments) {
  return path.join(app.getAppPath(), 'resources', ...segments)
}

const BANNER_ASPECT_RATIO = 3.0 // sfz-banner.png is 2172x724 (BRANDING.md)

let bannerBufferCache = null
function getBannerBuffer() {
  if (!bannerBufferCache) {
    bannerBufferCache = fs.readFileSync(resourcePath('branding', 'sfz-banner.png'))
  }
  return bannerBufferCache
}

let fontBase64Cache = null
function getFontBase64() {
  if (!fontBase64Cache) {
    fontBase64Cache = fs
      .readFileSync(resourcePath('fonts', 'Vazirmatn', 'Vazirmatn[wght].woff2'))
      .toString('base64')
  }
  return fontBase64Cache
}

// Mirrors renderer/src/utils/numberFormat.js — that file is renderer-only
// (separate Vite build target from main), so this small pure function is
// duplicated here rather than reaching across the process boundary.
const WESTERN_TO_PERSIAN = { 0: '۰', 1: '۱', 2: '۲', 3: '۳', 4: '۴', 5: '۵', 6: '۶', 7: '۷', 8: '۸', 9: '۹' }
function formatPersianNumber(value) {
  return Number(value)
    .toLocaleString('en-US')
    .replace(/[0-9]/g, (d) => WESTERN_TO_PERSIAN[d])
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}

// ---------------------------------------------------------------- Excel --

async function buildExcelBuffer({ title, columns, rows }) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Sanat Farabar Zarin Co.'
  const sheet = workbook.addWorksheet('گزارش', { views: [{ rightToLeft: true }] })

  sheet.columns = columns.map((c) => ({ width: c.numeric ? 12 : 24 }))

  // Banner: real embedded image (full resolution, no re-encoding — same
  // buffer as the source PNG), merged across the report's own columns.
  const bannerRows = 6
  const bannerWidthPx = 480
  sheet.mergeCells(1, 1, bannerRows, columns.length)
  const imageId = workbook.addImage({ buffer: getBannerBuffer(), extension: 'png' })
  sheet.addImage(imageId, {
    tl: { col: 0, row: 0 },
    ext: { width: bannerWidthPx, height: Math.round(bannerWidthPx / BANNER_ASPECT_RATIO) },
    editAs: 'oneCell'
  })
  for (let r = 1; r <= bannerRows; r++) sheet.getRow(r).height = 20

  const titleRowNum = bannerRows + 2
  const titleCell = sheet.getRow(titleRowNum).getCell(1)
  titleCell.value = title
  titleCell.font = { bold: true, size: 14 }
  sheet.mergeCells(titleRowNum, 1, titleRowNum, columns.length)

  const headerRowNum = bannerRows + 4
  const headerRow = sheet.getRow(headerRowNum)
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = c.title
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }
    cell.border = { bottom: { style: 'thin' } }
  })

  // Real numeric cells (not Persian-digit text) so Excel's own sort/sum/
  // filter still work on count columns — PDF formats these for display
  // instead, since it's a print target rather than a spreadsheet.
  rows.forEach((row, rIdx) => {
    const excelRow = sheet.getRow(headerRowNum + 1 + rIdx)
    columns.forEach((c, cIdx) => {
      excelRow.getCell(cIdx + 1).value = row[c.key] ?? ''
    })
  })

  return workbook.xlsx.writeBuffer()
}

// ------------------------------------------------------------------ PDF --

function buildReportHtml({ title, columns, rows }) {
  const bannerBase64 = getBannerBuffer().toString('base64')
  const fontBase64 = getFontBase64()

  const headerCells = columns.map((c) => `<th>${escapeHtml(c.title)}</th>`).join('')
  const bodyRows = rows
    .map((row) => {
      const cells = columns
        .map((c) => {
          const raw = row[c.key]
          const display = c.numeric ? formatPersianNumber(raw ?? 0) : raw ?? '—'
          return `<td class="${c.numeric ? 'num' : ''}">${escapeHtml(display)}</td>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')

  return `<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: 'Vazirmatn';
    src: url(data:font/woff2;base64,${fontBase64}) format('woff2-variations');
    font-weight: 100 900;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Vazirmatn', Tahoma, sans-serif; direction: rtl; margin: 0; color: #1f1f1f; }
  table { width: 100%; border-collapse: collapse; }
  /* thead repeats at the top of every printed page — this, not a manual
     pagination routine, is what satisfies "banner on every page". */
  thead { display: table-header-group; }
  tbody { display: table-row-group; }
  .banner-row td { padding: 0; }
  .banner-row img { width: 100%; height: auto; display: block; }
  .title-row td { padding: 14px 6px 10px; font-size: 15px; font-weight: 700; }
  .col-header th { text-align: right; padding: 6px 8px; background: #f0f0f0; border-bottom: 1px solid #ccc; font-size: 10.5px; }
  tbody td { padding: 5px 8px; border-bottom: 1px solid #eee; font-size: 10.5px; }
  tbody td.num { text-align: right; }
  tbody tr:nth-child(even) { background: #fafafa; }
</style>
</head>
<body>
<table>
  <thead>
    <tr class="banner-row"><td colspan="${columns.length}"><img src="data:image/png;base64,${bannerBase64}" alt="Sanat Farabar Zarin Co."></td></tr>
    <tr class="title-row"><td colspan="${columns.length}">${escapeHtml(title)}</td></tr>
    <tr class="col-header">${headerCells}</tr>
  </thead>
  <tbody>${bodyRows}</tbody>
</table>
</body>
</html>`
}

async function buildPdfBuffer({ title, columns, rows }) {
  const html = buildReportHtml({ title, columns, rows })
  // Security Hardening phase — explicit, matching the main window's own
  // webPreferences, rather than relying on Electron's current defaults
  // staying secure. This window never runs application code or loads
  // anything other than the HTML string built above (escapeHtml()'d
  // throughout — see buildReportHtml), so there's no functional reason
  // it would ever need Node/contextIsolation access; it just never had
  // an explicit opinion about it before.
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })

  // Bug fix (production report, real 10,000-asset PDF export) — Chromium
  // enforces a hard length ceiling on navigated data: URLs. A large
  // report's HTML, base64-encoded, blew well past it (~6.8 million
  // characters for 10,000 rows), so loadURL(`data:...`) failed outright
  // with ERR_INVALID_URL (-300) — this wasn't a slowness problem, it was
  // a hard cliff: small reports worked, large ones didn't work AT ALL.
  // A temp file + loadFile() has no such ceiling — the navigated URL is
  // just a short file path regardless of how large the file's contents
  // are, so this scales the same way normal file loading always has.
  // This changes only how the already-built `html` string gets INTO the
  // window; buildReportHtml, its embedded font/banner data URIs, and
  // every printToPDF option below are untouched.
  const tempHtmlPath = path.join(app.getPath('temp'), `awm-pdf-export-${crypto.randomUUID()}.html`)
  let tempFileWritten = false

  // Best-effort, idempotent cleanup — safe to call more than once (a
  // second fs.unlink on an already-removed file just fails silently
  // here), so it's registered both for the normal try/finally path below
  // AND as a fallback if this window is destroyed some other way (e.g.
  // the app quitting mid-export) before that finally block runs.
  function cleanupTempFile() {
    if (tempFileWritten) fs.unlink(tempHtmlPath, () => {})
  }
  win.once('closed', cleanupTempFile)

  try {
    fs.writeFileSync(tempHtmlPath, html, 'utf-8')
    tempFileWritten = true

    // Security Hardening phase — this window has exactly one legitimate
    // navigation, the loadFile() call below; closing off every other
    // navigation/new-window path costs nothing, same reasoning as the
    // main window's own guards (main/index.js), just not shared code
    // since this window is short-lived and created fresh per export.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())

    await win.loadFile(tempHtmlPath)
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      landscape: true, // wide enough for an 11-column asset list without cramming; every report benefits, none is hurt by the extra width
      printBackground: true, // required, or the banner image and shading are silently dropped
      margins: { top: 0.2, bottom: 0.4, left: 0.3, right: 0.3 }
    })
  } finally {
    win.destroy()
    cleanupTempFile()
  }
}

// --------------------------------------------------------------- Labels --
// Batch asset-label printing — the QrCode component (renderer/src/
// components/common/QrCode.jsx) already uses this same `qrcode` package
// client-side for the single-asset QR shown on Asset Details; this reuses
// it server-side (qrcode is isomorphic, not a DOM-dependent library) so
// no new dependency was needed for the bulk version.
//
// Deliberately not the report template: no letterhead (irrelevant on a
// sheet meant to be cut into individual stickers), and printed directly
// via webContents.print() rather than saved as a file, since "چاپ" here
// means "send to a printer now", not "export a document".

async function buildLabelSheetHtml({ assets }) {
  const fontBase64 = getFontBase64()
  const labelsHtml = (
    await Promise.all(
      assets.map(async (a) => {
        const qrDataUrl = await QRCode.toDataURL(a.assetCode, { width: 180, margin: 0 })
        return `<div class="label">
          <img class="qr" src="${qrDataUrl}" alt="">
          <div class="info">
            <div class="code">${escapeHtml(a.assetCode)}</div>
            <div class="name">${escapeHtml(a.assetName || '')}</div>
            ${a.serialNumber ? `<div class="serial">${escapeHtml(a.serialNumber)}</div>` : ''}
          </div>
        </div>`
      })
    )
  ).join('')

  return `<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: 'Vazirmatn';
    src: url(data:font/woff2;base64,${fontBase64}) format('woff2-variations');
    font-weight: 100 900;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Vazirmatn', Tahoma, sans-serif; direction: rtl; margin: 0; padding: 8mm; color: #1f1f1f; }
  .sheet { display: flex; flex-wrap: wrap; gap: 3mm; }
  /* flexbox, not CSS grid — breaks across printed pages more reliably in
     Chromium's print engine, and this template needs to paginate on its
     own for a selection that doesn't fit one sheet. */
  .label {
    flex: 0 0 31%;
    display: flex;
    align-items: center;
    gap: 2.5mm;
    border: 1px dashed #999;
    border-radius: 2mm;
    padding: 2.5mm;
    min-height: 24mm;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .qr { width: 20mm; height: 20mm; flex-shrink: 0; }
  .info { min-width: 0; overflow: hidden; }
  .code { font-family: 'Courier New', monospace; font-weight: 700; font-size: 11px; direction: ltr; text-align: right; }
  .name { font-size: 9.5px; color: #333; margin-top: 1mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .serial { font-family: 'Courier New', monospace; font-size: 8px; color: #666; margin-top: 0.5mm; direction: ltr; text-align: right; }
</style>
</head>
<body>
  <div class="sheet">${labelsHtml}</div>
</body>
</html>`
}

async function printLabels({ assets }, parentWindow, currentUser) {
  const html = await buildLabelSheetHtml({ assets })
  // Security Hardening phase — same reasoning as buildPdfBuffer's window
  // above: explicit rather than relying on Electron defaults, even
  // though this one is interactive (shows the OS print dialog) rather
  // than headless.
  const win = new BrowserWindow({
    show: false,
    parent: parentWindow,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  try {
    const dataUrl = 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf-8').toString('base64')
    await win.loadURL(dataUrl)
    const success = await new Promise((resolve, reject) => {
      win.webContents.print({ silent: false, printBackground: true }, (ok, failureReason) => {
        if (ok) resolve(true)
        // The dialog's own Cancel button is a normal outcome, not a
        // real failure — everything else genuinely failed.
        else if (/cancel/i.test(failureReason || '')) resolve(false)
        else reject(new Error(failureReason))
      })
    })
    // Reliability + Audit Completeness phase — only a real, completed
    // print counts as company data leaving the app; the person cancelling
    // the OS print dialog is a no-op, same as cancelling a save dialog
    // above, and is not recorded.
    if (success) {
      auditService.recordAudit({
        user: currentUser,
        action: 'EXPORT',
        entityType: 'Export',
        entityId: null,
        changes: { format: 'labels', assetCount: assets.length }
      })
    }
    return { success, canceled: !success }
  } finally {
    win.destroy()
  }
}

// --------------------------------------------------- save orchestration --

// Reliability + Audit Completeness phase — every successful export is
// company data leaving the app as a file, so it's audited like any
// other data-affecting operation. Cancelling the save dialog records
// nothing (no file was actually written); `changes` deliberately never
// carries row data itself — only metadata (format, title, how many
// rows/labels) — so the audit trail can show an export happened without
// itself becoming a second copy of the exported data.
async function exportToExcel({ title, columns, rows }, parentWindow, currentUser) {
  const buffer = await buildExcelBuffer({ title, columns, rows })
  const { canceled, filePath } = await dialog.showSaveDialog(parentWindow, {
    title: 'ذخیره خروجی اکسل',
    defaultPath: `${title}.xlsx`,
    filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }]
  })
  if (canceled || !filePath) return { success: false, canceled: true }
  fs.writeFileSync(filePath, buffer)
  auditService.recordAudit({
    user: currentUser,
    action: 'EXPORT',
    entityType: 'Export',
    entityId: null,
    changes: { format: 'excel', title, rowCount: rows.length }
  })
  return { success: true, path: filePath }
}

async function exportToPdf({ title, columns, rows }, parentWindow, currentUser) {
  const buffer = await buildPdfBuffer({ title, columns, rows })
  const { canceled, filePath } = await dialog.showSaveDialog(parentWindow, {
    title: 'ذخیره خروجی PDF',
    defaultPath: `${title}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (canceled || !filePath) return { success: false, canceled: true }
  fs.writeFileSync(filePath, buffer)
  auditService.recordAudit({
    user: currentUser,
    action: 'EXPORT',
    entityType: 'Export',
    entityId: null,
    changes: { format: 'pdf', title, rowCount: rows.length }
  })
  return { success: true, path: filePath }
}

export const exportService = { exportToExcel, exportToPdf, printLabels }
