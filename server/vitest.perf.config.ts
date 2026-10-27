import { defineConfig } from 'vitest/config'

// Performance measurement (`npm run test:perf`), kept out of `npm test`:
// it seeds a realistic synthetic volume, so it takes about a minute and its
// timings depend on the machine. Same throwaway-cluster harness and safety
// guarantees as the integration tests.
export default defineConfig({
  test: {
    name: 'perf',
    environment: 'node',
    include: ['tests/perf/**/*.perf.test.ts'],
    globalSetup: ['tests/support/globalSetup.ts'],
    setupFiles: ['tests/support/scrubEnv.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000
  }
})
