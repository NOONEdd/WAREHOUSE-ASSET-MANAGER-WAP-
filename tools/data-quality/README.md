# O-06 — read-only data-quality assessment of the desktop database

Decision **O-06, option B** (2026-10-27): the owner runs a reviewed, read-only, aggregate-only script on their own
PC, against a **copy** of the desktop database, inspects the output, and decides what may be shared. Nobody else
touches the real data. The results inform the Phase 1B-3 schema and migration rehearsal.

| File | What it is |
|---|---|
| `o06-data-quality.sql` | The script. **Review it before running it.** SELECT statements and read-only PRAGMA functions only. |
| `test_o06_data_quality.py` | Self-test on a synthetic database built from the desktop schema (optional to run, Python 3.9+, standard library only). |

## Safety properties — check them while reviewing

- **Read-only, three times over.** The command below opens the copy with `-readonly` and `mode=ro&immutable=1` (SQLite
  writes nothing, not even journal side files); the script's first statement sets `PRAGMA query_only = ON`, so SQLite
  refuses any write on that connection; and the script contains no `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`,
  `ALTER`, `ATTACH`, `VACUUM` or `REINDEX`.
- **Never the live database.** It stops at its first query if the file is still named `asset-warehouse.db` (the
  desktop app's live file). Work only on a renamed copy of a backup.
- **Aggregates only.** No asset name, asset code, serial number, person name, username, note, lookup name or file path
  is printed. Besides counts and percentages it prints only: status and role names, audit-log action and entity-type
  codes, the earliest and latest history/audit dates, the journal mode, and SQLite's own table, index and integrity
  messages.
- **Facts and heuristics are labelled.** `[FACT]` sections report what the database contains. `[HEURISTIC]` sections
  (placeholder-looking serials, near-duplicates, date formats, similar lookup names) are pattern-based guesses that can
  be wrong in both directions; they only show where to look.

## Prerequisites (on your PC; nothing is installed by me)

1. **The current desktop app**, to make a fresh backup (it runs its database migrations at start-up, so the backup has
   the current structure).
2. **The SQLite command-line shell, version 3.33 or later** (`.mode box` needs 3.33). For Windows: the official
   "sqlite-tools-win-x64" ZIP from <https://sqlite.org/download.html> — a single `sqlite3.exe`, no installer; compare
   the SHA3-256 hash shown on that page. Alternatively inside WSL2 (decision D-08): `sudo apt install sqlite3`.
   Graphical tools such as DB Browser for SQLite are **not** suitable: they do not run the shell settings at the top
   of the script and show only the last result.
3. **Optional:** Python 3.9 or later, to run the self-test on synthetic data first.

## Steps (Windows Command Prompt, `cmd.exe`)

1. In the desktop app, make a backup (the backup function uses SQLite's own backup API, so the file is complete and
   consistent; a plain copy of the live file can miss recent changes, because the app runs in WAL mode).
2. Create a working folder, for example `C:\WAM-assessment`, and copy **the new backup file** into it. Rename the copy
   to `wam-copy.db`. Never point the script at the live file in the app's data folder (`…\asset-warehouse.db`).
3. Put `o06-data-quality.sql` and `sqlite3.exe` in the same folder.
4. Note the copy's fingerprint (to confirm afterwards that nothing changed it):
   ```
   cd C:\WAM-assessment
   certutil -hashfile wam-copy.db SHA256
   ```
5. Run the assessment; the report is written to `o06-report.txt` (UTF-8):
   ```
   sqlite3.exe -readonly "file:wam-copy.db?mode=ro&immutable=1" ".output o06-report.txt" ".read o06-data-quality.sql"
   ```
   If it stops early, the reason is printed in the window (for example the live-file-name check). Nothing has been
   changed in that case either. If your shell version rejects the two quoted commands at the end, use this equivalent
   form instead (in `cmd.exe`, not PowerShell):
   ```
   sqlite3.exe -readonly "file:wam-copy.db?mode=ro&immutable=1" < o06-data-quality.sql > o06-report.txt
   ```
6. Run step 4 again; the fingerprint must be identical.
7. Open `o06-report.txt` (for example in Notepad) and read it. **You decide what may be shared.** You can redact status
   names or anything else before sending it.
8. Keep `wam-copy.db` in a protected place — it contains the real data — or delete it when you no longer need it.
   Do not e-mail or upload it.

Optional dry run before step 1 (uses only invented data, never your database):
```
python -I test_o06_data_quality.py
```
It needs the repository checkout (it reads the desktop schema from `src/main/database/schema.sql`) and must print
`o06 self-test passed`.

## What was verified, and what was not (2026-10-27)

- **Verified** in the development sandbox with the SQLite **3.45.1** engine (through Python's `sqlite3` module), on a
  synthetic database built from the desktop's `schema.sql` with planted problems: every statement runs; the file is
  byte-identical afterwards and no side files appear; writes are refused after `query_only`; no synthetic name, code,
  serial, username, note, lookup name or path appears in the output; every printed text value is one of the kinds
  listed above; the counts match the planted problems; the live-file-name check stops the run.
- **Not verified:** the four shell settings at the top (`.bail`, `.headers`, `.mode box`, `.nullvalue`) and the exact
  command in step 5 — the sqlite3 shell could not be downloaded in the sandbox (network policy). Nothing has been run
  on Windows or on real data.

## How the results will be used (Phase 1B-3)

| Finding | Effect on the schema and the migration rehearsal |
|---|---|
| Blank and placeholder-looking serials | The web schema allows **"serial unknown"** explicitly; no serial is ever invented, and placeholders are flagged for review, not converted automatically. |
| Exact and near-duplicate serials and codes | Reported in the import preview as **suspected duplicates**; never merged automatically. |
| No warehouse field (all assets) | Every migrated asset starts in `UNASSIGNED`; assignment is a reviewed business task (D-02, D-03). Workshops are never used as warehouses; no warehouse is inferred. |
| Status values, including legacy and inactive ones | An explicit status mapping table reviewed by you; unmapped values block the rehearsal rather than being guessed. |
| Status history gaps | Migrated as-is and reported; history is never fabricated. |
| Date formats | Parsing rules per detected format; ambiguous values are flagged, not guessed. |
| Leading zeros, Persian/Arabic digits and letters | Stored exactly as written (text); normalization is used only for duplicate detection. |
| Integrity and broken references | Must be `ok` / explained before any rehearsal on a copy. |
