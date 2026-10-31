import { sql, type Kysely } from 'kysely'
import { permissionsOfScope, type PermissionScope } from '../access/permissions.js'
import { AppError } from '../appError.js'
import { requiredName } from './names.js'
import { recordAudit, type AuditContext } from '../audit/audit.js'
import type { Database } from '../db/connection.js'
import { isForeignKeyViolation, isUniqueViolation } from './dbErrors.js'
import { assertMayManageSystemProfiles, auditActor, type Actor } from './rules.js'

// Permission profiles (owner-configurable sets of permissions) and job titles
// (descriptive labels that grant nothing). docs/security/identity-and-access.md §2.

export interface Profile {
  readonly id: number
  readonly name: string
  readonly description: string
  readonly scope: PermissionScope
  readonly isActive: boolean
  readonly permissions: readonly string[]
  readonly assignedUsers: number
  readonly version: number
}

export async function listProfiles(db: Kysely<Database>, scope?: PermissionScope): Promise<Profile[]> {
  const rows = await db
    .selectFrom('permission_profiles as p')
    .select([
      'p.id',
      'p.name',
      'p.description',
      'p.scope',
      'p.is_active',
      'p.version',
      sql<string[]>`COALESCE((SELECT array_agg(ppp.permission ORDER BY ppp.permission) FROM wam.permission_profile_permissions ppp
                              WHERE ppp.profile_id = p.id), '{}')`.as('permissions'),
      sql<number>`((SELECT count(DISTINCT uwp.user_id) FROM wam.user_warehouse_profiles uwp WHERE uwp.profile_id = p.id)
                 + (SELECT count(*) FROM wam.user_system_profiles usp WHERE usp.profile_id = p.id))::int`.as('assigned_users')
    ])
    .$if(scope !== undefined, (q) => q.where('p.scope', '=', scope ?? 'warehouse'))
    .orderBy('p.scope')
    .orderBy('p.name')
    .execute()
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    scope: r.scope,
    isActive: r.is_active,
    permissions: r.permissions,
    assignedUsers: r.assigned_users,
    version: r.version
  }))
}

async function getProfile(db: Kysely<Database>, id: number): Promise<Profile> {
  const profile = (await listProfiles(db)).find((p) => p.id === id)
  if (profile === undefined) throw new AppError('NOT_FOUND')
  return profile
}

function validatePermissions(scope: PermissionScope, permissions: readonly string[]): string[] {
  const allowed = new Set<string>(permissionsOfScope(scope))
  const unique = [...new Set(permissions)].sort()
  const invalid = unique.filter((p) => !allowed.has(p))
  if (invalid.length > 0) throw new AppError('VALIDATION_FAILED', { field: 'permissions', invalid, scope })
  return unique
}

/** A5: a non-owner may not change a profile they themselves hold. */
async function assertNotHeldByActor(trx: Kysely<Database>, actor: Actor, profileId: number): Promise<void> {
  if (actor.access.isOwner) return
  const held = await trx
    .selectFrom('user_warehouse_profiles')
    .select('profile_id')
    .where('profile_id', '=', profileId)
    .where('user_id', '=', actor.userId)
    .union(
      trx.selectFrom('user_system_profiles').select('profile_id').where('profile_id', '=', profileId).where('user_id', '=', actor.userId)
    )
    .executeTakeFirst()
  if (held !== undefined) throw new AppError('FORBIDDEN', { rule: 'A5', reason: 'you cannot change a profile assigned to yourself' })
}

export async function createProfile(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  input: { readonly name: string; readonly description: string; readonly scope: PermissionScope; readonly permissions: readonly string[] }
): Promise<Profile> {
  const name = requiredName(input.name, 'name')
  if (input.scope === 'system') assertMayManageSystemProfiles(actor)
  const permissions = validatePermissions(input.scope, input.permissions)
  let id: number
  try {
    const row = await trx
      .insertInto('permission_profiles')
      .values({ name, description: input.description.trim(), scope: input.scope })
      .returning('id')
      .executeTakeFirstOrThrow()
    id = row.id
  } catch (err) {
    if (isUniqueViolation(err, 'permission_profiles_name_key')) throw new AppError('NAME_TAKEN')
    throw err
  }
  if (permissions.length > 0) {
    await trx
      .insertInto('permission_profile_permissions')
      .values(permissions.map((permission) => ({ profile_id: id, scope: input.scope, permission })))
      .execute()
  }
  await recordAudit(trx, context, {
    action: 'profile.created',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'profile', id },
    details: { after: { name, scope: input.scope, permissions } }
  })
  return getProfile(trx, id)
}

export async function updateProfile(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  id: number,
  input: {
    readonly version: number
    readonly name?: string | undefined
    readonly description?: string | undefined
    readonly isActive?: boolean | undefined
    readonly permissions?: readonly string[] | undefined
  }
): Promise<Profile> {
  const current = await trx
    .selectFrom('permission_profiles')
    .select(['id', 'name', 'description', 'scope', 'is_active', 'version'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (current === undefined) throw new AppError('NOT_FOUND')
  if (current.scope === 'system') assertMayManageSystemProfiles(actor)
  await assertNotHeldByActor(trx, actor, id)
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT', { currentVersion: current.version })

  const beforePermissions = (await getProfile(trx, id)).permissions
  const afterPermissions = input.permissions === undefined ? [...beforePermissions] : validatePermissions(current.scope, input.permissions)
  const before = { name: current.name, description: current.description, isActive: current.is_active }
  const after = {
    name: input.name === undefined ? before.name : requiredName(input.name, 'name'),
    description: input.description?.trim() ?? before.description,
    isActive: input.isActive ?? before.isActive
  }
  const added = afterPermissions.filter((p) => !beforePermissions.includes(p))
  const removed = beforePermissions.filter((p) => !afterPermissions.includes(p))
  const changed = Object.fromEntries(
    (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== before[k]).map((k) => [k, { before: before[k], after: after[k] }])
  )
  if (Object.keys(changed).length === 0 && added.length === 0 && removed.length === 0) return getProfile(trx, id)

  try {
    await trx
      .updateTable('permission_profiles')
      .set({ name: after.name, description: after.description, is_active: after.isActive, updated_at: sql<Date>`now()`, version: sql<number>`version + 1` })
      .where('id', '=', id)
      .execute()
  } catch (err) {
    if (isUniqueViolation(err, 'permission_profiles_name_key')) throw new AppError('NAME_TAKEN')
    throw err
  }
  if (removed.length > 0) {
    await trx.deleteFrom('permission_profile_permissions').where('profile_id', '=', id).where('permission', 'in', removed).execute()
  }
  if (added.length > 0) {
    await trx
      .insertInto('permission_profile_permissions')
      .values(added.map((permission) => ({ profile_id: id, scope: current.scope, permission })))
      .execute()
  }
  await recordAudit(trx, context, {
    action: 'profile.updated',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'profile', id },
    details: { changed, permissionsAdded: added, permissionsRemoved: removed }
  })
  return getProfile(trx, id)
}

export async function deleteProfile(trx: Kysely<Database>, context: AuditContext, actor: Actor, id: number, version: number): Promise<void> {
  const current = await trx
    .selectFrom('permission_profiles')
    .select(['name', 'scope', 'version'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (current === undefined) throw new AppError('NOT_FOUND')
  if (current.scope === 'system') assertMayManageSystemProfiles(actor)
  await assertNotHeldByActor(trx, actor, id)
  if (current.version !== version) throw new AppError('VERSION_CONFLICT', { currentVersion: current.version })
  try {
    await trx.deleteFrom('permission_profiles').where('id', '=', id).execute()
  } catch (err) {
    if (isForeignKeyViolation(err)) throw new AppError('PROFILE_IN_USE')
    throw err
  }
  await recordAudit(trx, context, {
    action: 'profile.deleted',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'profile', id },
    details: { before: { name: current.name, scope: current.scope } }
  })
}

// --- job titles -------------------------------------------------------------

export interface JobTitle {
  readonly id: number
  readonly name: string
  readonly description: string
  readonly isActive: boolean
  readonly version: number
}

const jobTitleColumns = ['id', 'name', 'description', 'is_active as isActive', 'version'] as const

export async function listJobTitles(db: Kysely<Database>): Promise<JobTitle[]> {
  return db.selectFrom('job_titles').select(jobTitleColumns).orderBy('name').execute()
}

export async function createJobTitle(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  input: { readonly name: string; readonly description: string }
): Promise<JobTitle> {
  const name = requiredName(input.name, 'name')
  let row: JobTitle
  try {
    row = await trx
      .insertInto('job_titles')
      .values({ name, description: input.description.trim() })
      .returning(jobTitleColumns)
      .executeTakeFirstOrThrow()
  } catch (err) {
    if (isUniqueViolation(err, 'job_titles_name_key')) throw new AppError('NAME_TAKEN')
    throw err
  }
  await recordAudit(trx, context, {
    action: 'job_title.created',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'job_title', id: row.id },
    details: { after: { name: row.name } }
  })
  return row
}

export async function updateJobTitle(
  trx: Kysely<Database>,
  context: AuditContext,
  actor: Actor,
  id: number,
  input: { readonly version: number; readonly name?: string | undefined; readonly description?: string | undefined; readonly isActive?: boolean | undefined }
): Promise<JobTitle> {
  const current = await trx.selectFrom('job_titles').select(jobTitleColumns).where('id', '=', id).forUpdate().executeTakeFirst()
  if (current === undefined) throw new AppError('NOT_FOUND')
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT', { currentVersion: current.version })
  const after = {
    name: input.name === undefined ? current.name : requiredName(input.name, 'name'),
    description: input.description?.trim() ?? current.description,
    isActive: input.isActive ?? current.isActive
  }
  const changed = Object.fromEntries(
    (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== current[k]).map((k) => [k, { before: current[k], after: after[k] }])
  )
  if (Object.keys(changed).length === 0) return current
  let row: JobTitle
  try {
    row = await trx
      .updateTable('job_titles')
      .set({ name: after.name, description: after.description, is_active: after.isActive, updated_at: sql<Date>`now()`, version: sql<number>`version + 1` })
      .where('id', '=', id)
      .returning(jobTitleColumns)
      .executeTakeFirstOrThrow()
  } catch (err) {
    if (isUniqueViolation(err, 'job_titles_name_key')) throw new AppError('NAME_TAKEN')
    throw err
  }
  await recordAudit(trx, context, {
    action: 'job_title.updated',
    outcome: 'success',
    actor: auditActor(actor),
    target: { type: 'job_title', id },
    details: { changed }
  })
  return row
}
