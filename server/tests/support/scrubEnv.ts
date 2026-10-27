// node-postgres reads libpq-style variables (PGHOST, PGUSER, PGPASSWORD,
// PGSSLMODE, …) as defaults, and the server reads WAM_* variables. A
// developer's shell may have either pointing at a real database; tests must
// never inherit them. Tests pass configuration explicitly instead.
// Used as a vitest setupFile (every worker) and by globalSetup.
export function scrubDatabaseEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('PG') || (key.startsWith('WAM_') && key !== 'WAM_TEST_PG_BINDIR')) {
      Reflect.deleteProperty(env, key)
    }
  }
}

scrubDatabaseEnv()
