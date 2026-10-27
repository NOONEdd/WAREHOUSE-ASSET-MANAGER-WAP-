# Project status

Snapshot: **2026-10-27, fifth session**. Replace this file's contents at the end of each work session; history
stays in Git.

## Where things are

| Reference | Commit | On GitHub? | Content |
|---|---|---|---|
| `main` | `efbd65a9ca123c1ac03d464087628097671a0290` | yes (unchanged) | Desktop baseline |
| tag `desktop-baseline-efbd65a` | tag object `6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5` → `efbd65a9…` | **no** — a separate task you run locally (O-02); see [owner actions](#owner-actions) | Protects the baseline |
| `phase-1a/repo-safety-net` | `c819994e80cfdc0262677b0e359eb14a5b9765cc` | yes | Phase 1A |
| `ccr-1860034b-yp0csr` (session branch) | GitHub: `9c3ac79` (fourth push under O-10, verified). **Locally ahead by the commits below** | up to `9c3ac79` | Phase 1B-1, 1B-2 with MFA, O-12, O-06 tools, D-15; this session's evaluation locally |

**Local only** — pushing them needs a new approval:

| Commit | Content |
|---|---|
| `6ac697d` | O-06 script refuses unsafe input before reading any data; runbook clarified |
| the commit containing this file | O-13 / E-18 evaluation harness (`tools/import-evaluation/`), evidence, desktop interim restrictions, register and status |

Nothing was merged into `main`, tagged, released or deployed. No desktop file and no `server/` file changed
(`git diff 9c3ac79 HEAD` touches only `docs/` and `tools/`).

## Phase 1B-3 gate — **not passed**

| # | Condition | State |
|---|---|---|
| 1 | Authorized commits pushed and verified | **Met** for everything up to `9c3ac79` |
| 2 | O-06 | **Explicit blocker. Gate status: O-06 script prepared and synthetically tested; owner-side assessment pending.** A passing self-test does not complete it. |
| 3 | D-15 (server) recorded; dependencies reviewed | **Met**; O-13 investigated (override demonstrated); ExcelJS adoption awaits your decision |
| 4 | O-12 recorded and enforced | **Met** (`5ddf4cf`, on GitHub) |
| 5 | Documents agree | **Met** with this commit (register, STATUS, D-15 review, evaluation, matrix, interim restrictions) |

Until condition 2 is met — your run done and the aggregate report you approve reviewed — there is **no Phase 1B-3
work, no asset table and no migration-rehearsal database**.

## This session

| Item | Result |
|---|---|
| **O-13** | `unzipper` 0.12.5 override removes `buffers@0.1.1`: lockfile 194 → 88 entries, every package licensed, audit 0, SHA-512 integrity for all, no install scripts. Compatibility demonstrated: `load()` does not execute `unzipper`; the streaming reader's output is byte-identical with 0.12.5 and 0.10.14 on 8 files. **ExcelJS stays unapproved** until you decide; recommendation: approve with the conditions in [`security/import-evaluation.md`](security/import-evaluation.md); alternative: CSV-only import |
| **E-18** | Your eight ceilings enforced and boundary-tested (each accepted exactly at the value and refused one step over; final run 87/87 cases); memory limit per parse derived from measurement: heap 1,280 MiB, watchdog 2,048 MiB, kernel 3,072 MiB |
| **Isolation** | Confined child process per file; a worker thread was shown to be insufficient (its limit does not cover Buffers) |
| **ExcelJS defects found** | falsy formula results lost via `cell.value`; merged values repeated; range expansion (a 2.4 KB file → ~4 GiB); unanchored part names; the streaming reader damages Persian text — all handled by the design or excluded |
| **D-15 desktop scope** | Server-only confirmed; desktop replacement is separate work before a new desktop release; interim restrictions: [`security/desktop-workbook-interim-restrictions.md`](security/desktop-workbook-interim-restrictions.md) |
| **O-06** | Unchanged: waiting for your run |

## Verification of this session (Linux sandbox; **nothing run on Windows, nothing on real data**)

| Check | Result |
|---|---|
| Import evaluation, full run (measure, derive, verify, streaming comparison, isolation probes, load test), `tools/import-evaluation`, Node 24.22.1, 4 cores | exit 0: 75/75 cases; derived limits heap 1,280 / watchdog 2,048 / kernel 3,072 MiB |
| Import evaluation, confirmation run under exactly those recorded limits (`--quick`, corpus extended to 87 cases) | **exit 0: 87/87 cases**; `load()` deterministic with intact text; four parallel parses ok; every isolation layer acted. Results: [`security/import-evaluation-results.md`](security/import-evaluation-results.md) |
| `compare-unzipper.mjs` (streaming reader with `unzipper` 0.12.5 vs 0.10.14, 8 files) | exit 0: identical output for all 8 |
| Dependency tree (`tools/import-evaluation`) | 88 lockfile entries, no install scripts, SHA-512 for all, every package licensed, `npm audit` 0; `npm audit signatures` **not verified** (endpoint unreachable) |
| Repository suites (desktop `npm run verify`, server `npm run verify`, O-06 self-test) on a fresh clone of this commit | recorded in the next status commit |

## Known limitations and risks

1. **Trusted network only (O-11):** MFA for all staff before any public exposure.
2. **Deployment blocker:** behind a reverse proxy, `trustProxy` must be set to the proxy's address.
3. **MFA key:** no rotation command yet (L-8); a tested rotation and recovery procedure is required before production.
4. **First enrolment trusts the password** (always before appointment, A7); TOTP is not phishing-resistant (L-9).
5. **Spreadsheet import (not built yet):** ExcelJS is unmaintained and loads deprecated packages; not tested with
   files saved by Microsoft Excel; timings must be re-measured on the target server; the network-namespace layer may
   need configuration on the target host (import-evaluation §7).
6. **Desktop:** `xlsx@0.18.5` (two high advisories) stays until the separate replacement task; interim rules apply.
7. **O-06 script:** shell-level behavior unverified until your first run; heuristics can misclassify both ways.
8. No breached-password check; no general rate limit; audit trail not shipped off the server.

## Owner actions

1. **O-06 (blocker):** review `tools/data-quality/o06-data-quality.sql` and its README, run it on a renamed copy of
   a fresh desktop backup, read the report, and share what you choose. Optional first: the synthetic dry run.
2. **Push approval** for `6ac697d` and this session's commit, if you want them on GitHub (bundle backup provided).
3. **ExcelJS decision:** approve ExcelJS 4.4.0 `load()` with the overrides and the conditions of
   import-evaluation §1/§3/§7 for Phase 1B-3, or choose CSV-only import. Optional check: a few workbooks saved by
   Microsoft Excel on your PC (invented data only) through the harness.
4. **E-18 follow-ups:** acknowledge the derived controls (import-evaluation §4) and the proposal of at most 2 parses
   at a time; the server's memory size (D-04) decides the final concurrency.
5. **Staff rules now:** the desktop interim restrictions on workbooks, and **Skip**, never **Update**, for
   duplicates (O-03).
6. **Desktop replacement of `xlsx@0.18.5`:** separate approval when you want it scheduled (before a new desktop release).
7. **Publish the baseline tag (O-02)** — a separate task you run locally; I perform no tag operation. On your PC, in
   the repository folder, with `WAM_Phase1A_closure.bundle`:
   ```
   git fetch "PATH\TO\WAM_Phase1A_closure.bundle" refs/tags/desktop-baseline-efbd65a:refs/tags/desktop-baseline-efbd65a
   git rev-parse "desktop-baseline-efbd65a^{commit}"     # must print efbd65a9ca123c1ac03d464087628097671a0290
   git push origin refs/tags/desktop-baseline-efbd65a
   git ls-remote origin refs/tags/desktop-baseline-efbd65a   # must print 6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5
   ```
   Then in GitHub → Settings → Rules, protect `main` (require a pull request) and protect tags `desktop-baseline-*`.
8. When you can: O-03 and O-04 (desktop fixes), D-02 (warehouse list, privately), D-03 (mapping source and
   reviewer), D-06 (approvals), the WSL2 readiness checks (sheet T-5).
