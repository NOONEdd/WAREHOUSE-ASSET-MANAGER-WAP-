import { defineConfig } from 'vitest/config'

// Deliberately separate from the repository-root vitest.config.mjs (which only
// runs the desktop app's tests/**/*.test.js). Nothing under server/ is picked
// up by the root `npm test`, and nothing under the root tests/ runs here.
//
// Two projects:
//   unit         no database; runs anywhere Node 24 runs
//   integration  starts one throwaway PostgreSQL cluster for the run
//                (tests/support/ephemeralPostgres.ts); needs PostgreSQL's
//                server programs and a non-root user
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/harness.test.ts', 'tests/unit/**/*.test.ts'],
          setupFiles: ['tests/support/scrubEnv.ts']
        }
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/support/globalSetup.ts'],
          setupFiles: ['tests/support/scrubEnv.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000
        }
      }
    ]
  }
})
