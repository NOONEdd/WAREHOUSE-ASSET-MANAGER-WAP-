import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: 'src/renderer',
    // Electron loads the built index.html via file://, so asset URLs must be
    // relative — an absolute "/fonts/..." would resolve to the filesystem
    // root instead of the app's own output folder.
    base: './',
    // Fonts live in /resources at the project root (Phase 5's designated home
    // for static files), not duplicated into src/renderer — this tells Vite
    // to treat that folder as static assets copied into the output root.
    publicDir: resolve(__dirname, 'resources'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    plugins: [react()]
  }
})
