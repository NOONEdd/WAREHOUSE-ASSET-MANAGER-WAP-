import { sql, type Kysely } from 'kysely'

// Phase 1B-2c: multi-factor authentication (decision O-07).
// Specification: docs/security/identity-and-access.md §3.2. Invariants held
// by the schema:
//
//   - the security policy is a single row whose MFA setting can only be
//     `privileged` (the minimum: owner and administrators) or `all_users` —
//     no value makes MFA optional for privileged accounts;
//   - authenticator secrets are stored only sealed (AES-256-GCM, fixed
//     length) with the fingerprint of the key that sealed them;
//   - recovery codes, second-step tokens are stored only as SHA-256;
//   - wam_app can advance the single-use counter and the failure counter of
//     an enrolment but cannot rewrite its secret (delete and enrol again).

const UP: readonly string[] = [
  `CREATE TABLE wam.security_policy (
    id boolean PRIMARY KEY DEFAULT true,
    mfa_required_for text NOT NULL DEFAULT 'privileged',
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by integer REFERENCES wam.users (id),
    version integer NOT NULL DEFAULT 1,
    CONSTRAINT security_policy_single_row CHECK (id),
    CONSTRAINT security_policy_mfa_required_for CHECK (mfa_required_for IN ('privileged', 'all_users'))
  )`,
  `INSERT INTO wam.security_policy DEFAULT VALUES`,

  String.raw`CREATE TABLE wam.user_mfa (
    user_id integer PRIMARY KEY REFERENCES wam.users (id),
    totp_secret bytea NOT NULL,
    totp_key_id text NOT NULL,
    totp_last_step bigint NOT NULL DEFAULT 0,
    failed_attempts integer NOT NULL DEFAULT 0,
    enrolled_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_mfa_secret_length CHECK (octet_length(totp_secret) = 48),
    CONSTRAINT user_mfa_key_id_format CHECK (totp_key_id ~ '^[0-9a-f]{16}$'),
    CONSTRAINT user_mfa_last_step CHECK (totp_last_step >= 0),
    CONSTRAINT user_mfa_failed_attempts CHECK (failed_attempts >= 0)
  )`,

  `CREATE TABLE wam.mfa_recovery_codes (
    user_id integer NOT NULL REFERENCES wam.user_mfa (user_id) ON DELETE CASCADE,
    code_hash bytea NOT NULL,
    used_at timestamptz,
    PRIMARY KEY (user_id, code_hash),
    CONSTRAINT mfa_recovery_codes_hash_length CHECK (octet_length(code_hash) = 32)
  )`,

  String.raw`CREATE TABLE wam.mfa_enrollments (
    user_id integer PRIMARY KEY REFERENCES wam.users (id),
    totp_secret bytea NOT NULL,
    totp_key_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT mfa_enrollments_secret_length CHECK (octet_length(totp_secret) = 48),
    CONSTRAINT mfa_enrollments_key_id_format CHECK (totp_key_id ~ '^[0-9a-f]{16}$'),
    CONSTRAINT mfa_enrollments_expiry CHECK (expires_at > created_at)
  )`,

  `CREATE TABLE wam.login_challenges (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash bytea NOT NULL,
    user_id integer NOT NULL REFERENCES wam.users (id),
    purpose text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT login_challenges_token_hash_key UNIQUE (token_hash),
    CONSTRAINT login_challenges_token_hash_length CHECK (octet_length(token_hash) = 32),
    CONSTRAINT login_challenges_purpose CHECK (purpose IN ('verify', 'enroll')),
    CONSTRAINT login_challenges_expiry CHECK (expires_at > created_at)
  )`,
  `CREATE INDEX login_challenges_user_id_idx ON wam.login_challenges (user_id)`,

  // Whether the session was established with a second factor.
  `ALTER TABLE wam.sessions ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false`,

  `GRANT SELECT ON wam.security_policy TO wam_app`,
  `GRANT UPDATE (mfa_required_for, updated_at, updated_by, version) ON wam.security_policy TO wam_app`,
  `GRANT SELECT, INSERT, DELETE ON wam.user_mfa TO wam_app`,
  `GRANT UPDATE (totp_last_step, failed_attempts) ON wam.user_mfa TO wam_app`,
  `GRANT SELECT, INSERT, DELETE ON wam.mfa_recovery_codes TO wam_app`,
  `GRANT UPDATE (used_at) ON wam.mfa_recovery_codes TO wam_app`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON wam.mfa_enrollments TO wam_app`,
  `GRANT SELECT, INSERT, DELETE ON wam.login_challenges TO wam_app`,
  `GRANT UPDATE (mfa_verified) ON wam.sessions TO wam_app`
]

const DOWN: readonly string[] = [
  'ALTER TABLE wam.sessions DROP COLUMN mfa_verified',
  'DROP TABLE wam.login_challenges',
  'DROP TABLE wam.mfa_enrollments',
  'DROP TABLE wam.mfa_recovery_codes',
  'DROP TABLE wam.user_mfa',
  'DROP TABLE wam.security_policy'
]

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of UP) await sql.raw(statement).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const statement of DOWN) await sql.raw(statement).execute(db)
}
