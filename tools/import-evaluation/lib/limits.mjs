// Import ceilings (decision E-18, set by the owner 2026-10-27). Evaluation only:
// the web server does not parse spreadsheets yet (decision D-15).

const MiB = 1024 * 1024

export const LIMITS = Object.freeze({
  compressedBytes: 10 * MiB, // the uploaded file itself
  decompressedBytes: 100 * MiB, // all ZIP entries together, after inflating
  zipEntries: 1000,
  worksheets: 20,
  rows: 50_000, // across all worksheets; also the highest row number allowed in any worksheet
  columnsPerSheet: 100, // also the highest column number allowed in any cell reference
  cells: 1_000_000, // across all worksheets
  wallClockMs: 30_000 // per file, enforced by the parent
})

// Derived controls that are not owner ceilings but follow from how the parser
// works (see the evaluation README, "Amplification inside the format"):
export const DERIVED = Object.freeze({
  // ExcelJS materializes every position of a merged range and of a data-validation
  // range; their summed area is held to the same budget as real cells.
  expandedPositions: 1_000_000,
  // Excel's own grid (XFD1048576). Column-format and span attributes may name
  // whole columns, but nothing beyond the grid is accepted.
  gridColumns: 16_384,
  gridRows: 1_048_576,
  // Excel's documented maximum length of the text in one cell.
  cellTextChars: 32_767,
  // Every shared string is used by at least one cell, so there cannot be more
  // of them than cells.
  sharedStrings: 1_000_000,
  // Excel's documented maximum number of cell formats.
  cellFormats: 65_490
})

/** A file refused because it exceeds a ceiling; `limit` names which one. */
export class LimitError extends Error {
  constructor(limit, detail) {
    super(`limit exceeded: ${limit}${detail === undefined ? '' : ` (${detail})`}`)
    this.code = 'LIMIT'
    this.limit = limit
  }
}

/** A file refused because it is not what it claims to be, or is unsafe to open. */
export class InvalidFileError extends Error {
  constructor(reason) {
    super(`invalid file: ${reason}`)
    this.code = 'INVALID'
    this.reason = reason
  }
}
