import { defineConfig } from 'vitest/config'

// Deliberately separate from the repository-root vitest.config.mjs (which only
// runs the desktop app's tests/**/*.test.js). Nothing under server/ is picked
// up by the root `npm test`, and nothing under the root tests/ runs here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
