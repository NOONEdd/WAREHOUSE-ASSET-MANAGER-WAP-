# Project status

Snapshot: **2026-10-28, sixth session**. Replace this file's contents at the end of each work session; history
stays in Git.

## Where things are

| Reference | Commit | On GitHub? | Content |
|---|---|---|---|
| `main` | `efbd65a9ca123c1ac03d464087628097671a0290` | yes (unchanged) | Desktop baseline |
| tag `desktop-baseline-efbd65a` | tag object `6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5` → `efbd65a9…` | **no** — a separate task you run locally (O-02); see [owner actions](#owner-actions) | Protects the baseline |
| `phase-1a/repo-safety-net` | `c819994e80cfdc0262677b0e359eb14a5b9765cc` | yes (unchanged) | Phase 1A |
| `ccr-1860034b-yp0csr` (session branch) | GitHub: **`18b4c6b6415161d4c806783ce186c4c8ae596a83`** (fifth push under O-10, 2026-10-28, verified with `git ls-remote` and the GitHub API). **Locally ahead by the commits below** | up to `18b4c6b` | Phase 1B-1, 1B-2 with MFA, O-12, O-06 tools, D-15, O-13/E-18 evaluation |

Pushed this session (fast-forward `9c3ac79..18b4c6b`, no force, after checking ancestry, full diffs, remote state,
secrets and personal data, and that desktop source, build configuration, root package files, `server/`, `main` and
`phase-1a/repo-safety-net` were untouched): `6ac697d`, `8039708`, `18b4c6b`. The bundle backup was kept until the
remote branch was verified at `18b4c6b`, and is still kept.

**Local only** — pushing them needs a new approval:

| Commit | Content |
|---|---|
| the commit before the one containing this file | O-13 selection and artifact verification; E-18 approval: CSV fields counted as processed cells, exact and first-over boundary cases for CSV cells and the 30 s limit, cached-formula and merged-cell regression case, concurrency 1 by default / 2 at most with a 2-parallel load test and host-memory sampling; documents brought into line |
| the commit containing this file | Verification results of that commit (table below) |

Nothing was merged into `main`, tagged, released or deployed. No desktop file and no `server/` file changed.

## Phase 1B-3 gate — **not passed**

| # | Condition | State |
|---|---|---|
| 1 | Authorized commits pushed and verified | **Met** for everything up to `18b4c6b` |
| 2 | O-06 | **Explicit blocker. Gate status: O-06 script prepared and synthetically tested; owner-side assessment pending.** Synthetic tests and evaluation runs do not satisfy it. |
| 3 | D-15 (server) recorded; dependency selected | **Met** for selection (O-13, 2026-10-28); ExcelJS is **not approved for operational use** (acceptance gates G-1…G-9 below) |
| 4 | O-12 recorded and enforced | **Met** (`5ddf4cf`, on GitHub) |
| 5 | Documents agree | **Met** with these commits (register, STATUS, architecture review, D-15 review, evaluation, results, matrix, interim restrictions, tools READMEs) |

Until condition 2 is met — your run done and the aggregate report you approve reviewed — there is **no Phase 1B-3,
no asset schema finalized or implemented, no asset table, no migration-rehearsal database and no SQLite → PostgreSQL
rehearsal**.

## This session

| Item | Result |
|---|---|
| **A. Push** | `6ac697d`, `8039708`, `18b4c6b` pushed as a normal fast-forward; branch verified at `18b4c6b` |
| **B. O-13 selection** | ExcelJS 4.4.0 + explicit `unzipper@0.12.5` (+ `uuid@11.1.1`) + strict `csv-parse@7.0.3` selected — **not approved for operational use**. Final tree: 88 lockfile entries, `npm ls --all` clean, `buffers` absent. Against the published artifacts: SHA-512 recomputed from every tarball equals the lockfile (88/88); installed files byte-identical to the tarballs (88/88 packages, 2,186 files). Licences all permissive and declared; open: third-party notice file (`saxes` ships no text — upstream ISC verified; `isarray` text only in README). `npm audit` 0. `npm audit signatures` not verifiable here (network policy denies `tuf-repo-cdn.sigstore.dev`) |
| **C. E-18 approved** | Eight maximums enforced in the parser process; every exact boundary accepted and the first value above refused, now including CSV processed cells (every field counts, blank or not: 1,000,000 accepted, 1,000,004 and a mostly blank 1,000,100 refused) and the wall clock (29.5 s of work completes, 30.1 s is stopped at 30.0 s). Concurrency **1** by default, **2** at most, recorded in `lib/limits.mjs` (`OPERATIONAL`); a 2-parallel worst-case load test with host `MemAvailable` sampling added |
| **D. O-06** | Unchanged and blocking: script and runbook ready; your run pending |
| **Defects guarded** | ExcelJS `cell.value` loses cached 0/FALSE results and repeats merged values — now a dedicated regression case (X28) besides the producer files; the streaming reader is never used (Persian text damage) |

## Verification of this session (Linux sandbox; **nothing run on Windows, nothing on real data, not the target host**)

| Check | Result |
|---|---|
| `git ls-remote origin` and GitHub API after the push | `ccr-1860034b-yp0csr` = `18b4c6b6415161d4c806783ce186c4c8ae596a83`; `main` = `efbd65a`, `phase-1a/repo-safety-net` = `c819994` (unchanged); no tag |
| `npm ci --ignore-scripts` (clean, `tools/import-evaluation`), `npm ls --all`, `npm ls buffers` | 88 packages; `npm ls` exit 0; `buffers` absent; overrides `unzipper@0.12.5`, `uuid@11.1.1` applied; lockfile unchanged |
| `python3 -I verify_artifacts.py …` (every tarball downloaded with `npm pack`) | exit 0: SHA-512 equals lockfile 88/88; installed files identical to tarballs 88/88 packages (2,186 files); licence field 88/88 |
| `npm audit` (`tools/import-evaluation`) | 0 vulnerabilities |
| `npm audit signatures` | **not verified**: exit 1, HTTP 403 — the network policy denies `tuf-repo-cdn.sigstore.dev` |
| `node run-evaluation.mjs` (full: measure, derive, verify, streaming comparison, isolation probes, load) after the parser change | **exit 0: 90/90 cases** under the derived heap 1,280 / watchdog 1,792 / kernel 2,816 MiB |
| `node run-evaluation.mjs --quick` under the recorded heap 1,280 / watchdog 2,048 / kernel 3,072 MiB | **exit 0: 90/90 cases**; `load()` deterministic with intact text; every isolation layer acted (incl. 29.5 s completes, 30.1 s stopped); 2 parallel worst-case parses ok in at most 11.1 s, host `MemAvailable` never below 13,245 MiB (16 GiB host). Results: [`security/import-evaluation-results.md`](security/import-evaluation-results.md) |
| `compare-unzipper.mjs` | exit 0 on 2026-10-27 (identical output for all 8 files); the code path it tests did not change |
| Desktop `npm run verify`, server `npm run verify`, O-06 self-test, audits on a fresh clone of the commit before this one | recorded in the next status commit |

## Acceptance gates before any operational import (ExcelJS not approved for operational use until all pass)

| # | Gate | State |
|---|---|---|
| G-1 | O-06 owner-side assessment done; approved aggregate report reviewed | Open |
| G-2 | Workbooks saved by Microsoft Excel (invented data) pass the harness with correct values | Open |
| G-3 | Limits re-evaluated on the target server (full harness; memory limits re-derived; timing margin) | Open |
| G-4 | Concurrency 2 only after the 2-parallel worst-case evidence on the target host; default 1 | Open (default 1) |
| G-5 | Every confinement layer available on the target host; imports refused (fail closed) if not | Open |
| G-6 | `npm audit signatures` passes | Open (blocked here) |
| G-7 | Third-party notice file with every licence text | Open |
| G-8 | After integration into `server/`: corpus as automated tests, audits, `verify_artifacts.py`, complete verification suite | Open |
| G-9 | Preview, confirmation, blank-never-erases, one transaction, idempotency, duplicates never merged (1B-3) | Open |

Details: [`security/import-evaluation.md`](security/import-evaluation.md) §5.2 and §7.

## Known limitations and risks

1. **Trusted network only (O-11):** MFA for all staff before any public exposure.
2. **Deployment blocker:** behind a reverse proxy, `trustProxy` must be set to the proxy's address.
3. **MFA key (L-8):** no rotation command yet; a tested key-rotation and recovery procedure is required before
   production.
4. **First enrolment trusts the password** (always before appointment, A7); TOTP is not phishing-resistant (L-9).
5. **Spreadsheet import (not built):** ExcelJS is unmaintained and loads deprecated packages; sandbox timings and
   memory are not evidence for the target host; gates G-1…G-9.
6. **Desktop:** `xlsx@0.18.5` (two high advisories) stays until the separate replacement task; interim rules apply.
7. **O-06 script:** shell-level behavior unverified until your first run; heuristics can misclassify both ways.
8. No breached-password check; no general rate limit; audit trail not shipped off the server.

None of this is production readiness: unit, integration and synthetic tests, audits and sandbox measurements do not
replace the deployment gates (O-11, L-8, G-1…G-9, Phase 1E).

## Owner actions

1. **O-06 (blocker):** (1) review `tools/data-quality/o06-data-quality.sql` and its README; (2) make a fresh backup
   with the desktop app's own backup function; (3) copy that backup to a separate folder and rename it; (4) run the
   assessment on the copy, read-only, as the runbook describes; (5) read the aggregate report and decide what may be
   shared. Never on the live database; the database itself is never sent.
2. **Push approval** for this session's two local commits, if you want them on GitHub (bundle backup provided).
3. **ExcelJS acceptance (later):** a few workbooks saved by Microsoft Excel on your PC (invented data only) through
   the harness (G-2); the target server for G-3…G-5 when it exists.
4. **Staff rules now:** the desktop interim restrictions on workbooks, and **Skip**, never **Update**, for
   duplicates (O-03).
5. **Separate items needing their own authorization:** O-03 (desktop import data-loss fix), O-04 (desktop Electron
   and dependency update), the desktop replacement of `xlsx@0.18.5` (before a new desktop release).
6. **L-8:** MFA encryption-key rotation and recovery procedure — to be designed, documented and tested before
   production (Phase 1E).
7. **Publish the baseline tag (O-02)** — a separate task you run locally; I perform no tag operation. On your PC, in
   the repository folder, with `WAM_Phase1A_closure.bundle`:
   ```
   git fetch "PATH\TO\WAM_Phase1A_closure.bundle" refs/tags/desktop-baseline-efbd65a:refs/tags/desktop-baseline-efbd65a
   git rev-parse "desktop-baseline-efbd65a^{commit}"     # must print efbd65a9ca123c1ac03d464087628097671a0290
   git push origin refs/tags/desktop-baseline-efbd65a
   git ls-remote origin refs/tags/desktop-baseline-efbd65a   # must print 6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5
   ```
   Then in GitHub → Settings → Rules, protect `main` (require a pull request) and protect tags `desktop-baseline-*`.
8. When you can: D-02 (warehouse list, privately), D-03 (mapping source and reviewer), D-06 (approvals), the WSL2
   readiness checks (sheet T-5).
