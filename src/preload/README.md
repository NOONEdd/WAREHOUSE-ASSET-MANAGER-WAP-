The only bridge between the renderer and the main process. Exposes a narrow
`window.api.*` surface via `contextBridge`; the renderer can never reach Node.js or the file
system directly (Phase 2 Section 1).
