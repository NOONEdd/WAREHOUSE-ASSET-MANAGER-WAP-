# Asset & Warehouse Management System

Offline desktop app (Electron + React + SQLite) for tracking 5,000+ serialized company assets.
Persian (Farsi) interface, RTL, Jalali calendar. See Phase 1-4 documents for requirements,
architecture, database schema, and wireframes.

## Structure

- `src/main/` - Electron main process: database, repositories, services, IPC handlers (the "backend")
- `src/preload/` - contextBridge script exposing a safe `window.api.*` surface to the renderer
- `src/renderer/` - the React UI (the "frontend")
- `resources/` - static files bundled with the app: fonts, icons
- `tests/` - automated tests (populated in Phase 16)
- `build/` - packaging assets for electron-builder (installer icon, etc.)

This structure is created in Phase 5. No dependencies are installed and no `package.json` exists
yet on purpose - Electron itself gets wired up in Phase 6.
