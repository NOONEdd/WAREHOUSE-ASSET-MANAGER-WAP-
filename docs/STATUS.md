# Project status

Snapshot: **2026-10-28, O-06 resolved**. Replace this file's contents at the end of each work session; history
stays in Git.

## Where things are

| Reference | Commit | On GitHub? | Content |
|---|---|---|---|
| `main` | `efbd65a9ca123c1ac03d464087628097671a0290` | yes (unchanged) | Desktop baseline |
| tag `desktop-baseline-efbd65a` | tag object `6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5` → `efbd65a9…` | **no** — a separate task you run locally (O-02); see [owner actions](#owner-actions) | Protects the baseline |
| `phase-1a/repo-safety-net` | `c819994e80cfdc0262677b0e359eb14a5b9765cc` | yes (unchanged) | Phase 1A |
| `ccr-1860034b-yp0csr` (session branch) | GitHub: **`67e3d2e94e248e10bc642cc07c7ca6914903de41`** (sixth push under O-10, 2026-10-28, verified with `git ls-remote` and the GitHub API). **Locally ahead only by the commit containing this file** | up to `67e3d2e` | Phase 1B-1, 1B-2 with MFA, O-12, O-06 tools and disposition, D-15, O-13/E-18 evaluation |

Pushed on 2026-10-28, each as a fast-forward with no force, after checking ancestry, full diffs, remote state,
secrets and personal data, and that desktop source, build configuration, root package files, `server/`, `main` and
`phase-1a/repo-safety-net` were untouched: `6ac697d`, `8039708`, `18b4c6b` (fifth push, `9c3ac79..18b4c6b`), then
`416d2f9`, `67e3d2e` (sixth push, `18b4c6b..67e3d2e`). The bundle backups were kept until the remote branch was
verified, and are still kept.

**Local only** — pushing it needs a new approval:

| Commit | Content |
|---|---|
| the commit containing this file | O-06 disposition recorded in the decision register and STATUS (with the companion alignment of six documents, if committed together) |

Nothing was merged into `main`, tagged, released or deployed. No desktop file and no `server/` file changed.

## Phase 1B-3 gate — **O-06 resolved; Phase 1B-3 not authorized**

| # | Condition | State |
|---|---|---|
| 1 | Authorized commits pushed and verified | **Met** for everything up to `67e3d2e` |
| 2 | O-06 | **Met — resolved 2026-10-28 through the documented alternative** (not option B's owner-side run): the desktop source database was inspected and contains test data only; no desktop data migration is required for the WAM web application. Not an empty database: 5 assets (1 active, 4 soft-deleted), 9 `asset_transactions` rows and 118 `audit_log` rows, which the owner confirmed are disposable test data. Evidence: register, O-06 |
| 3 | D-15 (server) recorded; dependency selected | **Met** for selection (O-13, 2026-10-28); ExcelJS is **not approved for operational use** (acceptance gates G-1…G-9 below) |
| 4 | O-12 recorded and enforced | **Met** (`5ddf4cf`, on GitHub) |
| 5 | Documents agree | **Met only if committed together with the companion alignment** of the six documents that still assumed a desktop data migration (`tools/data-quality/README.md`, `docs/plan/30-day-plan.md`, `docs/security/import-evaluation.md`, `docs/security/security-acceptance-matrix.md`, `docs/security/d15-spreadsheet-import-review.md`, `docs/architecture/web-architecture-and-security-review.md`); otherwise **Open** |
| 6 | Your explicit authorization to start Phase 1B-3 | **Open — not given** |

With O-06 resolved there is **no desktop data migration, no migration-rehearsal database and no SQLite → PostgreSQL
rehearsal** of desktop data. Phase 1B-3 is **not authorized**: it starts only with your explicit approval (condition
6) and once the documents agree (condition 5); until then no asset schema is finalized or implemented and no asset
table exists. Proposed sequence under that approval: an asset-schema design proposal for your review, then
implementation and tests on synthetic data only. Real spreadsheet data is governed separately by the Excel Source
Admission Gate (O-14, proposed), whose stages are each approved on their own: (1) the file as schema design input,
D-03 may be deferred here; (2) a preview-only test without commit, which also needs D-03 decided and the minimum
preview controls of [`security/import-evaluation.md`](security/import-evaluation.md) §7.1 (they satisfy no gate
G-2…G-9); (3) operational import, which also needs D-02, D-03 and gates G-2…G-9. **No preview or import of the
real spreadsheet is authorized.**

## This session

| Item | Result |
|---|---|
| **A. Push** | `6ac697d`, `8039708`, `18b4c6b` pushed as a normal fast-forward, then `416d2f9`, `67e3d2e`; branch verified at `67e3d2e` |
| **B. O-13 selection** | ExcelJS 4.4.0 + explicit `unzipper@0.12.5` (+ `uuid@11.1.1`) + strict `csv-parse@7.0.3` selected — **not approved for operational use**. Final tree: 88 lockfile entries, `npm ls --all` clean, `buffers` absent. Against the published artifacts: SHA-512 recomputed from every tarball equals the lockfile (88/88); installed files byte-identical to the tarballs (88/88 packages, 2,186 files). Licences all permissive and declared; open: third-party notice file (`saxes` ships no text — upstream ISC verified; `isarray` text only in README). `npm audit` 0. `npm audit signatures` not verifiable here (network policy denies `tuf-repo-cdn.sigstore.dev`) |
| **C. E-18 approved** | Eight maximums enforced in the parser process; every exact boundary accepted and the first value above refused, now including CSV processed cells (every field counts, blank or not: 1,000,000 accepted, 1,000,004 and a mostly blank 1,000,100 refused) and the wall clock (29.5 s of work completes, 30.1 s is stopped at 30.0 s). Concurrency **1** by default, **2** at most, recorded in `lib/limits.mjs` (`OPERATIONAL`); a 2-parallel worst-case load test with host `MemAvailable` sampling added |
| **D. O-06** | **Resolved:** instead of option B's owner-side run, the backup supplied by the owner was assessed in the development sandbox on a read-only copy (34/34 statements, no errors, Section 0 all `ok`, `integrity_check` ok); test data only, as confirmed by the owner; no desktop data migration. The copy was deleted after the report |
| **Defects guarded** | ExcelJS `cell.value` loses cached 0/FALSE results and repeats merged values — now a dedicated regression case (X28) besides the producer files; the streaming reader is never used (Persian text damage) |

## Verification of this session (Linux sandbox; **nothing run on Windows or on company data, not the target host**)

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
| Fresh clone of `416d2f9`, `npm ci --ignore-scripts` (root, `server/`, `tools/import-evaluation/`), non-root user, Node 24.22.1 | all three lockfiles unchanged |
| Desktop `npm run verify` (env check, tests, build), private `TMPDIR` | **exit 0**: 533/533 tests in 37 files; build OK |
| Server `npm run verify` (typecheck, ESLint `strictTypeChecked`, tests, build), PostgreSQL 16.15 | **exit 0**: 323/323 tests in 17 files |
| O-06 self-test (`tools/data-quality/test_o06_data_quality.py`) | passed: 34 statements, no synthetic value in the report, file unchanged, 6 unsafe inputs refused |
| O-06 on the owner-supplied backup (copy only) | 34/34 statements, no errors; Section 0 all `ok`; `integrity_check` ok; SHA-256 `acda021e…dd824` of the original and the copy identical before and after; no side files. Isolation: read-only mounts, unprivileged user, no network, `mode=ro&immutable=1`, `query_only`; each layer refused a write probe on a synthetic copy first. Python's SQLite 3.45.1, not the `sqlite3` shell |
| `npm audit` | `server/` 0; `tools/import-evaluation/` 0 |
| `verify_artifacts.py` on the clone's install; `npm ls --all`; `buffers` | exit 0 (88/88 SHA-512, 88/88 identical contents); `npm ls` exit 0; `buffers` not in the tree |
| `node --check` of every evaluation script | no syntax error |
| Scope | `18b4c6b..416d2f9` touches only `docs/` and `tools/import-evaluation/`; desktop source, build configuration, root package files and `server/` unchanged; GitHub branch still `18b4c6b` (nothing pushed) |

## Acceptance gates before any operational import (ExcelJS not approved for operational use until all pass)

| # | Gate | State |
|---|---|---|
| G-1 | O-06 owner-side assessment done; approved aggregate report reviewed | **Satisfied through the documented alternative, not by the original procedure** (O-06, 2026-10-28): you did not run the assessment on your own PC; it ran in the development sandbox on a read-only copy of the backup you supplied, at your request, and its aggregate report was presented to you; you confirmed test data only. Approving the O-06 record accepts this alternative in place of the owner-side run. Phase 1B-3 still needs your explicit authorization |
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
   memory are not evidence for the target host; gates G-2…G-9 and, for real spreadsheet data, the Excel Source
   Admission Gate (O-14, proposed).
6. **Desktop:** `xlsx@0.18.5` (two high advisories) stays until the separate replacement task; interim rules apply.
7. **O-06 script:** its `sqlite3`-shell steps remain unverified (the 2026-10-28 run used Python's SQLite); relevant
   only if a desktop database holding company data must ever be assessed. Heuristics can misclassify both ways.
8. No breached-password check; no general rate limit; audit trail not shipped off the server.

None of this is production readiness: unit, integration and synthetic tests, audits and sandbox measurements do not
replace the deployment gates (O-11, L-8, G-2…G-9, Phase 1E).

## Owner actions

1. **Next approvals (O-06 is resolved):** (a) whether to adopt the Excel Source Admission Gate (O-14, proposed in the
   register, section 2), each of whose stages is then approved separately; (b) explicit authorization to start
   Phase 1B-3, with the proposed sequence of an asset-schema design proposal for your review, then implementation and
   tests on synthetic data only. Neither authorizes a preview or an import of the real spreadsheet. The desktop app
   and its database stay as they are.
2. **Push approval** for the commit containing this file, if you want it on GitHub.
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
