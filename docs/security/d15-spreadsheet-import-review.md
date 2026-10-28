# D-15 — Spreadsheet parsing on the web server: decision, dependency review and required controls

Date: 2026-10-27, updated 2026-10-28. Status: **decision recorded; dependency selected (O-13: ExcelJS with the explicit
`unzipper@0.12.5` override, strict `csv-parse`); E-18 limits approved; evaluated on synthetic files; not approved for
operational use.** No package has been added to `server/package.json`. Adoption happens in Phase 1B-3, after the 1B-3
gate (STATUS), with the controls below **as corrected by the evaluation**:
[`import-evaluation.md`](import-evaluation.md). Where this review and the evaluation differ, the evaluation is current.

## 1. Decision and scope

**Owner decision (2026-10-27), server only:** the web server processes `.xlsx` files with **ExcelJS** and CSV files
with a **strict CSV parser**, subject to this dependency review and the security controls in section 4. The server
never uses `xlsx@0.18.5` (review F-5).

**Scope (confirmed by the owner, 2026-10-27): server-side parsing only.** Replacing the desktop's `xlsx@0.18.5` is
separate work with its own approval, done before any new desktop release; until then the interim rules in
[`desktop-workbook-interim-restrictions.md`](desktop-workbook-interim-restrictions.md) apply. Nothing in this decision
changes desktop code or dependencies.

## 2. Selected versions (verified 2026-10-27 on the npm registry)

| Package | Version | Published | Licence | Direct dependencies | Why |
|---|---|---|---|---|---|
| `exceljs` | **4.4.0** (latest) | 2023-10-19 | MIT | 9: `archiver`, `dayjs`, `fast-csv`, `jszip`, `readable-stream`, `saxes`, `tmp`, `unzipper`, `uuid` | `.xlsx` reading on npm, MIT, no install scripts |
| `csv-parse` | **7.0.3** (latest) | 2026-09-25 | MIT | **none** | Strict RFC 4180 options (unclosed quotes, inconsistent column counts and stray quotes are errors); no type casting, so text stays exactly as written |
| `uuid` (override inside ExcelJS) | **11.1.1** | 2026-04-29 | MIT | none | Fixes GHSA-w5hq-g745-h8pq; see section 3.2 |

Not selected: `papaparse` 5.7.0 (MIT, no dependencies, already used by the desktop) — lenient by default and designed
for browsers; `csv-parse` gives the strict server-side behavior the decision asks for.

How verified: `npm view <package> version time license dependencies`; `npm install --package-lock-only
--ignore-scripts` and `npm ci --ignore-scripts` of exactly `exceljs@4.4.0` + `csv-parse@7.0.3` in a throwaway folder
(outside the repository, deleted afterwards); `npm audit --json`; reading the installed sources; a probe script.

## 3. Findings

### 3.1 Dependency tree

- **194 packages** in total (ExcelJS brings 193, `csv-parse` 1). **No install scripts.** *(Superseded by O-13: with
  the explicit override `unzipper@0.12.5` the lockfile has 88 entries and no package without a licence —
  [`import-evaluation.md`](import-evaluation.md) §2.)*
- Licences: MIT 172, ISC 13, Apache-2.0 2, BSD-3-Clause 2, MIT/X11 1, (MIT AND Zlib) 1 (`pako`), Unlicense 1
  (`big-integer`, public domain), (MIT OR GPL-3.0-or-later) 1 (`jszip`; used under MIT), and **one package without any
  licence: `buffers@0.1.1`** (no licence field, no licence text in the package). Without a licence there is no granted
  permission to use it — **adoption blocker until resolved** (section 5).
- **Deprecated packages** (npm warnings): `inflight@1.0.6` ("not supported, and leaks memory"), `glob@7.2.3`,
  `rimraf@2.7.1`, `fstream@1.0.12`, `lodash.isequal@4.5.0`, `uuid@8.3.2`. They sit mostly on ExcelJS's writing
  (`archiver`) and extract-to-disk (`unzipper` → `fstream`) paths, which the import does not use (section 4), but they
  are installed and must stay under the audit gate.
- **Maintenance:** ExcelJS's latest release is three years old. Risk accepted for now by the decision; it is a
  "risky component" in the sense of ASVS V15.1.4 and gets the isolation of section 4 (V15.2.5). Re-review the tree at
  adoption time and at least every quarter; if a high or critical advisory without a usable fix appears, the import
  feature is switched off until it is resolved.
- **Which code the import would run:** `workbook.xlsx.load(buffer)` uses **JSZip** (with `pako`) for the archive and
  **saxes** for XML. The streaming reader (`stream.xlsx.WorkbookReader`) would use the older `unzipper`; the design
  does not use it.

### 3.2 Advisories — checked for applicability, not assumed harmless

`npm audit` of the tree: **2 moderate, 0 high, 0 critical**, both the same advisory:

| Advisory | Package | Vulnerable | Severity | What it is |
|---|---|---|---|---|
| GHSA-w5hq-g745-h8pq | `uuid@8.3.2` (via `exceljs`) | `< 11.1.1` | moderate (CVSS 7.5; CWE-787, CWE-1285) | "Missing buffer bounds check in v3/v5/v6 when buf is provided" — an out-of-bounds write when a caller passes its own output buffer |

- **Applicability — not reachable from ExcelJS** [verified by reading `exceljs@4.4.0/lib`]: ExcelJS uses `uuid` in one
  file only, `lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`, as `uuidv4()` **with no arguments** (ids for
  conditional-formatting extensions). The vulnerable functions are v3, v5 and v6, and only with a caller-supplied
  buffer.
- **Mitigation anyway:** an npm `overrides` entry pins ExcelJS's `uuid` to **11.1.1**. Tested: it installs, `npm audit`
  then reports **0 vulnerabilities**, and an `.xlsx` round trip with a data-bar rule (the code path that calls
  `uuidv4()`) writes a valid id.
- npm's own suggested fix — downgrading ExcelJS to 3.4.0 — is rejected (older code, same dependency).

### 3.3 Behavior that matters for data integrity (probe, synthetic data)

- `.xlsx` round trip: a Persian header (`کد`) is preserved; a serial `00123` stored as **text** (`@` format) comes back
  as the string `"00123"`; a numeric cell comes back as a number (leading zeros in numeric cells are already gone in
  the file itself — see 4.7).
- CSV with `bom: true, columns: true, relax_quotes: false, relax_column_count: false, cast: false,
  max_record_size: 4096`: a UTF-8 BOM is accepted; `00123` and `۰۱۲` stay exactly as written; an unclosed quote
  (`CSV_QUOTE_NOT_CLOSED`), a row with too many columns (`CSV_RECORD_INCONSISTENT_COLUMNS`) and a stray quote
  (`INVALID_OPENING_QUOTE`) are rejected.
- **Since verified** (evaluation, synthetic corpus): saxes refuses DTD-based entities; DTDs are refused before
  parsing anyway. ExcelJS needs additional controls on hostile and on ordinary files (range expansion, falsy formula
  results, merged cells, unanchored part names): [`import-evaluation.md`](import-evaluation.md) §3 and §6.

## 4. Required controls (implemented and tested in 1B-3; ASVS 5.0.0 IDs)

| # | Requirement | Design |
|---|---|---|
| 4.1 | Isolation (V15.2.5, V15.2.2) | **Corrected by the evaluation:** a worker thread is **not** sufficient (its limit does not cover Buffers — measured). Parsing runs in a **separate, confined child process** per file: kernel memory limit, V8 heap ceiling, resident-memory watchdog, 30 s kill, no file writes, no child processes, no network, empty environment; it receives the upload on stdin and returns typed rows. Evaluation §3. |
| 4.2 | File size (V5.2.1, V5.1.1) | Upload limit **10 MiB** (E-18), enforced while the request body streams in, before any parsing (`413`), and again by the parser process. |
| 4.3 | Type (V5.2.2) | Extension `.xlsx` or `.csv`, **and** content check: `.xlsx` must be a ZIP (magic bytes `PK\x03\x04`) containing `[Content_Types].xml` and `xl/workbook.xml`; `.csv` must be valid UTF-8 text without NUL bytes. Legacy `.xls` and `.xlsm` are refused. |
| 4.4 | Decompressed content (V5.2.3, V5.3.3) | **Owner values (E-18):** at most **1,000** entries, **100 MiB** decompressed in total. Checked from the central directory, then every entry is inflated with a hard cap at its declared size and its CRC verified, so a false declaration fails before the parser runs; no encrypted entries, absolute paths, `..`, symlinks, ZIP64 or macros; DTDs refused. Entry paths are never used to create files. Evaluation §3–§4. |
| 4.5 | Rows, columns, time (V15.1.3, V2.3.2) | **Owner values (E-18):** **20** worksheets, **50,000** rows and **1,000,000** cells in total, **100** columns per worksheet, **30 s** per file; upload **10 MiB**. Plus the derived controls of evaluation §4 (range budget, grid, shared strings, cell formats; text over 32,767 characters flagged). Exceeding any ceiling rejects the file with a message naming it; nothing partial is kept. |
| 4.6 | Validation (V2.2.1–V2.2.3) | Every value validated against the import schema at the server (allow-lists for statuses and lookups, lengths, date rules); formulas are never evaluated (formula cells are flagged; their cached value is shown, never trusted silently); error cells are rejected. |
| 4.7 | Leading zeros and Persian text | Identifiers (code, serial) are read as **text**: a text cell as-is; a numeric cell via its formatted text and **flagged** ("numeric cell — leading zeros may already be lost in the file"). CSV with `cast: false`. Input must be UTF-8 (strict decoding; anything else is rejected with "save as CSV UTF-8"). Values are stored exactly as written; Persian/Arabic digit and letter normalization is used **only** to detect duplicates. |
| 4.8 | Preview, row-level results, explicit confirmation (V2.3.1) | Staged import: upload → parse → an import batch with per-row results (valid, warning, error) → preview → the user confirms → only then are assets written. Nothing touches assets before confirmation; a batch can be confirmed once. |
| 4.9 | Blank cells never erase | A blank cell means **"no change"**. Clearing a field requires an explicit, documented marker, shown in the preview as a change (review F-3). Columns absent from the file are never touched. |
| 4.10 | Transactions and idempotency (V2.3.3) | Confirmation runs in **one transaction** with its audit records and status history, under an `Idempotency-Key`; the batch moves pending → applied exactly once (state checked under a row lock). A retry after a lost response replays the result. |
| 4.11 | Duplicates | Duplicates within the file and against existing assets (exact and normalized) are flagged per row; **never merged automatically**; the user decides per row (skip, or create with a distinct code). |
| 4.12 | Audit (V16) | Who imported what, file SHA-256, counts, decision per row; per asset before/after values; status changes always write history. |
| 4.13 | Hostile-file tests | 1B-3 test corpus: ZIP bomb (ratio and size), too many entries, path traversal names, encrypted entries, oversized shared strings, deep XML nesting, DTD/entity tricks (XXE, billion laughs), invalid UTF-8, mismatched CSV columns, formula cells, huge single cells, time limit. Each must be rejected within the limits without affecting other requests. |
| 4.14 | Dependency hygiene (V15.1.1, V15.1.2, V15.2.1) | Exact pins and the lockfile; `uuid` override; `npm audit` gate in `verify` once adopted; remediation time frames (**proposed**, engineering default E-18 — yours to change) — critical/high: switch the import off immediately, fix or replace within 14 days; moderate: assess applicability within 14 days, as done here. |

## 5. Open items before adoption

1. ~~`buffers@0.1.1` has no licence~~ — **resolved by the explicit override `unzipper@0.12.5` (O-13)**, tested for
   compatibility and verified against the published artifacts; [`import-evaluation.md`](import-evaluation.md) §2.
   The dependency is selected (O-13, 2026-10-28); operational use waits for the acceptance gates (evaluation §7).
2. ~~D-15 (desktop scope)~~ — **settled**: server only; desktop replacement is separate work before a new desktop
   release; interim restrictions documented.
3. ~~Concrete limit values~~ — **approved by you (E-18, 2026-10-28)** with concurrency 1 by default and 2 at most, and boundary-tested; the memory limit is derived from
   measurement. Re-check against the profile of the spreadsheet version that the Excel Source Admission Gate (O-14,
   proposed) admits, once it admits one (row and column counts, field lengths), since the desktop database holds test
   data only (O-06) and is no longer the reference, and re-measure on the target server before import is switched on.
