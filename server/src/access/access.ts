import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/connection.js'
import { isSystemPermission, isWarehousePermission, type SystemPermission, type WarehousePermission } from './permissions.js'

// Effective permissions of a user (docs/security/identity-and-access.md §2).
// Read from the database on every request — never cached in the session —
// so a grant or revocation takes effect on the next request. Only active
// profiles count. The owner implicitly holds every permission everywhere.

export interface Access {
  readonly isOwner: boolean
  readonly system: ReadonlySet<SystemPermission>
  /** warehouse id → permissions there; only warehouses with at least one permission appear. */
  readonly warehouses: ReadonlyMap<number, ReadonlySet<WarehousePermission>>
}

export async function loadAccess(db: Kysely<Database>, userId: number, isOwner: boolean): Promise<Access> {
  if (isOwner) return { isOwner: true, system: new Set(), warehouses: new Map() }
  const { rows } = await sql<{ warehouse_id: number | null; permission: string }>`
    SELECT NULL::integer AS warehouse_id, ppp.permission
      FROM wam.user_system_profiles usp
      JOIN wam.permission_profiles pp ON pp.id = usp.profile_id AND pp.is_active
      JOIN wam.permission_profile_permissions ppp ON ppp.profile_id = pp.id
     WHERE usp.user_id = ${userId}
    UNION
    SELECT uwp.warehouse_id, ppp.permission
      FROM wam.user_warehouse_profiles uwp
      JOIN wam.permission_profiles pp ON pp.id = uwp.profile_id AND pp.is_active
      JOIN wam.permission_profile_permissions ppp ON ppp.profile_id = pp.id
     WHERE uwp.user_id = ${userId}`.execute(db)

  const system = new Set<SystemPermission>()
  const warehouses = new Map<number, Set<WarehousePermission>>()
  for (const { warehouse_id: warehouseId, permission } of rows) {
    if (warehouseId === null) {
      if (isSystemPermission(permission)) system.add(permission)
    } else if (isWarehousePermission(permission)) {
      const set = warehouses.get(warehouseId) ?? new Set<WarehousePermission>()
      set.add(permission)
      warehouses.set(warehouseId, set)
    }
  }
  return { isOwner: false, system, warehouses }
}

export function hasSystemPermission(access: Access, permission: SystemPermission): boolean {
  return access.isOwner || access.system.has(permission)
}

/**
 * Whether the user may do `permission` in warehouse `warehouseId`. False for
 * a warehouse that does not exist — even for the owner — so callers can
 * answer 404 in both cases and never reveal which warehouses exist.
 */
export async function hasWarehousePermission(
  db: Kysely<Database>,
  access: Access,
  permission: WarehousePermission,
  warehouseId: number
): Promise<boolean> {
  if (!access.isOwner) return access.warehouses.get(warehouseId)?.has(permission) === true
  const row = await db.selectFrom('warehouses').select('id').where('id', '=', warehouseId).executeTakeFirst()
  return row !== undefined
}
