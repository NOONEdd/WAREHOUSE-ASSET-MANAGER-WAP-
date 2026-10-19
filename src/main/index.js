import { app, BrowserWindow, dialog, Menu } from 'electron'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { getDatabase, closeDatabase } from './database/connection'
import { authService } from './services/authService'
import { guardDevTools } from './utils/devToolsGuard'
import { registerAuthHandlers } from './ipc/auth.ipc'
import { registerAssetHandlers } from './ipc/assets.ipc'
import { registerLookupHandlers } from './ipc/lookup.ipc'
import { registerAuditLogHandlers } from './ipc/auditLog.ipc'
import { registerTransactionHandlers } from './ipc/transactions.ipc'
import { registerExportHandlers } from './ipc/export.ipc'
import { registerBackupHandlers } from './ipc/backup.ipc'
import { registerImportHandlers } from './ipc/import.ipc'
import { registerSavedFilterHandlers } from './ipc/savedFilters.ipc'
import { registerAppHandlers } from './ipc/app.ipc'

let mainWindow = null

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security model from Phase 2, Section 1 — the renderer never gets
      // direct Node.js or filesystem access. Everything goes through the
      // preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Avoid a white flash on launch — show only once content is ready.
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // Security Hardening phase — see devToolsGuard.js. No-op in
  // development; closes DevTools immediately if opened in a packaged
  // build, however it was triggered.
  guardDevTools(mainWindow.webContents)

  // Security Hardening phase — this app never opens links in a new
  // window or navigates away from its own bundled UI, so there's no
  // legitimate case for either to succeed. Deny-by-default costs nothing
  // today and closes off the possibility outright rather than relying on
  // "nothing currently tries to."
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isCurrentRendererUrl =
      (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) ||
      url.startsWith('file://')
    if (!isCurrentRendererUrl) {
      event.preventDefault()
    }
  })

  // electron-vite sets ELECTRON_RENDERER_URL automatically in dev mode,
  // pointing at the Vite dev server. In a production build it's undefined,
  // so we load the built HTML file instead.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Technical diagnostics (crashes, failed queries) — separate from the
 * Audit Log, which is user-attributed business events, not error traces
 * (Phase 2, Section 13).
 */
function logFatalError(err) {
  try {
    const logPath = join(app.getPath('userData'), 'error.log')
    appendFileSync(logPath, `[${new Date().toISOString()}] ${err.stack || err}\n`)
  } catch {
    // If we can't even write the log, there's nothing further to do —
    // the dialog below is still shown regardless.
  }
}

app.whenReady().then(() => {
  // Phase 10 — this is a single-purpose internal tool, not a document
  // editor: Electron's default File/Edit/View/Window menu (shown
  // whenever no application menu is explicitly set) doesn't map to
  // anything the app actually does, and sitting above the app's own
  // Persian RTL header, it broke the "premium desktop app" impression
  // this phase was about. No custom menu replaces it — the app has no
  // use for one; every action already lives in the sidebar/toolbars.
  Menu.setApplicationMenu(null)

  let initFailed = false
  try {
    // Opens (and on first run, creates + schemas) the database before
    // anything else can touch it.
    getDatabase()

    // First-Run Security phase — no password is generated to show here
    // anymore (see authService.bootstrapAdminIfNeeded). The renderer's
    // own routing (App.jsx, via auth:needsFirstRunSetup) is what
    // presents the mandatory setup screen; nothing sensitive is ever
    // written to this console log.
    const freshAdmin = authService.bootstrapAdminIfNeeded()
    if (freshAdmin) {
      console.log('First run: Administrator account created — password setup required on launch.')
    }

    registerAuthHandlers()
    registerAssetHandlers()
    registerLookupHandlers()
    registerAuditLogHandlers()
    registerTransactionHandlers()
    registerExportHandlers()
    registerBackupHandlers()
    registerImportHandlers()
    registerSavedFilterHandlers()
    registerAppHandlers()
  } catch (err) {
    initFailed = true
    logFatalError(err)
    dialog.showErrorBox(
      'خطا در راه‌اندازی پایگاه داده',
      'سامانه نتوانست به پایگاه داده متصل شود. جزئیات خطا در فایل گزارش ذخیره شد.'
    )
  }

  // Production-readiness audit finding (CRITICAL): this used to fall
  // through to createMainWindow() unconditionally even after a failed
  // init above — the window would open normally with zero IPC handlers
  // registered, so the app *looked* fine and every single action inside
  // it silently did nothing. Quitting after the error dialog is shown is
  // the only sane outcome here: there is no usable state to open a
  // window into without a database.
  if (initFailed) {
    app.quit()
    return
  }

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  closeDatabase()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
