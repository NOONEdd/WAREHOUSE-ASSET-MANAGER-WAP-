# Project status

Snapshot: **2026-10-27**. Replace this file's contents at the end of each work session; history stays in Git.

## Where things are

| Reference | Commit | On GitHub? | Content |
|---|---|---|---|
| `main` | `efbd65a9ca123c1ac03d464087628097671a0290` | yes (unchanged) | Desktop baseline |
| tag `desktop-baseline-efbd65a` | tag object `6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5` → `efbd65a9…` | **no** — push refused (HTTP 403) by this session's permissions; see [owner actions](#owner-actions) | Protects the baseline |
| `phase-1a/repo-safety-net` | `c819994e80cfdc0262677b0e359eb14a5b9765cc` | **yes**, verified with `git ls-remote` | Phase 1A, imported from `WAM_Phase1A_closure.bundle` |
| `ccr-1860034b-yp0csr` (session branch) | `eeb25fea8448c400b42c6d2f6f0700e19e47f5f4` | **yes** — pushed with your approval (O-01), verified with `git ls-remote` | Phase 1A + Phase 1B-1 server foundation + these documents |

How Phase 1A reached GitHub: this session may push only to its session branch, so the verified Phase 1A commits
were pushed there (a fast-forward, no force), and `phase-1a/repo-safety-net` was created on GitHub from it via
the GitHub API. Both point to exactly `c819994e…`. Nothing was merged into `main`; nothing was deployed.

## Verification (run in this session, Linux cloud sandbox; **nothing has been run on Windows**)

| Check | Environment | Result |
|---|---|---|
| Bundle integrity (`git bundle verify`, `git fsck`) | — | OK; complete history; ZIP is byte-identical to the branch tree |
| Desktop source unchanged vs baseline | `git diff efbd65a -- src resources …` | empty |
| Baseline test failures reproduced | `efbd65a`, Node 22.22.0 | 552 tests: 529 passed, 23 failed — exactly as the dispositions doc says |
| Root `npm ci --ignore-scripts` | Node 22.22.0 | exit 0; lockfile unchanged |
| Root `npm run verify` (env check, 533 tests, build) | Node 22.22.0 **and** Node 24.22.1 | exit 0 on both; 533/533 |
| Server `npm run verify` (Phase 1A skeleton) | Node 24.22.1 | 2/2 tests |
| Server Phase 1B-1: typecheck, lint, build | Node 24.22.1 | exit 0 |
| Server Phase 1B-1: tests | Node 24.22.1, PostgreSQL 16.15, non-root user | 58/58 (22 unit, 36 integration) |
| Safety-test mutation check (14 deliberate defects) | same | 14/14 caught |
| Runbook smoke test with the built server | same | refuses before migration and as owner; migrates; health OK; SIGTERM exit 0; no password in logs |
| Registry signatures, both lockfiles | — | 839/839 verified |
| `npm audit` | root / server | root: 15 findings (4 in production dependencies) — unchanged, see review F-4/F-5; server: 0 |
| `npm audit signatures` (Sigstore) | — | could not download in the sandbox; please run on your network |

## Done this session

1. Discovery and Phase 1A import, review and publication (above).
2. Architecture and security review: [`architecture/web-architecture-and-security-review.md`](architecture/web-architecture-and-security-review.md).
   Two findings affect the **desktop app in use today**: import "update" erases data (F-3) and Electron 43.2.0 has
   published security fixes not yet applied (F-4).
3. Decision register: [`decisions/decision-register.md`](decisions/decision-register.md). Security matrix:
   [`security/security-acceptance-matrix.md`](security/security-acceptance-matrix.md). Plan: [`plan/30-day-plan.md`](plan/30-day-plan.md).
4. Phase 1B-1 server foundation, isolated in `server/` (see [`../server/README.md`](../server/README.md)). No business
   tables, authentication or company data. No desktop file changed.

## Not done

Phase 1B-2 onward; any desktop change; anything on Windows; PostgreSQL 17 testing; deployment of any kind.

## Owner actions

1. ~~Approve the push (O-01)~~ — done 2026-10-27.
2. **Publish the baseline tag** (O-02). On your PC, in the repository folder, with the original
   `WAM_Phase1A_closure.bundle` (changes your local Git and adds one tag on GitHub; touches nothing else):
   ```
   git fetch "PATH\TO\WAM_Phase1A_closure.bundle" refs/tags/desktop-baseline-efbd65a:refs/tags/desktop-baseline-efbd65a
   git rev-parse "desktop-baseline-efbd65a^{commit}"     # must print efbd65a9ca123c1ac03d464087628097671a0290
   git push origin refs/tags/desktop-baseline-efbd65a
   git ls-remote origin refs/tags/desktop-baseline-efbd65a   # must print 6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5
   ```
   Then in GitHub → Settings → Rules, protect `main` (require a pull request) and protect tags `desktop-baseline-*`.
3. **Tell staff:** in the desktop import screen, choose *skip* — never *update* — for duplicates, until O-03 is fixed.
4. **Answer D-01 and D-05** (and, when you can, D-02, D-03, D-06), and run the WSL2 readiness checks in the
   readiness sheet, T-5 (read-only).
