import { app, ipcMain } from 'electron'

// Versioning phase — app.getVersion() is Electron's own API for this and
// reads straight from package.json's "version" field (both in dev and in
// a packaged build, where electron-builder also copies package.json in
// alongside the app for exactly this reason — see electron-builder.yml's
// `files` list). No separate version constant is introduced anywhere:
// this handler is the single place package.json's version reaches the
// renderer.
//
// Deliberately NOT behind requireUser(): the version number isn't
// sensitive company data (unlike everything else in ipc/), and gating it
// behind login would block showing it on the login/first-run screens
// too. This doesn't weaken the existing security model — it's a new,
// intentionally public read, the same category as auth:currentUser or
// auth:needsFirstRunSetup already are.
export function registerAppHandlers() {
  ipcMain.handle('app:getVersion', () => app.getVersion())
}
