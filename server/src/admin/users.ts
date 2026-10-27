import { sql, type Kysely } from 'kysely'
import { AppError } from '../appError.js'
import { recordAudit, type AuditContext } from '../audit/audit.js'
import { checkUsername } from '../auth/passwordPolicy.js'
import { revokeUserSessions } from '../auth/sessions.js'
import { issueSetupCode, SETUP_CODE_TTL_HOURS } from '../auth/setupCodes.js'
import type { Database } from '../db/connection.js'
import { isUniqueViolation } from './dbErrors.js'
import { assertMayManageSystemProfiles, assertMayManageUser, auditActor, type Actor, type ManagedUser } from './rules.js'

// User administration (docs/security/identity-and-access.md §2). Every
// change runs in the caller's transaction (`trx`) together with its audit
// record, after the escalation rules and an optimistic version check.

export interface UserListItem {
  readonly id: number
  readonly username: string
  readonly displayName: string
  readonly jobTitle: { readonly id: number; readonly name: string } | null
  readonly status: 'active' | 'disabled'
  readonly isOwner: boolean
  readonly isAdministrator: boolean
  readonly hasPassword: boolean
  readonly lastLoginAt: Date | null
  readonly createdAt: Date
  readonly version: number
}

export interface UserAccess {
  readonly systemProfiles: readonly { readonly id: number; readonly name: string }[]
  readonly warehouseAssignments: readonly {
    readonly warehouseId: number
    readonly warehouseCode: string
    readonly profileId: number
    readonly profileName: string
  }[]
}

export interface UserDetail extends UserListItem {
  readonly access: UserAccess
  readonly liveSessions: number
}

function baseUserQuery(db: Kysely<Database>) {
  return db
    .selectFrom('users as u')
    .leftJoin('job_titles as j', 'j.id', 'u.job_title_id')
    .select([
      'u.id',
      'u.username',
      'u.display_name',
      'u.status',
      'u.is_owner',
      'u.last_login_at',
      'u.created_at',
      'u.version',
      'j.id as job_title_id',
      'j.name as job_title_name',
      sql<boolean>`u.password_hash IS NOT NULL`.as('has_password'),
      sql<boolean>`EXISTS (SELECT 1 FROM wam.user_system_profiles usp WHERE usp.user_id = u.id)`.as('is_administrator')
    ])
}

type BaseRow = Awaited<ReturnType<ReturnType<typeof baseUserQuery>['executeTakeFirstOrThrow']>>

function toListItem(row: BaseRow): UserListItem {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    jobTitle: row.job_title_id === null || row.job_title_name === null ? null : { id: row.job_title_id, name: row.job_title_name },
    status: row.status,
    isOwner: row.is_owner,
    isAdministrator: row.is_administrator,
    hasPassword: row.has_password,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    version: row.version
  }
}

export async function listUsers(
  db: Kysely<Database>,
  options: { readonly search?: string | undefined; readonly after?: string | undefined; readonly limit: number }
): Promise<{ readonly users: UserListItem[]; readonly nextAfter: string | null }> {
  const search = options.search?.trim().toLowerCase()
  const rows = await baseUserQuery(db)
    .$if(search !== undefined && search !== '', (q) =>
      q.where((eb) =>
        eb.or([
          eb('u.username', 'like', `${escapeLike(search ?? '')}%`),
          eb(sql`lower(u.display_name)`, 'like', `%${escapeLike(search ?? '')}%`)
        ])
      )
    )
    .$if(options.after !== undefined, (q) => q.where('u.username', '>', options.after ?? ''))
    .orderBy('u.username')
    .limit(options.limit + 1)
    .execute()
  const page = rows.slice(0, options.limit)
  return { users: page.map(toListItem), nextAfter: rows.length > options.limit ? (page.at(-1)?.username ?? null) : null }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

async function loadAccess(db: Kysely<Database>, userId: number): Promise<UserAccess> {
  const systemProfiles = await db
    .selectFrom('user_system_profiles as usp')
    .innerJoin('permission_profiles as p', 'p.id', 'usp.profile_id')
    .select(['p.id', 'p.name'])
    .where('usp.user_id', '=', userId)
    .orderBy('p.name')
    .execute()
  const warehouseAssignments = await db
    .selectFrom('user_warehouse_profiles as uwp')
    .innerJoin('permission_profiles as p', 'p.id', 'uwp.profile_id')
    .innerJoin('warehouses as w', 'w.id', 'uwp.warehouse_id')
    .select(['w.id as warehouseId', 'w.code as warehouseCode', 'p.id as profileId', 'p.name as profileName'])
    .where('uwp.user_id', '=', userId)
    .orderBy('w.code')
    .orderBy('p.name')
    .execute()
  return { systemProfiles, warehouseAssignments }
}

export async function getUser(db: Kysely<Database>, id: number): Promise<UserDetail> {
  const row = await baseUserQuery(db).where('u.id', '=', id).executeTakeFirst()
  if (row === undefined) throw new AppError('NOT_FOUND')
  const { live } = await db
    .selectFrom('sessions')
    .select(sql<number>`count(*)::int`.as('live'))
    .where('user_id', '=', id)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .executeTakeFirstOrThrow()
  return { ...toListItem(row), access: await loadAccess(db, id), liveSessions: live }
}

/** Locks the user row for the rest of the transaction and applies the rules. */
async function lockManagedUser(trx: Kysely<Database>, actor: Actor, id: number, expectedVersion?: number): Promise<ManagedUser & { version: number; status: 'active' | 'disabled'; username: string; display_name: string; job_title_id: number | null }> {
  const row = await trx
    .selectFrom('users as u')
    .select([
      'u.id',
      'u.username',
      'u.display_name',
      'u.job_title_id',
      'u.status',
      'u.is_owner',
      'u.version',
      sql<boolean>`EXISTS (SELECT 1 FROM wam.user_system_profiles usp WHERE usp.user_id = u.id)`.as('is_administrator')
    ])
    .where('u.id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (row === undefined) throw new AppError('NOT_FOUND')
  const target = { ...row, isOwner: row.is_owner, isAdministrator: row.is_administrator }
  assertMayManageUser(actor, target)
  if (expectedVersion !== undefined && row.version !== expectedVersion) throw new AppError('VERSION_CONFLICT', { currentVersion: row.version })
  return target
}

async function assertJobTitleUsable(trx: Kysely<Database>, jobTitleId: number | null): Promise<void> {
  if (jobTitleId === null) return
  const row = await trx.selectFrom('job_titles').select('is_active').where('id', '=', jobTitleId).executeTakeFirst()
  if (row?.is_active !== true) throw new AppError('VALIDATION_FAILED', { field: 'jobTitleId', reason: 'unknown or inactive job title' })
}

export async function createUser(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  input: { readonly username: string; readonly displayName: string; readonly jobTitleId: number | null }
): Promise<UserDetail> {
  const username = input.username.trim().toLowerCase()
  const problem = checkUsername(username)
  if (problem !== null) throw new AppError('VALIDATION_FAILED', { field: 'username', reason: problem })
  await assertJobTitleUsable(trx, input.jobTitleId)
  let id: number
  try {
    const row = await trx
      .insertInto('users')
      .values({ username, display_name: input.displayName.trim(), job_title_id: input.jobTitleId, created_by: actor.userId })
      .returning('id')
      .executeTakeFirstOrThrow()
    id = row.id
  } catch (err) {
    if (isUniqueViolation(err, 'users_username_key')) throw new AppError('USERNAME_TAKEN')
    throw err
  }
  await recordAudit(trx, context, {
    action: 'user.created',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'user', id },
    details: { after: { username, displayName: input.displayName.trim(), jobTitleId: input.jobTitleId } }
  })
  return getUser(trx, id)
}

export async function updateUser(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  id: number,
  input: {
    readonly version: number
    readonly displayName?: string | undefined
    readonly jobTitleId?: number | null | undefined
    readonly status?: 'active' | 'disabled' | undefined
  }
): Promise<UserDetail> {
  const target = await lockManagedUser(trx, actor, id, input.version)
  const before = { displayName: target.display_name, jobTitleId: target.job_title_id, status: target.status }
  const after = {
    displayName: input.displayName?.trim() ?? before.displayName,
    jobTitleId: input.jobTitleId === undefined ? before.jobTitleId : input.jobTitleId,
    status: input.status ?? before.status
  }
  if (after.status === 'disabled' && target.isOwner) throw new AppError('FORBIDDEN', { reason: 'the owner account cannot be disabled' })
  if (after.jobTitleId !== before.jobTitleId) await assertJobTitleUsable(trx, after.jobTitleId)
  const changed = Object.fromEntries(
    (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== before[k]).map((k) => [k, { before: before[k], after: after[k] }])
  )
  // Nothing to change: no new version (which would make a colleague's pending edit conflict) and no audit noise.
  if (Object.keys(changed).length === 0) return getUser(trx, id)

  await trx
    .updateTable('users')
    .set({
      display_name: after.displayName,
      job_title_id: after.jobTitleId,
      status: after.status,
      updated_at: sql<Date>`now()`,
      version: sql<number>`version + 1`
    })
    .where('id', '=', id)
    .execute()
  // ASVS V7.4.2: disabling ends every session at once.
  const sessionsEnded = after.status === 'disabled' && before.status === 'active' ? await revokeUserSessions(trx, id, 'user_disabled') : 0
  const action =
    before.status !== after.status ? (after.status === 'disabled' ? 'user.disabled' : 'user.enabled') : 'user.updated'
  await recordAudit(trx, context, {
    action,
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'user', id },
    details: { changed, ...(sessionsEnded > 0 ? { sessionsEnded } : {}) }
  })
  return getUser(trx, id)
}

/** A reset: clears the password, ends all sessions, and returns a new one-time code (shown once). */
export async function issueUserSetupCode(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  id: number
): Promise<{ readonly setupCode: string; readonly expiresInHours: number }> {
  const target = await lockManagedUser(trx, actor, id)
  if (target.status !== 'active') throw new AppError('VALIDATION_FAILED', { reason: 'enable the account first' })
  await trx.updateTable('users').set({ password_hash: null, updated_at: sql<Date>`now()` }).where('id', '=', id).execute()
  const sessionsEnded = await revokeUserSessions(trx, id, 'setup_code_issued')
  const setupCode = await issueSetupCode(trx, id, actor.userId)
  await recordAudit(trx, context, {
    action: 'user.setup_code_issued',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'user', id },
    details: { sessionsEnded, expiresInHours: SETUP_CODE_TTL_HOURS }
  })
  return { setupCode, expiresInHours: SETUP_CODE_TTL_HOURS }
}

export async function endUserSessions(trx: Kysely<Database>, context: AuditContext, actor: Actor, id: number): Promise<number> {
  await lockManagedUser(trx, actor, id)
  const ended = await revokeUserSessions(trx, id, 'admin_revoked')
  await recordAudit(trx, context, {
    action: 'session.ended_by_admin',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'user', id },
    details: { ended }
  })
  return ended
}

export interface AccessInput {
  readonly version: number
  readonly systemProfileIds: readonly number[]
  readonly warehouseAssignments: readonly { readonly warehouseId: number; readonly profileId: number }[]
}

/**
 * Replaces a user's whole access set. System profiles (administrator
 * rights) may be changed only by the owner (A1); warehouse profiles by
 * holders of user.manage, within A2–A4. One audit event per affected
 * warehouse (so warehouse auditors see changes in their warehouse) and
 * one for system profiles.
 */
export async function setUserAccess(trx: Kysely<Database>, context: AuditContext, actor: Actor, id: number, input: AccessInput): Promise<UserDetail> {
  const target = await lockManagedUser(trx, actor, id, input.version)
  if (target.isOwner) throw new AppError('VALIDATION_FAILED', { reason: 'the owner has every permission; assignments do not apply' })

  const wantedSystem = [...new Set(input.systemProfileIds)].sort((a, b) => a - b)
  const wantedWarehouse = [...new Map(input.warehouseAssignments.map((a) => [`${String(a.warehouseId)}:${String(a.profileId)}`, a])).values()]

  const currentSystem = (await trx.selectFrom('user_system_profiles').select('profile_id').where('user_id', '=', id).execute())
    .map((r) => r.profile_id)
    .sort((a, b) => a - b)
  const currentWarehouse = await trx.selectFrom('user_warehouse_profiles').select(['warehouse_id', 'profile_id']).where('user_id', '=', id).execute()

  const systemChanged = currentSystem.join(',') !== wantedSystem.join(',')
  if (systemChanged) assertMayManageSystemProfiles(actor)

  // A6: only existing, active profiles of the right scope, in existing warehouses.
  const profileIds = [...new Set([...wantedSystem, ...wantedWarehouse.map((a) => a.profileId)])]
  const profiles =
    profileIds.length === 0
      ? []
      : await trx.selectFrom('permission_profiles').select(['id', 'scope', 'is_active']).where('id', 'in', profileIds).execute()
  const profileById = new Map(profiles.map((p) => [p.id, p]))
  for (const pid of wantedSystem) {
    const p = profileById.get(pid)
    if (p?.scope !== 'system' || !p.is_active) throw new AppError('VALIDATION_FAILED', { field: 'systemProfileIds', profileId: pid })
  }
  for (const a of wantedWarehouse) {
    const p = profileById.get(a.profileId)
    if (p?.scope !== 'warehouse' || !p.is_active) throw new AppError('VALIDATION_FAILED', { field: 'warehouseAssignments', profileId: a.profileId })
  }
  const warehouseIds = [...new Set(wantedWarehouse.map((a) => a.warehouseId))]
  const existingWarehouses =
    warehouseIds.length === 0 ? [] : await trx.selectFrom('warehouses').select('id').where('id', 'in', warehouseIds).execute()
  if (existingWarehouses.length !== warehouseIds.length) throw new AppError('VALIDATION_FAILED', { field: 'warehouseAssignments', reason: 'unknown warehouse' })

  // Replace.
  if (systemChanged) {
    await trx.deleteFrom('user_system_profiles').where('user_id', '=', id).execute()
    if (wantedSystem.length > 0) {
      await trx
        .insertInto('user_system_profiles')
        .values(wantedSystem.map((profile_id) => ({ user_id: id, profile_id, granted_by: actor.userId })))
        .execute()
    }
    await recordAudit(trx, context, {
      action: 'user.access_changed',
      outcome: 'success',
      actor: auditActor(actor),
      target: { type: 'user', id },
      details: { scope: 'system', before: currentSystem, after: wantedSystem }
    })
  }

  const key = (w: number, p: number) => `${String(w)}:${String(p)}`
  const currentKeys = new Set(currentWarehouse.map((a) => key(a.warehouse_id, a.profile_id)))
  const wantedKeys = new Set(wantedWarehouse.map((a) => key(a.warehouseId, a.profileId)))
  const affected = new Set<number>()
  for (const a of currentWarehouse) if (!wantedKeys.has(key(a.warehouse_id, a.profile_id))) affected.add(a.warehouse_id)
  for (const a of wantedWarehouse) if (!currentKeys.has(key(a.warehouseId, a.profileId))) affected.add(a.warehouseId)

  if (affected.size > 0) {
    await trx.deleteFrom('user_warehouse_profiles').where('user_id', '=', id).execute()
    if (wantedWarehouse.length > 0) {
      await trx
        .insertInto('user_warehouse_profiles')
        .values(wantedWarehouse.map((a) => ({ user_id: id, warehouse_id: a.warehouseId, profile_id: a.profileId, granted_by: actor.userId })))
        .execute()
    }
    for (const warehouseId of [...affected].sort((a, b) => a - b)) {
      const profilesIn = (list: readonly { warehouse: number; profile: number }[]) =>
        list.filter((a) => a.warehouse === warehouseId).map((a) => a.profile).sort((a, b) => a - b)
      await recordAudit(trx, context, {
        action: 'user.access_changed',
        outcome: 'success',
        actor: auditActor(actor),
        target: { type: 'user', id },
        warehouseId,
        details: {
          scope: 'warehouse',
          before: profilesIn(currentWarehouse.map((a) => ({ warehouse: a.warehouse_id, profile: a.profile_id }))),
          after: profilesIn(wantedWarehouse.map((a) => ({ warehouse: a.warehouseId, profile: a.profileId })))
        }
      })
    }
  }

  if (systemChanged || affected.size > 0) {
    await trx.updateTable('users').set({ version: sql<number>`version + 1`, updated_at: sql<Date>`now()` }).where('id', '=', id).execute()
  }
  return getUser(trx, id)
}
