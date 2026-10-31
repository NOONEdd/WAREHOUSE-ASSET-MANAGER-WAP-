// The permission catalogue: every action the server can check
// (docs/security/identity-and-access.md §2.2). The same list lives in the
// `permissions` table, inserted by migrations; a test fails if the two
// differ. Adding a permission therefore means a migration plus an entry here.
//
// Profiles (owner-configurable) are sets of these. Code never grants a
// permission to a particular person.

export const SYSTEM_PERMISSIONS = {
  'user.view': 'View user accounts',
  'user.manage': 'Create, edit, disable and reset user accounts; assign warehouse profiles',
  'profile.manage': 'Create, edit and delete warehouse permission profiles',
  'job_title.manage': 'Create and edit job titles',
  'warehouse.manage': 'Create, rename and deactivate warehouses',
  'audit.view_all': 'View the complete audit trail',
  'catalog.manage': 'Create, rename and deactivate item types, workshops, countries and asset statuses',
  'person.erase': 'Erase the name of a person without a WAM account (one-way; history keeps the id)'
} as const

export const WAREHOUSE_PERMISSIONS = {
  'asset.view': 'View assets and their history',
  'asset.create': 'Register new assets',
  'asset.edit': 'Edit asset details',
  'asset.change_status': 'Change asset status',
  'asset.transfer': 'Transfer assets out of the warehouse',
  'asset.retire': 'Retire or dispose of assets',
  'asset.approve': 'Approve or reject pending asset requests',
  'asset.import': 'Import assets into the warehouse',
  'asset.export': 'Export the warehouse’s asset data',
  'audit.view': 'View the warehouse’s audit events'
} as const

export type SystemPermission = keyof typeof SYSTEM_PERMISSIONS
export type WarehousePermission = keyof typeof WAREHOUSE_PERMISSIONS
export type Permission = SystemPermission | WarehousePermission
export type PermissionScope = 'system' | 'warehouse'

export function isSystemPermission(value: string): value is SystemPermission {
  return Object.hasOwn(SYSTEM_PERMISSIONS, value)
}

export function isWarehousePermission(value: string): value is WarehousePermission {
  return Object.hasOwn(WAREHOUSE_PERMISSIONS, value)
}

export function permissionsOfScope(scope: PermissionScope): readonly Permission[] {
  return Object.keys(scope === 'system' ? SYSTEM_PERMISSIONS : WAREHOUSE_PERMISSIONS) as Permission[]
}
