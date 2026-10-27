# Desktop app: interim restrictions on opening workbooks

Date: 2026-10-27. Status: **in force now**, until the desktop's spreadsheet library is replaced and that replacement
is verified (decision register, "D-15 (desktop scope)"). Nothing in the desktop app was changed for this; these
are rules for the people who use it.

## Why

The desktop app reads `.xlsx` and `.xls` files with `xlsx@0.18.5` (review F-5), which has two **high** advisories
and no fixed version on npm:

| Advisory | What a crafted workbook can do | Fixed in |
|---|---|---|
| [GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6) — prototype pollution | Alter the behaviour of the running app (it parses in the Electron main process, which has full access to the database file and the disk) | 0.19.3 (not on npm) |
| [GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9) — regular-expression denial of service | Freeze the app | 0.20.2 (not on npm) |

Both need a **crafted file** to be opened in the app's import screen. Verified in the source (read-only):
`.xlsx` and `.xls` go to `xlsx@0.18.5` (`src/main/parsers/excelParser.js`); **`.csv` goes to a different library**
(`papaparse`, `src/main/parsers/csvParser.js`) and never reaches `xlsx@0.18.5`; the type is chosen by the file
extension (`src/main/services/importService.js`).

## Rules until the replacement is verified

1. **Import a workbook (`.xlsx`) only if it was made inside the organization** — exported by the WAM desktop app
   itself, or filled in by staff from the organization's own template — and it came to you through an internal
   channel.
2. **Never import a workbook from outside or of unknown origin** directly: e-mail attachments from outside,
   downloads, files from suppliers or other organizations, removable media from third parties.
3. **To use data from outside:** open the file in Excel (keep Protected View on until you have checked it is what
   you expected), then **Save As → "CSV UTF-8 (Comma delimited)"**, and import the **CSV** instead. The desktop's
   CSV import does not use the affected library. Check in the import preview that codes and serial numbers kept
   their leading zeros.
4. **Never import legacy `.xls` files** from any source other than your own older exports; convert them as in
   rule 3.
5. **Make a backup in the app before every import**, so that a damaged database can be restored.
6. **If the app freezes or behaves strangely after opening a workbook:** close it completely (Task Manager if
   needed), start it again — this clears any effect on the running app — check the last changes, and report the
   file; do not open it again.
7. The duplicate rule stays in force (O-03): in the import screen choose **Skip**, never **Update**.

## What ends these restrictions

A separate desktop task, needing its own approval, done **before any new desktop release**: replace `xlsx@0.18.5`
in the desktop's import (for example with the parser and controls being evaluated for the web server — see
[`import-evaluation.md`](import-evaluation.md)), with regression tests of the import wizard and a check on Windows.
Until it is approved, no desktop source, dependency or packaging changes.
