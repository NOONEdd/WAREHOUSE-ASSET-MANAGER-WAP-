import { sql, type Kysely } from 'kysely'

// Phase 1B-1 baseline. Creates no application tables; it only establishes
// the privilege layout every later migration builds on:
//
//   - Schema `wam` is created by the migrator itself (for its bookkeeping
//     tables) and is owned by the role running migrations, wam_owner.
//   - Nobody but that owner may create objects in it.
//   - The runtime role wam_app may resolve names in it (USAGE) and read the
//     migration history, so the server can refuse to start against a
//     database whose schema does not match its code (src/db/safety.ts).
//
// There are deliberately no ALTER DEFAULT PRIVILEGES: a table added by a
// later migration is invisible to wam_app until that migration grants
// exactly the privileges it needs (for example, no UPDATE/DELETE on audit
// tables).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`REVOKE ALL ON SCHEMA wam FROM PUBLIC`.execute(db)
  await sql`GRANT USAGE ON SCHEMA wam TO wam_app`.execute(db)
  await sql`GRANT SELECT ON wam.kysely_migration TO wam_app`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`REVOKE SELECT ON wam.kysely_migration FROM wam_app`.execute(db)
  await sql`REVOKE USAGE ON SCHEMA wam FROM wam_app`.execute(db)
}
