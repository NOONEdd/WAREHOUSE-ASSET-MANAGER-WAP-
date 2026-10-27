# Project status

Snapshot: **2026-10-27, fourth session**. Replace this file's contents at the end of each work session; history
stays in Git.

## Where things are

| Reference | Commit | On GitHub? | Content |
|---|---|---|---|
| `main` | `efbd65a9ca123c1ac03d464087628097671a0290` | yes (unchanged) | Desktop baseline |
| tag `desktop-baseline-efbd65a` | tag object `6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5` → `efbd65a9…` | **no** — a separate task you run locally (O-02); see [owner actions](#owner-actions) | Protects the baseline |
| `phase-1a/repo-safety-net` | `c819994e80cfdc0262677b0e359eb14a5b9765cc` | yes | Phase 1A |
| `ccr-1860034b-yp0csr` (session branch) | GitHub: `c90883e` (third push under O-10, verified). **Locally ahead by the commits below** | up to `c90883e` | Phase 1B-1, 1B-2 with MFA; O-12, O-06 tools, D-15 locally |

Pushed this session (O-10, third approval; fast-forward from `568846b`, no force, verified on GitHub and through the
GitHub API): `1724a7a` (owner never reset over HTTP), `c90883e` (decisions).

**Local only** — pushing them needs a new approval:

| Commit | Content |
|---|---|
| `5ddf4cf` | O-12: administrators must enrol MFA before appointment — service rule under a row lock **and** database constraint triggers (migration 0004) |
| `356596c` | O-06: read-only data-quality script, runbook and synthetic self-test (`tools/data-quality/`) for your review |
| the commit containing this file | D-15 (server) decision and dependency review; register, plan, review and matrix brought into line; this status |

Nothing was merged into `main`, tagged, released or deployed. No desktop file changed (`git diff c90883e HEAD` touches
only `server/`, `docs/` and the new `tools/`).

## Phase 1B-3 gate (your conditions) — **not passed yet**

| # | Condition | State |
|---|---|---|
| 1 | Authorized security commits pushed and verified | **Met:** `1724a7a`, `c90883e` on GitHub (verified by `git ls-remote` and the GitHub API) |
| 2 | O-06 script reviewed and your owner-controlled assessment completed (or the decision changed) | **Open — waiting for you.** Script ready for review in `tools/data-quality/`. |
| 3 | D-15 (server) recorded; dependencies reviewed | **Met:** decision recorded; review in `security/d15-spreadsheet-import-review.md`. Before ExcelJS is installed, O-13 (an undeclared licence) must be resolved. |
| 4 | O-12 recorded and enforced | **Met locally:** implemented and verified in `5ddf4cf`; pushing it needs your approval |
| 5 | Status, architecture and decision documents agree | **Met** with this commit (checked: register, STATUS, plan, review §2.7 and F-5, matrix, identity-and-access, server README) |

Because condition 2 is open, **no asset schema or migration-rehearsal plan has been proposed yet**, no asset table has
been written, and no rehearsal database exists. Next, once your assessment is done: the asset schema proposal and the
rehearsal plan on synthetic data, using your findings.

## Verification of this session (Linux sandbox; **nothing run on Windows, nothing on real data**)

| Check | Result |
|---|---|
| Fresh clone of `356596c`, `npm ci --ignore-scripts`, `npm run verify` (typecheck, lint `strictTypeChecked`, tests, build), Node 24.22.1, PostgreSQL 16.15, non-root user | **exit 0**; **323/323** tests (unit 145 in 7 files, integration 178 in 10 files); lockfile unchanged |
| O-12 deliberate-defect check: 9 safeguards removed one at a time (service check, reset refusal, re-check under lock, both database triggers, the triggers' row lock, owner exemption, migration refusal, transfer clean-up) | **9/9 caught**; source restored byte-identical |
| O-12 stability | full suite 3× in a row, 323/323 each time (includes a concurrency test and a deterministic two-transaction interleaving test) |
| O-06 script self-test (`tools/data-quality/test_o06_data_quality.py`) on a synthetic database built from the desktop schema, SQLite 3.45.1 engine | **passed** from the fresh clone: 32 statements; file byte-identical; writes refused; no synthetic value printed; planted counts reported; live-file-name guard stops the run. **Not tested:** the sqlite3 shell's dot-commands and the runbook command line (the shell could not be downloaded in the sandbox) |
| D-15 dependency review (throwaway folder outside the repository) | `exceljs@4.4.0` + `csv-parse@7.0.3`: 194 packages, no install scripts; 1 advisory (uuid GHSA-w5hq-g745-h8pq) checked in the source as not reachable, neutralized by an override to uuid 11.1.1 (tested: audit 0, call path works); findings: an undeclared licence (`buffers@0.1.1`), deprecated packages, ExcelJS unreleased since 2023-10-19 |
| `npm audit` (server) | 0 vulnerabilities; no dependency added to `server/` |
| Performance (fresh clone, synthetic data) | all targets met — p95: login 199 ms (≤ 1,000), second step 45 ms, `/api/me` 46 ms, admin search 37 ms, audit page 40 ms (≤ 100 each) |

## Known limitations and risks

1. **Trusted network only (O-11):** MFA for all staff before any public exposure; until the policy is `all_users`,
   verified and recovery-tested, the server stays on a trusted network.
2. **Deployment blocker:** behind a reverse proxy, `trustProxy` must be set to the proxy's address.
3. **MFA key:** no rotation command yet (L-8); a tested rotation and recovery procedure is required before production.
4. **First enrolment trusts the password** (now always before appointment, A7); TOTP is not phishing-resistant (L-9).
5. **Spreadsheet import risks (1B-3):** ExcelJS is unmaintained since 2023 and pulls in deprecated packages; an
   undeclared licence (O-13); hostile-file behavior is not tested yet (D-15 review §3.3, §4.13).
6. **O-06 script:** shell-level behavior unverified until your first run; heuristics can misclassify both ways.
7. No breached-password check; no general rate limit; audit trail not shipped off the server.

## Owner actions

1. **Review `tools/data-quality/o06-data-quality.sql` and its README, then run it** on a renamed copy of a fresh
   desktop backup, read the report, and share what you choose (O-06). Optional first: the synthetic dry run.
2. **Push approval** for `5ddf4cf`, `356596c` and the docs commit above, if you want them on GitHub (bundle backup
   provided).
3. **O-13:** how to handle `buffers@0.1.1` (no licence) before ExcelJS is adopted.
4. **D-15 (desktop scope):** whether, and when, the desktop's `xlsx@0.18.5` is replaced (separate approval).
5. **Publish the baseline tag (O-02)** — a separate task you run locally; I perform no tag operation. On your PC, in
   the repository folder, with `WAM_Phase1A_closure.bundle`:
   ```
   git fetch "PATH\TO\WAM_Phase1A_closure.bundle" refs/tags/desktop-baseline-efbd65a:refs/tags/desktop-baseline-efbd65a
   git rev-parse "desktop-baseline-efbd65a^{commit}"     # must print efbd65a9ca123c1ac03d464087628097671a0290
   git push origin refs/tags/desktop-baseline-efbd65a
   git ls-remote origin refs/tags/desktop-baseline-efbd65a   # must print 6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5
   ```
   Then in GitHub → Settings → Rules, protect `main` (require a pull request) and protect tags `desktop-baseline-*`.
6. **Staff rule until O-03 is fixed and verified:** in the desktop import screen choose **Skip**, never **Update**.
7. When you can: O-03 and O-04 (desktop fixes), D-02 (warehouse list, privately), D-03 (mapping source and
   reviewer), D-06 (approvals), the WSL2 readiness checks (sheet T-5), and the proposed import limits (E-18).
