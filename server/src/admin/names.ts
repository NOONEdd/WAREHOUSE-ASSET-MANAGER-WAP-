import { AppError } from '../appError.js'

// Names are stored trimmed, and the database refuses one that is empty once trimmed (its CHECK constraints count
// btrim). Checking the trimmed value here, before any database work, turns a whitespace-only name into a
// validation error instead of a constraint violation answered with 500 (findings NF-1 and NF-3). The route
// schemas cannot do it: their minLength counts raw characters.

/** The trimmed name; refuses one that is empty after trimming. */
export function requiredName(raw: string, field: string): string {
  const name = raw.trim()
  if (name === '') throw new AppError('VALIDATION_FAILED', { field, reason: 'blank' })
  return name
}
