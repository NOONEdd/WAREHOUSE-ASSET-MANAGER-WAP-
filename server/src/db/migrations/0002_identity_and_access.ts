import { sql, type Kysely } from 'kysely'

// Phase 1B-2: identity, configurable access, sessions and the audit trail.
// Specification: docs/security/identity-and-access.md. Invariants are
// enforced here, in the schema, wherever the database can express them:
//
//   - exactly one owner at most (partial unique index), never disabled (CHECK);
//   - wam_app cannot write users.is_owner at all (column-level grants), so only
//     the owner CLI, running as wam_owner, can create or move ownership;
//   - a profile's permissions have the profile's scope, and system/warehouse
//     assignments use profiles of the right scope (composite foreign keys);
//   - audit_events is append-only: wam_app may only INSERT/SELECT, and a
//     trigger rejects UPDATE, DELETE and TRUNCATE for every role;
//   - nothing grants access implicitly: every privilege below is explicit.
//
// The permission rows are a frozen copy of the catalogue at this version;
// src/access/permissions.ts must match the database (tested).

const PERMISSIONS: readonly (readonly [code: string, scope: 'system' | 'warehouse', description: string])[] = [
  ['user.view', 'system', 'View user accounts'],
  ['user.manage', 'system', 'Create, edit, disable and reset user accounts; assign warehouse profiles'],
  ['profile.manage', 'system', 'Create, edit and delete warehouse permission profiles'],
  ['job_title.manage', 'system', 'Create and edit job titles'],
  ['warehouse.manage', 'system', 'Create, rename and deactivate warehouses'],
  ['audit.view_all', 'system', 'View the complete audit trail'],
  ['asset.view', 'warehouse', 'View assets and their history'],
  ['asset.create', 'warehouse', 'Register new assets'],
  ['asset.edit', 'warehouse', 'Edit asset details'],
  ['asset.change_status', 'warehouse', 'Change asset status'],
  ['asset.transfer', 'warehouse', 'Transfer assets out of the warehouse'],
  ['asset.retire', 'warehouse', 'Retire or dispose of assets'],
  ['asset.approve', 'warehouse', 'Approve or reject pending asset requests'],
  ['asset.import', 'warehouse', 'Import assets into the warehouse'],
  ['asset.export', 'warehouse', 'Export the warehouse’s asset data'],
  ['audit.view', 'warehouse', 'View the warehouse’s audit events']
]

const UP: readonly string[] = [
  String.raw`CREATE TABLE wam.warehouses (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL,
    name text NOT NULL,
    is_system boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1,
    CONSTRAINT warehouses_code_key UNIQUE (code),
    CONSTRAINT warehouses_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
    CONSTRAINT warehouses_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    CONSTRAINT warehouses_system_is_active CHECK (NOT is_system OR is_active)
  )`,
  // The one system warehouse: holds anything not yet mapped to a real one (D-03).
  `INSERT INTO wam.warehouses (code, name, is_system) VALUES ('UNASSIGNED', 'Unassigned', true)`,

  String.raw`CREATE TABLE wam.permissions (
    code text PRIMARY KEY,
    scope text NOT NULL,
    description text NOT NULL,
    CONSTRAINT permissions_code_scope_key UNIQUE (code, scope),
    CONSTRAINT permissions_scope CHECK (scope IN ('system', 'warehouse')),
    CONSTRAINT permissions_code_format CHECK (code ~ '^[a-z_]+\.[a-z_]+$')
  )`,

  `CREATE TABLE wam.permission_profiles (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    scope text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1,
    CONSTRAINT permission_profiles_id_scope_key UNIQUE (id, scope),
    CONSTRAINT permission_profiles_scope CHECK (scope IN ('system', 'warehouse')),
    CONSTRAINT permission_profiles_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
    CONSTRAINT permission_profiles_description_length CHECK (char_length(description) <= 500)
  )`,
  `CREATE UNIQUE INDEX permission_profiles_name_key ON wam.permission_profiles (lower(name))`,

  `CREATE TABLE wam.permission_profile_permissions (
    profile_id integer NOT NULL,
    scope text NOT NULL,
    permission text NOT NULL,
    PRIMARY KEY (profile_id, permission),
    CONSTRAINT permission_profile_permissions_profile_fk
      FOREIGN KEY (profile_id, scope) REFERENCES wam.permission_profiles (id, scope) ON DELETE CASCADE,
    CONSTRAINT permission_profile_permissions_permission_fk
      FOREIGN KEY (permission, scope) REFERENCES wam.permissions (code, scope)
  )`,

  `CREATE TABLE wam.job_titles (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1,
    CONSTRAINT job_titles_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
    CONSTRAINT job_titles_description_length CHECK (char_length(description) <= 500)
  )`,
  `CREATE UNIQUE INDEX job_titles_name_key ON wam.job_titles (lower(name))`,

  String.raw`CREATE TABLE wam.users (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username text NOT NULL,
    display_name text NOT NULL,
    job_title_id integer REFERENCES wam.job_titles (id),
    status text NOT NULL DEFAULT 'active',
    is_owner boolean NOT NULL DEFAULT false,
    password_hash text,
    password_changed_at timestamptz,
    last_login_at timestamptz,
    created_by integer REFERENCES wam.users (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1,
    CONSTRAINT users_username_key UNIQUE (username),
    CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    CONSTRAINT users_display_name_length CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
    CONSTRAINT users_status CHECK (status IN ('active', 'disabled')),
    CONSTRAINT users_owner_is_active CHECK (NOT is_owner OR status = 'active'),
    CONSTRAINT users_password_hash_format CHECK (password_hash IS NULL OR password_hash LIKE '$argon2id$%')
  )`,
  `CREATE UNIQUE INDEX users_single_owner ON wam.users (is_owner) WHERE is_owner`,
  `CREATE INDEX users_job_title_id_idx ON wam.users (job_title_id)`,

  `CREATE TABLE wam.user_system_profiles (
    user_id integer NOT NULL REFERENCES wam.users (id),
    profile_id integer NOT NULL,
    scope text NOT NULL DEFAULT 'system',
    granted_by integer REFERENCES wam.users (id),
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, profile_id),
    CONSTRAINT user_system_profiles_scope CHECK (scope = 'system'),
    CONSTRAINT user_system_profiles_profile_fk
      FOREIGN KEY (profile_id, scope) REFERENCES wam.permission_profiles (id, scope)
  )`,
  `CREATE INDEX user_system_profiles_profile_id_idx ON wam.user_system_profiles (profile_id)`,

  `CREATE TABLE wam.user_warehouse_profiles (
    user_id integer NOT NULL REFERENCES wam.users (id),
    warehouse_id integer NOT NULL REFERENCES wam.warehouses (id),
    profile_id integer NOT NULL,
    scope text NOT NULL DEFAULT 'warehouse',
    granted_by integer REFERENCES wam.users (id),
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, warehouse_id, profile_id),
    CONSTRAINT user_warehouse_profiles_scope CHECK (scope = 'warehouse'),
    CONSTRAINT user_warehouse_profiles_profile_fk
      FOREIGN KEY (profile_id, scope) REFERENCES wam.permission_profiles (id, scope)
  )`,
  `CREATE INDEX user_warehouse_profiles_profile_id_idx ON wam.user_warehouse_profiles (profile_id)`,
  `CREATE INDEX user_warehouse_profiles_warehouse_id_idx ON wam.user_warehouse_profiles (warehouse_id)`,

  `CREATE TABLE wam.sessions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash bytea NOT NULL,
    user_id integer NOT NULL REFERENCES wam.users (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_reason text,
    source_ip inet,
    user_agent text,
    CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
    CONSTRAINT sessions_token_hash_length CHECK (octet_length(token_hash) = 32),
    CONSTRAINT sessions_expiry CHECK (expires_at > created_at),
    CONSTRAINT sessions_revocation CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
    CONSTRAINT sessions_user_agent_length CHECK (char_length(user_agent) <= 300)
  )`,
  `CREATE INDEX sessions_active_user_id_idx ON wam.sessions (user_id) WHERE revoked_at IS NULL`,

  `CREATE TABLE wam.auth_failures (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL,
    username_key text NOT NULL,
    source_ip inet NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_failures_kind CHECK (kind IN ('login', 'setup')),
    CONSTRAINT auth_failures_username_key_length CHECK (char_length(username_key) <= 64)
  )`,
  `CREATE INDEX auth_failures_username_idx ON wam.auth_failures (kind, username_key, occurred_at)`,
  `CREATE INDEX auth_failures_source_ip_idx ON wam.auth_failures (kind, source_ip, occurred_at)`,

  `CREATE TABLE wam.password_setup_codes (
    user_id integer PRIMARY KEY REFERENCES wam.users (id),
    code_hash bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by integer REFERENCES wam.users (id),
    CONSTRAINT password_setup_codes_hash_length CHECK (octet_length(code_hash) = 32),
    CONSTRAINT password_setup_codes_expiry CHECK (expires_at > created_at)
  )`,

  `CREATE TABLE wam.idempotency_keys (
    user_id integer NOT NULL REFERENCES wam.users (id),
    key uuid NOT NULL,
    fingerprint bytea NOT NULL,
    status_code integer,
    response_body jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key),
    CONSTRAINT idempotency_keys_fingerprint_length CHECK (octet_length(fingerprint) = 32)
  )`,
  `CREATE INDEX idempotency_keys_created_at_idx ON wam.idempotency_keys (created_at)`,

  String.raw`CREATE TABLE wam.audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    actor_user_id integer REFERENCES wam.users (id),
    actor_username text,
    action text NOT NULL,
    outcome text NOT NULL,
    target_type text,
    target_id text,
    warehouse_id integer REFERENCES wam.warehouses (id),
    request_id uuid,
    source_ip inet,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT audit_events_action_format CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
    CONSTRAINT audit_events_outcome CHECK (outcome IN ('success', 'denied', 'failure')),
    CONSTRAINT audit_events_details_is_object CHECK (jsonb_typeof(details) = 'object')
  )`,
  `CREATE INDEX audit_events_warehouse_idx ON wam.audit_events (warehouse_id, id) WHERE warehouse_id IS NOT NULL`,
  `CREATE INDEX audit_events_actor_idx ON wam.audit_events (actor_user_id, id)`,
  `CREATE INDEX audit_events_target_idx ON wam.audit_events (target_type, target_id, id)`,
  `CREATE INDEX audit_events_action_idx ON wam.audit_events (action, id)`,
  `CREATE FUNCTION wam.reject_audit_change() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS
    'BEGIN RAISE EXCEPTION ''audit_events is append-only'' USING ERRCODE = ''insufficient_privilege''; END'`,
  `CREATE TRIGGER audit_events_reject_update_delete BEFORE UPDATE OR DELETE ON wam.audit_events
    FOR EACH ROW EXECUTE FUNCTION wam.reject_audit_change()`,
  `CREATE TRIGGER audit_events_reject_truncate BEFORE TRUNCATE ON wam.audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION wam.reject_audit_change()`,

  // Runtime privileges: exactly what the server needs, column by column where
  // it matters. Not granted to wam_app: users.is_owner (any write), any DELETE
  // on users, warehouses, job titles or audit events, and any write to the
  // permission catalogue.
  `GRANT SELECT ON wam.permissions TO wam_app`,
  `GRANT SELECT ON wam.warehouses TO wam_app`,
  `GRANT INSERT (code, name) ON wam.warehouses TO wam_app`,
  `GRANT UPDATE (name, is_active, updated_at, version) ON wam.warehouses TO wam_app`,
  `GRANT SELECT, DELETE ON wam.permission_profiles TO wam_app`,
  `GRANT INSERT (name, description, scope) ON wam.permission_profiles TO wam_app`,
  `GRANT UPDATE (name, description, is_active, updated_at, version) ON wam.permission_profiles TO wam_app`,
  `GRANT SELECT, INSERT, DELETE ON wam.permission_profile_permissions TO wam_app`,
  `GRANT SELECT ON wam.job_titles TO wam_app`,
  `GRANT INSERT (name, description) ON wam.job_titles TO wam_app`,
  `GRANT UPDATE (name, description, is_active, updated_at, version) ON wam.job_titles TO wam_app`,
  `GRANT SELECT ON wam.users TO wam_app`,
  `GRANT INSERT (username, display_name, job_title_id, created_by) ON wam.users TO wam_app`,
  `GRANT UPDATE (display_name, job_title_id, status, password_hash, password_changed_at, last_login_at, updated_at, version)
    ON wam.users TO wam_app`,
  `GRANT SELECT, INSERT, DELETE ON wam.user_system_profiles TO wam_app`,
  `GRANT SELECT, INSERT, DELETE ON wam.user_warehouse_profiles TO wam_app`,
  `GRANT SELECT, INSERT, DELETE ON wam.sessions TO wam_app`,
  `GRANT UPDATE (last_seen_at, revoked_at, revoked_reason) ON wam.sessions TO wam_app`,
  `GRANT SELECT, INSERT, DELETE ON wam.auth_failures TO wam_app`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON wam.password_setup_codes TO wam_app`,
  `GRANT SELECT, INSERT, DELETE ON wam.idempotency_keys TO wam_app`,
  `GRANT UPDATE (status_code, response_body) ON wam.idempotency_keys TO wam_app`,
  `GRANT SELECT, INSERT ON wam.audit_events TO wam_app`
]

const DOWN: readonly string[] = [
  'DROP TABLE wam.audit_events',
  'DROP FUNCTION wam.reject_audit_change()',
  'DROP TABLE wam.idempotency_keys',
  'DROP TABLE wam.password_setup_codes',
  'DROP TABLE wam.auth_failures',
  'DROP TABLE wam.sessions',
  'DROP TABLE wam.user_warehouse_profiles',
  'DROP TABLE wam.user_system_profiles',
  'DROP TABLE wam.users',
  'DROP TABLE wam.job_titles',
  'DROP TABLE wam.permission_profile_permissions',
  'DROP TABLE wam.permission_profiles',
  'DROP TABLE wam.permissions',
  'DROP TABLE wam.warehouses'
]

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of UP) await sql.raw(statement).execute(db)
  for (const [code, scope, description] of PERMISSIONS) {
    await sql`INSERT INTO wam.permissions (code, scope, description) VALUES (${code}, ${scope}, ${description})`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const statement of DOWN) await sql.raw(statement).execute(db)
}
