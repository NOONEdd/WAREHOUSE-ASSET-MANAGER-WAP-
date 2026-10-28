# Spreadsheet import: evaluation for O-13 and E-18 (D-15, server side)

Date: 2026-10-28. Status: **dependency selected (O-13), limits approved (E-18); evaluated on synthetic files in the
Linux development sandbox; nothing added to `server/`; not approved for operational use.** Harness and runbook:
[`tools/import-evaluation/`](../../tools/import-evaluation/). Raw results of the final run:
[`import-evaluation-results.md`](import-evaluation-results.md). Blocks between `gen:` markers are written by
`tools/import-evaluation/report.py` from the run results; no number in them is typed by hand.

## 1. Answers

| Question | Answer | Evidence |
|---|---|---|
| Does an explicit `unzipper` override remove `buffers@0.1.1`? | **Yes.** `unzipper` **0.12.5** inside ExcelJS removes 102 distinct packages, `buffers` among them, and adds 4 (MIT); the lockfile goes from 194 to **88** entries; `npm ls buffers` is empty | §2 |
| Is the move from ExcelJS's declared `^0.10.11` to 0.12.5 compatible? | **Yes, demonstrated.** (a) The import path, `workbook.xlsx.load()`, never executes `unzipper` (it unzips with JSZip; `unzipper` is only loaded). (b) The only code that uses `unzipper`, ExcelJS's streaming reader, returns **byte-identical** output with 0.12.5 and with 0.10.14 on 8 files, two of them with 1,000,000 cells | §2.3 |
| Do the installed packages match what was published? | **Yes.** For all 88 lockfile entries the SHA-512 recomputed from the downloaded tarball equals the lockfile value, and every installed file is byte-identical to the tarball (2,186 files) | §2.2 |
| Licences | Every package declares a permissive licence (MIT, ISC, Apache-2.0, BSD-3-Clause, MIT-or-GPL used under MIT, MIT-and-Zlib); none lacks one. **Open:** a third-party notice file with the texts, because `saxes` ships no licence file (upstream ISC text verified) and `isarray` carries its MIT text only in the README | §2.1 |
| Is ExcelJS safe enough on hostile files? | **Only with the controls of §3**, which the evaluation found necessary: without them, a 2.4 KB file makes ExcelJS use about 4 GiB of memory (merged or validated ranges, column ranges). With them, <!-- gen:cases -->all 90 cases end as expected (90/90 in the final run)<!-- /gen:cases --> | §4, §6 |
| Is a worker thread a sufficient resource limit? | **No.** A worker with a 64 MiB heap limit allocated 1,024 MiB of Buffers without being stopped. The design uses a separate, confined process | §3, §5.3 |
| E-18 ceilings | All eight enforced in the parser process and tested at the exact value (accepted) and the first value above it (refused with a message naming the ceiling) | §4 |
| Memory limits | Recommended from measurement: <!-- gen:limits -->V8 heap **1,280 MiB**, resident-memory watchdog **2,048 MiB**, kernel data limit **3,072 MiB**<!-- /gen:limits --> per parse | §5 |
| Concurrency | **1** parse at a time by default; **2** at most, and only after measurement on the target host | §5.2 |
| ExcelJS's streaming reader | **Never used**: it damages Persian text (U+FFFD in 174 and 236 places in two 1,000,000-cell files), leaves shared strings unresolved, turns Excel's built-in date format into numbers, and needs temporary files on disk | §6 |

**Owner decisions (2026-10-28).** O-13: ExcelJS 4.4.0 with the explicitly pinned `unzipper@0.12.5` override (and
`uuid@11.1.1`), together with the strict CSV parser `csv-parse@7.0.3`, is the **selected dependency direction — not an
approval for operational use**. E-18: the eight ceilings are approved as maximums, with concurrency 1 by default and 2
at most. The acceptance gates that must pass before any operational import endpoint exists are in §7.

## 2. Dependencies

### 2.1 Tree with the override

`tools/import-evaluation/package.json`: `exceljs@4.4.0`, `csv-parse@7.0.3`, `overrides.exceljs` = `unzipper@0.12.5`,
`uuid@11.1.1`. Compared with the same install without the `unzipper` override (throwaway folder outside the
repository):

| | Without override | With override |
|---|---|---|
| Lockfile entries (distinct packages) | 194 (171) | **88** (73) |
| `unzipper` | 0.10.14 | 0.12.5 (MIT; dependencies `bluebird`, `duplexer2`, `fs-extra`, `graceful-fs`, `node-int64`) |
| Package without any licence | `buffers@0.1.1` | **none** |
| Removed by the override | — | `buffers`, `binary`, `chainsaw`, `traverse`, `fstream`, `rimraf`, `mkdirp`, `minimist`, `big-integer`, `buffer-indexof-polyfill`, `listenercount` and an `es-abstract` polyfill tree (102 distinct packages) |
| Added by the override | — | `fs-extra`, `jsonfile`, `universalify`, `node-int64` (all MIT) |
| Licences (installed `package.json`) | — | MIT 72, ISC 10, Apache-2.0 2 (`crc-32`, `readdir-glob`), BSD-3-Clause 2 (`duplexer2`, `ieee754`), (MIT AND Zlib) 1 (`pako`), (MIT OR GPL-3.0-or-later) 1 (`jszip`, used under MIT) |
| `npm audit` | 0 (with the `uuid` override) | **0** |
| `npm ls --all` | — | exit 0 (nothing missing, invalid or extraneous) |
| Install scripts | none | none |
| Deprecated | `fstream`, `rimraf`, `glob@7`, `inflight`, `lodash.isequal` | `glob@7.2.3`, `inflight@1.0.6`, `lodash.isequal@4.5.0` (all on ExcelJS's writing side: `archiver`, `fast-csv`) |

**Licence findings (recorded, not resolved by assumption):** `saxes@5.0.1` declares ISC but ships no licence file;
the upstream repository's `LICENSE` at tag `v5.0.1` is ISC (fetched 2026-10-27 and again 2026-10-28, SHA-256
`0fac2374…7f061d0e` both times; it also carries the ISC notice of `sax`, from which `saxes` was forked).
`isarray@1.0.0` declares MIT and carries the MIT text only in its README. No package ships a `NOTICE` file. The
licences require their texts to accompany distributed copies, so a **third-party notice file** (all texts, the `jszip`
election of MIT, both `pako` notices) is an acceptance gate (§7). Nothing was changed or suppressed.

**Loaded at run time:** `require('exceljs')` loads 65 packages, including the deprecated `glob@7`, `inflight` and
`lodash.isequal`, although the reading path never calls them. They run only inside the confined parser process (§3).

### 2.2 Installed artifacts against the published tarballs

`verify_artifacts.py` (run 2026-10-28 after a clean `npm ci --ignore-scripts`): every lockfile entry's tarball was
downloaded with `npm pack`, its SHA-512 computed independently and compared with the lockfile, and every file in it
compared byte for byte with the installed copy in `node_modules`.

| Check | Result |
|---|---|
| SHA-512 recomputed from the tarball equals the lockfile's `integrity` | **88/88** entries (79 distinct tarballs) |
| Installed files identical to the tarball (no difference, nothing missing, nothing extra) | **88/88** packages, 2,186 files |
| Tarballs resolved from `https://registry.npmjs.org/` | 88/88 |
| Licence field in the installed `package.json` equals the lockfile | 88/88 |
| `npm audit signatures` (registry signatures and provenance) | **not verified**: the sandbox's network policy denies `tuf-repo-cdn.sigstore.dev` (proxy 403), which npm needs; gate in §7 |

### 2.3 Compatibility of the override

- Source (`exceljs@4.4.0/lib`): `xlsx/xlsx.js` (`load()`, `read()`) uses `JSZip.loadAsync`; only
  `stream/xlsx/workbook-reader.js` uses `unzipper.Parse`.
- `compare-unzipper.mjs` runs the streaming reader on the same 8 synthetic files (the reference table from four
  producers, two 1,000,000-cell workbooks, a 20-sheet workbook) with both installs and compares every cell:
  **identical output for all 8.** Every difference the streaming reader shows against `load()` is the same with
  0.10.14, so it is ExcelJS's own behavior, not the override's (§6).

## 3. The design that was tested (all layers are required)

| # | Control | What it stops | Verified by |
|---|---|---|---|
| 1 | **Separate process per file**, started by a supervisor; empty environment (only `UV_THREADPOOL_SIZE`) | A parser failure or exploit affecting the server process; secrets reaching the parser | probe `escape`: environment keys |
| 2 | **Kernel limit** `RLIMIT_DATA` via `prlimit` (covers V8 heap and Buffers alike), `RLIMIT_CORE=0` (no memory dumps on disk), `RLIMIT_FSIZE=0`, `RLIMIT_NOFILE=64` | Memory exhaustion that a heap limit cannot see | probe: Buffer growth with the watchdog switched off → stopped by the kernel |
| 3 | **V8 heap ceiling** `--max-old-space-size` and **one V8 worker thread** (`--v8-pool-size=1`, `UV_THREADPOOL_SIZE=1`), so a parse uses about one CPU core | Heap growth (most of ExcelJS's memory); one parse taking several cores | probe: heap growth → stopped |
| 4 | **Resident-memory watchdog** in the supervisor (VmRSS every 20 ms) and **wall-clock kill at 30 s** | Resident growth below the kernel limit; endless loops and slow work | probes: Buffer growth with the kernel limit switched off → killed; work of 29.5 s completes, work of 30.1 s and an endless loop are killed at 30.0 s |
| 5 | **Node permission model**: read access to the parser's own folder only; no file writes, no child processes, no worker threads | Writing or reading files, starting programs | probe: all four refused (`ERR_ACCESS_DENIED`) |
| 6 | **No network**: a new network namespace (`unshare -r -n`) | Connections from the parser | probe: `ENETUNREACH` inside, connection allowed without it |
| 7 | **Pre-check** before ExcelJS sees the file (`zip-inspect.mjs`): ZIP structure from the central directory (entry count, names, no traversal or absolute paths, no symlinks, encryption, ZIP64, macros or unknown methods); every entry inflated with a hard cap at its declared size, then size and CRC-32 checked; **no DTD or entity declaration in any XML part**; every worksheet scanned for rows, cells and every coordinate ExcelJS acts on | ZIP bombs (truthful or lying), XXE, entity expansion, oversized or out-of-grid sheets, range-expansion bombs | §4, §6 |
| 8 | **JSZip cross-check**: JSZip (what `load()` uses) must see exactly the parts, sizes and checksums the pre-check checked | Two ZIP readers disagreeing about one file (a known trick to slip content past a check) | N3: legitimate folder entries pass. No disagreement got past the pre-check in this corpus (duplicates, H14, are caught there first); the cross-check is the second line |
| 9 | **Typed row output with an authoritative recount** of what ExcelJS built, against the same ceilings | Anything the pre-check undercounts | every `ok` case |
| 10 | **Value rules**: formula cells read through `cell.result` and flagged, never evaluated; merged ranges read once at the top-left cell; blank cells are not output at all; text over 32,767 characters and formula-like text are flagged; a parse that sees no cells in a file that has some is refused | Silent data loss or invention (§6) | X28 (cached 0, FALSE and TRUE, merged range — regression case), N1–N6 (values), X5 (no cells read → refused), X6 (overlong text flagged), C6 (formula-like text) |
| 11 | **Strict CSV**: valid UTF-8 only (fatal decoding), no NUL, `csv-parse` with strict quotes and equal column counts, no type casting; **every field, blank or not, counts as a processed cell** | Mis-decoded or ambiguous text files; work hidden in blank fields | C1–C7, N7, O11, O12 |

CPU: each parse is held to about one core (control 3) and to 30 s of wall-clock time (control 4); with concurrency 1
by default (§5.2) the parser never takes more than one core of the server.

The supervisor also caps what the child may send back (3 × the decompressed ceiling) and accepts only its line
protocol. Parser messages are never passed on (they can quote file content); the user sees only the pre-check's own
messages or "the file could not be read".

## 4. E-18 ceilings: enforcement and boundary tests

All values as approved by you (2026-10-28); all enforced in the parser process before and after ExcelJS runs.
"At" cases must be accepted, "over" cases refused with the named ceiling. "Processed cells" counts every `<c>`
element of a worksheet (blank or not) and every CSV field (blank or not).

<!-- gen:boundary -->
Verification run of 2026-10-28 03:59 UTC under heap 1,280 / watchdog 2,048 / kernel 3,072 MiB.

| Ceiling | At the value | Result | Time | First value above | Result (message) |
|---|---|---|---|---|---|
| rows 50,000 | L1: 50,000 rows x 20 columns = 1,000,000 cells, one sheet, unique shared strings | accepted | 8.9 s | O2: 50,001 rows (across two sheets) | refused (limit exceeded: rows (50001)) |
| processed cells 1,000,000 (.xlsx) | L1: 50,000 rows x 20 columns = 1,000,000 cells, one sheet, unique shared strings | accepted | 8.9 s | O4: 1,000,001 cells (40,000 x 25 + 1) | refused (limit exceeded: cells (1000001)) |
| worksheets 20 | L2: 20 worksheets x 2,500 rows x 20 columns = 1,000,000 cells | accepted | 10.2 s | O1: 21 worksheets | refused (limit exceeded: worksheets (21)) |
| columns 100 per worksheet | L3: 10,000 rows x 100 columns = 1,000,000 cells | accepted | 7.3 s | O3: a cell in column 101 (CW) | refused (limit exceeded: columnsPerSheet (xl/worksheets/sheet1.xml: column 101)) |
| ZIP entries 1,000 | L5: exactly 1,000 ZIP entries | accepted | 0.6 s | O5: 1,001 ZIP entries | refused (limit exceeded: zipEntries (1001)) |
| decompressed 100 MiB | L11: decompressed total exactly 100 MiB (104,857,600 bytes) | accepted | 1.6 s | O6: 100 MiB + 1 byte decompressed (truthful sizes) | refused (limit exceeded: decompressedBytes (declared 104857601 bytes)) |
| compressed file 10 MiB (.xlsx) | L8: exactly 10 MiB (10,485,760 bytes) compressed | accepted | 0.4 s | O7: 10 MiB + 1 byte compressed | refused (limit exceeded: compressedBytes (more than 10485760 bytes)) |
| CSV rows 50,000 | L4: CSV 50,000 rows x 20 columns = 1,000,000 cells, just under 10 MiB | accepted | 1.1 s | O8: CSV 50,001 rows | refused (limit exceeded: rows (50001)) |
| CSV columns 100 | L9: CSV with exactly 100 columns | accepted | 0.1 s | O9: CSV 101 columns | refused (limit exceeded: columnsPerSheet (row 1: 101)) |
| CSV processed cells (fields) 1,000,000 | L4: CSV 50,000 rows x 20 columns = 1,000,000 cells, just under 10 MiB | accepted | 1.1 s | O11: CSV 1,000,004 fields (53 x 18,868), the first count above 1,000,000 a strict CSV can have | refused (limit exceeded: cells (1000004 fields)) |
| CSV file 10 MiB | L10: CSV of exactly 10 MiB (10,485,760 bytes) | accepted | 1.2 s | O10: CSV 10 MiB + 1 byte | refused (limit exceeded: compressedBytes (more than 10485760 bytes)) |
| CSV blank fields | — | — | — | O12: CSV 1,000,100 fields that are mostly blank (10,001 non-blank): blank fields are processed cells too | refused (limit exceeded: cells (1000100 fields)) |
| wall clock 30 s per file | work of 29.5 s | completed | 29.5 s | work of 30.1 s; endless loop | stopped at 30.0 s; stopped at 30.0 s |
<!-- /gen:boundary -->

**Correction (2026-10-28):** the run reported on 2026-10-27 did not test the first value above the ceiling for CSV
processed cells (CSV then counted only non-blank cells) or the 30 s boundary itself (only an endless loop); both
are covered now (O11, O12, and the 29.5 s / 30.1 s probes).

For strict CSV every row has the same number of fields, so exactly 1,000,001 fields cannot occur within 100 columns
and 50,000 rows (1,000,001 = 101 × 9,901); 1,000,004 (53 × 18,868) is the first count above the ceiling a valid CSV
can have, and O12 shows that blank fields count.

**Derived controls** (refusal-only; they follow from how ExcelJS works and never relax a ceiling):

| Control | Value | Why |
|---|---|---|
| Area of merged and data-validation ranges | ≤ 1,000,000 positions in total | ExcelJS materializes every position of both (X7/X8: one `A1:XFD1048576` range = 17 billion positions) |
| Row and column numbers anywhere in a worksheet | ≤ 50,000 and ≤ 100 (your ceilings applied as an extent) | ExcelJS builds rows and columns up to the highest number it sees |
| Column-format ranges and row spans | within Excel's grid (16,384 columns) | `<col max="2000000000">` makes ExcelJS create two billion column objects (X9) |
| Shared strings | ≤ 1,000,000 | each is used by at least one cell |
| Cell formats | ≤ 65,490 | Excel's own maximum |
| Text in one cell | over 32,767 characters → flagged for a row-level error | Excel's own maximum; the file is not refused |

**For CSV**, the 10 MiB file ceiling is reached before the 1,000,000-cell ceiling when cells average more than about 9
bytes (L4: 1,000,000 cells of 9 characters already make a 9.5 MiB file). This is a property of your values, not a
change to them.

**Preview and confirmation** (your E-18 conditions: row-level validation, explicit confirmation, blank cells never
erase, transactions, idempotency, no automatic merging of duplicates) are requirements of the 1B-3 import design
(D-15 review §4.8–4.11). They need the asset schema and cannot be built or tested before Phase 1B-3, which waits for
your explicit authorization (O-06 is resolved: no desktop data migration). What this evaluation already fixes at the
parser boundary: blank cells produce **no value at all** (not an empty
string), so nothing downstream can mistake a blank for "erase"; every value carries its type; formulas, overlong text
and formula-like text are flagged for the preview.

## 5. Memory, time and concurrency

### 5.1 Measurement (generous limits) and derivation

<!-- gen:measure -->
| Case | File | Time | Peak resident memory | Peak VmData |
|---|---|---|---|---|
| L1 | 50,000 rows x 20 columns = 1,000,000 cells, one sheet, unique shared strings (7,122,775 bytes) | 13.4 s | 1,080 MiB | 1,560 MiB |
| L2 | 20 worksheets x 2,500 rows x 20 columns = 1,000,000 cells (7,036,545 bytes) | 12.5 s | 1,046 MiB | 1,522 MiB |
| L3 | 10,000 rows x 100 columns = 1,000,000 cells (3,885,632 bytes) | 8.8 s | 908 MiB | 1,387 MiB |
| L4 | CSV 50,000 rows x 20 columns = 1,000,000 cells, just under 10 MiB (9,999,999 bytes) | 1.1 s | 274 MiB | 757 MiB |
| L6 | 1,000,000 cells of longer text, 99.3 MiB decompressed (5.7 MiB compressed) (5,958,725 bytes) | 14.8 s | 1,171 MiB | 1,652 MiB |
| L7 | 1,000,000 random (incompressible) shared strings, 9.4 MiB compressed (9,894,929 bytes) | 10.9 s | 1,068 MiB | 1,547 MiB |
| X6 | one 90 MiB cell (Excel allows 32,767 characters) (94,129 bytes) | 5.7 s | 789 MiB | 1,495 MiB |

Full run of 2026-10-28 03:48 UTC: smallest heap ceiling at which every at-limit file parses **768 MiB**; peak resident memory 1,171 MiB, peak VmData 1,652 MiB; derived heap 1,280 / watchdog 1,792 / kernel 2,816 MiB (recorded: 1,280 / 2,048 / 3,072 MiB).
<!-- /gen:measure -->

Method: the smallest V8 heap ceiling at which every at-limit file still parses is searched in steps
(512, 768, 1,024 … MiB) and multiplied by 1.5; the resident-memory and kernel limits are 1.5 × the measured peaks,
rounded up to 256 MiB, and ordered so that the heap ceiling acts first, then the watchdog, then the kernel
(watchdog ≥ heap + 512 MiB, kernel ≥ watchdog + 1,024 MiB, because the kernel limit also counts the address space
Node reserves at start-up, about 550 MiB). **Variance:** the heaviest file's peak varies between runs on the same
host by a few percent, enough to move the rounded watchdog value by one 256 MiB step; the recommendation keeps the
higher value seen in a full run, so that every legitimate at-limit file keeps a 1.5 × margin. In the full run of
2026-10-27 the heaviest file (L6) peaked at 1,211 MiB, giving watchdog 2,048 / kernel 3,072 MiB (results document as
committed in `8039708`); in the full run of 2026-10-28 (above) it peaked lower, giving 1,792 / 2,816 MiB. The whole
corpus passed under **both** sets: under the lower values in that full run, and under the recorded values in the
confirmation run whose results are in [`import-evaluation-results.md`](import-evaluation-results.md).

**Recommended limits per parse:** <!-- gen:limits -->V8 heap **1,280 MiB**, resident-memory watchdog **2,048 MiB**, kernel data limit **3,072 MiB**<!-- /gen:limits -->. These are recommendations from
this sandbox, not approved values; they are re-evaluated on the target host (§7).

### 5.2 Concurrency

**Setting (E-18, 2026-10-28): 1 parse at a time by default; never more than 2.** Imports beyond the active ones wait
in a queue with a visible status. The values are recorded in `tools/import-evaluation/lib/limits.mjs` (`OPERATIONAL`)
for the 1B-3 implementation; no operational import code exists yet.

Sandbox evidence (not the target host):

<!-- gen:load -->
| Parallel | Files | Outcomes | Time per parse | Peak per parse | Same rows for the same file | Host MemAvailable before / lowest |
|---|---|---|---|---|---|---|
| 2 | L6+L6 | ok, ok | 10.8–11.1 s | 940–941 MiB | True | 15,094 / 13,245 MiB |
| 2 | L1+L1 | ok, ok | 9.5–9.6 s | 836–856 MiB | True | 14,894 / 13,441 MiB |
| 2 | L6+L1 | ok, ok | 9.8–10.5 s | 846–920 MiB | True | 14,821 / 13,362 MiB |
| 4 (stress, above the approved maximum) | L6+L6+L6+L6 | ok, ok, ok, ok | 15.2–16.6 s | 864–949 MiB | True | 14,808 / 11,542 MiB |
| 4 (stress, above the approved maximum) | L1+L1+L1+L1 | ok, ok, ok, ok | 14.3–17.9 s | 816–856 MiB | True | 14,809 / 12,188 MiB |
<!-- /gen:load -->

**Evidence required before 2 parallel parses are enabled** (on the target host, with the server and PostgreSQL
running): the full harness passes with the recorded limits; the 2-parallel worst-case sets (L6 + L6, L1 + L1, L6 + L1)
all finish well inside 30 s with identical results; the host's `MemAvailable` before the test is at least
2 × the watchdog limit plus the memory the server and PostgreSQL need, and its lowest value during the test leaves
that reserve intact; the kernel limit, the watchdog and the 30 s kill each still act (isolation probes). If any of
this fails, concurrency stays 1 and the measurements are presented to you; no ceiling is raised.

### 5.3 Worker threads (why not)

A `worker_threads` worker with `resourceLimits` (64 MiB old generation) allocated **1,024 MiB of Buffers without
being stopped** — the limit covers only the worker's JavaScript heap. For ordinary objects the worker was eventually
stopped (`ERR_WORKER_OUT_OF_MEMORY`, main thread alive), <!-- gen:worker -->but only after 9.2 s, when the process's resident memory had reached 1,387 MiB — about 22 times the configured limit.<!-- /gen:worker --> ExcelJS
and JSZip hold file content in Buffers and strings. Worker threads also cannot be put under a separate kernel limit,
permission set or network namespace.

## 6. ExcelJS behavior found (all reproduced on synthetic files)

| # | Finding | Effect without a control | Control in the design |
|---|---|---|---|
| 1 | `cell.value` drops a formula's cached result when it is **0 or FALSE** (`FormulaValue._copyModel` tests truthiness) | A formula showing 0 or FALSE arrives blank; LibreOffice saves every TRUE/FALSE as a formula, so FALSE values from LibreOffice files would vanish | read `cell.result` (X28, N6) |
| 2 | Merged ranges report the top-left value in **every** cell of the range | One value imported several times | read merged ranges once (X28, N3–N6) |
| 3 | Merged and data-validation ranges are **expanded cell by cell**; column ranges create one object per column | With generous limits (4 GiB heap) a 2.4 KB file used about 4 GiB until the 30 s kill; under the recommended limits the heap ceiling, the watchdog or the 30 s kill stops it (X7u, X8u, X9u) | range budget and grid checks (X7–X10) |
| 4 | Part names are matched with **unanchored** patterns (`xl\/worksheets\/sheet\d+[.]xml` anywhere in the name) | A worksheet hidden at another path is parsed but not checked | parts outside their standard place are refused (H16) |
| 5 | Namespace-prefixed SpreadsheetML (`<x:c>`) is valid XML but ExcelJS does not read it (here: `TypeError`) | — the file is rejected, never imported empty | rejected (N8); had ExcelJS returned nothing instead, the "no cells read" rule refuses it; the user sees "the file could not be read" |
| 6 | An empty cached string result of a formula is lost | Same as blank | acceptable: blank never changes data |
| 7 | **Streaming reader**: damages multi-byte (Persian) characters at chunk boundaries; leaves shared strings unresolved when worksheets come before the shared-string table (Excel's own order); turns Excel's built-in date format 14 into numbers; returns cached TRUE/FALSE as 1/0; writes each worksheet to a temporary file | Corrupted Persian text and wrong values | **never used**; refused anyway by the confinement (no file writes) |
| 8 | saxes refuses DTD-based entities (X3u, X4u) | — | DTDs are refused before parsing in any case |
| 9 | Every other element that carries a range — sheet dimension, selection, shared and array formulas, hyperlinks, conditional formatting, auto filter, page breaks, tables — set to the whole grid is **not** expanded (0.3 s, about 75 MiB each, even without the pre-check) | — | none needed; kept in the corpus as regression cases (X19–X27) |

## 7. Acceptance gates before any operational import endpoint

ExcelJS stays **unapproved for operational use** until every gate below has passed and you have reviewed the
results; if any critical compatibility, security, licensing or resource-control concern remains, the evidence and
the alternatives (for example CSV-only import) are put to you instead.

These gates cover the parser and the import endpoint. Real spreadsheet data is also subject to the Excel Source
Admission Gate (O-14, proposed in the decision register). A preview-only test of the real spreadsheet (its stage 2)
needs its own approval and the minimum controls of §7.1, which satisfy none of the gates below; its operational
import (stage 3) needs its own approval and every gate below.

| # | Gate | State |
|---|---|---|
| G-1 | O-06 owner-side assessment done and its approved aggregate report reviewed (Phase 1B-3 starts only then) | **Satisfied through the documented alternative, not by the original procedure** (O-06 in the decision register, 2026-10-28): you did not run the assessment on your own PC; it ran in the development sandbox on a read-only copy of the backup you supplied, at your request, and its aggregate report was presented to you; you confirmed test data only, so no desktop data is migrated. Approving the O-06 record accepts this alternative in place of the owner-side run. Phase 1B-3 itself still needs your explicit authorization |
| G-2 | Representative workbooks **saved by Microsoft Excel** (invented data only) pass the harness with correct values — including Persian text, leading zeros, dates, formulas and merged cells | **Open** (no Excel in the sandbox; tested producers: openpyxl 3.1.5, XlsxWriter 3.2.9, LibreOffice Calc, ExcelJS 4.4.0, the corpus' own writer) |
| G-3 | Limits re-evaluated **on the target server**: full harness run there; memory limits re-derived; timings with margin against 30 s; if the margin is thin, a lower ceiling is proposed to you, never a higher time limit | **Open** |
| G-4 | Concurrency 2 only after the §5.2 evidence on the target host; until then 1 | **Open** (default 1) |
| G-5 | Every confinement layer can be established on the target host (kernel limits, permission model, network namespace — some distributions restrict unprivileged namespaces, for example through AppArmor); the server refuses imports if any layer is missing (fail closed) | **Open** (verified in the sandbox only) |
| G-6 | `npm audit signatures` passes for the parser dependencies | **Open** (blocked in the sandbox by the network policy) |
| G-7 | Third-party notice file with every licence text shipped with the server (§2.1) | **Open** |
| G-8 | After the parser is integrated into `server/` (Phase 1B-3): the same corpus as automated tests there, dependency audits, `verify_artifacts.py` and the complete verification suite (desktop and server) all pass; repeated after any later parser or dependency change | **Open** |
| G-9 | Preview with row-level validation, explicit confirmation, blank-never-erases, one transaction, idempotency, duplicates flagged and never merged — built and tested in 1B-3 | **Open** |

### 7.1 Minimum controls before a preview-only test of real spreadsheet data (O-14 stage 2, proposed)

A preview-only test parses a real spreadsheet, so it processes real data even though nothing is committed. Before
you can approve one, every control below must be implemented **and** verified, with the evidence put to you. They
are the minimum for that test only: meeting them satisfies **none** of the gates G-2…G-9 above, and operational
import (stage 3) still needs all of those.

| # | Control | Verified by |
|---|---|---|
| S2-1 | Prerequisites recorded: O-14 stage 1 approved for this file version; D-03 decided (deferral blocks stage 2); Phase 1B-3's staging, validation and preview pipeline built and tested on synthetic data; an agreed import field contract | The register; the 1B-3 test results |
| S2-2 | Only the admitted file: its SHA-256 is checked before parsing, and any other file is refused | A test with a changed file |
| S2-3 | Non-production isolation: a dedicated environment and database with no production data and no production credentials, no network path to production, reachable from a trusted network only (O-11) | Configuration review; a connection attempt to production from that environment fails |
| S2-4 | Resource limits and confinement on the host that runs the preview: the E-18 ceilings and the pre-check; a separate parse process with kernel memory, heap, watchdog and 30 s limits, no network and no file writes; one parse at a time; the parse is refused if any layer cannot be established (fail closed). This host is not necessarily the target server, so G-3…G-5 stay open | The isolation probes of the evaluation harness, run on that host |
| S2-5 | No operational writes and no commit: the commit step does not exist or is disabled in that environment; the preview writes only to staging and to the audit log (S2-7); its database role cannot write asset or status-history tables | Tests: a commit attempt is refused; asset and history row counts are unchanged after a preview |
| S2-6 | Preview results handled under the stage-1 privacy rule: shown only to the people it names; no export; no copy into the repository or out of that environment | Access review |
| S2-7 | Each preview run is audit-logged (who, when, file hash, outcome); staging data and preview results are deleted after the review, and the deletion is recorded | Audit entries; staging empty afterwards |

## 8. Remaining risks

1. **Unmaintained parser.** ExcelJS's last release is 2023-10-19; defects above are unlikely to be fixed upstream.
   The controls are written against 4.4.0's behavior; any version change must re-run this evaluation.
2. **Deprecated packages loaded** into the parser process (`glob@7`, `inflight`, `lodash.isequal`); contained by §3,
   kept under the audit gate.
3. **Hardware.** Timings are from a 4-core sandbox: <!-- gen:timing -->an at-limit file takes up to 13.1 s alone, up to 11.1 s with two in parallel and up to 17.9 s with four, against the 30 s ceiling.<!-- /gen:timing --> Results from
   this host are not evidence for the target host (G-3).
4. **Node's permission model** is documented by Node as a safeguard for trusted code, not a security boundary
   against malicious code; here it is one layer of six.
5. **Linear-growth parts** (comments, styles, drawings) are bounded only by the 100 MiB decompressed ceiling and the
   memory limits: <!-- gen:x18 -->1.5 million comments parsed in 6.5 s with 785 MiB (X18), within the limits.<!-- /gen:x18 -->
6. **Watchdog granularity:** it samples every 20 ms (<!-- gen:watchdog -->29 MiB past its limit was observed before the kill<!-- /gen:watchdog -->); the
   kernel limit is the hard bound.
7. **CSV** relies on Excel's "CSV UTF-8" export; other encodings are refused, not guessed.
