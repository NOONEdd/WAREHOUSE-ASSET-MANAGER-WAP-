import type { TestProject } from 'vitest/node'
import { startEphemeralCluster, type ClusterInfo } from './ephemeralPostgres.js'
import { scrubDatabaseEnv } from './scrubEnv.js'

declare module 'vitest' {
  export interface ProvidedContext {
    wamPostgres: ClusterInfo
  }
}

/** One throwaway cluster for the whole integration run; each test file creates its own database in it. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  scrubDatabaseEnv()
  const { stop, ...info } = await startEphemeralCluster()
  project.provide('wamPostgres', info)
  return stop
}
