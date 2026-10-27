import type { Migration } from 'kysely/migration'
import * as baseline from './0001_baseline.js'

/**
 * Every schema migration, keyed by name; applied in name order.
 *
 * An explicit list rather than a directory scan: a stray or half-written
 * file can never be picked up, and adding a migration is a reviewed change
 * to this file. Never rename or edit a migration that has been applied
 * anywhere — add a new one instead.
 */
export const migrations: Readonly<Record<string, Migration>> = {
  '0001_baseline': baseline
}
