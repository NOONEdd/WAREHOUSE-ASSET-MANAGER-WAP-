import { AppError } from '../appError.js'

// Turns what the asset schema's constraints and triggers refused into a precise client error
// (migrations 0005–0007). The trigger messages matched here are fixed texts in those migrations;
// anything unrecognized is rethrown and becomes a 500 without detail.

interface PgError {
  readonly code?: unknown
  readonly constraint?: unknown
  readonly message?: unknown
}

const INACTIVE_FIELD: Readonly<Record<string, string>> = {
  'inactive asset status': 'statusId',
  'inactive item type': 'itemTypeId',
  'inactive country': 'countryId',
  'inactive workshop': 'workshopId'
}

const CHECK_FIELD: Readonly<Record<string, string>> = {
  assets_asset_code_length: 'assetCode',
  assets_asset_code_not_blank: 'assetCode',
  assets_serial_number_length: 'serialNumber',
  assets_serial_number_not_blank: 'serialNumber',
  assets_name_length: 'name',
  assets_model_length: 'model',
  assets_notes_length: 'notes',
  assets_dates: 'exitDate',
  assets_delivered_by_one: 'deliveredBy',
  assets_received_by_one: 'receivedBy',
  persons_display_name_length: 'displayName',
  asset_statuses_name_length: 'name',
  item_types_name_length: 'name',
  workshops_name_length: 'name',
  countries_name_length: 'name',
  countries_iso_code_format: 'isoCode'
}

export function assetDbError(err: unknown): AppError | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as PgError
  const message = typeof e.message === 'string' ? e.message : ''
  const constraint = typeof e.constraint === 'string' ? e.constraint : ''
  switch (e.code) {
    case '23505':
      if (constraint === 'assets_asset_code_key' || constraint === 'countries_iso_code_key') return new AppError('CODE_TAKEN')
      if (constraint.endsWith('_name_key')) return new AppError('NAME_TAKEN')
      return null
    case '23514': {
      if (message.startsWith('the warehouse is not active')) return new AppError('WAREHOUSE_INACTIVE')
      const inactive = INACTIVE_FIELD[message]
      if (inactive !== undefined) return new AppError('VALIDATION_FAILED', { field: inactive, reason: 'inactive' })
      if (message === 'unknown person for this warehouse') return new AppError('VALIDATION_FAILED', { field: 'person', reason: 'unknown' })
      if (message === 'a system status cannot be renamed or recoded') return new AppError('FORBIDDEN', { reason: 'system status' })
      if (constraint === 'asset_statuses_system_is_active') return new AppError('FORBIDDEN', { reason: 'system status' })
      const field = CHECK_FIELD[constraint]
      return field === undefined ? null : new AppError('VALIDATION_FAILED', { field })
    }
    case '23503':
      return new AppError('VALIDATION_FAILED', { reason: 'unknown reference' })
    case '22007':
    case '22008':
      return new AppError('VALIDATION_FAILED', { reason: 'invalid date' })
    default:
      return null
  }
}

/** Runs `work`, translating recognized database refusals into AppErrors. */
export async function mapAssetDbErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    throw assetDbError(err) ?? err
  }
}
