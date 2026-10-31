// "Blank never erases" (docs/architecture/web-architecture-and-security-review.md §2.7;
// docs/security/d15-spreadsheet-import-review.md §4; the E-18 conditions). When an import
// row describes an existing asset, only the cells it actually has can change that asset:
// the parser produces no value at all for a blank cell (import-evaluation §4), so a blank
// cell changes nothing, and clearing a field needs an explicit marker. How a marker is
// written in a file belongs to the import field contract (O-14, stage 2); this module only
// sees the result.
//
// Pure: it plans changes and applies them to a copy; persisting them (in one transaction,
// with the audit record) is the caller's job.

export type IncomingCell<T> =
  | { readonly kind: 'set'; readonly value: T }
  /** Explicit request to clear the field; never produced by a blank cell. */
  | { readonly kind: 'clear' }

export interface FieldChange<F extends string, T> {
  readonly field: F
  readonly before: T | null
  readonly after: T | null
}

/**
 * The changes `incoming` makes to `current`, in the field order of `current`. A field
 * absent from `incoming` is unchanged. A field `incoming` names that `current` does not
 * have is a programming error and throws, so a typo can never be silently ignored.
 */
export function planFieldChanges<F extends string, T>(
  current: Readonly<Record<F, T | null>>,
  incoming: Readonly<Partial<Record<F, IncomingCell<T>>>>,
  same: (a: T, b: T) => boolean = Object.is
): FieldChange<F, T>[] {
  for (const field of Object.keys(incoming)) {
    if (!Object.hasOwn(current, field)) throw new Error(`unknown field in an import change: ${field}`)
  }
  const changes: FieldChange<F, T>[] = []
  for (const field of Object.keys(current) as F[]) {
    const cell = incoming[field]
    if (cell === undefined) continue
    const before = current[field]
    if (cell.kind === 'clear') {
      if (before !== null) changes.push({ field, before, after: null })
    } else if (before === null || !same(before, cell.value)) {
      changes.push({ field, before, after: cell.value })
    }
  }
  return changes
}

/** `current` with `changes` applied; `current` itself is not modified. */
export function applyFieldChanges<F extends string, T>(
  current: Readonly<Record<F, T | null>>,
  changes: readonly FieldChange<F, T>[]
): Record<F, T | null> {
  const next: Record<F, T | null> = { ...current }
  for (const { field, after } of changes) next[field] = after
  return next
}
