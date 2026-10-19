import { app } from 'electron'

/**
 * Security Hardening phase — DevTools must not be reachable in the
 * packaged application (audit finding: HIGH — combined with several
 * IPC channels previously having no auth check, DevTools access let
 * company data be read without ever logging in).
 *
 * Deliberately mechanism-agnostic rather than blocking specific
 * keyboard shortcuts (F12, Ctrl+Shift+I, ...): Electron fires
 * 'devtools-opened' on the webContents no matter HOW DevTools was
 * triggered, so listening for that one event and immediately closing it
 * back up covers every current and future opening mechanism in one
 * place, instead of trying to enumerate and keep in sync with every
 * possible shortcut across platforms. The app's own menu is already
 * removed entirely (see index.js's Menu.setApplicationMenu(null)), which
 * independently closes the menu-based route on top of this.
 *
 * app.isPackaged is Electron's own built-in distinction between a real
 * packaged build and `electron .`/`electron-vite dev` — used instead of
 * NODE_ENV, which electron-vite doesn't reliably set the same way in
 * every run mode. In development this function still attaches the
 * listener but it's a no-op every time, so F12/Ctrl+Shift+I keep working
 * exactly as before with zero behavior change for developers.
 */
export function guardDevTools(webContents) {
  webContents.on('devtools-opened', () => {
    if (app.isPackaged) {
      webContents.closeDevTools()
    }
  })
}
