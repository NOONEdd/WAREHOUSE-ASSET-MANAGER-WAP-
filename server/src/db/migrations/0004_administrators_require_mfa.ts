import { sql, type Kysely } from 'kysely'

// Decision O-12: enrol first, then appoint. Invariant, held by the database
// for every code path and every role:
//
//   a user who is not the owner and holds any system (administrator)
//   profile has an enrolled authenticator.
//
// Checked at commit (constraint triggers, DEFERRABLE INITIALLY DEFERRED), so
// replacing an authenticator — delete and insert in one transaction — stays
// possible. The check first locks the user's row, the lock the server's
// appointment and removal paths also take, so concurrent transactions cannot
// both pass it. The owner is exempt: the owner always needs MFA at sign-in
// and is recovered only by the owner CLI (identity-and-access §1, §3.2.5).
//
// The migration refuses a database that already breaks the invariant, rather
// than silently accepting it.

const UP: readonly string[] = [
  `DO $$
  DECLARE violations integer;
  BEGIN
    SELECT count(DISTINCT usp.user_id) INTO violations
      FROM wam.user_system_profiles usp
      JOIN wam.users u ON u.id = usp.user_id
     WHERE NOT u.is_owner
       AND NOT EXISTS (SELECT 1 FROM wam.user_mfa m WHERE m.user_id = usp.user_id);
    IF violations > 0 THEN
      RAISE EXCEPTION '% administrator account(s) have no enrolled authenticator; remove their administrator profiles (or have them enrol) before this migration', violations
        USING ERRCODE = 'check_violation';
    END IF;
  END $$`,

  `CREATE FUNCTION wam.check_administrator_has_mfa() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $$
  DECLARE
    target integer := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
    owner boolean;
  BEGIN
    -- Serializes with concurrent appointments and removals for this user.
    SELECT u.is_owner INTO owner FROM wam.users u WHERE u.id = target FOR UPDATE;
    IF owner IS DISTINCT FROM true
       AND EXISTS (SELECT 1 FROM wam.user_system_profiles usp WHERE usp.user_id = target)
       AND NOT EXISTS (SELECT 1 FROM wam.user_mfa m WHERE m.user_id = target) THEN
      RAISE EXCEPTION 'administrator profiles require an enrolled authenticator (decision O-12)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END $$`,

  `CREATE CONSTRAINT TRIGGER user_system_profiles_require_mfa
    AFTER INSERT OR UPDATE ON wam.user_system_profiles
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION wam.check_administrator_has_mfa()`,
  `CREATE CONSTRAINT TRIGGER user_mfa_kept_by_administrators
    AFTER DELETE OR UPDATE ON wam.user_mfa
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION wam.check_administrator_has_mfa()`
]

const DOWN: readonly string[] = [
  'DROP TRIGGER user_mfa_kept_by_administrators ON wam.user_mfa',
  'DROP TRIGGER user_system_profiles_require_mfa ON wam.user_system_profiles',
  'DROP FUNCTION wam.check_administrator_has_mfa()'
]

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of UP) await sql.raw(statement).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const statement of DOWN) await sql.raw(statement).execute(db)
}
