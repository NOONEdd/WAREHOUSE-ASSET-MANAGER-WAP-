# Spreadsheet import: evaluation for O-13 and E-18 (D-15, server side)

Date: 2026-10-27. Status: **evaluation done on synthetic files in the Linux development sandbox; nothing added to
`server/`; ExcelJS not adopted.** Harness and runbook: [`tools/import-evaluation/`](../../tools/import-evaluation/).
Raw results of the final run are in [`import-evaluation-results.md`](import-evaluation-results.md).

## 1. Answers

| Question | Answer | Evidence |
|---|---|---|
| Does an explicit `unzipper` override remove `buffers@0.1.1`? | **Yes.** `unzipper` **0.12.5** inside ExcelJS removes 102 distinct packages, `buffers` among them, and adds 4 (MIT); the lockfile goes from 194 to **88** entries | §2 |
| Is the move from ExcelJS's declared `^0.10.11` to 0.12.5 compatible? | **Yes, demonstrated.** (a) The import path, `workbook.xlsx.load()`, never executes `unzipper` (it unzips with JSZip; `unzipper` is only loaded). (b) The only code that uses `unzipper`, ExcelJS's streaming reader, returns **byte-identical** output with 0.12.5 and with 0.10.14 on 8 files, two of them with 1,000,000 cells | §2.2 |
| Licences, versions, integrity, advisories | Every package declares a licence; none lacks one. 0 advisories (`npm audit`). Every package in the lockfile has a SHA-512 integrity hash. No install scripts. Two packages ship no licence file: `saxes` (ISC; text verified in the upstream repository at tag v5.0.1) and `isarray` (MIT; text in its README) | §2.1 |
| Is ExcelJS safe enough on hostile files? | **Only with the controls of §3**, which the evaluation found necessary: without them, a 2.4 KB file makes ExcelJS use about 4 GiB of memory (merged or validated ranges, column ranges). With them, all 87 cases end as expected (87/87 in the final run) | §4, §6 |
| Is a worker thread a sufficient resource limit? | **No.** A worker with a 64 MiB heap limit allocated 1,024 MiB of Buffers without being stopped. The design uses a separate, confined process | §3, §5.3 |
| E-18 ceilings | All eight enforced on the server side and tested at the boundary: exactly at the ceiling is accepted, one step over is refused with a message naming the ceiling | §4 |
| Memory limit | Recommended from measurement: V8 heap **1,280 MiB**, resident-memory watchdog **2,048 MiB**, kernel data limit **3,072 MiB** per parse | §5 |
| ExcelJS's streaming reader | **Must not be used**: it damages Persian text (U+FFFD in 174 and 236 places in two 1,000,000-cell files), leaves shared strings unresolved, turns Excel's built-in date format into numbers, and needs temporary files on disk | §6 |

**Recommendation (yours to decide):** approve the explicit override (`unzipper` 0.12.5, `uuid` 11.1.1) and ExcelJS
4.4.0 `load()` for Phase 1B-3, **with every control in §3 as a condition** and the checks of §7 before import is
switched on for users. If you do not want to carry ExcelJS's risks (§7), the alternative is **CSV-only import**
(strict `csv-parse`, no ZIP or XML parsing at all; users save as "CSV UTF-8"): smaller attack surface, at the cost of
one extra step for staff.

## 2. Dependency tree with the override

### 2.1 Tree

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
| Licences | — | MIT 72, ISC 10, Apache-2.0 2, BSD-3-Clause 2, (MIT AND Zlib) 1 (`pako`), (MIT OR GPL-3.0-or-later) 1 (`jszip`, used under MIT) |
| `npm audit` | 0 (with the `uuid` override) | **0** |
| Integrity | — | SHA-512 for all 88 entries |
| Install scripts | none | none |
| Deprecated | `fstream`, `rimraf`, `glob@7`, `inflight`, `lodash.isequal` | `glob@7.2.3`, `inflight@1.0.6`, `lodash.isequal@4.5.0` (all on ExcelJS's writing side: `archiver`, `fast-csv`) |

Not verified: `npm audit signatures` (the registry's signature endpoint could not be reached from the sandbox).

**Licence texts:** `saxes@5.0.1` declares ISC but ships no licence file; the upstream repository's `LICENSE` at tag
`v5.0.1` is ISC (fetched 2026-10-27, SHA-256 `0fac2374…7f061d0e`; it also carries the ISC notice of `sax`, from which
`saxes` was forked). `isarray@1.0.0` declares MIT and carries the MIT text in its README. Both texts belong in the
third-party notice file when the parser is adopted; nothing was changed or suppressed.

**Loaded at run time:** `require('exceljs')` loads 65 packages, including the deprecated `glob@7`, `inflight` and
`lodash.isequal`, although the reading path never calls them. They run only inside the confined parser process (§3).

### 2.2 Compatibility of the override

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
| 3 | **V8 heap ceiling** `--max-old-space-size` | Heap growth (most of ExcelJS's memory) | probe: heap growth → stopped |
| 4 | **Resident-memory watchdog** in the supervisor (VmRSS every 20 ms) and **wall-clock kill at 30 s** | Resident growth below the kernel limit; endless loops | probes: Buffer growth with the kernel limit switched off → killed; endless loop → killed at 30.0 s |
| 5 | **Node permission model**: read access to the parser's own folder only; no file writes, no child processes, no worker threads | Writing or reading files, starting programs | probe: all four refused (`ERR_ACCESS_DENIED`) |
| 6 | **No network**: a new network namespace (`unshare -r -n`) | Connections from the parser | probe: `ENETUNREACH` inside, connection allowed without it |
| 7 | **Pre-check** before ExcelJS sees the file (`zip-inspect.mjs`): ZIP structure from the central directory (entry count, names, no traversal or absolute paths, no symlinks, encryption, ZIP64, macros or unknown methods); every entry inflated with a hard cap at its declared size, then size and CRC-32 checked; **no DTD or entity declaration in any XML part**; every worksheet scanned for rows, cells and every coordinate ExcelJS acts on | ZIP bombs (truthful or lying), XXE, entity expansion, oversized or out-of-grid sheets, range-expansion bombs | §4, §6 |
| 8 | **JSZip cross-check**: JSZip (what `load()` uses) must see exactly the parts, sizes and checksums the pre-check checked | Two ZIP readers disagreeing about one file (a known trick to slip content past a check) | N3: legitimate folder entries pass. No disagreement got past the pre-check in this corpus (duplicates, H14, are caught there first); the cross-check is the second line |
| 9 | **Typed row output with an authoritative recount** of what ExcelJS built, against the same ceilings | Anything the pre-check undercounts | every `ok` case |
| 10 | **Value rules**: formula cells read through `cell.result` and flagged, never evaluated; merged ranges read once at the top-left cell; blank cells are not output at all; text over 32,767 characters and formula-like text are flagged; a parse that sees no cells in a file that has some is refused | Silent data loss or invention (§6) | N1–N6 (values), X5 (no cells read → refused), X6 (overlong text flagged), C6 (formula-like text) |
| 11 | **Strict CSV**: valid UTF-8 only (fatal decoding), no NUL, `csv-parse` with strict quotes and equal column counts, no type casting | Mis-decoded or ambiguous text files | C1–C7, N7 |

The supervisor also caps what the child may send back (3 × the decompressed ceiling) and accepts only its line
protocol. Parser messages are never passed on (they can quote file content); the user sees only the pre-check's own
messages or "the file could not be read".

## 4. E-18 ceilings: enforcement and boundary tests

All values as set by you; all enforced in the parser process before and after ExcelJS runs. "At" cases must be
accepted, "over" cases refused with the named ceiling. Results of the final run (verification run of 2026-10-27 23:12 UTC under the recorded limits):

| Ceiling | At the value | Result | Time | One step over | Result (message) |
|---|---|---|---|---|---|
| rows 50,000 | L1: rows 50,000; cells 1,000,000 | accepted | 10.2 s | O2: rows 50,001 | refused (limit exceeded: rows (50001)) |
| cells 1,000,000 | L1: rows 50,000; cells 1,000,000 | accepted | 10.2 s | O4: cells 1,000,001 | refused (limit exceeded: cells (1000001)) |
| worksheets 20 | L2: worksheets 20 | accepted | 11.6 s | O1: worksheets 21 | refused (limit exceeded: worksheets (21)) |
| columns 100 per worksheet | L3: columns 100 | accepted | 7.4 s | O3: column 101 | refused (limit exceeded: columnsPerSheet (xl/worksheets/sheet1.xml: column 101)) |
| ZIP entries 1,000 | L5: ZIP entries 1,000 | accepted | 0.6 s | O5: ZIP entries 1,001 | refused (limit exceeded: zipEntries (1001)) |
| decompressed 100 MiB | L11: decompressed exactly 100 MiB | accepted | 1.7 s | O6: decompressed 100 MiB + 1 byte | refused (limit exceeded: decompressedBytes (declared 104857601 bytes)) |
| compressed 10 MiB | L8: compressed exactly 10 MiB | accepted | 0.4 s | O7: compressed 10 MiB + 1 byte | refused (limit exceeded: compressedBytes (more than 10485760 bytes)) |
| CSV rows 50,000 | L4: CSV 50,000 rows x 20 columns | accepted | 1.2 s | O8: CSV rows 50,001 | refused (limit exceeded: rows (50001)) |
| CSV columns 100 | L9: CSV with exactly 100 columns | accepted | 0.1 s | O9: CSV columns 101 | refused (limit exceeded: columnsPerSheet (row 1: 101)) |
| CSV file 10 MiB | L10: CSV of exactly 10 MiB | accepted | 1.3 s | O10: CSV 10 MiB + 1 byte | refused (limit exceeded: compressedBytes (more than 10485760 bytes)) |
| wall clock 30 s | every file above | all finished in at most 14.8 s | — | endless loop in the parser process | killed after 30.0 s |

**Derived controls** (not your ceilings; they follow from how ExcelJS works and only ever refuse more):

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
(D-15 review §4.8–4.11). They need the asset schema and cannot be tested before Phase 1B-3, which waits for O-06.
What this evaluation already fixes at the parser boundary: blank cells produce **no value at all** (not an empty
string), so nothing downstream can mistake a blank for "erase"; every value carries its type; formulas, overlong text
and formula-like text are flagged for the preview.

## 5. Memory and time

### 5.1 Measurement (generous limits) and derivation

| Case | File | Time | Peak resident memory | Peak VmData |
|---|---|---|---|---|
| L1 | 50,000 rows x 20 columns = 1,000,000 cells, one sheet, unique shared strings (7,122,775 bytes) | 9.2 s | 1,099 MiB | 1,577 MiB |
| L2 | 20 worksheets x 2,500 rows x 20 columns = 1,000,000 cells (7,036,545 bytes) | 10.1 s | 906 MiB | 1,385 MiB |
| L3 | 10,000 rows x 100 columns = 1,000,000 cells (3,885,632 bytes) | 6.8 s | 913 MiB | 1,392 MiB |
| L4 | CSV 50,000 rows x 20 columns = 1,000,000 cells, just under 10 MiB (9,999,999 bytes) | 1.4 s | 274 MiB | 756 MiB |
| L6 | 1,000,000 cells of longer text, 99.3 MiB decompressed (5.7 MiB compressed) (5,958,725 bytes) | 11.6 s | 1,211 MiB | 1,691 MiB |
| L7 | 1,000,000 random (incompressible) shared strings, 9.4 MiB compressed (9,894,929 bytes) | 9.3 s | 933 MiB | 1,412 MiB |
| X6 | one 90 MiB cell (Excel allows 32,767 characters) (94,129 bytes) | 3.1 s | 756 MiB | 1,496 MiB |

Smallest heap ceiling at which every at-limit file parses: **768 MiB** (512 MiB fails on L6). Peak resident memory 1,211 MiB, peak VmData 1,691 MiB (full run of 2026-10-27).

Method: the smallest V8 heap ceiling at which every at-limit file still parses was searched in steps
(512, 768, 1,024 … MiB) and multiplied by 1.5; the resident-memory and kernel limits are 1.5 × the measured peaks,
rounded up to 256 MiB, and ordered so that the heap ceiling acts first, then the watchdog, then the kernel
(watchdog ≥ heap + 512 MiB, kernel ≥ watchdog + 1,024 MiB, because the kernel limit also counts the address space
Node reserves at start-up, about 550 MiB).

**Recommended limits per parse:** V8 heap **1,280 MiB**, resident-memory watchdog **2,048 MiB**, kernel data limit **3,072 MiB**. The confirmation run verified all cases under exactly these values.

### 5.2 Concurrency

| File | Four parallel parses | Time per parse | Peak per parse | Same rows in all four |
|---|---|---|---|---|
| L6 | ok, ok, ok, ok | 15.9–16.2 s | 858–918 MiB | True |
| L1 | ok, ok, ok, ok | 13.8–17.0 s | 812–850 MiB | True |

Worst case per parse is the watchdog value; **N parallel parses need N × that much memory**. Proposal: one queue
with at most **2** parses at a time (configurable), so the parser can never take more than about 4,096 MiB of the
server's memory; further imports wait in the queue with a visible status. The server's memory size is not known yet
(D-04, deployment).

### 5.3 Worker threads (why not)

A `worker_threads` worker with `resourceLimits` (64 MiB old generation) allocated **1,024 MiB of Buffers without
being stopped** — the limit covers only the worker's JavaScript heap. For ordinary objects the worker was eventually stopped
(`ERR_WORKER_OUT_OF_MEMORY`, main thread alive), but only after 8.3 s, when the process's resident memory
had reached 1,342 MiB — about twenty times the configured limit. ExcelJS and JSZip hold file content in Buffers and
strings. Worker threads also cannot be put under a separate kernel limit, permission set or
network namespace.

## 6. ExcelJS behavior found (all reproduced on synthetic files)

| # | Finding | Effect without a control | Control in the design |
|---|---|---|---|
| 1 | `cell.value` drops a formula's cached result when it is **0 or FALSE** (`FormulaValue._copyModel` tests truthiness) | A formula showing 0 or FALSE arrives blank; LibreOffice saves every TRUE/FALSE as a formula, so FALSE values from LibreOffice files would vanish | read `cell.result` (N6 verifies it) |
| 2 | Merged ranges report the top-left value in **every** cell of the range | One value imported several times | read merged ranges once (N3–N6 check it) |
| 3 | Merged and data-validation ranges are **expanded cell by cell**; column ranges create one object per column | With generous limits (4 GiB heap) a 2.4 KB file used about 4 GiB until the 30 s kill; under the recommended limits the heap ceiling, the watchdog or the 30 s kill stops it (X7u, X8u, X9u) | range budget and grid checks (X7–X10) |
| 4 | Part names are matched with **unanchored** patterns (`xl\/worksheets\/sheet\d+[.]xml` anywhere in the name) | A worksheet hidden at another path is parsed but not checked | parts outside their standard place are refused (H16) |
| 5 | Namespace-prefixed SpreadsheetML (`<x:c>`) is valid XML but ExcelJS does not read it (here: `TypeError`) | — the file is rejected, never imported empty | rejected (N8); had ExcelJS returned nothing instead, the "no cells read" rule refuses it; the user sees "the file could not be read" |
| 6 | An empty cached string result of a formula is lost | Same as blank | acceptable: blank never changes data |
| 7 | **Streaming reader**: damages multi-byte (Persian) characters at chunk boundaries; leaves shared strings unresolved when worksheets come before the shared-string table (Excel's own order); turns Excel's built-in date format 14 into numbers; returns cached TRUE/FALSE as 1/0; writes each worksheet to a temporary file | Corrupted Persian text and wrong values | **not used**; refused anyway by the confinement (no file writes) |
| 8 | saxes refuses DTD-based entities (X3u, X4u) | — | DTDs are refused before parsing in any case |
| 9 | Every other element that carries a range — sheet dimension, selection, shared and array formulas, hyperlinks, conditional formatting, auto filter, page breaks, tables — set to the whole grid is **not** expanded (0.3 s, about 75 MiB each, even without the pre-check) | — | none needed; kept in the corpus as regression cases (X19–X27) |

## 7. Remaining risks and checks before import is switched on

1. **Unmaintained parser.** ExcelJS's last release is 2023-10-19; defects above are unlikely to be fixed upstream.
   The controls are written against 4.4.0's behavior; any version change must re-run this evaluation.
2. **Deprecated packages loaded** into the parser process (`glob@7`, `inflight`, `lodash.isequal`); contained by §3,
   kept under the audit gate.
3. **Not tested with files saved by Microsoft Excel** (not available in the sandbox). Tested producers: openpyxl
   3.1.5, XlsxWriter 3.2.9, LibreOffice Calc, ExcelJS 4.4.0 and the corpus' own writer. **Check before adoption:** a
   few workbooks saved by Excel on your PC, with invented data only, run through the harness.
4. **Hardware.** Timings are from a 4-core sandbox: an at-limit file takes up to 14.8 s alone and 17.0 s with
   four in parallel, against the 30 s ceiling. **Re-run the harness on the target server** and confirm the margin
   before switching import on; if it is thin, propose a lower ceiling to you rather than raising the time limit.
5. **Network namespace availability.** Unprivileged `unshare -n` worked in the sandbox; some distributions restrict
   it (for example by an AppArmor setting). The server must check at start-up that every confinement layer can be
   established and **refuse imports otherwise** (fail closed), or obtain the same effect from the service manager.
6. **Node's permission model** is documented by Node as a safeguard for trusted code, not a security boundary
   against malicious code; here it is one layer of six.
7. **Linear-growth parts** (comments, styles, drawings) are bounded only by the 100 MiB decompressed ceiling and the
   memory limits: 1.5 million comments parsed in 6.8 s with 742 MiB (X18), within the limits.
8. **Watchdog granularity:** it samples every 20 ms (40 MiB past its limit was observed before the kill); the kernel limit
   is the hard bound.
9. **CSV** relies on Excel's "CSV UTF-8" export; other encodings are refused, not guessed.
