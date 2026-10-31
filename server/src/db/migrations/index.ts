import type { Migration } from 'kysely/migration'
import * as baseline from './0001_baseline.js'
import * as identityAndAccess from './0002_identity_and_access.js'
import * as multiFactorAuthentication from './0003_multi_factor_authentication.js'
import * as administratorsRequireMfa from './0004_administrators_require_mfa.js'
import * as assetCatalogue from './0005_asset_catalogue.js'
import * as assetsAndHistory from './0006_assets_and_history.js'
import * as importStaging from './0007_import_staging.js'
import * as idempotencyPersonSubjects from './0008_idempotency_person_subjects.js'

/**
 * Every schema migration, keyed by name; applied in name order.
 *
 * An explicit list rather than a directory scan: a stray or half-written
 * file can never be picked up, and adding a migration is a reviewed change
 * to this file. Never rename or edit a migration that has been applied
 * anywhere — add a new one instead.
 */
export const migrations: Readonly<Record<string, Migration>> = {
  '0001_baseline': baseline,
  '0002_identity_and_access': identityAndAccess,
  '0003_multi_factor_authentication': multiFactorAuthentication,
  '0004_administrators_require_mfa': administratorsRequireMfa,
  '0005_asset_catalogue': assetCatalogue,
  '0006_assets_and_history': assetsAndHistory,
  '0007_import_staging': importStaging,
  '0008_idempotency_person_subjects': idempotencyPersonSubjects
}
